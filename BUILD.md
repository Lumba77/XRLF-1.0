# XRLF — Build Manual (v1.0)

> **Versioned recipe** for reproducing `gemma-4-12b-xrl.xrlf` from scratch.
> This manual freezes the exact build steps, prerequisites, and known failure modes
> so that any engineer (or future agent session) can rebuild the XRLF hybrid model file.

---

## 1. Prerequisites

### 1.1 System Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| OS | Windows 11 / Linux | Windows 11 (native) |
| Python | 3.11 | 3.11.x |
| RAM | 16 GB | 32 GB+ |
| VRAM | 8 GB | 12 GB+ (for 12B core) |
| Disk | 10 GB free | 20 GB free |
| CUDA | 12.4+ | 12.4+ (for GPU inference) |

### 1.2 Core Tools

- **Python 3.11** — [Download](https://www.python.org/downloads/)
- **Git** — for cloning the repository
- **A GGUF source model** — Gemma-4-12B-it-qat-GGUF-MoQ (MoQ-3.5 = 4.7 GB)
  - Source: `w-ahmad/Gemma-4-12B-it-qat-GGUF-MoQ` on HuggingFace
  - Local path example: `C:/Users/danie/.cache/huggingface/hub/w-ahmad/Gemma-4-12B-it-qat-GGUF-MoQ/MoQ-3.5.gguf`
- **flash-attn wheel** (optional, for training/distillation only)
  - Included: `flash_attn_3-3.0.0+20260427.cu128torch2110cxx11abitrue.c9a560-cp39-abi3-win_amd64.whl`

### 1.3 Source Models

| Component | Model | Purpose |
|---|---|---|
| Neural core | Gemma-4-12B-it-qat-GGUF-MoQ (MoQ-3.5) | Quantized inference core (~4.7 GB) |
| XRL distillation source | Qwen3.5-4B (or cloud model) | Reasoning fingerprint extraction |
| Multimodal | Gemma-4 native | Image/video/audio input (built into core) |

---

## 2. Environment Setup

### 2.1 Clone the Repository

```powershell
git clone <repo-url> xrlf-model
cd xrlf-model
```

### 2.2 Create Virtual Environment

```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
```

### 2.3 Install Dependencies

```powershell
# Core dependencies
pip install -r requirements.txt

# GPU-accelerated llama-cpp-python (recommended for Gemma-4-12B)
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# CPU-only fallback (much slower)
# pip install llama-cpp-python
```

### 2.4 Verify Installation

```powershell
python -c "import llama_cpp; import fastapi; import uvicorn; import msgpack; import yaml; print('✅ Dependencies OK')"
```

---

## 3. Source Model Distillation (XRL Artifacts)

The XRL cognitive layer is distilled from a source model into JSON artifacts stored in `xrl_encoded/`.

### 3.1 XRL Artifacts Overview

| File | Section Type | Description |
|---|---|---|
| `meta_gguf.json` | RUNTIME_META | Build info, version, capability flags |
| `principles_gguf.json` | XRL_PRINCIPLES | Distilled reasoning principia |
| `semantic_graph_gguf.json` | XRL_GRAPH | Semantic concept graph (nodes + edges) |
| `semantic_clusters_gguf.json` | XRL_CLUSTERS | Cognitive cluster definitions |
| `semantic_expansion_gguf.json` | XRL_EXPANSION | Expansion rules |
| `semantic_graph_export_gguf.json` | — | Export copy of graph (for tooling) |
| `threads_gguf.json` | XRL_PROFILES | Task profiles (chat/code/vision/reasoning) |

### 3.2 Re-distill from a Source Model

```powershell
# Using the local GGUF probe (Qwen3.5-4B)
python xrl_process_qwen4b_gguf.py

# Or using the modular builder
python builder/distillation/distill_xrl.py
```

The distillation process:
1. Loads the source model (Qwen3.5-4B GGUF or API endpoint)
2. Probes reasoning patterns via structured prompts
3. Extracts semantic clusters and graph relationships
4. Distills reasoning principles
5. Generates task profiles
6. Writes all artifacts to `xrl_encoded/*.json`

---

## 4. XRLF Packing

### 4.1 Configure the Build

Edit `xrlf_config.yaml`:

```yaml
model: gemma-4-12b-xrl.xrlf

gguf_source: "C:/path/to/MoQ-3.5.gguf"
memory_db_source: "foveated-memory/memory_data/default/memory.db"

gpu_layers: -1
n_ctx: 8192
```

### 4.2 Pack the XRLF File

```powershell
# One-command pack (reads xrlf_config.yaml)
python run_xrlf.py --pack

# Or use the packer directly
python builder/packer/pack_xrlf.py \
  --core-gguf "C:/path/to/MoQ-3.5.gguf" \
  --xrl-dir xrl_encoded/ \
  --output gemma-4-12b-xrl.xrlf
```

### 4.3 Pack Structure

The packer creates a single `.xrlf` file with this binary layout:

```
[4B magic "XRLF"]
[22B header]
  ├── magic(4s)
  ├── version(H)
  ├── base_model_len(H)
  ├── xrl_source_len(H)
  ├── flags(I)
  ├── section_count(H)
  └── reserved(6s)
[base_model_name bytes]
[xrl_source_model bytes]
[section table: N × 22B entries]
  └── type(H) offset(Q) length(Q) flags(H)
[section payloads...]
  ├── CORE_GGUF         — Raw Gemma-4 GGUF bytes (~4.7 GB)
  ├── XRL_PRINCIPLES    — Distilled reasoning principia
  ├── XRL_GRAPH         — Semantic concept graph
  ├── XRL_CLUSTERS      — Cognitive cluster map
  ├── XRL_PROFILES      — Task profiles (5 modes)
  ├── XRL_EXPANSION     — Expansion rules
  ├── XRL_MM_HOOKS      — Multimodal hook config (TTS)
  ├── XRL_MEMORY_DATA   — SQLite DB + TF-IDF index
  ├── XRL_MEMORY_SCHEMA — 6-ring policy config
  └── RUNTIME_META      — Build info, version, flags
```

### 4.4 Packing Flags

The default flags for Gemma-4-12B-MoQ:
```python
GEMMA4_DEFAULT_FLAGS =
    HAS_CORE_GGUF | IS_MULTIMODAL | HAS_MM_HOOKS |
    HAS_EMBEDDED_MEMORY | HAS_MEMORY_SCHEMA | MEMORY_PERSISTENT |
    CORE_IS_GGUF_MoQ | STT_NATIVE | VISION_NATIVE
```

---

## 5. Verification

### 5.1 Self-Test (No GGUF Required)

```powershell
python run_xrlf.py --test
```

This packs a stub `.xrlf` (no GGUF core), loads it, and runs sample chats including:
- Reasoning prompt
- Code generation prompt
- Vision prompt (hook fire check)
- Memory recall test

### 5.2 Memory Persistence Test

```powershell
python memory/init_memory.py
```

Expected output:
```
Ring 0 [identity]    ✅ persisted
Ring 1 [task]        ✅ persisted
Ring 2 [recent]      ✅ persisted
Ring 3 [working]     ✅ persisted
Ring 4 [background]  ✅ persisted
Ring 5 [archive]     ✅ persisted
All 6 rings verified. Persistence: OK.
```

### 5.3 Multimodal Hook Validation

```powershell
python tools/validate_mm_hooks.py
```

### 5.4 Benchmark Suite

```powershell
# Full suite
python benchmark_run.py

# Quick (5 questions per track)
python benchmark_run.py --quick

# Single track
python benchmark_run.py --track reasoning
```

---

## 6. Memory Initialization

### 6.1 Six-Ring Foveated Memory

The embedded memory engine uses 6 conceptual rings:

| Ring | Label | Purpose | TTL |
|---|---|---|---|
| 0 | `identity` | Persistent model persona / system context | ∞ |
| 1 | `task` | Current task / goal framing | ∞ |
| 2 | `recent` | Last 8 turns (verbatim) | 8 turns |
| 3 | `working` | Last 32 turns (compressed) | 32 turns |
| 4 | `background` | Last 128 turns (heavily compressed) | 128 turns |
| 5 | `archive` | Long-term semantic summaries (TF-IDF retrieved) | ∞ |

### 6.2 Storage

- **SQLite** — single table `turns` with `ring` integer column + `session_id` filtering
- **TF-IDF** — in-process semantic search index for ring 5 (archive) recall
- **Persistence** — memory is re-packed into the `.xrlf` file on session close

### 6.3 Initialize Memory

```powershell
python memory/init_memory.py
```

### 6.4 Cloud Memory (Distributed Persistence)

For cross-machine continuity, the memory engine supports a cloud sync layer:

```powershell
# Set cloud store URL
set XRLF_CLOUD_MEMORY_URL=postgresql://user:pass@host:5432/xrlf

# Or use SQLite cloud (Turso, libSQL)
set XRLF_CLOUD_MEMORY_URL=libsql://xrlf.turso.io

# Run wake-up test (verifies cross-instance recall)
python memory/wake_up_test.py
```

See `memory/cloud_sync.py` for the sync adapter implementation.

---

## 7. Multimodal Hook Wiring

### 7.1 Native vs. Hook Capabilities

| Modality | Input | Output | Notes |
|---|---|---|---|
| Text | ✅ Native (Gemma-4) | ✅ Native | Core GGUF |
| Image | ✅ Native (Gemma-4 vision) | ❌ Hook | `ImageGenHook` → Stable Diffusion |
| Video | ✅ Native (Gemma-4 temporal) | ❌ | No output hook |
| Audio/STT | ✅ Native (Gemma-4) | ❌ Hook | `TTSHook` → Kokoro/Piper/espeak |
| Music | ❌ | ❌ Hook | `AudioGenHook` → stub (future) |

### 7.2 TTS Hook Configuration

Edit `xrlf_config.yaml`:

```yaml
tts:
  enabled: true
  engine: auto            # auto-detect provider
  provider: http          # preferred provider
  endpoint: http://127.0.0.1:8004/tts
  voice: default
  fallback: [http, piper, espeak, stub]
```

Provider auto-detection order:
1. **HTTP TTS service** — POST to endpoint (XRLF TTS at :8004)
2. **Kokoro** — local Python `kokoro` package (KPipeline)
3. **Piper** — local `piper` executable
4. **espeak-ng** — local `espeak-ng` executable
5. **Stub** — log event, return None

### 7.3 Hook Event Schema

All hooks emit events with this schema:
```json
{
  "hook": "tts|image_gen|audio_gen",
  "status": "ok|stub|error",
  "payload": { ... },
  "output": "path or null",
  "schema_version": 1,
  "message": "human-readable"
}
```

---

## 8. Known Failure Modes & Fixes

### 8.1 GGUF Loading Failures

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: llama_cpp` | Not installed / wrong venv | `pip install llama-cpp-python` with CUDA index |
| `RuntimeError: CUDA error` | VRAM insufficient | Reduce `n_ctx` in config, use MoQ-3.0 (3.78 GB) |
| `OOM during generation` | Context too large | Lower `n_ctx` or `gpu_layers` |
| Model loads but no output | Stub mode (no GGUF) | Check `gguf_source` path in config |

### 8.2 Memory Failures

| Symptom | Cause | Fix |
|---|---|---|
| Memory not persisting | `persistent_memory: false` | Set `persistent_memory: true` in config |
| Re-pack fails | `.xrlf` is read-only | Check file permissions, close other processes |
| TF-IDF recall empty | No turns stored | Run `memory/init_memory.py` to seed |
| Ring data missing | Wrong `session_id` | Verify session ID matches between runs |

### 8.3 Multimodal Failures

| Symptom | Cause | Fix |
|---|---|---|
| TTS returns None | All providers unavailable | Falls back to stub (expected); install Piper or run XRLF TTS |
| Image gen returns None | No SD endpoint | Expected in stub mode; start A1111/ComfyUI on :7860 |
| Hook not firing | Registry not loaded | Check `XRL_MM_HOOKS` section exists in `.xrlf` |
| Schema validation fails | Malformed hook config | Re-pack with `packer.add_multimodal_hooks()` |

### 8.4 Build/Pack Failures

| Symptom | Cause | Fix |
|---|---|---|
| `.xrlf` too small | GGUF path missing | Verify `gguf_source` in `xrlf_config.yaml` |
| `SectionType` mismatch | Corrupted section table | Re-pack from scratch |
| `flash-attn` install fails | CUDA version mismatch | Use included `.whl` or skip (only needed for distillation) |

### 8.5 Platform Notes

- **Windows-native**: All paths use forward slashes in config; backslashes in PowerShell
- **Flash-attn**: Use the included `.whl` file: `pip install flash_attn_3-3.0.0+...whl`
- **VRAM budgets**: MoQ-3.5 needs ~10 GB VRAM for full offload; MoQ-3.0 needs ~8 GB
- **Temp files**: Runtime extracts GGUF + memory to `%TEMP%/xrlf_*` — cleaned on close

---

## 9. File Manifest

### 9.1 Repository Structure

```
xrlf-model/
  formats/            ← XRLF binary format (schema, parser, packer)
  builder/            ← Distillation + packing pipeline
  runtime/            ← Main orchestrator + XRL cognitive steering
  llama_bridge/        ← llama-cpp-python wrapper
  memory/             ← In-process foveated memory engine
  tools/              ← Multimodal hooks (TTS auto-detect)
  api/                ← OpenAI-compatible REST API
  xrl_encoded/        ← XRL JSON artifacts (distilled from Qwen3.5-4B)
  foveated-memory/    ← Original Foveated Memory system (Node.js)
  xrlf_config.yaml   ← Master config
  run_xrlf.py        ← One-command launcher
  requirements.txt
  BUILD.md            ← This file
```

### 9.2 Generating a SHA-256 Manifest

```powershell
python _forge/build_manifest.py
```

This reads the `.xrlf` header and section table, computes per-section SHA-256 hashes (fast, kilobytes), and outputs a manifest table. Full-file SHA-256 is reserved for release builds.

---

## 10. Extending the Format

### 10.1 Adding a New XRL Section

1. Add a new `SectionType` enum value in `formats/xrlf_schema.py`
2. Implement packing in `formats/xrlf_packer.py`
3. Implement parsing in `formats/xrlf_parser.py`
4. Add handling in `runtime/xrlf_runtime.py` if needed at runtime

### 10.2 Swapping the Core GGUF

1. Update `gguf_source` in `xrlf_config.yaml` to the new GGUF path
2. Update `base_model_name` in the packer call if the model name changes
3. Re-pack: `python run_xrlf.py --pack`
4. Test: `python run_xrlf.py --test`

### 10.3 Re-distilling XRL from a New Source

1. Point `builder/distillation/distill_xrl.py` to the new source model
2. Run distillation → new `xrl_encoded/*.json` artifacts
3. Re-pack the `.xrlf` file

---

## Version

- **Manual version**: 1.0
- **XRLF format version**: 1
- **Core model**: Gemma-4-12B-it-qat-GGUF-MoQ (MoQ-3.5)
- **XRL source**: Qwen3.5-4B
- **Last updated**: 2026-08-05
