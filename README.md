# XRLF — Hybrid Model Format

**A single-file hybrid AI format that makes a 12B model behave like a 100B+ model.**

XRLF pairs a **small, highly-quantized neural core** (Gemma-4-12B MoQ, ~4.7 GB) with a **distilled XRL cognitive layer** — encoding the reasoning fingerprint of a much larger source model — and an **embedded Foveated Memory engine** that gives the model persistent, infinite-feeling context.

---

## What makes XRLF different

| Feature | Plain GGUF | XRLF |
|---|---|---|
| Neural core | ✅ | ✅ (Gemma-4-12B MoQ) |
| Image input | Only with clip | ✅ Native (Gemma-4) |
| Video input | ❌ | ✅ Native (Gemma-4) |
| Audio/STT input | ❌ | ✅ Native (Gemma-4) |
| Voice output (TTS) | ❌ | ✅ Auto-detected (Kokoro/Piper) |
| Long-term memory | ❌ | ✅ Embedded foveated 6-ring memory |
| Reasoning steering | ❌ | ✅ XRL cognitive layer |
| Distribution | Single file | ✅ Single file |
| External servers | None | ✅ None required |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      gemma-4-12b-xrl.xrlf               │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  CORE_GGUF   Gemma-4-12B MoQ  (4.7 GB)          │   │
│  │  • Text in/out     ✅ native                     │   │
│  │  • Image in        ✅ native (vision encoder)    │   │
│  │  • Video in        ✅ native (temporal vision)   │   │
│  │  • Audio/STT in    ✅ native                     │   │
│  │  • Voice out (TTS) 🔌 Kokoro/Piper hook          │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  XRL COGNITIVE LAYER  (distilled from source)   │   │
│  │  XRL_PRINCIPLES   reasoning principia            │   │
│  │  XRL_GRAPH        semantic concept graph         │   │
│  │  XRL_CLUSTERS     cognitive cluster map          │   │
│  │  XRL_PROFILES     task profiles (5 modes)        │   │
│  │  XRL_EXPANSION    expansion rules                │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  EMBEDDED FOVEATED MEMORY                       │   │
│  │  XRL_MEMORY_DATA   SQLite DB + TF-IDF index     │   │
│  │  XRL_MEMORY_SCHEMA 6-ring policy config         │   │
│  │  • 6-ring context weaving (identity→archive)    │   │
│  │  • Semantic recall via TF-IDF                   │   │
│  │  • Persistent across sessions (re-packed)       │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Set up the environment

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Install llama-cpp-python with CUDA (for GPU inference):
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124
```

### 2. Run the self-test (no GGUF required)

```powershell
python run_xrlf.py --test
```

### 3. Pack your first .xrlf file

```powershell
# Edit xrlf_config.yaml to set gguf_source path, then:
python run_xrlf.py --pack

# Or use the CLI directly:
python builder/packer/pack_xrlf.py \
  --core-gguf "C:/path/to/Gemma-4-12B-MoQ.gguf" \
  --xrl-dir xrl_encoded/ \
  --output gemma-4-12b-xrl.xrlf
```

### 4. Start the API server

```powershell
python run_xrlf.py
# API ready at http://127.0.0.1:8300/v1
```

### 5. Use it like any OpenAI-compatible model

Point LM Studio, Open WebUI, or any OpenAI SDK at `http://127.0.0.1:8300/v1`.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8300/v1", api_key="xrlf")
response = client.chat.completions.create(
    model="gemma-4-12b-xrl",
    messages=[{"role": "user", "content": "Explain attention in transformers."}]
)
print(response.choices[0].message.content)
```

---

## Building new XRL artifacts

To re-distill the XRL cognitive layer from a different source model:

```powershell
# Probe + distill using local GGUF
python xrl_process_qwen4b_gguf.py

# Or use the modular builder
python builder/distillation/distill_xrl.py
```

---

## Repository structure

```
xrlf-model/
  formats/            ← XRLF binary format (schema, parser, packer)
  builder/            ← Distillation + packing pipeline
  runtime/            ← Main orchestrator + XRL cognitive steering
  llama_bridge/       ← llama-cpp-python wrapper
  memory/             ← In-process foveated memory engine
  tools/              ← Multimodal hooks (TTS auto-detect)
  api/                ← OpenAI-compatible REST API
  xrl_encoded/        ← XRL JSON artifacts (distilled from Qwen3.5-4B)
  foveated-memory/    ← Original Foveated Memory system
  xrlf_config.yaml   ← Master config
  run_xrlf.py        ← One-command launcher
  requirements.txt
```

---

## Roadmap

- [x] Phase 1: Python runtime (this release)
- [ ] Phase 2: llama-server plugin (.dll) — `llama-server --plugin xrlf_plugin.dll --model file.xrlf`
- [ ] Phase 3: Native llama.cpp format — `llama-run file.xrlf`
- [ ] Kokoro TTS integration (high-quality voice output)
- [ ] Re-distillation pipeline from cloud source models (Claude, GPT-4o)
- [ ] Multimodal expansion (image generation via diffusion hook)
