"""
formats/xrlf_packer.py — XRLF Binary File Writer
=================================================
Assembles XRLF sections from JSON artifacts + a GGUF file + memory DB
and writes a single .xrlf binary.

Usage:
    packer = XRLFPacker(
        base_model_name="gemma-4-12b-it-qat-GGUF-MoQ",
        xrl_source_model="qwen3.5-4b",
    )
    packer.add_gguf("path/to/Gemma-4-12B-MoQ.gguf")
    packer.add_xrl_json_dir("xrl_encoded/")
    packer.add_memory_db("foveated-memory/memory_data/default/memory.db")
    packer.write("gemma-4-12b-xrl.xrlf")
"""

import json
import os
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import msgpack
    _MSGPACK = True
except ImportError:
    _MSGPACK = False

from formats.xrlf_schema import (
    MAGIC, FORMAT_VERSION, HEADER_STRUCT, HEADER_SIZE,
    SECTION_ENTRY_STRUCT, SECTION_ENTRY_SIZE,
    XRLFFlags, SectionType, SectionFlags, GEMMA4_DEFAULT_FLAGS,
    GEMMA4_CAPABILITY_MAP,
)


# ── Default Gemma-4 TTS hook config ──────────────────────────────────────────

DEFAULT_MM_HOOKS = {
    "version": 1,
    "native_multimodal": {
        "image_in":  True,
        "video_in":  True,
        "audio_in":  True,   # Gemma-4 handles STT natively
        "text_in":   True,
        "text_out":  True,
    },
    "external_hooks": {
        "tts": {
            "enabled": True,
            "engine": "auto",
            "provider": "http",
            "endpoint": "http://127.0.0.1:8004/tts",
            "voice": "default",
            "sample_rate": 22050,
            "format": "wav",
            "fallback": ["http", "piper", "espeak", "stub"],
        },
        "image_gen": {
            "enabled":  False,
            "endpoint": "http://127.0.0.1:7860",  # A1111/ComfyUI
        },
        "audio_gen": {
            "enabled": False,
        },
    },
    "capability_map": GEMMA4_CAPABILITY_MAP,
}

DEFAULT_MEMORY_SCHEMA = {
    "version": 1,
    "ring_count": 6,
    "token_budget": 2048,
    "tfidf_top_k": 5,
    "persistent": True,
    "ring_config": {
        "ring_0": {"label": "identity",    "max_tokens": 128,  "ttl_turns": None},
        "ring_1": {"label": "task",        "max_tokens": 256,  "ttl_turns": None},
        "ring_2": {"label": "recent",      "max_tokens": 512,  "ttl_turns": 8},
        "ring_3": {"label": "working",     "max_tokens": 512,  "ttl_turns": 32},
        "ring_4": {"label": "background",  "max_tokens": 384,  "ttl_turns": 128},
        "ring_5": {"label": "archive",     "max_tokens": 256,  "ttl_turns": None},
    },
}


# ── Section payload builder ───────────────────────────────────────────────────

@dataclass
class _SectionBlob:
    section_type: SectionType
    payload: bytes        # raw bytes to write
    flags: int = int(SectionFlags.NONE)


