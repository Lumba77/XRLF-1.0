"""
builder/packer/pack_xrlf.py — XRLF CLI Packer
==============================================
Produces a .xrlf file from a GGUF model + XRL JSON artifacts + optional memory DB.

Usage:
    python builder/packer/pack_xrlf.py ^
        --core-gguf "path/to/Gemma-4-12B-MoQ.gguf" ^
        --xrl-dir xrl_encoded/ ^
        --memory-db foveated-memory/memory_data/default/memory.db ^
        --output gemma-4-12b-xrl.xrlf

    # Dry run (no file written):
    python builder/packer/pack_xrlf.py --core-gguf ... --dry-run

Run from the xrlf-model/ root directory.
"""

import argparse
import os
import sys
import time

# Allow running from project root
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from formats.xrlf_packer import XRLFPacker


def main():
    parser = argparse.ArgumentParser(
        description="Pack a .xrlf hybrid model file from a GGUF core + XRL artifacts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--core-gguf", required=False,
        default=None,
        help="Path to the Gemma-4-12B MoQ GGUF file (the neural core). "
             "If omitted, a GGUF-free XRLF stub is produced (for testing).",
    )
    parser.add_argument(
        "--xrl-dir", default="xrl_encoded",
        help="Directory containing XRL JSON artifacts (default: xrl_encoded/)",
    )
    parser.add_argument(
        "--mmproj", default=None,
        help="Path to the Multimodal Projector GGUF file (optional).",
    )
    parser.add_argument(
        "--memory-db", default=None,
        help="Path to a foveated memory SQLite DB to embed (optional)",
    )
    parser.add_argument(
        "--base-model", default="gemma-4-12b-it-qat-GGUF-MoQ",
        help="Name of the neural core model",
    )
    parser.add_argument(
        "--xrl-source", default="qwen3.5-4b",
        help="Name of the XRL source/distillation model",
    )
    parser.add_argument(
        "--output", "-o", default="gemma-4-12b-xrl.xrlf",
        help="Output .xrlf file path",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the section table without writing the file",
    )

    args = parser.parse_args()

    print("\n" + "=" * 60)
    print("  XRLF PACKER")
    print("=" * 60)
    print(f"  Core model   : {args.base_model}")
    print(f"  XRL source   : {args.xrl_source}")
    print(f"  XRL dir      : {args.xrl_dir}")
    print(f"  MMPROJ       : {args.mmproj or '(none)'}")
    print(f"  Memory DB    : {args.memory_db or '(none — empty seed)'}")
    print(f"  Output       : {args.output}")
    print(f"  Dry run      : {args.dry_run}")
    print("=" * 60 + "\n")

    t0 = time.time()

    packer = XRLFPacker(
        base_model_name=args.base_model,
        xrl_source_model=args.xrl_source,
    )

    # 1. Register GGUF core (optional for stub/testing)
    if args.core_gguf:
        packer.add_gguf(args.core_gguf)
    else:
        print("  ⚠️  No GGUF provided — producing a stub XRLF (no neural core).")

    if args.mmproj:
        packer.add_mmproj(args.mmproj)

    # 2. XRL cognitive artifacts
    packer.add_xrl_json_dir(args.xrl_dir)

    # 3. Multimodal hooks (Gemma-4 native + TTS)
    packer.add_multimodal_hooks()

    # 4. Foveated memory
    packer.add_memory_db(args.memory_db)
    packer.add_memory_schema()

    # 5. Runtime metadata
    packer.add_runtime_meta()

    # 6. Write
    output = packer.write(args.output, dry_run=args.dry_run)

    elapsed = time.time() - t0
    if not args.dry_run:
        print(f"\n  ✅ Done in {elapsed:.1f}s → {output}")


if __name__ == "__main__":
    main()
