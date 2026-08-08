"""
tools/mm_hooks.py — Multimodal Tool Hooks
==========================================
Gemma-4-12B handles natively: image in, video in, audio/speech in, text in/out.
The ONLY external tool needed is TTS for voice output.

This module provides:
  - TTSHook: Text-to-speech (auto-detects Kokoro → Piper → stub)
  - ImageGenHook: Optional image generation (stub → Stable Diffusion)
  - AudioGenHook: Optional audio/music generation (stub)

All hooks are non-blocking and fail gracefully — they log and return
a placeholder if the external tool is unavailable.
"""

import json
import os
import subprocess
import sys
import tempfile
import wave
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional


# ── Base hook ─────────────────────────────────────────────────────────────────

class BaseHook(ABC):
    def __init__(self, config: dict = None):
        self.config = config or {}
        self.enabled = self.config.get("enabled", True)
        self._available: Optional[bool] = None
        self.on_hook_fire = None

    @property
    def available(self) -> bool:
        if self._available is None:
            self._available = self._check_availability()
        return self._available

    @abstractmethod
    def _check_availability(self) -> bool: ...

    def _log(self, msg: str):
        print(f"  [{self.__class__.__name__}] {msg}")

    def _emit_hook_event(self, hook_name: str, payload: dict, *, output=None, status: str = "ok", message: Optional[str] = None):
        event = {
            "hook": hook_name,
            "status": status,
            "payload": payload,
            "output": output,
            "schema_version": 1,
            "message": message or f"{hook_name} hook fired",
        }
        if self.on_hook_fire is not None:
            self.on_hook_fire(event)
        return event

    @staticmethod
    def validate_schema(result) -> bool:
        if not isinstance(result, dict):
            return False
        required = {"hook", "status", "payload", "output", "schema_version", "message"}
        if not required.issubset(result.keys()):
            return False
        if not isinstance(result["hook"], str):
            return False
        if result["status"] not in {"ok", "stub", "error"}:
            return False
        if not isinstance(result["payload"], dict):
            return False
        if result["schema_version"] != 1:
            return False
        return True


# ── TTS Hook ──────────────────────────────────────────────────────────────────

