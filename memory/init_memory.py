"""
memory/init_memory.py — Six-Ring Memory Initialiser & Persistence Verifier
===========================================================================
Initialises the MembraneEngine with one seed entry per ring, flushes to
SQLite, re-opens the engine, and verifies all six rings persisted correctly.

Usage:
    python memory/init_memory.py                          # default session
    python memory/init_memory.py --session my_session     # named session
    python memory/init_memory.py --db path/to/memory.db   # custom DB path
    python memory/init_memory.py --reset                  # fresh start
"""

import argparse
import os
import sys
import time
from pathlib import Path

# Ensure project root on path
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from memory.membrane_engine import MembraneEngine, _default_ring_config


# ── Ring seed data ─────────────────────────────────────────────────────────────

RING_SEEDS = [
    {
        "ring_id": 0,
        "label": "identity",
        "role": "system",
        "content": (
            "I am XRLF — a hybrid AI model built on Gemma-4-12B with XRL cognitive "
            "steering. I reason across text, image, audio, and memory. My source "
            "distillation model is Qwen3.5-4B. I maintain six rings of foveated "
            "memory to preserve continuity across sessions."
        ),
    },
    {
        "ring_id": 1,
        "label": "task",
        "role": "system",
        "content": (
            "Current objective: validate the XRLF six-ring memory engine, confirm "
            "persistence across sessions, and prepare for benchmarking and multimodal "
            "validation."
        ),
    },
    {
        "ring_id": 2,
        "label": "recent",
        "role": "assistant",
        "content": (
            "Memory engine initialisation run started. Writing seed data to all six "
            "rings. This is the most recent entry and will be retrieved first in "
            "context weaving."
        ),
    },
    {
        "ring_id": 3,
        "label": "working",
        "role": "assistant",
        "content": (
            "The working memory ring holds compressed summaries of the last 32 turns. "
            "This seed represents an episode where the build process was documented, "
            "the multimodal hooks were validated, and the benchmark suite was executed."
        ),
    },
    {
        "ring_id": 4,
        "label": "background",
        "role": "assistant",
        "content": (
            "Background context: XRLF was built from a 5 GB .xrlf file combining "
            "Gemma-4-12B MoQ GGUF with XRL cognitive artifacts. Flash Attention 3 is "
            "available via a pre-built wheel. The runtime exposes an OpenAI-compatible "
            "API on port 8300."
        ),
    },
    {
        "ring_id": 5,
        "label": "archive",
        "role": "assistant",
        "content": (
            "Semantic archive: XRLF uses distilled XRL principia — six reasoning "
            "modes (stability, correction, exploration, abstraction, compression, "
            "expansion), a semantic graph, cognitive clusters, task profiles, and "
            "expansion rules — stored as binary sections inside the .xrlf file."
        ),
    },
]

IDENTITY_KEYS = {
    "system_context": (
        "I am XRLF, a hybrid AI model combining Gemma-4-12B with XRL cognitive steering."
    ),
    "model_version": "xrlf-1.0",
    "base_model": "gemma-4-12b-it-qat-GGUF-MoQ",
    "xrl_source": "qwen3.5-4b",
    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}


# ── Initialiser ───────────────────────────────────────────────────────────────

def initialise_rings(db_path: str, session_id: str) -> None:
    print("\n" + "=" * 62)
    print("  XRLF — Six-Ring Memory Initialiser")
    print("=" * 62)
    print(f"  DB path   : {db_path}")
    print(f"  Session   : {session_id}")
    print()

    engine = MembraneEngine(db_path=db_path, session_id=session_id)
    engine.load()

    # Write identity table entries
    for key, value in IDENTITY_KEYS.items():
        engine.set_identity(key, value)
    print(f"  Identity keys written: {list(IDENTITY_KEYS.keys())}")

    # Write one seed turn per ring
    for seed in RING_SEEDS:
        turn_id = engine.store_turn(
            role=seed["role"],
            content=seed["content"],
            tags=[f"ring:{seed['label']}", "init_seed"],
            ring_id=seed["ring_id"],
            ring_label=seed["label"],
        )
        print(f"  Ring {seed['ring_id']} [{seed['label']:10s}] → turn id {turn_id}")

    engine.close()
    print("\n  Engine closed — flushed to SQLite.\n")


# ── Verifier ──────────────────────────────────────────────────────────────────

def verify_rings(db_path: str, session_id: str) -> bool:
    print("  Re-opening engine for persistence verification…")
    engine = MembraneEngine(db_path=db_path, session_id=session_id)
    engine.load()

    ring_config = _default_ring_config()
    labels = [rc["label"] for rc in ring_config.values()]

    results: dict = {}

    # Identity table check
    identity_val = engine.get_identity("system_context")
    results["identity_table"] = identity_val is not None and "XRLF" in identity_val

    # Ring-by-ring turn retrieval
    ring_rows: list = []
    all_rings_ok = True
    for ring_id, label in enumerate(labels):
        turns = engine.get_by_ring(ring_id, limit=5)
        found = len(turns) > 0
        sample = (turns[0]["content"][:56] + "…") if found else "(empty)"
        ring_rows.append((ring_id, label, found, sample))
        results[f"ring_{ring_id}"] = found
        if not found:
            all_rings_ok = False

    # Semantic recall test
    recall = engine.semantic_search("hybrid AI model XRL cognitive", top_k=3)
    results["semantic_search"] = len(recall) > 0

    # Context weave test
    block = engine.weave_context("What is XRLF?")
    results["context_weave"] = len(block) > 50

    engine.close()

    # ── Report ────────────────────────────────────────────────────────────────
    print()
    print("  ┌───────────────────────────────────────────────────────────────┐")
    print("  │  Persistence Verification                                      │")
    print("  ├──────┬─────────────┬────────┬──────────────────────────────────┤")
    print("  │ Ring │ Label       │ Status │ Sample                           │")
    print("  ├──────┼─────────────┼────────┼──────────────────────────────────┤")
    for ring_id, label, found, sample in ring_rows:
        status = "✅ OK  " if found else "❌ FAIL"
        trunc = sample[:32] + "…" if len(sample) > 32 else sample
        print(f"  │  {ring_id}   │ {label:11s} │ {status} │ {trunc:<32s} │")
    print("  ├──────┴─────────────┴────────┴──────────────────────────────────┤")

    extra_checks = [
        ("Identity table",  results["identity_table"]),
        ("Semantic search", results["semantic_search"]),
        ("Context weave",   results["context_weave"]),
    ]
    for name, ok in extra_checks:
        icon = "✅" if ok else "❌"
        if not ok:
            all_rings_ok = False
        print(f"  │  {icon} {name:<60} │")

    print("  └───────────────────────────────────────────────────────────────┘")

    if all_rings_ok:
        print("\n  ✅ All 6 rings verified. Persistence: OK.\n")
    else:
        print("\n  ❌ Some rings failed persistence check.\n")

    return all_rings_ok


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="XRLF Six-Ring Memory Initialiser")
    parser.add_argument("--session", default="default", help="Session ID")
    parser.add_argument(
        "--db",
        default=str(
            ROOT / "foveated-memory" / "memory_data" / "default" / "memory.db"
        ),
        help="Path to SQLite memory DB",
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="Delete existing DB before initialising (fresh start)",
    )
    args = parser.parse_args()

    db_path = str(Path(args.db).resolve())

    if args.reset and os.path.exists(db_path):
        os.remove(db_path)
        print(f"  🗑  Reset: removed {db_path}")

    initialise_rings(db_path, args.session)
    ok = verify_rings(db_path, args.session)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
