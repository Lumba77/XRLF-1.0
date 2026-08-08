"""
runtime/xrlf_runtime.py — XRLF Main Runtime Orchestrator
=========================================================
Loads a .xrlf file and runs the hybrid model:

  1. Parse XRLF → extract GGUF core + memory DB to temp
  2. Load LlamaEngine (Gemma-4-12B MoQ)
  3. Load MembraneEngine (embedded foveated memory)
  4. Load XRL cognitive layer (profiles, clusters, graph, principles)
  5. On each chat() call:
     a. Select task profile (chat/code/vision/audio/reasoning)
     b. Activate semantic clusters
     c. Walk semantic graph for concept enrichment
     d. Weave foveated memory ring block
     e. Build steered system prompt
     f. Call LlamaEngine for generation
     g. Store turn in memory
     h. Return response
  6. On close: optionally re-pack memory back into .xrlf

Usage:
    rt = XRLFRuntime("gemma-4-12b-xrl.xrlf")
    rt.load()
    response = rt.chat([{"role": "user", "content": "Hello!"}])
    rt.close()
"""

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Union

# ── Reactor Master Kill Switch (Step 1) ──────────────────────────────────────
# XRLF_REPO_ENABLED=false → the repo becomes COLD: all XRL cognitive steering,
# foveated memory injection, and system-prompt overrides are bypassed so the
# runtime becomes a transparent passthrough to the GGUF core model.
# This isolates the repo permanently until you turn it back on.
XRLF_REPO_ENABLED = os.environ.get("XRLF_REPO_ENABLED", "false").lower().strip() in (
    "true", "1", "on",
)
XRLF_CONTEXT_OVERRIDE = (
    os.environ.get("XRLF_CONTEXT_OVERRIDE", "true" if XRLF_REPO_ENABLED else "false").lower().strip()
    in ("true", "1", "on")
)
XRLF_CAPABILITY_OVERRIDE = (
    os.environ.get("XRLF_CAPABILITY_OVERRIDE", "true" if XRLF_REPO_ENABLED else "false").lower().strip()
    in ("true", "1", "on")
)
XRLF_FOVEATION_OVERRIDE = (
    os.environ.get("XRLF_FOVEATION_OVERRIDE", "true" if XRLF_REPO_ENABLED else "false").lower().strip()
    in ("true", "1", "on")
)

from formats.xrlf_parser import XRLFParser
from formats.xrlf_schema import SectionType
from llama_bridge.llama_engine import LlamaEngine
from memory.membrane_engine import MembraneEngine
from runtime.cognitive_steering import (
    ProfileSelector,
    ClusterActivator,
    GraphTraverser,
    PrincipiaApplicator,
)
from tools.mm_hooks import MMHookRegistry


