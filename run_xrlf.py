"""
run_xrlf.py — XRLF One-Command Launcher
=========================================
Loads xrlf_config.yaml (or a custom config), starts the XRLF runtime
and the OpenAI-compatible API server.

Usage:
    # Start with default config
    python run_xrlf.py

    # Start with custom model
    python run_xrlf.py --model gemma-4-12b-xrl.xrlf --port 8300

    # Self-test (no llama.cpp required)
    python run_xrlf.py --test
"""

import argparse
import os
import sys

# Ensure project root is on the path
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    import yaml
    _YAML = True
except ImportError:
    _YAML = False
    import json


def load_config(config_path: str = "xrlf_config.yaml") -> dict:
    if _YAML and os.path.exists(config_path):
        with open(config_path, "r") as f:
            return yaml.safe_load(f)
    return {}


def run_test(config: dict):
    """
    Self-test: pack a stub XRLF from existing XRL artifacts (no GGUF),
    load it with XRLFRuntime, and run a sample chat.
    """
    import tempfile
    from formats.xrlf_packer import XRLFPacker
    from runtime.xrlf_runtime import XRLFRuntime

    print("\n" + "=" * 60)
    print("  XRLF SELF-TEST")
    print("=" * 60)

    # 1. Pack a stub .xrlf (no GGUF core)
    stub_path = os.path.join(tempfile.mkdtemp(), "test.xrlf")
    packer = XRLFPacker(
        base_model_name="gemma-4-12b-it-qat-GGUF-MoQ",
        xrl_source_model="qwen3.5-4b",
    )
    packer.add_xrl_json_dir("xrl_encoded")
    packer.add_multimodal_hooks()
    packer.add_memory_db(None)   # empty seed
    packer.add_memory_schema()
    packer.add_runtime_meta()
    packer.write(stub_path)

    print(f"\n  Stub XRLF written: {stub_path}")

    # 2. Load with runtime
    rt = XRLFRuntime(stub_path, session_id="test", verbose=True)
    rt.load()

    # 3. Sample chats
    test_prompts = [
        {"role": "user", "content": "Explain semantic compression in two sentences."},
        {"role": "user", "content": "Write a Python function to add two numbers."},
        {"role": "user", "content": "Describe what you see in this image."},   # vision test
    ]

    for i, msg in enumerate(test_prompts):
        has_image = "image" in msg["content"].lower()
        print(f"\n  --- Test {i+1}: {'[VISION]' if has_image else ''} ---")
        print(f"  User: {msg['content']}")
        response = rt.chat([msg], has_image=has_image)
        print(f"  XRLF: {response}")

    # 4. Memory test
    print("\n  --- Memory recall test ---")
    rt._memory.set_identity("system_context", "I am XRLF, a hybrid AI model.")
    rt.chat([{"role": "user", "content": "Remember that I am a researcher."}])
    response = rt.chat([{"role": "user", "content": "Who are you and who am I?"}])
    print(f"  Memory recall response: {response}")

    rt.close(repack_memory=False)
    print("\n  ✅ XRLF self-test complete!")


def main():
    parser = argparse.ArgumentParser(description="XRLF Runtime Launcher")
    parser.add_argument("--model", help="Path to .xrlf file (overrides config)")
    parser.add_argument("--port", type=int, help="API port (overrides config)")
    parser.add_argument("--config", default="xrlf_config.yaml", help="Config file path")
    parser.add_argument("--test", action="store_true", help="Run self-test and exit")
    parser.add_argument("--pack", action="store_true",
                        help="Pack a new .xrlf from config settings, then exit")
    parser.add_argument("--draft", help="Path to Draft Model GGUF for speculative decoding (used in --pack)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    config = load_config(args.config)

    # ── Self-test ─────────────────────────────────────────────────────────────
    if args.test:
        run_test(config)
        return

    # ── Pack mode ─────────────────────────────────────────────────────────────
    if args.pack:
        from formats.xrlf_packer import XRLFPacker
        gguf = config.get("gguf_source", "") or ""
        output = args.model or config.get("model", "gemma-4-12b-xrl.xrlf")
        memory_db = config.get("memory_db_source", None)

        packer = XRLFPacker(
            base_model_name="gemma-4-12b-it-qat-GGUF-MoQ",
            xrl_source_model="qwen3.5-4b",
        )
        if gguf and os.path.exists(gguf):
            packer.add_gguf(gguf)
        else:
            print("  ⚠️  No GGUF source in config — packing without core GGUF (stub mode)")
            
        draft = args.draft or config.get("draft_source", "") or ""
        if draft and os.path.exists(draft):
            packer.add_draft_gguf(draft)

        packer.add_xrl_json_dir("xrl_encoded")
        packer.add_multimodal_hooks()
        packer.add_memory_db(memory_db)
        packer.add_memory_schema()
        packer.add_runtime_meta()
        packer.write(output)
        return

    # ── Server mode ───────────────────────────────────────────────────────────
    model_path = args.model or config.get("model", "gemma-4-12b-xrl.xrlf")
    port = args.port or config.get("api", {}).get("port", 8300)
    host = config.get("api", {}).get("host", "127.0.0.1")
    gpu_layers = config.get("gpu_layers", -1)
    n_ctx = config.get("n_ctx", 8192)
    session_id = config.get("session", {}).get("id", "default")
    persistent = config.get("session", {}).get("persistent_memory", True)
    verbose = args.verbose or config.get("xrl", {}).get("verbose", False)

    if not os.path.exists(model_path):
        print(f"\n  ❌ Model not found: {model_path}")
        print("  Run with --pack to create a new .xrlf, or --test for a self-test.\n")
        sys.exit(1)

    from runtime.xrlf_runtime import XRLFRuntime
    from api.server import create_app
    import uvicorn

    runtime = XRLFRuntime(
        xrlf_path=model_path,
        session_id=session_id,
        n_gpu_layers=gpu_layers,
        n_ctx=n_ctx,
        persistent_memory=persistent,
        verbose=verbose,
    )
    runtime.load()
    app = create_app(runtime)

    print(f"\n  🚀 XRLF API → http://{host}:{port}/v1")
    print(f"     Model : {runtime.model_name}")
    print(f"     Memory: embedded foveated (6-ring, persistent={persistent})")
    print(f"     TTS   : provider-driven (http / Piper / espeak / stub)")
    print(f"\n  Point your LLM client at http://{host}:{port}/v1/chat/completions\n")

    try:
        uvicorn.run(app, host=host, port=port, log_level="warning")
    finally:
        runtime.close()


if __name__ == "__main__":
    main()
