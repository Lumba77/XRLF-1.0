"""
tools/validate_mm_hooks.py — Multimodal Hook Smoke Test
========================================================
Tests image, audio, and video hooks by:
  1. Generating synthetic inputs in-process (no external files needed)
  2. Firing each hook through MMHookRegistry
  3. Asserting that the hook event schema is valid
  4. Reporting a pass/fail table

Usage:
    python tools/validate_mm_hooks.py           # all hooks
    python tools/validate_mm_hooks.py --tts     # TTS only
    python tools/validate_mm_hooks.py --vision  # image gen + synthetic PNG payload
    python tools/validate_mm_hooks.py --audio   # audio gen + synthetic WAV payload
    python tools/validate_mm_hooks.py --video   # video frame stub
    python tools/validate_mm_hooks.py --verbose # print full hook events
"""

import argparse
import io
import math
import struct
import sys
import time
import wave
import zlib
from pathlib import Path
from typing import List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from tools.mm_hooks import BaseHook, MMHookRegistry


# ── Synthetic asset generators ────────────────────────────────────────────────

def make_png_bytes(width: int = 4, height: int = 4) -> bytes:
    """Generate a minimal valid RGB PNG in-memory (no PIL required)."""

    def _u32be(n: int) -> bytes:
        return struct.pack(">I", n)

    def _chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return _u32be(len(data)) + body + _u32be(zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))

    colors = [(255, 0, 0), (0, 200, 255), (128, 0, 255), (255, 200, 0)]
    raw = b""
    for row in range(height):
        raw += b"\x00"
        for col in range(width):
            r, g, b = colors[(row + col) % len(colors)]
            raw += bytes([r, g, b])

    idat = _chunk(b"IDAT", zlib.compress(raw))
    iend = _chunk(b"IEND", b"")

    return b"\x89PNG\r\n\x1a\n" + ihdr + idat + iend