class TTSHook(BaseHook):
    """
    Text-to-Speech hook with a portable provider model.

    Supported provider types:
      - auto: choose the most usable provider in this order:
          * Lumax HTTP TTS service at http://127.0.0.1:8004/tts
          * KPipeline-backed Kokoro if the compatible package is installed
          * Piper
          * espeak-ng
          * stub
      - http: send requests to a configured TTS HTTP endpoint
      - kokoro: use a local Python Kokoro package if available
      - piper: use the local Piper executable
      - espeak: use the local espeak-ng executable
      - stub: emit events only and return None

    Usage:
        tts = TTSHook({"engine": "auto", "voice": "default"})
        wav_path = tts.speak("Hello, I am XRLF running Gemma-4.")
    """

    def __init__(self, config: dict = None):
        super().__init__(config)
        self.engine = self.config.get("engine", "auto")
        self.provider = self.config.get("provider", self.engine)
        self.voice = self.config.get("voice", "default")
        self.sample_rate = self.config.get("sample_rate", 22050)
        self.endpoint = self.config.get("endpoint", "http://127.0.0.1:8004/tts")
        self._resolved_engine: Optional[str] = None

    def _check_availability(self) -> bool:
        self._resolved_engine = self._detect_engine()
        return self._resolved_engine != "stub"

    def _provider_order(self):
        configured = self.config.get("fallback") or [self.provider or self.engine or "http"]
        order = []
        for item in configured:
            name = str(item).lower()
            if name in {"http", "kokoro", "piper", "espeak", "stub"} and name not in order:
                order.append(name)

        explicit = (self.provider or self.engine or "auto").lower()
        if explicit not in {"auto", "http", "kokoro", "piper", "espeak", "stub"}:
            explicit = "auto"

        if explicit != "auto":
            order = [explicit] + [p for p in order if p != explicit]
        elif not order:
            order = ["http", "piper", "espeak", "stub"]

        if order and order[-1] != "stub":
            order.append("stub")
        return order

    def _detect_engine(self) -> str:
        for provider in self._provider_order():
            if provider == "http":
                if _http_tts_available(self.endpoint):
                    return "http"
                continue
            if provider == "kokoro":
                try:
                    import kokoro  # noqa
                    if hasattr(kokoro, "KPipeline") or hasattr(kokoro, "generate"):
                        return "kokoro"
                except Exception:
                    pass
                continue
            if provider == "piper":
                for candidate in ["piper", "piper-tts", r"C:\Program Files\piper\piper.exe"]:
                    if _command_exists(candidate):
                        return "piper"
                continue
            if provider == "espeak":
                if _command_exists("espeak-ng") or _command_exists("espeak"):
                    return "espeak"
                continue
            if provider == "stub":
                return "stub"
        return "stub"

    def speak(self, text: str, output_path: Optional[str] = None) -> Optional[str]:
        """
        Synthesize speech from text.
        Returns path to a WAV file, or None if stub mode.
        """
        if not self.enabled:
            self._emit_hook_event(
                "tts",
                {"text": text, "output_path": output_path},
                output=None,
                status="stub",
                message="TTS hook disabled",
            )
            return None

        last_error = None
        for engine in self._provider_order():
            try:
                if engine == "http" and not _http_tts_available(self.endpoint):
                    last_error = RuntimeError(f"HTTP TTS unavailable at {self.endpoint}")
                    continue
                if engine == "kokoro":
                    try:
                        import kokoro  # noqa
                    except Exception as exc:
                        last_error = exc
                        continue
                    if not (hasattr(kokoro, "KPipeline") or hasattr(kokoro, "generate")):
                        last_error = RuntimeError("Compatible Kokoro API not available")
                        continue
                if engine == "piper" and not any(_command_exists(c) for c in ["piper", "piper-tts", r"C:\Program Files\piper\piper.exe"]):
                    last_error = RuntimeError("Piper executable not found")
                    continue
                if engine == "espeak" and not (_command_exists("espeak-ng") or _command_exists("espeak")):
                    last_error = RuntimeError("espeak-ng not found")
                    continue

                out = output_path or tempfile.mktemp(suffix=".wav")
                if engine == "http":
                    result = self._speak_http(text, out)
                    self._emit_hook_event("tts", {"text": text, "engine": engine, "provider": "http", "endpoint": self.endpoint}, output=result, status="ok")
                    return result
                elif engine == "kokoro":
                    result = self._speak_kokoro(text, out)
                    self._emit_hook_event("tts", {"text": text, "engine": engine, "provider": "kokoro"}, output=result, status="ok")
                    return result
                elif engine == "piper":
                    result = self._speak_piper(text, out)
                    self._emit_hook_event("tts", {"text": text, "engine": engine, "provider": "piper"}, output=result, status="ok")
                    return result
                elif engine == "espeak":
                    result = self._speak_espeak(text, out)
                    self._emit_hook_event("tts", {"text": text, "engine": engine, "provider": "espeak"}, output=result, status="ok")
                    return result
                else:
                    self._log(f"TTS stub — would speak: {text[:80]}...")
                    self._emit_hook_event(
                        "tts",
                        {"text": text, "engine": "stub", "provider": "stub"},
                        output=None,
                        status="stub",
                        message="TTS stub mode",
                    )
                    return None
            except Exception as e:
                last_error = e
                self._log(f"TTS failed ({engine}): {e}")
                continue

        self._emit_hook_event(
            "tts",
            {"text": text, "engine": self._detect_engine(), "provider": self.provider or self.engine or "auto"},
            output=None,
            status="error",
            message=str(last_error) if last_error else "No TTS provider available",
        )
        return None

    def _speak_http(self, text: str, out: str) -> str:
        import json
        import urllib.request

        payload = {
            "text": text,
            "voice": self.voice,
            "style": "default",
            "emotion": "neutral",
            "speed": 1.0,
        }
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            audio = response.read()
        Path(out).write_bytes(audio)
        return out

    def _speak_kokoro(self, text: str, out: str) -> str:
        import kokoro

        if hasattr(kokoro, "KPipeline"):
            pipeline = kokoro.KPipeline(lang_code="a")
            chunks = []
            for result in pipeline(text, voice=self.voice, speed=1.0):
                if hasattr(result, "audio"):
                    audio = result.audio
                elif isinstance(result, (tuple, list)) and len(result) >= 3:
                    audio = result[2]
                else:
                    audio = result
                if audio is not None:
                    chunks.append(audio)
            if not chunks:
                raise RuntimeError("Kokoro produced no audio")
            audio = chunks[0] if len(chunks) == 1 else _merge_audio_chunks(chunks)
            _save_wav(audio, 24000, out)
            return out

        if hasattr(kokoro, "generate"):
            audio, rate = kokoro.generate(text, voice=self.voice)
            _save_wav(audio, rate, out)
            return out

        raise RuntimeError("Compatible Kokoro API not available")

    def _speak_piper(self, text: str, out: str) -> str:
        cmd = ["piper", "--output_file", out]
        proc = subprocess.run(cmd, input=text.encode(), capture_output=True, timeout=30)
        if proc.returncode != 0:
            raise RuntimeError(f"Piper failed: {proc.stderr.decode()}")
        return out

    def _speak_espeak(self, text: str, out: str) -> str:
        cmd = ["espeak-ng", "-w", out, text]
        subprocess.run(cmd, check=True, timeout=15)
        return out