class XRLFPacker:
    """
    Builds an XRLF file section-by-section, then writes the complete binary.
    The CORE_GGUF is streamed in chunks to avoid loading 3.8 GB into RAM.
    """

    def __init__(
        self,
        base_model_name: str = "gemma-4-12b-it-qat-GGUF-MoQ",
        xrl_source_model: str = "qwen3.5-4b",
        flags: int = int(GEMMA4_DEFAULT_FLAGS),
    ):
        self.base_model_name = base_model_name
        self.xrl_source_model = xrl_source_model
        self.flags = flags
        self._sections: List[_SectionBlob] = []
        self._gguf_path: Optional[str] = None   # streamed separately
        self._mmproj_path: Optional[str] = None # streamed separately
        self._draft_gguf_path: Optional[str] = None # streamed separately

    # ── Section adders ────────────────────────────────────────────────────────

    def add_gguf(self, gguf_path: str) -> "XRLFPacker":
        """Register the GGUF path; payload is streamed at write time."""
        if not Path(gguf_path).exists():
            raise FileNotFoundError(f"GGUF not found: {gguf_path}")
        self._gguf_path = gguf_path
        print(f"  CORE_GGUF registered: {gguf_path}  ({Path(gguf_path).stat().st_size / 1e9:.2f} GB)")
        return self

    def add_mmproj(self, mmproj_path: str) -> "XRLFPacker":
        """Register the Multimodal Projector GGUF path."""
        if not Path(mmproj_path).exists():
            raise FileNotFoundError(f"MMPROJ not found: {mmproj_path}")
        self._mmproj_path = mmproj_path
        print(f"  CORE_MMPROJ registered: {mmproj_path}  ({Path(mmproj_path).stat().st_size / 1e6:.2f} MB)")
        return self

    def add_draft_gguf(self, draft_path: str) -> "XRLFPacker":
        """Register the Draft model GGUF path for speculative decoding."""
        if not Path(draft_path).exists():
            raise FileNotFoundError(f"Draft GGUF not found: {draft_path}")
        self._draft_gguf_path = draft_path
        print(f"  CORE_DRAFT_GGUF registered: {draft_path}  ({Path(draft_path).stat().st_size / 1e6:.2f} MB)")
        self.flags |= int(XRLFFlags.HAS_DRAFT_GGUF)
        return self

    def _encode(self, obj: Any) -> Tuple[bytes, int]:
        """Encode a Python object to bytes; use msgpack if available."""
        if _MSGPACK:
            data = msgpack.packb(obj, use_bin_type=True)
            return data, int(SectionFlags.COMPRESSED)
        else:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            return data, int(SectionFlags.NONE)

    def _add_json_section(self, section_type: SectionType, obj: Any) -> "XRLFPacker":
        payload, flags = self._encode(obj)
        self._sections.append(_SectionBlob(section_type, payload, flags))
        print(f"  {section_type.name:22s} {len(payload) / 1024:.1f} KB")
        return self

    def add_xrl_json_dir(self, xrl_dir: str) -> "XRLFPacker":
        """
        Load all XRL artifacts from the standard xrl_encoded/ directory layout.
        Expected files (from xrl_process_qwen4b_gguf.py output):
          principles_gguf.json, semantic_graph_gguf.json,
          semantic_clusters_gguf.json, semantic_expansion_gguf.json,
          threads_gguf.json
        """
        d = Path(xrl_dir)
        print(f"\n  Loading XRL artifacts from: {d}")

        def load(filename: str) -> Any:
            p = d / filename
            if p.exists():
                with open(p, "r", encoding="utf-8") as f:
                    return json.load(f)
            return {}

        principles  = load("principles_gguf.json")
        graph       = load("semantic_graph_gguf.json")
        clusters    = load("semantic_clusters_gguf.json")
        expansions  = load("semantic_expansion_gguf.json")
        threads     = load("threads_gguf.json")

        # Build task profiles from thread analysis
        profiles = _build_task_profiles(threads)

        self._add_json_section(SectionType.XRL_PRINCIPLES, principles)
        self._add_json_section(SectionType.XRL_GRAPH,      graph)
        self._add_json_section(SectionType.XRL_CLUSTERS,   clusters)
        self._add_json_section(SectionType.XRL_PROFILES,   profiles)
        self._add_json_section(SectionType.XRL_EXPANSION,  expansions)

        return self

    def add_multimodal_hooks(self, hooks: Optional[Dict] = None) -> "XRLFPacker":
        """Add multimodal hook config. Defaults to Gemma-4 native + TTS."""
        self._add_json_section(SectionType.XRL_MM_HOOKS, hooks or DEFAULT_MM_HOOKS)
        return self

    def add_memory_db(self, db_path: Optional[str] = None) -> "XRLFPacker":
        """
        Embed foveated memory SQLite DB + empty TF-IDF index.
        If db_path is None or file doesn't exist, embeds a stub (empty seed).
        """
        section_type = SectionType.XRL_MEMORY_DATA

        if db_path and Path(db_path).exists():
            sqlite_bytes = Path(db_path).read_bytes()
            print(f"  Embedding memory DB: {db_path}  ({len(sqlite_bytes)} bytes)")
        else:
            # Stub: minimal valid SQLite header (empty DB)
            sqlite_bytes = _minimal_sqlite_stub()
            print("  Embedding memory DB: (empty seed — no existing DB found)")

        tfidf_bytes = b""   # empty index; will be built at runtime

        # Layout: [4B sqlite_len][sqlite][tfidf]
        payload = struct.pack("<I", len(sqlite_bytes)) + sqlite_bytes + tfidf_bytes
        self._sections.append(_SectionBlob(section_type, payload, int(SectionFlags.NONE)))
        print(f"  {section_type.name:22s} {len(payload) / 1024:.1f} KB")
        return self

    def add_memory_schema(self, schema: Optional[Dict] = None) -> "XRLFPacker":
        self._add_json_section(SectionType.XRL_MEMORY_SCHEMA, schema or DEFAULT_MEMORY_SCHEMA)
        return self

    def add_runtime_meta(self) -> "XRLFPacker":
        meta = {
            "xrlf_version": FORMAT_VERSION,
            "build_time": int(time.time()),
            "base_model": self.base_model_name,
            "xrl_source": self.xrl_source_model,
            "flags": self.flags,
            "capability_map": GEMMA4_CAPABILITY_MAP,
            "required_runtime": "xrlf-runtime>=1.0",
        }
        self._add_json_section(SectionType.RUNTIME_META, meta)
        return self

    # ── Write ─────────────────────────────────────────────────────────────────

    def write(self, output_path: str, dry_run: bool = False) -> str:
        """
        Write the complete .xrlf file.
        CORE_GGUF is streamed in 64 MB chunks — no full-file RAM load.
        """
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)

        # ── 1. Determine layout ───────────────────────────────────────────────
        base_name_bytes = self.base_model_name.encode("utf-8")
        xrl_name_bytes  = self.xrl_source_model.encode("utf-8")

        # Section count: all JSON sections + (1 GGUF if registered) + (1 MMPROJ if registered) + (1 DRAFT if registered)
        section_count = len(self._sections) + (1 if self._gguf_path else 0) + (1 if self._mmproj_path else 0) + (1 if self._draft_gguf_path else 0)

        # Compute the byte offset where section payloads begin
        payload_start = (
            HEADER_SIZE
            + len(base_name_bytes)
            + len(xrl_name_bytes)
            + section_count * SECTION_ENTRY_SIZE
        )

        # ── 2. Build section table entries (offsets) ──────────────────────────
        entries: List[Tuple[SectionType, int, int, int]] = []  # type,offset,len,flags
        cursor = payload_start

        # GGUF goes first (largest section, fast to mmap later)
        gguf_size = 0
        if self._gguf_path:
            gguf_size = Path(self._gguf_path).stat().st_size
            entries.append((SectionType.CORE_GGUF, cursor, gguf_size, int(SectionFlags.NONE)))
            cursor += gguf_size

        mmproj_size = 0
        if self._mmproj_path:
            mmproj_size = Path(self._mmproj_path).stat().st_size
            entries.append((SectionType.CORE_MMPROJ, cursor, mmproj_size, int(SectionFlags.NONE)))
            cursor += mmproj_size

        draft_size = 0
        if self._draft_gguf_path:
            draft_size = Path(self._draft_gguf_path).stat().st_size
            entries.append((SectionType.CORE_DRAFT_GGUF, cursor, draft_size, int(SectionFlags.NONE)))
            cursor += draft_size

        for blob in self._sections:
            entries.append((blob.section_type, cursor, len(blob.payload), blob.flags))
            cursor += len(blob.payload)

        total_size = cursor

        print(f"\n  Total XRLF size: {total_size / 1e9:.2f} GB → {out}")

        if dry_run:
            print("  [DRY RUN] No file written.")
            _print_section_table(entries)
            return str(out)

        # ── 3. Write file ─────────────────────────────────────────────────────
        with open(out, "wb") as f:
            # Header
            header_raw = HEADER_STRUCT.pack(
                MAGIC,
                FORMAT_VERSION,
                len(base_name_bytes),
                len(xrl_name_bytes),
                self.flags,
                section_count,
                b"\x00" * 6,
            )
            f.write(header_raw)
            f.write(base_name_bytes)
            f.write(xrl_name_bytes)

            # Section table
            for stype, offset, length, sflags in entries:
                f.write(SECTION_ENTRY_STRUCT.pack(int(stype), offset, length, sflags))

            # GGUF payload (streamed)
            if self._gguf_path:
                chunk = 64 * 1024 * 1024
                written = 0
                with open(self._gguf_path, "rb") as gguf:
                    while True:
                        data = gguf.read(chunk)
                        if not data:
                            break
                        f.write(data)
                        written += len(data)
                        pct = 100 * written / gguf_size
                        print(f"\r  Writing GGUF core... {pct:.1f}%", end="", flush=True)
                print(f"\r  Written GGUF core  ({gguf_size / 1e9:.2f} GB)        ")

            # MMPROJ payload (streamed)
            if self._mmproj_path:
                chunk = 64 * 1024 * 1024
                written = 0
                with open(self._mmproj_path, "rb") as mmproj:
                    while True:
                        data = mmproj.read(chunk)
                        if not data:
                            break
                        f.write(data)
                        written += len(data)
                        pct = 100 * written / mmproj_size
                        print(f"\r  Writing MMPROJ... {pct:.1f}%", end="", flush=True)
                print(f"\r  Written MMPROJ  ({mmproj_size / 1e6:.2f} MB)        ")

            # DRAFT GGUF payload (streamed)
            if self._draft_gguf_path:
                chunk = 64 * 1024 * 1024
                written = 0
                with open(self._draft_gguf_path, "rb") as draft:
                    while True:
                        data = draft.read(chunk)
                        if not data:
                            break
                        f.write(data)
                        written += len(data)
                        pct = 100 * written / draft_size
                        print(f"\r  Writing DRAFT GGUF... {pct:.1f}%", end="", flush=True)
                print(f"\r  Written DRAFT GGUF  ({draft_size / 1e6:.2f} MB)        ")

            # JSON/msgpack sections
            for blob in self._sections:
                f.write(blob.payload)

        actual_size = out.stat().st_size
        print(f"  ✅ XRLF written: {out}  ({actual_size / 1e9:.2f} GB)")
        _print_section_table(entries)
        return str(out)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _build_task_profiles(threads: Any) -> Dict:
    """Derive basic task profiles from thread prompts."""
    return {
        "version": 1,
        "profiles": {
            "chat": {
                "name": "Conversational",
                "description": "Friendly, coherent, context-aware chat",
                "system_prefix": (
                    "You are a helpful, intelligent assistant. "
                    "Think carefully and respond clearly."
                ),
                "temperature": 0.7,
                "triggers": ["chat", "help", "what", "why", "how", "explain"],
            },
            "code": {
                "name": "Code",
                "description": "Precise, structured, technically correct",
                "system_prefix": (
                    "You are an expert software engineer. "
                    "Write clean, correct, well-commented code. "
                    "Explain your reasoning step by step."
                ),
                "temperature": 0.2,
                "triggers": ["code", "write", "function", "class", "implement", "debug", "fix"],
            },
            "vision": {
                "name": "Vision Analysis",
                "description": "Descriptive, spatial, detail-oriented image/video reasoning",
                "system_prefix": (
                    "You are analyzing visual content. "
                    "Describe what you see in detail: objects, colors, layout, text, relationships."
                ),
                "temperature": 0.4,
                "triggers": ["image", "photo", "picture", "video", "see", "look", "describe"],
            },
            "audio": {
                "name": "Audio Reasoning",
                "description": "Sound and speech understanding",
                "system_prefix": (
                    "You are analyzing audio content. "
                    "Describe what you hear: speech, tone, language, emotion, background sounds."
                ),
                "temperature": 0.4,
                "triggers": ["audio", "sound", "speech", "hear", "listen", "voice"],
            },
            "reasoning": {
                "name": "Deep Reasoning",
                "description": "Step-by-step logical analysis",
                "system_prefix": (
                    "Think through this problem carefully, step by step. "
                    "Show your reasoning explicitly. "
                    "Check your work at each step."
                ),
                "temperature": 0.3,
                "triggers": ["reason", "analyze", "logic", "proof", "step", "solve"],
            },
        },
        "default_profile": "chat",
        "auto_detect": True,
    }


def _minimal_sqlite_stub() -> bytes:
    """Create a minimal valid empty SQLite3 database using Python's sqlite3 module."""
    import sqlite3, tempfile, os
    tmp = tempfile.mktemp(suffix=".db")
    try:
        conn = sqlite3.connect(tmp)
        conn.execute("CREATE TABLE _xrlf_seed (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        return Path(tmp).read_bytes()
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _print_section_table(entries):
    print("\n  Section table:")
    print(f"  {'Type':22s} {'Offset':>14s} {'Size':>12s}")
    print("  " + "-" * 52)
    for stype, offset, length, _ in entries:
        name = stype.name if hasattr(stype, 'name') else str(stype)
        print(f"  {name:22s} {offset:>14,}  {length / 1e6:>10.2f} MB")
