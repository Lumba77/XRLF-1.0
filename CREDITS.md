# XRLF Model & Protocol — Credits & Acknowledgements

## Inspirations & Prior Art

### TokenSlayer
The structural skeletonization approach used in the **XRLF Native Skeletonizer** was directly inspired by the **TokenSlayer** VS Code plugin and standalone tool.

TokenSlayer pioneered the concept of compacting source code into structural skeletons (signatures, imports, decorators — stripped of bodies) to dramatically reduce token usage in AI-assisted development workflows. Their work demonstrated that **40–99.5% context reduction** was achievable without sacrificing code comprehension, and that idea fundamentally shaped how XRLF approaches its own context compression pipeline.

While the XRLF skeletonizer is an independent, self-contained native JS implementation (with no runtime dependency on the TokenSlayer codebase), we owe a clear creative debt to the TokenSlayer team for demonstrating the viability of this approach.

Thank you for inspiring us to push this research further.

---

## Open Source Dependencies

| Library | Purpose | License |
| :--- | :--- | :--- |
| `unsloth` | High-speed, memory-efficient LoRA fine-tuning | Apache 2.0 |
| `llama.cpp` | Local GGUF inference server | MIT |
| `transformers` | Base model loading and tokenisation | Apache 2.0 |
| `datasets` | Training dataset loading | Apache 2.0 |
| `torch` | GPU tensor operations during training | BSD-3 |
| `Qwen2.5-3B-Instruct` | Base model (fine-tuned) | Apache 2.0 |
| `Kokoro` | Text-to-speech audio generation | Apache 2.0 |
| `express` | HTTP server for the Foveated Memory proxy | MIT |

---

## Project
**XRLF (Extended Reasoning Language Framework)** is developed as part of the **XRLF Diamond Concordia** project.