class XRLFRuntime:
    """
    Full XRLF runtime: parses the file, drives llama.cpp,
    applies XRL cognitive steering, weaves foveated memory.
    """

    def __init__(
        self,
        xrlf_path: str,
        session_id: str = "default",
        n_gpu_layers: int = -1,
        n_ctx: int = 8192,
        persistent_memory: bool = True,
        verbose: bool = False,
    ):
        self.xrlf_path = str(xrlf_path)
        self.session_id = session_id
        self.n_gpu_layers = n_gpu_layers
        self.n_ctx = n_ctx
        self.persistent_memory = persistent_memory
        self.verbose = verbose

        # Runtime objects (initialized in load())
        self._parser: Optional[XRLFParser] = None
        self._llama: Optional[LlamaEngine] = None
        self._memory: Optional[MembraneEngine] = None
        self._profile_sel: Optional[ProfileSelector] = None
        self._cluster_act: Optional[ClusterActivator] = None
        self._graph_trav: Optional[GraphTraverser] = None
        self._principia: Optional[PrincipiaApplicator] = None

        # Temp dir for extracted artifacts
        self._tmpdir: Optional[str] = None
        self._gguf_path: Optional[str] = None
        self._mmproj_path: Optional[str] = None
        self._draft_gguf_path: Optional[str] = None
        self._memory_db_path: Optional[str] = None

        # Runtime state
        self.loaded = False
        self.model_name = ""
        self._mm_hooks: Dict = {}
        self._mm_registry: Optional[MMHookRegistry] = None
        self._memory_schema: Dict = {}

    # ── Load ──────────────────────────────────────────────────────────────────

    def load(self) -> "XRLFRuntime":
        print("\n" + "=" * 60)
        print("  XRLF RUNTIME — Loading")
        print("=" * 60)

        # 1. Parse XRLF file
        self._parser = XRLFParser.open(self.xrlf_path)
        hdr = self._parser.manifest.header
        self.model_name = hdr.base_model_name
        print(f"\n{self._parser.manifest.summary()}\n")

        # 2. Set up temp workspace
        self._tmpdir = tempfile.mkdtemp(prefix="xrlf_")

        # 3. Extract GGUF core
        if self._parser.has_section(SectionType.CORE_GGUF):
            self._gguf_path = self._parser.extract_gguf(
                os.path.join(self._tmpdir, "core.gguf")
            )
        else:
            print("  ⚠️  No CORE_GGUF section — running in XRL-only mode (no llama.cpp)")

        # 3.5. Extract MMPROJ
        if self._parser.has_section(SectionType.CORE_MMPROJ):
            self._mmproj_path = self._parser.extract_mmproj(
                os.path.join(self._tmpdir, "mmproj.gguf")
            )

        # 3.7. Extract DRAFT GGUF
        if self._parser.has_section(SectionType.CORE_DRAFT_GGUF):
            self._draft_gguf_path = self._parser.extract_draft_gguf(
                os.path.join(self._tmpdir, "draft.gguf")
            )


        # 4. Extract embedded memory
        if self._parser.has_section(SectionType.XRL_MEMORY_DATA):
            self._memory_db_path = self._parser.extract_memory_db(
                os.path.join(self._tmpdir, "memory.db")
            )
        else:
            self._memory_db_path = os.path.join(self._tmpdir, "memory.db")
            print("  ⚠️  No embedded memory — starting fresh memory store")

        # 5. Load XRL cognitive artifacts
        self._load_xrl_layers()

        # 6. Load memory schema & hooks
        if self._parser.has_section(SectionType.XRL_MEMORY_SCHEMA):
            self._memory_schema = self._parser.get_memory_schema()
        if self._parser.has_section(SectionType.XRL_MM_HOOKS):
            self._mm_hooks = self._parser.get_mm_hooks()
        self._mm_registry = MMHookRegistry(self._mm_hooks) if self._mm_hooks else None

        # 7. Start llama engine
        if self._gguf_path:
            self._llama = LlamaEngine(
                gguf_path=self._gguf_path,
                n_gpu_layers=self.n_gpu_layers,
                n_ctx=self.n_ctx,
                verbose=self.verbose,
                flash_attn=True,
                mmproj_path=self._mmproj_path,
                draft_model_path=self._draft_gguf_path,
            ).load()

        # 8. Start memory engine
        token_budget = self._memory_schema.get("token_budget", 2048)
        ring_config = self._memory_schema.get("ring_config")
        self._memory = MembraneEngine(
            db_path=self._memory_db_path,
            session_id=self.session_id,
            token_budget=token_budget,
            ring_config=ring_config,
        ).load()

        self.loaded = True
        print("\n  ✅ XRLF Runtime ready\n")
        return self

    def _load_xrl_layers(self):
        """Load all XRL cognitive sections into Python objects."""
        p = self._parser

        profiles_data = (
            p.get_section_json(SectionType.XRL_PROFILES)
            if p.has_section(SectionType.XRL_PROFILES) else {}
        )
        clusters_data = (
            p.get_section_json(SectionType.XRL_CLUSTERS)
            if p.has_section(SectionType.XRL_CLUSTERS) else {}
        )
        graph_data = (
            p.get_section_json(SectionType.XRL_GRAPH)
            if p.has_section(SectionType.XRL_GRAPH) else {}
        )
        principles_data = (
            p.get_section_json(SectionType.XRL_PRINCIPLES)
            if p.has_section(SectionType.XRL_PRINCIPLES) else []
        )

        self._profile_sel  = ProfileSelector(profiles_data)
        self._cluster_act  = ClusterActivator(clusters_data)
        self._graph_trav   = GraphTraverser(graph_data)
        self._principia    = PrincipiaApplicator(principles_data)
        print("  XRL cognitive layers loaded (profiles, clusters, graph, principles)")

    # ── Chat ──────────────────────────────────────────────────────────────────

    def chat(
        self,
        messages: List[Dict[str, Any]],
        max_tokens: int = 1024,
        temperature: Optional[float] = None,
        stream: bool = False,
        has_image: bool = False,
        has_audio: bool = False,
        has_video: bool = False,
        force_profile: Optional[str] = None,
    ) -> Union[str, Generator[str, None, None]]:
        """
        Main generation entry point.
        messages: OpenAI-format [{"role": ..., "content": ...}]

        Gemma-4 native multimodal: set has_image/has_audio/has_video=True
        to steer to the right cognitive profile. The content can include
        base64 image URLs or audio tokens directly (passed to llama.cpp).
        """
        self._require_loaded()

        # Extract the last user message for cognitive steering
        user_msg = ""
        for m in reversed(messages):
            if m.get("role") == "user":
                content = m.get("content", "")
                if isinstance(content, str):
                    user_msg = content
                elif isinstance(content, list):
                    # multimodal content list — extract text parts
                    user_msg = " ".join(
                        part.get("text", "") for part in content
                        if isinstance(part, dict) and part.get("type") == "text"
                    )
                break

        # ── Reactor Cold Passthrough ──────────────────────────────────────────
        # When XRLF_REPO_ENABLED is false, bypass all XRL cognitive steering,
        # foveated memory injection, and system-prompt overrides.
        if not XRLF_REPO_ENABLED:
            if self.verbose:
                print("  [XRLF] REACTOR COLD — passthrough (no steering)")
            temp = temperature if temperature is not None else 0.7
            if self._llama is None:
                response = "[XRLF stub — no GGUF core loaded] Reactor COLD passthrough."
            elif stream:
                return self._stream_and_store(messages, user_msg, max_tokens, temp, "cold")
            else:
                response = self._llama.chat(messages, max_tokens=max_tokens, temperature=temp)
            if self._memory and XRLF_FOVEATION_OVERRIDE:
                self._memory.store_turn("user", user_msg)
                self._memory.store_turn("assistant", response)
            return response

        # ── XRL Cognitive Steering (only when reactor is HOT) ─────────────────

        profile_name, profile_cfg = self._profile_sel.select(
            user_msg,
            has_image=has_image,
            has_audio=has_audio,
            has_video=has_video,
            force_profile=force_profile,
        )

        if XRLF_CAPABILITY_OVERRIDE:
            activated_clusters = self._cluster_act.activate(user_msg)
            graph_concepts = self._graph_trav.enrich(user_msg)
            system_prefix = self._principia.build_system_prefix(
                profile_config=profile_cfg,
                activated_clusters=activated_clusters,
                graph_concepts=graph_concepts,
            )
        else:
            activated_clusters = []
            graph_concepts = []
            system_prefix = ""

        if XRLF_FOVEATION_OVERRIDE:
            memory_block = self._memory.weave_context(user_msg)
        else:
            memory_block = ""

        # ── Assemble steered messages ─────────────────────────────────────────

        if system_prefix or memory_block:
            steered_messages = _inject_system(messages, system_prefix, memory_block)
        else:
            steered_messages = list(messages)

        if self.verbose:
            print(f"  [XRL] profile={profile_name}  clusters={activated_clusters}")
            print(f"  [XRL] graph_concepts={graph_concepts}")

        # ── Generate ──────────────────────────────────────────────────────────

        temp = temperature if temperature is not None else profile_cfg.get("temperature", 0.7)

        if self._llama is None:
            # Stub response when no GGUF is loaded
            response = f"[XRLF stub — no GGUF core loaded] Profile: {profile_name}. Memory: {'yes' if memory_block else 'no'}."
        elif stream:
            return self._stream_and_store(
                steered_messages, user_msg, max_tokens, temp, profile_name
            )
        else:
            response = self._llama.chat(steered_messages, max_tokens=max_tokens, temperature=temp)

        # Store turn
        if self._memory:
            self._memory.store_turn("user", user_msg)
            self._memory.store_turn("assistant", response)

        return response

    def _stream_and_store(
        self,
        messages, user_msg, max_tokens, temperature, profile_name
    ) -> Generator[str, None, None]:
        full_response = []
        for chunk in self._llama.chat(messages, max_tokens=max_tokens, temperature=temperature, stream=True):
            full_response.append(chunk)
            yield chunk
        response = "".join(full_response)
        self._memory.store_turn("user", user_msg)
        self._memory.store_turn("assistant", response)

    def generate(
        self,
        prompt: str,
        max_tokens: int = 512,
        temperature: float = 0.7,
    ) -> str:
        """Raw text completion (no chat template)."""
        self._require_loaded()
        if self._llama is None:
            return "[XRLF stub — no GGUF core]"
        return self._llama.generate(prompt, max_tokens=max_tokens, temperature=temperature)

    # ── Close ─────────────────────────────────────────────────────────────────

    def close(self, repack_memory: bool = True):
        """
        Shutdown runtime. If persistent_memory=True and repack_memory=True,
        re-packs updated memory back into the .xrlf file.
        """
        if self._memory:
            if self.persistent_memory and repack_memory:
                self._repack_memory()
            self._memory.close()

        if self._llama:
            self._llama.unload()

        if self._parser:
            self._parser.close()

        if self._tmpdir and os.path.exists(self._tmpdir):
            shutil.rmtree(self._tmpdir, ignore_errors=True)

        self.loaded = False
        print("  XRLF Runtime closed.")

    def _repack_memory(self):
        """Re-pack updated memory data back into the .xrlf file in-place."""
        try:
            new_memory_bytes = self._memory.get_serializable_snapshot()
            _rewrite_section(self.xrlf_path, SectionType.XRL_MEMORY_DATA, new_memory_bytes)
            print("  Memory re-packed into XRLF file.")
        except Exception as e:
            print(f"  ⚠️  Memory re-pack failed (non-fatal): {e}")

    def __enter__(self):
        return self.load()

    def __exit__(self, *_):
        self.close()

    def _require_loaded(self):
        if not self.loaded:
            raise RuntimeError("XRLFRuntime not loaded — call .load() first")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _inject_system(
    messages: List[Dict],
    system_prefix: str,
    memory_block: str,
) -> List[Dict]:
    """
    Inject the XRL system prefix and memory block into the message list.
    Finds an existing system message or prepends a new one.
    """
    steered = list(messages)
    combined_system = "\n\n".join(filter(None, [memory_block, system_prefix]))
    if not combined_system:
        return steered

    # Update existing system message or prepend
    for i, m in enumerate(steered):
        if m.get("role") == "system":
            existing = m.get("content", "")
            steered[i] = {"role": "system", "content": combined_system + "\n\n" + existing}
            return steered

    steered.insert(0, {"role": "system", "content": combined_system})
    return steered


