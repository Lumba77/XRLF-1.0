"""
formats/xrlf_schema.py — XRLF Binary Format Schema
====================================================
XRLF is a single-file hybrid model format:
  [4B magic] [header] [section table] [section payloads...]

Gemma-4-12B-it-qat-GGUF-MoQ is the default neural core.
It natively handles: text, image, video, audio/speech INPUT.
Only TTS (text→voice) requires an external hook.

Section layout
--------------
  CORE_GGUF         Raw Gemma-4 GGUF bytes
  XRL_PRINCIPLES    Distilled reasoning principia (msgpack)
  XRL_GRAPH         Semantic graph nodes+edges (msgpack)
  XRL_CLUSTERS      Cognitive clusters (msgpack)
  XRL_PROFILES      Task profiles: chat/code/vision/reasoning (msgpack)
  XRL_EXPANSION     Expansion rules (msgpack)
  XRL_MM_HOOKS      Multimodal hook descriptors — TTS only for Gemma-4 (JSON)
  XRL_MEMORY_DATA   Embedded foveated memory: SQLite db bytes + TF-IDF index
  XRL_MEMORY_SCHEMA Memory retrieval policy & 6-ring config (JSON)
  RUNTIME_META      Build info, version, capability flags (JSON)
"""

import struct
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Dict, List, Optional

# ── Constants ────────────────────────────────────────────────────────────────

MAGIC = b"XRLF"
FORMAT_VERSION = 1

# Header layout (fixed, little-endian)
# magic(4s) version(H) base_model_len(H) xrl_source_len(H) flags(I) section_count(H) reserved(6s)
HEADER_STRUCT = struct.Struct("<4sHHHIH6s")
HEADER_SIZE = HEADER_STRUCT.size  # 22 bytes

SECTION_ENTRY_STRUCT = struct.Struct("<HQQH")  # type(H) offset(Q) length(Q) flags(H)
SECTION_ENTRY_SIZE = SECTION_ENTRY_STRUCT.size  # 22 bytes


# ── Flags bitfield ────────────────────────────────────────────────────────────

class XRLFFlags(IntEnum):
    HAS_CORE_GGUF       = 1 << 0
    IS_MULTIMODAL       = 1 << 1   # native vision/audio in core model
    HAS_MM_HOOKS        = 1 << 2   # external tool hooks (TTS etc.)
    HAS_EMBEDDED_MEMORY = 1 << 3   # foveated memory embedded
    HAS_MEMORY_SCHEMA   = 1 << 4
    MEMORY_PERSISTENT   = 1 << 5   # memory updates re-packed on session end
    CORE_IS_GGUF_MoQ    = 1 << 6   # MoQ (Mixed-Quantization) core
    STT_NATIVE          = 1 << 7   # core model handles speech-to-text natively
    VISION_NATIVE       = 1 << 8   # core model handles image/video natively
    HAS_MMPROJ          = 1 << 9   # embedded multimodal projector
    HAS_DRAFT_GGUF      = 1 << 10  # embedded speculative decoding draft model


# Default flags for Gemma-4-12B-MoQ (all native multimodal input)
GEMMA4_DEFAULT_FLAGS = (
    XRLFFlags.HAS_CORE_GGUF
    | XRLFFlags.IS_MULTIMODAL
    | XRLFFlags.HAS_MM_HOOKS
    | XRLFFlags.HAS_EMBEDDED_MEMORY
    | XRLFFlags.HAS_MEMORY_SCHEMA
    | XRLFFlags.MEMORY_PERSISTENT
    | XRLFFlags.CORE_IS_GGUF_MoQ
    | XRLFFlags.STT_NATIVE
    | XRLFFlags.VISION_NATIVE
)


# ── Section types ─────────────────────────────────────────────────────────────

