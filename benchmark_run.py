"""
benchmark_run.py — XRLF Benchmark Runner
=========================================
One-command benchmark entry point. Loads xrlf_config.yaml to find the model,
then runs the benchmark suite and saves results as JSON + prints a summary table.

Usage:
    python benchmark_run.py                        # full benchmark
    python benchmark_run.py --quick                # 5 questions per track
    python benchmark_run.py --track reasoning      # one track only
    python benchmark_run.py --track reasoning coherence
    python benchmark_run.py --model my-model.xrlf  # custom model
    python benchmark_run.py --out results.json      # save to specific path
    python benchmark_run.py --stub                  # force stub mode (no llama.cpp needed)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:
    import yaml
    def _load_yaml(p):
        with open(p) as f:
            return yaml.safe_load(f) or {}
except ImportError:
    def _load_yaml(p):
        return {}


def main():
    parser = argparse.ArgumentParser(description="XRLF Benchmark Runner")
    parser.add_argument(
        "--model", default=None,
        help="Path to .xrlf file (default: from xrlf_config.yaml)",
    )
    parser.add_argument(
        "--config", default="xrlf_config.yaml",
        help="Config file path",
    )
    parser.add_argument(
        "--track", nargs="+",
        choices=["reasoning", "coherence", "multimodal"],
        default=None,
        help="Tracks to run (default: all)",
    )
    parser.add_argument(
        "--quick", action="store_true",
        help="Quick mode: 5 questions per track instead of 20",
    )
    parser.add_argument(
        "--api", action="store_true",
        help="Use active API server on port 8300 instead of loading model locally",
    )
    parser.add_argument(
        "--stub", action="store_true",
        help="Force stub mode (no XRLF runtime required)",
    )
    parser.add_argument(
        "--out", default=None,
        help="Output JSON path (default: auto-generated timestamp filename)",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Print each question result",
    )
    args = parser.parse_args()

    # ── Resolve model path ────────────────────────────────────────────────────
    config = {}
    if os.path.exists(args.config):
        config = _load_yaml(args.config)

    xrlf_path = args.model or config.get("model", "gemma-4-12b-xrl.xrlf")
    if not os.path.isabs(xrlf_path):
        xrlf_path = str(ROOT / xrlf_path)

    tracks = args.track  # None = all

    print("\n" + "=" * 68)
    print("  XRLF Benchmark Runner")
    print("=" * 68)
    print(f"  Model  : {xrlf_path}")
    print(f"  Tracks : {tracks or 'all'}")
    print(f"  Mode   : {'quick (5q)' if args.quick else 'full (20q)'}")
    print(f"  Target : {'API Server' if args.api else 'Local runtime'}")
    print(f"  Stub   : {args.stub}")
    print()

    # ── Import benchmark suite ────────────────────────────────────────────────
    from builder.probes.benchmark_suite import run_benchmark, print_report

    # Force stub mode if requested
    if args.stub:
        xrlf_path = "__stub__"

    # ── Run ───────────────────────────────────────────────────────────────────
    report = run_benchmark(
        xrlf_path=xrlf_path,
        tracks=tracks,
        quick=args.quick,
        use_api=args.api,
    )

    # ── Print summary ─────────────────────────────────────────────────────────
    print_report(report)

    if args.verbose:
        print("\n  Detailed results:")
        for track in report.tracks:
            print(f"\n  ── {track.name} ──")
            for q in track.questions:
                icon = "✅" if q.correct else "❌"
                print(f"    {icon} exp={q.expected!r:20s} pred={q.predicted!r:20s}  ({q.elapsed_ms:.0f}ms)")

    # ── Save JSON ─────────────────────────────────────────────────────────────
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = args.out or str(ROOT / f"benchmark_results_{ts}.json")
    data = report.to_dict()
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"\n  💾 Results saved → {out_path}")

    # ── Exit code: 0 if any track has >50% accuracy ───────────────────────────
    if report.tracks:
        avg = sum(t.accuracy for t in report.tracks) / len(report.tracks)
        sys.exit(0 if avg > 0.50 or report.stub_mode else 1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
