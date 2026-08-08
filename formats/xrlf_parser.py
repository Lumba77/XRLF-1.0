"""
formats/xrlf_parser.py — XRLF Binary File Parser
==================================================
Reads an XRLF file, validates the header, parses the section table,
and provides methods to extract section payloads.

Usage:
    parser = XRLFParser.open("gemma-4-12b-xrl.xrlf")
    print(parser.manifest.summary())
    gguf_path = parser.extract_gguf("tmp/core.gguf")
    memory_db_path = parser.extract_memory_db("tmp/memory.db")
    principles = parser.get_section_json(SectionType.XRL_PRINCIPLES)
"""

import json
import mmap
import os
import shutil
import struct
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import msgpack
    _MSGPACK = True
except ImportError:
    _MSGPACK = False

from formats.xrlf_schema import (
    HEADER_STRUCT, HEADER_SIZE,
    SECTION_ENTRY_STRUCT, SECTION_ENTRY_SIZE,
    MAGIC, FORMAT_VERSION,
    XRLFHeader, SectionEntry, XRLFManifest, SectionType, SectionFlags,
)


class XRLFParseError(Exception):
    pass


class XRLFParser:
    """
    Memory-mapped XRLF reader.
    Open once; extract sections on demand — no full-file load into RAM.
    The large CORE_GGUF section is streamed directly to disk.
    """

    def __init__(self, path: str):
        self.path = Path(path)
        self._file = None
        self._mm: Optional[mmap.mmap] = None
        self.manifest: Optional[XRLFManifest] = None
        self._section_map: Dict[SectionType, SectionEntry] = {}
        self._data_offset: int = 0   # byte offset where section payloads start

    # ── Open / close ─────────────────────────────────────────────────────────

    @classmethod
    def open(cls, path: str) -> "XRLFParser":
        parser = cls(path)
        parser._open()
        return parser

    def _open(self):
        if not self.path.exists():
            raise FileNotFoundError(f"XRLF file not found: {self.path}")
        self._file = open(self.path, "rb")
        self._mm = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)
        self._parse_header()
        self._parse_section_table()

    def close(self):
        if self._mm:
            self._mm.close()
        if self._file:
            self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ── Header parsing ────────────────────────────────────────────────────────

    def _parse_header(self):
        raw = self._mm[:HEADER_SIZE]
        if len(raw) < HEADER_SIZE:
            raise XRLFParseError("File too small to be a valid XRLF file")

        magic, version, base_len, xrl_len, flags, section_count, _ = HEADER_STRUCT.unpack(raw)

        if magic != MAGIC:
            raise XRLFParseError(f"Invalid magic bytes: {magic!r} (expected {MAGIC!r})")
        if version != FORMAT_VERSION:
            raise XRLFParseError(f"Unsupported XRLF version: {version}")

        # Read variable-length model name strings immediately after header
        cursor = HEADER_SIZE
        base_model_name = self._mm[cursor: cursor + base_len].decode("utf-8")
        cursor += base_len
        xrl_source_model = self._mm[cursor: cursor + xrl_len].decode("utf-8")
        cursor += xrl_len

        header = XRLFHeader(
            magic=magic,
            version=version,
            base_model_name=base_model_name,
            xrl_source_model=xrl_source_model,
            flags=flags,
            section_count=section_count,
        )

        # Section table starts right after the name strings
        self._section_table_offset = cursor
        self.manifest = XRLFManifest(header=header, file_size=len(self._mm))

    # ── Section table parsing ─────────────────────────────────────────────────

    def _parse_section_table(self):
        cursor = self._section_table_offset
        count = self.manifest.header.section_count

        for _ in range(count):
            raw = self._mm[cursor: cursor + SECTION_ENTRY_SIZE]
            if len(raw) < SECTION_ENTRY_SIZE:
                raise XRLFParseError("Section table truncated")
            stype, offset, length, sflags = SECTION_ENTRY_STRUCT.unpack(raw)
            entry = SectionEntry(
                section_type=SectionType(stype),
                offset=offset,
                length=length,
                flags=sflags,
            )
            self.manifest.sections.append(entry)
            self._section_map[SectionType(stype)] = entry
            cursor += SECTION_ENTRY_SIZE

    # ── Section access ────────────────────────────────────────────────────────

    def _raw_bytes(self, section_type: SectionType) -> bytes:
        entry = self._section_map.get(section_type)
        if entry is None:
            raise XRLFParseError(f"Section {section_type.name} not present in file")
        return bytes(self._mm[entry.offset: entry.offset + entry.length])

    def _decompress(self, section_type: SectionType, raw: bytes) -> bytes:
        entry = self._section_map[section_type]
        if entry.compressed and _MSGPACK:
            return msgpack.unpackb(raw, raw=False)
        return raw

    def get_section_bytes(self, section_type: SectionType) -> bytes:
        """Return raw (possibly compressed) section payload."""
        return self._raw_bytes(section_type)

    def get_section_json(self, section_type: SectionType) -> Any:
        """Decode section as JSON or msgpack → Python object."""
        raw = self._raw_bytes(section_type)
        entry = self._section_map[section_type]
        if entry.compressed and _MSGPACK:
            return msgpack.unpackb(raw, raw=False)
        return json.loads(raw.decode("utf-8"))

    def has_section(self, section_type: SectionType) -> bool:
        return section_type in self._section_map

    # ── Extraction helpers ────────────────────────────────────────────────────

    def extract_gguf(self, dest_path: str, show_progress: bool = True) -> str:
        """
        Stream the CORE_GGUF section to a file on disk.
        Returns the dest_path. Uses chunked copy to avoid RAM pressure.
        """
        entry = self._section_map.get(SectionType.CORE_GGUF)
        if entry is None:
            raise XRLFParseError("No CORE_GGUF section in this XRLF file")

        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)

        chunk = 64 * 1024 * 1024  # 64 MB
        written = 0
        total = entry.length

        with open(dest, "wb") as out:
            pos = entry.offset
            while pos < entry.offset + total:
                end = min(pos + chunk, entry.offset + total)
                out.write(self._mm[pos:end])
                written += (end - pos)
                pos = end
                if show_progress:
                    pct = 100 * written / total
                    print(f"\r  Extracting GGUF core... {pct:.1f}%", end="", flush=True)

        if show_progress:
            print(f"\r  Extracted GGUF core → {dest}  ({written / 1e9:.2f} GB)")
        return str(dest)

    def extract_mmproj(self, dest_path: str, show_progress: bool = True) -> str:
        """
        Stream the CORE_MMPROJ section to a file on disk.
        Returns the dest_path. Uses chunked copy to avoid RAM pressure.
        """
        entry = self._section_map.get(SectionType.CORE_MMPROJ)
        if entry is None:
            raise XRLFParseError("No CORE_MMPROJ section in this XRLF file")

        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)

        chunk = 64 * 1024 * 1024  # 64 MB
        written = 0
        total = entry.length

        with open(dest, "wb") as out:
            pos = entry.offset
            while pos < entry.offset + total:
                end = min(pos + chunk, entry.offset + total)
                out.write(self._mm[pos:end])
                written += (end - pos)
                pos = end
                if show_progress:
                    pct = 100 * written / total
                    print(f"\r  Extracting MMPROJ... {pct:.1f}%", end="", flush=True)

        if show_progress:
            print(f"\r  Extracted MMPROJ → {dest}  ({written / 1e6:.2f} MB)")
        return str(dest)

    def extract_draft_gguf(self, dest_path: str, show_progress: bool = True) -> str:
        """
        Stream the CORE_DRAFT_GGUF section to a file on disk.
        Returns the dest_path.
        """
        entry = self._section_map.get(SectionType.CORE_DRAFT_GGUF)
        if entry is None:
            raise XRLFParseError("No CORE_DRAFT_GGUF section in this XRLF file")

        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)

        chunk = 64 * 1024 * 1024  # 64 MB
        written = 0
        total = entry.length

        with open(dest, "wb") as out:
            pos = entry.offset
            while pos < entry.offset + total:
                end = min(pos + chunk, entry.offset + total)
                out.write(self._mm[pos:end])
                written += (end - pos)
                pos = end
                if show_progress:
                    pct = 100 * written / total
                    print(f"\r  Extracting DRAFT GGUF... {pct:.1f}%", end="", flush=True)

        if show_progress:
            print(f"\r  Extracted DRAFT GGUF → {dest}  ({written / 1e6:.2f} MB)")
        return str(dest)

    def extract_memory_db(self, dest_path: str) -> str:
        """Extract the embedded SQLite memory store to a file."""
        raw = self._raw_bytes(SectionType.XRL_MEMORY_DATA)
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        # Memory data is packed as: [4B sqlite_len][sqlite bytes][rest = tfidf index]
        sqlite_len = struct.unpack_from("<I", raw, 0)[0]
        sqlite_bytes = raw[4: 4 + sqlite_len]
        dest.write_bytes(sqlite_bytes)
        print(f"  Extracted memory DB → {dest}  ({len(sqlite_bytes)} bytes)")
        return str(dest)

    def extract_tfidf_index(self, dest_path: str) -> str:
        """Extract the embedded TF-IDF index blob."""
        raw = self._raw_bytes(SectionType.XRL_MEMORY_DATA)
        sqlite_len = struct.unpack_from("<I", raw, 0)[0]
        tfidf_bytes = raw[4 + sqlite_len:]
        dest = Path(dest_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(tfidf_bytes)
        print(f"  Extracted TF-IDF index → {dest}  ({len(tfidf_bytes)} bytes)")
        return str(dest)

    def get_memory_schema(self) -> Dict:
        """Return the memory retrieval policy and ring config."""
        return self.get_section_json(SectionType.XRL_MEMORY_SCHEMA)

    def get_mm_hooks(self) -> Dict:
        """Return the multimodal hook descriptors."""
        return self.get_section_json(SectionType.XRL_MM_HOOKS)

    def get_runtime_meta(self) -> Dict:
        """Return build info and capability map."""
        return self.get_section_json(SectionType.RUNTIME_META)