# ── Image Gen Hook ────────────────────────────────────────────────────────────

class ImageGenHook(BaseHook):
    """
    Optional image generation hook. Points to a local Stable Diffusion
    endpoint (A1111, ComfyUI). Returns None if unavailable.
    """

    def __init__(self, config: dict = None):
        super().__init__(config)
        self.endpoint = self.config.get("endpoint", "http://127.0.0.1:7860")

    def _check_availability(self) -> bool:
        try:
            import urllib.request
            urllib.request.urlopen(f"{self.endpoint}/sdapi/v1/sd-models", timeout=2)
            return True
        except Exception:
            return False

    def generate(self, prompt: str, output_path: Optional[str] = None) -> Optional[str]:
        if not self.enabled or not self.available:
            self._log(f"Image gen stub — would generate: {prompt[:60]}...")
            self._emit_hook_event(
                "image_gen",
                {"prompt": prompt, "endpoint": self.endpoint},
                output=None,
                status="stub",
                message="Image generation unavailable",
            )
            return None

        try:
            import json, urllib.request
            payload = json.dumps({
                "prompt": prompt,
                "steps": 20,
                "width": 512,
                "height": 512,
            }).encode()
            req = urllib.request.Request(
                f"{self.endpoint}/sdapi/v1/txt2img",
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                result = json.loads(resp.read())
            import base64
            img_data = base64.b64decode(result["images"][0])
            out = output_path or tempfile.mktemp(suffix=".png")
            Path(out).write_bytes(img_data)
            self._emit_hook_event(
                "image_gen",
                {"prompt": prompt, "endpoint": self.endpoint},
                output=out,
                status="ok",
                message="Image generated",
            )
            return out
        except Exception as e:
            self._log(f"Image gen failed: {e}")
            self._emit_hook_event(
                "image_gen",
                {"prompt": prompt, "endpoint": self.endpoint},
                output=None,
                status="error",
                message=str(e),
            )
            return None


# ── Audio Gen Hook ────────────────────────────────────────────────────────────

class AudioGenHook(BaseHook):
    """Optional music/sound generation stub."""

    def _check_availability(self) -> bool:
        return False  # Future sprint

    def generate(self, prompt: str) -> Optional[str]:
        self._log(f"Audio gen stub — would generate: {prompt[:60]}...")
        self._emit_hook_event(
            "audio_gen",
            {"prompt": prompt},
            output=None,
            status="stub",
            message="Audio generation unavailable",
        )
        return None


# ── Hook Registry ─────────────────────────────────────────────────────────────

class MMHookRegistry:
    """
    Loads multimodal hooks from the XRL_MM_HOOKS config and provides
    a unified interface for the runtime to call external tools.
    """

    def __init__(self, hooks_config: dict):
        external = hooks_config.get("external_hooks", {})
        self.tts = TTSHook(external.get("tts", {}))
        self.image_gen = ImageGenHook(external.get("image_gen", {}))
        self.audio_gen = AudioGenHook(external.get("audio_gen", {}))

        print(f"  MMHooks loaded:")
        print(f"    TTS engine     : {self.tts._detect_engine()}")
        print(f"    Image gen      : {'available' if self.image_gen.available else 'stub'}")
        print(f"    Audio gen      : stub (future sprint)")

    def set_hook_listener(self, callback):
        self.on_hook_fire = callback
        self.tts.on_hook_fire = callback
        self.image_gen.on_hook_fire = callback
        self.audio_gen.on_hook_fire = callback
        return self

    def speak(self, text: str) -> Optional[str]:
        return self.tts.speak(text)

    def generate_image(self, prompt: str) -> Optional[str]:
        return self.image_gen.generate(prompt)


# ── Utilities ─────────────────────────────────────────────────────────────────

def _command_exists(cmd: str) -> bool:
    try:
        subprocess.run([cmd, "--version"], capture_output=True, timeout=3)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _http_tts_available(endpoint: str) -> bool:
    try:
        import urllib.request
        req = urllib.request.Request(endpoint.replace("/tts", "/health"), method="GET")
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status == 200
    except Exception:
        return False


def _merge_audio_chunks(chunks):
    import numpy as np
    first = np.asarray(chunks[0], dtype=np.float32)
    if len(chunks) == 1:
        return first
    merged = np.concatenate([np.asarray(c, dtype=np.float32).reshape(-1) for c in chunks])
    return merged.astype(np.float32)


def _save_wav(audio_data, sample_rate: int, path: str):
    """Save float32 audio array to WAV file."""
    import array
    audio = list(audio_data)
    samples = array.array("h", (max(-32768, min(32767, int(s * 32767))) for s in audio))
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())