class SectionType(IntEnum):
    CORE_GGUF        = 0x01   # Raw GGUF bytes of the neural core
    XRL_PRINCIPLES   = 0x02   # Distilled reasoning principia
    XRL_GRAPH        = 0x03   # Semantic concept graph
    XRL_CLUSTERS     = 0x04   # Cognitive cluster definitions
    XRL_PROFILES     = 0x05   # Task profiles (chat/code/vision/reasoning)
    XRL_EXPANSION    = 0x06   # Expansion rules
    XRL_MM_HOOKS     = 0x07   # Multimodal hook descriptors (TTS for Gemma-4)
    XRL_MEMORY_DATA  = 0x08   # Embedded foveated memory (SQLite + TF-IDF)
    XRL_MEMORY_SCHEMA= 0x09   # Memory retrieval policy & 6-ring config
    RUNTIME_META     = 0x0A   # Build info, flags, capability map
    CORE_MMPROJ      = 0x0B   # Raw GGUF bytes of the multimodal projector
    CORE_DRAFT_GGUF  = 0x0C   # Raw GGUF bytes of the speculative decoding draft model

SECTION_NAMES: Dict[int, str] = {t.value: t.name for t in SectionType}


# Section-level flags
class SectionFlags(IntEnum):
    NONE        = 0
    COMPRESSED  = 1 << 0   # payload is msgpack-compressed
    ENCRYPTED   = 1 << 1   # reserved for future encryption
    OPTIONAL    = 1 << 2   # runtime can continue without this section


# ── Dataclasses ───────────────────────────────────────────────────────────────

@dataclass
class XRLFHeader:
    """Parsed XRLF file header."""
    magic: bytes           = MAGIC
    version: int           = FORMAT_VERSION
    base_model_name: str   = ""   # e.g. "gemma-4-12b-it-qat-GGUF-MoQ"
    xrl_source_model: str  = ""   # e.g. "claude-sonnet-4" or "qwen3.5-4b"
    flags: int             = int(GEMMA4_DEFAULT_FLAGS)
    section_count: int     = 0

    def has_flag(self, flag: XRLFFlags) -> bool:
        return bool(self.flags & flag)

    def native_vision(self) -> bool:
        return self.has_flag(XRLFFlags.VISION_NATIVE)

    def native_stt(self) -> bool:
        return self.has_flag(XRLFFlags.STT_NATIVE)

    def embedded_memory(self) -> bool:
        return self.has_flag(XRLFFlags.HAS_EMBEDDED_MEMORY)


@dataclass
class SectionEntry:
    """One entry in the XRLF section table."""
    section_type: SectionType
    offset: int    = 0
    length: int    = 0
    flags: int     = int(SectionFlags.NONE)

    @property
    def name(self) -> str:
        return SECTION_NAMES.get(self.section_type, f"UNKNOWN(0x{self.section_type:02x})")

    @property
    def compressed(self) -> bool:
        return bool(self.flags & SectionFlags.COMPRESSED)


@dataclass
class XRLFManifest:
    """Full parsed manifest of an XRLF file."""
    header: XRLFHeader
    sections: List[SectionEntry] = field(default_factory=list)
    file_size: int = 0

    def section(self, section_type: SectionType) -> Optional[SectionEntry]:
        for s in self.sections:
            if s.section_type == section_type:
                return s
        return None

    def summary(self) -> str:
        lines = [
            f"XRLF v{self.header.version}",
            f"  Core model   : {self.header.base_model_name}",
            f"  XRL source   : {self.header.xrl_source_model}",
            f"  Sections     : {self.header.section_count}",
            f"  Native vision: {self.header.native_vision()}",
            f"  Native STT   : {self.header.native_stt()}",
            f"  Memory embed : {self.header.embedded_memory()}",
            f"  File size    : {self.file_size / 1e9:.2f} GB",
        ]
        for s in self.sections:
            lines.append(f"    [{s.name:20s}] {s.length / 1e6:8.2f} MB  flags=0x{s.flags:02x}")
        return "\n".join(lines)


# ── Multimodal capability map for Gemma-4 ────────────────────────────────────

GEMMA4_CAPABILITY_MAP = {
    "input": {
        "text":   {"native": True,  "hook": None},
        "image":  {"native": True,  "hook": None},   # mmproj built into GGUF
        "video":  {"native": True,  "hook": None},   # temporal vision
        "audio":  {"native": True,  "hook": None},   # speech/audio understanding
    },
    "output": {
        "text":   {"native": True,  "hook": None},
        "speech": {"native": False, "hook": "tts"},  # only external dep needed
        "image":  {"native": False, "hook": "image_gen"},   # optional diffusion
        "audio":  {"native": False, "hook": "audio_gen"},   # optional music gen
    },
}
