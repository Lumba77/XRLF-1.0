"""
llama_bridge/llama_engine.py — llama-cpp-python Wrapper
========================================================
Thin, fault-tolerant wrapper around llama-cpp-python for the XRLF runtime.

Gemma-4-12B MoQ supports native multimodal input (image, video, audio).
This engine handles the multimodal chat template for llama.cpp.
"""

import os
import sys
import json
import tempfile
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional, Union

# ── llama-cpp-python import (with helpful error if not installed) ──────────────

try:
    from llama_cpp import Llama, LlamaGrammar
    _LLAMA_AVAILABLE = True
except ImportError:
    _LLAMA_AVAILABLE = False
    Llama = None


LLAMA_INSTALL_HINT = """
llama-cpp-python is not installed.

Install with CUDA support (recommended for Gemma-4-12B):

    pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

Or CPU-only:

    pip install llama-cpp-python
"""


class LlamaEngine:
    """
    Wraps a llama.cpp model loaded from a GGUF path.

    Supports:
      - Text generation (generate)
      - Chat completion (chat) with automatic template application
      - Text embedding (embed) for semantic cluster routing
      - Streaming generation (generate_stream)
    """

    def __init__(
        self,
        gguf_path: str,
        n_gpu_layers: int = -1,      # -1 = offload all layers
        n_ctx: int = 8192,
        n_threads: Optional[int] = None,
        verbose: bool = False,
        flash_attn: bool = True,
        mmproj_path: Optional[str] = None,
        draft_model_path: Optional[str] = None,
    ):
        if not _LLAMA_AVAILABLE:
            raise RuntimeError(LLAMA_INSTALL_HINT)

        self.gguf_path = str(gguf_path)
        self.n_gpu_layers = n_gpu_layers
        self.n_ctx = n_ctx
        self.n_threads = n_threads or os.cpu_count()
        self.verbose = verbose
        self.flash_attn = flash_attn
        self.mmproj_path = mmproj_path
        self.draft_model_path = draft_model_path
        self._llm: Optional[Llama] = None
        self.loaded = False


    def load(self) -> "LlamaEngine":
        if self.loaded:
            return self
        if not Path(self.gguf_path).exists():
            raise FileNotFoundError(f"GGUF not found: {self.gguf_path}")

        print(f"  Loading GGUF: {self.gguf_path}")
        print(f"    n_ctx={self.n_ctx}  gpu_layers={self.n_gpu_layers}  threads={self.n_threads}")

        kwargs = dict(
            model_path=self.gguf_path,
            n_ctx=self.n_ctx,
            n_gpu_layers=self.n_gpu_layers,
            n_threads=self.n_threads,
            verbose=self.verbose,
            n_batch=128,
        )
        # Flash Attention 3 support (if the wheel is available)
        if self.flash_attn:
            kwargs["flash_attn"] = True

        # Multimodal Chat Handler
        if self.mmproj_path and Path(self.mmproj_path).exists():
            print(f"  Loading MMPROJ handler: {self.mmproj_path}")
            try:
                from llama_cpp.llama_chat_format import Qwen25VLChatHandler, Llava15ChatHandler
                # Attempt to use Qwen2.5-VL handler, fallback to LLaVA 1.5 if missing
                # Some llama-cpp-python versions might not have Qwen25VLChatHandler exported
                kwargs["chat_handler"] = Qwen25VLChatHandler(clip_model_path=self.mmproj_path)
            except ImportError:
                # Fallback to generic Llava if Qwen25VLChatHandler is missing
                from llama_cpp.llama_chat_format import Llava15ChatHandler
                kwargs["chat_handler"] = Llava15ChatHandler(clip_model_path=self.mmproj_path)
            except AttributeError:
                # If Qwen25VLChatHandler is not in llama_chat_format
                from llama_cpp.llama_chat_format import Llava15ChatHandler
                kwargs["chat_handler"] = Llava15ChatHandler(clip_model_path=self.mmproj_path)

        from llama_cpp import Llama
        # Speculative Decoding (Draft Model)
        if self.draft_model_path and Path(self.draft_model_path).exists():
            print(f"  Loading DRAFT GGUF (Speculative Decoding): {self.draft_model_path}")
            try:
                from llama_cpp import Llama
                from llama_cpp.llama_speculative import LlamaDraftModel
                import numpy as np

                class GGUFDraftModel(LlamaDraftModel):
                    def __init__(self, draft_llm, num_pred_tokens=3):
                        self.draft_llm = draft_llm
                        self.num_pred_tokens = num_pred_tokens

                    def __call__(self, input_ids, /, **kwargs):
                        # Guard: empty or too-short prefix collapses the broadcast
                        if input_ids is None or len(input_ids) == 0:
                            return np.array([], dtype=np.intc)
                        try:
                            tokens = []
                            # top_p=1.0 avoids the (0,) broadcast — top_k=1 is greedy
                            for t in self.draft_llm.generate(
                                input_ids.tolist(), top_k=1, top_p=1.0, temp=0.0
                            ):
                                tokens.append(t)
                                if len(tokens) >= self.num_pred_tokens:
                                    break
                            return np.array(tokens, dtype=np.intc)
                        except Exception:
                            return np.array([], dtype=np.intc)

                draft_llm = Llama(
                    model_path=self.draft_model_path,
                    n_gpu_layers=self.n_gpu_layers,
                    n_ctx=self.n_ctx,
                    verbose=self.verbose
                )
                kwargs["draft_model"] = GGUFDraftModel(draft_llm)
            except ImportError:
                print("  ⚠️ Warning: LlamaDraftModel not found in this llama-cpp-python version. Skipping speculative decoding.")

        self._llm = Llama(**kwargs)
        self.loaded = True
        print("  ✅ GGUF loaded into llama.cpp")
        return self

    def unload(self):
        self._llm = None
        self.loaded = False

    # ── Generation ────────────────────────────────────────────────────────────

    def generate(
        self,
        prompt: str,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.95,
        repeat_penalty: float = 1.1,
        stop: Optional[List[str]] = None,
    ) -> str:
        """Raw text completion."""
        self._require_loaded()
        result = self._llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            repeat_penalty=repeat_penalty,
            stop=stop or ["<end_of_turn>", "<eos>"],
            echo=False,
        )
        return result["choices"][0]["text"]

    def generate_stream(
        self,
        prompt: str,
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.95,
        stop: Optional[List[str]] = None,
    ) -> Generator[str, None, None]:
        """Streaming text completion — yields token chunks."""
        self._require_loaded()
        for chunk in self._llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            stop=stop or ["<end_of_turn>", "<eos>"],
            stream=True,
            echo=False,
        ):
            delta = chunk["choices"][0].get("text", "")
            if delta:
                yield delta

    def chat(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int = 1024,
        temperature: float = 0.7,
        stream: bool = False,
    ) -> Union[str, Generator[str, None, None]]:
        """
        Chat completion using the model's built-in chat template.
        Messages format: [{"role": "user"|"assistant"|"system", "content": "..."}]

        For multimodal (Gemma-4 native):
          content can also be a list:
          [{"type": "text", "text": "..."}, {"type": "image_url", "image_url": {...}}]
        """
        self._require_loaded()
        if stream:
            return self._chat_stream(messages, max_tokens, temperature)
        result = self._llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stop=["<end_of_turn>"],
        )
        return result["choices"][0]["message"]["content"]

    def _chat_stream(
        self,
        messages: List[Dict[str, str]],
        max_tokens: int,
        temperature: float,
    ) -> Generator[str, None, None]:
        for chunk in self._llm.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stop=["<end_of_turn>"],
            stream=True,
        ):
            delta = chunk["choices"][0]["delta"].get("content", "")
            if delta:
                yield delta

    def embed(self, text: str) -> List[float]:
        """
        Generate a text embedding vector.
        Used for semantic cluster activation scoring.
        Falls back to empty list if embedding not supported.
        """
        self._require_loaded()
        try:
            result = self._llm.embed(text)
            # llama_cpp returns list or ndarray
            if hasattr(result, "tolist"):
                return result.tolist()
            return list(result)
        except Exception:
            return []

    def tokenize(self, text: str) -> List[int]:
        self._require_loaded()
        return self._llm.tokenize(text.encode("utf-8"))

    def token_count(self, text: str) -> int:
        return len(self.tokenize(text))

    def _require_loaded(self):
        if not self.loaded or self._llm is None:
            raise RuntimeError("LlamaEngine not loaded — call .load() first")

    # ── Context ───────────────────────────────────────────────────────────────

    @property
    def context_length(self) -> int:
        return self.n_ctx

    def __repr__(self) -> str:
        status = "loaded" if self.loaded else "unloaded"
        return f"LlamaEngine({Path(self.gguf_path).name}, {status}, ctx={self.n_ctx})"
