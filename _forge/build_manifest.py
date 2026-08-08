#!/usr/bin/env python3
"""
_forge/build_manifest.py — Generate a file manifest for the .xrlf format.
Reads the .xrlf header + section table, computes per-section SHA-256 hashes
(fast — kilobytes, not gigabytes), and prints/outputs a manifest table.

Usage:
    python _forge/build_manifest.py
    python _forge/build_manifest.py --xrlf gemma-4-12b-xrl.xrlf
    python _forge/build_manifest.py --full-sha    # slow: hashes entire 4.7GB file
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

# Ensure project root is on path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from formats.xrlf_parser import XRLFParser
from formats.xrlf_schema import SECTION_NAMES, SectionType, XRLFFlags


def _format_bytes(n: int) -> str:
    if n >= 1e9:
        return f"{n / 1e9:.2f} GB"
    if n >= 1e6:
        return f"{n / 1e6:.2f} MB"
    if n >= 1e3:
        return f"{n / 1e3:.2f} KB"
    return f"{n} B"


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file_range(filepath: str, offset: int, length: int, chunk_size: int = 65536) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        f.seek(offset)
        remaining = length
        while remaining > 0:
            read_size = min(chunk_size, remaining)
            chunk = f.read(read_size)
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


def _full_file_sha256(filepath: str, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def generate_manifest(xrlf_path: str, full_sha: bool = False) -> dict:
    """Generate a complete manifest dict for the .xrlf file."""
    path = Path(xrlf_path)
    if not path.exists():
        raise FileNotFoundError(f"XRLF file not found: {xrlf_path}")

    file_size = path.stat().st_size

    with XRLFParser.open(str(path)) as parser:
        manifest = parser.manifest
        header = manifest.header

        sections = []
        for entry in manifest.sections:
            sha = _sha256_file_range(str(path), entry.offset, entry.length)
            sections.append({
                "type": entry.section_type,
                "name": SECTION_NAMES.get(entry.section_type, f"UNKNOWN(0x{entry.section_type:02x})"),
                "offset": entry.offset,
                "length": entry.length,
                "size_human": _format_bytes(entry.length),
                "flags": entry.flags,
                "sha256": sha,
            })

        full_file_sha = None
        if full_sha:
            print("  Computing full-file SHA-256 (may take a minute for ~5 GB)...")
            full_file_sha = _full_file_sha256(str(path))

    result = {
        "file": str(path.name),
        "file_path": str(path.resolve()),
        "file_size": file_size,
        "file_size_human": _format_bytes(file_size),
        "format_version": header.version,
        "base_model_name": header.base_model_name,
        "xrl_source_model": header.xrl_source_model,
        "flags": header.flags,
        "flags_human": _decode_flags(header.flags),
        "section_count": header.section_count,
        "sections": sections,
        "full_file_sha256": full_file_sha,
    }
    return result


def _decode_flags(flags: int) -> list:
    result = []
    for f in XRLFFlags:
        if flags & f:
            result.append(f.name)
    return result


def print_manifest_table(manifest: dict):
    """Print a human-readable manifest table."""
    print("\n" + "=" * 80)
    print("  XRLF FILE MANIFEST")
    print("=" * 80)
    print(f"  File            : {manifest['file']}")
    print(f"  Size            : {manifest['file_size_human']}")
    print(f"  Format version  : {manifest['format_version']}")
    print(f"  Core model      : {manifest['base_model_name']}")
    print(f"  XRL source      : {manifest['xrl_source_model']}")
    print(f"  Flags           : {', '.join(manifest['flags_human'])}")
    print(f"  Sections        : {manifest['section_count']}")
    if manifest.get('full_file_sha256'):
        print(f"  Full SHA-256    : {manifest['full_file_sha256']}")
    print()
    print(f"  {'#':<4} {'Section':<22} {'Size':<12} {'Flags':<8} {'SHA-256 (first 16 chars)'}")
    print(f"  {'-'*4} {'-'*22} {'-'*12} {'-'*8} {'-'*20}")
    for i, s in enumerate(manifest['sections']):
        sha_short = s['sha256'][:16] + "..."
        print(f"  {i:<4} {s['name']:<22} {s['size_human']:<12} 0x{s['flags']:02x}     {sha_short}")
    print("=" * 80)


def save_manifest_json(manifest: dict, output_path: str = None):
    """Save manifest as JSON."""
    if output_path is None:
        output_path = str(Path(manifest['file_path']).with_suffix('.manifest.json'))
    with open(output_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f"\n  Manifest saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Generate XRLF file manifest")
    parser.add_argument("--xrlf", default=str(ROOT / "gemma-4-12b-xrl.xrlf"),
                        help="Path to .xrlf file (default: gemma-4-12b-xrl.xrlf)")
    parser.add_argument("--full-sha", action="store_true",
                        help="Compute full-file SHA-256 (slow for ~5 GB files)")
    parser.add_argument("--json", action="store_true",
                        help="Save manifest as JSON file")
    parser.add_argument("--output", help="Output JSON path (with --json)")
    args = parser.parse_args()

    if not Path(args.xrlf).exists():
        print(f"  ❌ XRLF file not found: {args.xrlf}")
        print(f"     Run 'python run_xrlf.py --pack' first to create the .xrlf file.")
        sys.exit(1)

    manifest = generate_manifest(args.xrlf, full_sha=args.full_sha)
    print_manifest_table(manifest)

    if args.json:
        save_manifest_json(manifest, args.output)


if __name__ == "__main__":
    main()