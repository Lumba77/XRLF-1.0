"""
api/server.py — OpenAI-Compatible REST API for XRLF
====================================================
Exposes the XRLFRuntime as an OpenAI-compatible endpoint.
Point LM Studio, Open WebUI, Antigravity, or any OpenAI SDK at:

    http://localhost:8300/v1

Endpoints:
  GET  /health
  GET  /v1/models
  POST /v1/chat/completions   (streaming + non-streaming)
  POST /v1/completions

Usage:
  python api/server.py --model gemma-4-12b-xrl.xrlf --port 8300
"""

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from typing import Any, AsyncGenerator, Dict, List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

try:
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, StreamingResponse
    import uvicorn
    from pydantic import BaseModel
    _FASTAPI = True
except ImportError:
    _FASTAPI = False

from runtime.xrlf_runtime import XRLFRuntime


# ── Pydantic models ───────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: Any   # str or list (multimodal)

class ChatCompletionRequest(BaseModel):
    model: str = ""
    messages: List[ChatMessage]
    max_tokens: Optional[int] = 1024
    temperature: Optional[float] = None
    stream: Optional[bool] = False
    # XRLF extensions
    xrlf_force_profile: Optional[str] = None

class CompletionRequest(BaseModel):
    model: str = ""
    prompt: str
    max_tokens: Optional[int] = 512
    temperature: Optional[float] = 0.7
    stream: Optional[bool] = False


# ── App factory ───────────────────────────────────────────────────────────────

def create_app(runtime: XRLFRuntime) -> "FastAPI":
    if not _FASTAPI:
        raise RuntimeError("fastapi + uvicorn not installed. Run: pip install fastapi uvicorn[standard]")

    app = FastAPI(
        title="XRLF Runtime API",
        version="1.0.0",
        description="OpenAI-compatible API for XRLF hybrid models",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Health ────────────────────────────────────────────────────────────────

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "model": runtime.model_name,
            "runtime": "xrlf-1.0",
            "loaded": runtime.loaded,
        }

    # ── Models ────────────────────────────────────────────────────────────────

    @app.get("/v1/models")
    async def list_models():
        model_id = runtime.model_name or "xrlf-model"
        return {
            "object": "list",
            "data": [{
                "id": model_id,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "xrlf-runtime",
                "capabilities": {
                    "vision": True,
                    "audio": True,
                    "video": True,
                    "tts": True,
                    "xrl_cognitive_layer": True,
                    "foveated_memory": True,
                },
            }],
        }

    # ── Chat completions ──────────────────────────────────────────────────────

    @app.post("/v1/chat/completions")
    async def chat_completions(req: ChatCompletionRequest, request: Request):
        messages = [m.model_dump() for m in req.messages]

        # Detect multimodal content
        has_image = has_audio = has_video = False
        for m in messages:
            content = m.get("content", "")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        t = part.get("type", "")
                        if t in ("image_url", "image"):
                            has_image = True
                        elif t in ("audio_url", "audio", "input_audio"):
                            has_audio = True

        completion_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        model_id = runtime.model_name or "xrlf-model"

        if req.stream:
            return StreamingResponse(
                _stream_chat(
                    runtime, messages, req, has_image, has_audio, has_video,
                    completion_id, model_id
                ),
                media_type="text/event-stream",
            )

        # Non-streaming
        try:
            response_text = runtime.chat(
                messages=messages,
                max_tokens=req.max_tokens,
                temperature=req.temperature,
                stream=False,
                has_image=has_image,
                has_audio=has_audio,
                has_video=has_video,
                force_profile=req.xrlf_force_profile,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

        return {
            "id": completion_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_id,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": response_text},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": -1,
                "completion_tokens": -1,
                "total_tokens": -1,
            },
        }

    async def _stream_chat(
        runtime, messages, req, has_image, has_audio, has_video,
        completion_id, model_id
    ) -> AsyncGenerator[str, None]:
        """SSE streaming generator."""
        try:
            gen = runtime.chat(
                messages=messages,
                max_tokens=req.max_tokens,
                temperature=req.temperature,
                stream=True,
                has_image=has_image,
                has_audio=has_audio,
                has_video=has_video,
                force_profile=req.xrlf_force_profile,
            )
            for chunk in gen:
                data = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model_id,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": chunk},
                        "finish_reason": None,
                    }],
                }
                yield f"data: {json.dumps(data)}\n\n"
                await asyncio.sleep(0)
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            done = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model_id,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            yield f"data: {json.dumps(done)}\n\n"
            yield "data: [DONE]\n\n"

    # ── Raw completions ───────────────────────────────────────────────────────

    @app.post("/v1/completions")
    async def completions(req: CompletionRequest):
        try:
            text = runtime.generate(
                req.prompt,
                max_tokens=req.max_tokens,
                temperature=req.temperature,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

        return {
            "id": f"cmpl-{uuid.uuid4().hex[:12]}",
            "object": "text_completion",
            "created": int(time.time()),
            "model": runtime.model_name,
            "choices": [{
                "text": text,
                "index": 0,
                "finish_reason": "stop",
            }],
        }

    return app


# ── CLI entry point ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="XRLF OpenAI-compatible API server")
    parser.add_argument("--model", required=True, help="Path to .xrlf file")
    parser.add_argument("--port", type=int, default=8300, help="API port (default: 8300)")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address")
    parser.add_argument("--gpu-layers", type=int, default=-1, help="GPU layers (-1=all)")
    parser.add_argument("--ctx", type=int, default=8192, help="Context window size")
    parser.add_argument("--session", default="default", help="Session ID for memory")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    runtime = XRLFRuntime(
        xrlf_path=args.model,
        session_id=args.session,
        n_gpu_layers=args.gpu_layers,
        n_ctx=args.ctx,
        verbose=args.verbose,
    )
    runtime.load()

    app = create_app(runtime)

    print(f"\n  🚀 XRLF API ready → http://{args.host}:{args.port}/v1")
    print(f"     Model: {runtime.model_name}")
    print(f"     Point LM Studio / Open WebUI / Antigravity at this endpoint\n")

    try:
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    finally:
        runtime.close()


if __name__ == "__main__":
    main()