def _rewrite_section(xrlf_path: str, section_type: SectionType, new_payload: bytes):
    """
    In-place update of a section payload in the .xrlf file.
    Only safe when the new payload is the same size as the old one,
    otherwise rewrites the whole file (rare operation).
    """
    from formats.xrlf_parser import XRLFParser
    from formats.xrlf_packer import XRLFPacker
    import struct

    with XRLFParser.open(xrlf_path) as p:
        entry = p.manifest.section(section_type)
        if entry is None:
            return

        if len(new_payload) == entry.length:
            # Same size — patch in place
            with open(xrlf_path, "r+b") as f:
                f.seek(entry.offset)
                f.write(new_payload)
        else:
            # Different size — full rewrite (happens rarely, only when memory grows)
            _full_rewrite_with_section(xrlf_path, p, section_type, new_payload)


def _full_rewrite_with_section(xrlf_path, parser, target_type, new_payload):
    """Rebuild the .xrlf with one section replaced."""
    import tempfile, shutil
    from formats.xrlf_schema import (
        HEADER_STRUCT, SECTION_ENTRY_STRUCT,
        MAGIC, FORMAT_VERSION,
    )
    from formats.xrlf_parser import XRLFParser

    tmp = xrlf_path + ".tmp"
    hdr = parser.manifest.header
    base_bytes = hdr.base_model_name.encode()
    xrl_bytes = hdr.xrl_source_model.encode()
    sections = parser.manifest.sections

    section_count = len(sections)
    payload_start = (
        HEADER_STRUCT.size
        + len(base_bytes) + len(xrl_bytes)
        + section_count * SECTION_ENTRY_STRUCT.size
    )

    entries = []
    payloads = []
    cursor = payload_start
    for s in sections:
        if s.section_type == target_type:
            data = new_payload
        else:
            data = parser.get_section_bytes(s.section_type)
        entries.append((s.section_type, cursor, len(data), s.flags))
        payloads.append(data)
        cursor += len(data)

    with open(tmp, "wb") as f:
        f.write(HEADER_STRUCT.pack(MAGIC, FORMAT_VERSION, len(base_bytes), len(xrl_bytes),
                                   hdr.flags, section_count, b"\x00"*6))
        f.write(base_bytes)
        f.write(xrl_bytes)
        for stype, offset, length, sflags in entries:
            f.write(SECTION_ENTRY_STRUCT.pack(int(stype), offset, length, sflags))
        for data in payloads:
            f.write(data)

    shutil.move(tmp, xrlf_path)