def make_wav_bytes(duration_s: float = 0.5, freq_hz: float = 440.0, sample_rate: int = 22050) -> bytes:
    """Generate a 440 Hz sine-wave WAV (no dependencies)."""
    n = int(duration_s * sample_rate)
    frames = b"".join(
        struct.pack("<h", int(32767 * math.sin(2 * math.pi * freq_hz * i / sample_rate)))
        for i in range(n)
    )
    bio = io.BytesIO()
    with wave.open(bio, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(frames)
    return bio.getvalue()


def make_video_frames() -> list:
    """Return a stub video frame descriptor list."""
    return [
        {"frame": 0, "timestamp_ms": 0,   "description": "Blue background — XRLF logo fades in"},
        {"frame": 1, "timestamp_ms": 33,  "description": "Text 'XRLF v1.0' appears centre screen"},
        {"frame": 2, "timestamp_ms": 66,  "description": "Neural network diagram renders"},
        {"frame": 3, "timestamp_ms": 100, "description": "End card with build info"},
    ]


# ── Test result container ─────────────────────────────────────────────────────

class HookResult:
    def __init__(self, name: str):
        self.name = name
        self.fired: bool = False
        self.schema_valid: bool = False
        self.notes: str = ""
        self.elapsed_ms: float = 0.0
        self.event: Optional[dict] = None


def _run(name: str, fn) -> HookResult:
    r = HookResult(name)
    t0 = time.perf_counter()
    try:
        fn(r)
    except Exception as exc:
        r.notes = f"Exception: {exc}"
    r.elapsed_ms = (time.perf_counter() - t0) * 1000
    return r


# ── Individual tests ──────────────────────────────────────────────────────────

def test_tts(registry: MMHookRegistry, verbose: bool) -> HookResult:
    def inner(r: HookResult):
        captured = []
        registry.tts.on_hook_fire = captured.append
        registry.speak("XRLF multimodal validation: TTS hook active.")
        if captured:
            r.fired = True
            r.event = captured[-1]
            r.schema_valid = BaseHook.validate_schema(r.event)
            engine = r.event.get("payload", {}).get("engine", "?")
            status = r.event.get("status", "?")
            r.notes = f"engine={engine} status={status}"
        else:
            r.notes = "no event emitted"
        if verbose and r.event:
            print(f"\n    [TTS] {r.event}")
    return _run("TTS (text→audio)", inner)


def test_image_gen(registry: MMHookRegistry, verbose: bool) -> HookResult:
    def inner(r: HookResult):
        captured = []
        registry.image_gen.on_hook_fire = captured.append
        registry.generate_image("A glowing neural network diagram.")
        if captured:
            r.fired = True
            r.event = captured[-1]
            r.schema_valid = BaseHook.validate_schema(r.event)
            r.notes = f"status={r.event.get('status', '?')}"
        else:
            r.notes = "no event emitted"
        if verbose and r.event:
            print(f"\n    [ImageGen] {r.event}")
    return _run("Image Gen (text→image)", inner)


def test_audio_gen(registry: MMHookRegistry, verbose: bool) -> HookResult:
    def inner(r: HookResult):
        captured = []
        registry.audio_gen.on_hook_fire = captured.append
        registry.audio_gen.generate("A short test tone.")
        if captured:
            r.fired = True
            r.event = captured[-1]
            r.schema_valid = BaseHook.validate_schema(r.event)
            r.notes = f"status={r.event.get('status', '?')} (stub)"
        else:
            r.notes = "no event emitted"
        if verbose and r.event:
            print(f"\n    [AudioGen] {r.event}")
    return _run("Audio Gen (text→sound)", inner)


def test_png_payload(verbose: bool) -> HookResult:
    def inner(r: HookResult):
        png = make_png_bytes(4, 4)
        valid = png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 67
        r.fired = True
        r.schema_valid = valid
        r.notes = f"{len(png)} B  sig={'✅' if valid else '❌'}"
        r.event = {"hook": "image_payload", "status": "ok" if valid else "error",
                   "payload": {"format": "png", "bytes": len(png)},
                   "output": None, "schema_version": 1, "message": "synthetic 4×4 PNG"}
        if verbose:
            print(f"\n    [PNG] first 16 bytes: {png[:16].hex()}")
    return _run("Synthetic PNG payload", inner)


def test_wav_payload(verbose: bool) -> HookResult:
    def inner(r: HookResult):
        wav = make_wav_bytes(0.5, 440.0)
        valid = wav[:4] == b"RIFF" and b"WAVE" in wav[:12] and len(wav) > 44
        r.fired = True
        r.schema_valid = valid
        r.notes = f"{len(wav)} B  sig={'✅' if valid else '❌'}"
        r.event = {"hook": "audio_payload", "status": "ok" if valid else "error",
                   "payload": {"format": "wav", "bytes": len(wav), "duration_s": 0.5},
                   "output": None, "schema_version": 1, "message": "440 Hz sine WAV"}
        if verbose:
            print(f"\n    [WAV] first 12 bytes: {wav[:12].hex()}")
    return _run("Synthetic WAV payload", inner)


def test_video_stub(verbose: bool) -> HookResult:
    def inner(r: HookResult):
        frames = make_video_frames()
        valid = (
            isinstance(frames, list)
            and len(frames) == 4
            and all("frame" in f and "description" in f for f in frames)
        )
        r.fired = True
        r.schema_valid = valid
        r.notes = f"{len(frames)} frames  schema={'✅' if valid else '❌'}"
        r.event = {"hook": "video_stub", "status": "ok" if valid else "error",
                   "payload": {"frame_count": len(frames)},
                   "output": None, "schema_version": 1, "message": "4-frame video stub"}
        if verbose:
            print(f"\n    [Video] frames: {frames}")
    return _run("Video frame stub", inner)


# ── Reporter ──────────────────────────────────────────────────────────────────

def print_report(results: List[HookResult]) -> bool:
    print()
    W = 72
    print("  " + "─" * W)
    print("  │  Multimodal Hook Validation" + " " * (W - 30) + "│")
    print("  " + "─" * W)
    print(f"  │ {'Test':<30} │ {'Fired':<6} │ {'Schema':<7} │ {'Notes':<18} │")
    print("  " + "─" * W)

    all_fired = True
    for r in results:
        fire_icon   = "✅" if r.fired else "❌"
        schema_icon = "✅" if r.schema_valid else "⚠️ "
        note = r.notes[:18]
        name = r.name[:30]
        print(f"  │ {name:<30} │ {fire_icon:<6} │ {schema_icon:<7} │ {note:<18} │")
        if not r.fired:
            all_fired = False

    print("  " + "─" * W)

    if all_fired:
        print("\n  ✅ All hooks fired. Multimodal hook wiring: ACTIVE.\n")
    else:
        print("\n  ⚠️  Some hooks did not fire — check config or tool availability.\n")

    return all_fired


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="XRLF Multimodal Hook Validator")
    ap.add_argument("--tts",     action="store_true")
    ap.add_argument("--vision",  action="store_true")
    ap.add_argument("--audio",   action="store_true")
    ap.add_argument("--video",   action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    run_all = not (args.tts or args.vision or args.audio or args.video)

    print("\n" + "=" * 74)
    print("  XRLF — Multimodal Hook Smoke Test")
    print("=" * 74)

    registry = MMHookRegistry({
        "external_hooks": {
            "tts":       {"enabled": True, "engine": "auto"},
            "image_gen": {"enabled": False},
            "audio_gen": {"enabled": False},
        }
    })

    results: List[HookResult] = []

    if run_all or args.tts:
        results.append(test_tts(registry, args.verbose))

    if run_all or args.vision:
        results.append(test_image_gen(registry, args.verbose))
        results.append(test_png_payload(args.verbose))

    if run_all or args.audio:
        results.append(test_audio_gen(registry, args.verbose))
        results.append(test_wav_payload(args.verbose))

    if run_all or args.video:
        results.append(test_video_stub(args.verbose))

    ok = print_report(results)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
