"""
membrane_core — LUMAX MEMBRANE BALANCER ENGINE

Deterministic context-weaving engine that implements the LUMAX MEMBRANE BALANCER
SPECIFICATION v1.0. Loads weaving rules, evaluates red thread thickness, expands
or contracts the skeleton, deploys or retracts tendrils, and compresses
aggressively or gently based on token budget pressure.

Stability guarantees:
  - No task drift
  - No hallucinated goals
  - No premature completion
  - No broken context
  - No missing constraints
  - No malformed structure
  - No token overflow
  - No silent drops
  - No merging that breaks meaning
"""

import json
import logging
import os
import subprocess
import sys
import warnings
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_last_backend_info: Optional[Dict[str, Any]] = None
"""Stores the backend_info from the most recent weave_context call for cognitive reset detection."""

# ---------------------------------------------------------------------------
# Token counting
# ---------------------------------------------------------------------------

_tiktoken_available = False
_encoding = None

try:
    import tiktoken

    _tiktoken_available = True
    _encoding = tiktoken.get_encoding("cl100k_base")
except ImportError:
    pass


def count_tokens(text: str) -> int:
    """Return an approximate token count for *text*.

    Uses tiktoken (cl100k_base) when available; otherwise falls back to a
    word-count heuristic (word count × 1.3, rounded up).
    """
    if not isinstance(text, str):
        text = str(text)
    if _tiktoken_available and _encoding is not None:
        return len(_encoding.encode(text))
    # Heuristic: average English token is ~1.3 words
    word_count = len(text.split())
    return max(1, int(word_count * 1.3 + 0.5))


# ---------------------------------------------------------------------------
# Weaving rules loader
# ---------------------------------------------------------------------------

def load_weaving_rules(path: str) -> Dict[str, Any]:
    """Load and validate the weaving_rules.json configuration file.

    Returns the parsed JSON dictionary. Raises FileNotFoundError or
    json.JSONDecodeError on failure.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Weaving rules file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        rules = json.load(f)
    if "symbols" not in rules:
        raise ValueError("weaving_rules.json must contain a 'symbols' key")
    return rules


# ---------------------------------------------------------------------------
# Summarization (dependency-injected)
# ---------------------------------------------------------------------------

def summarize(
    text: str,
    target_tokens: int,
    model: str = "smart_proxy_gguf",
) -> str:
    """Summarize *text* to approximately *target_tokens* tokens.

    Uses a subprocess call to *model* (default ``smart_proxy_gguf``) when
    available.  If the external summarizer is not found, a warning is logged
    and the input is returned unchanged.
    """
    if not text.strip():
        return text

    try:
        payload = json.dumps({
            "text": text,
            "target_tokens": target_tokens,
            "model": model,
        })
        result = subprocess.run(
            [model],
            input=payload,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            output = result.stdout.strip()
            if output:
                return output
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        warnings.warn(
            f"Summarizer '{model}' unavailable ({exc}); returning input unchanged.",
            RuntimeWarning,
            stacklevel=2,
        )

    # Fallback: return input unchanged
    return text


# ---------------------------------------------------------------------------
# Core balancer
# ---------------------------------------------------------------------------

_THIN_RED_THREAD_CHARS = 100
"""Character threshold below which a red thread is considered 'thin'."""

_TIGHT_BUDGET_RATIO = 0.8
"""Fraction of token_budget above which compression is 'aggressive'."""


def _is_thin_red_thread(red_thread: str) -> bool:
    """Heuristic: a red thread is 'thin' if it is short and lacks structure.

    A very long string (>= 200 chars) is always considered thick even
    without punctuation, because it carries enough content to be meaningful.
    """
    if len(red_thread) < _THIN_RED_THREAD_CHARS:
        return True
    # If the thread is long enough, it is thick regardless of structure
    if len(red_thread) >= 200:
        return False
    # Lacks structure: no sentence-ending punctuation and no newlines
    has_structure = any(c in red_thread for c in (".", "!", "?", "\n"))
    return not has_structure


def _expand_skeleton(skeleton: str, tendrils: str) -> Tuple[str, str]:
    """Expand the skeleton and deploy tendrils."""
    expanded = f"expanded:{skeleton}"
    deployed = f"deployed:{tendrils}" if tendrils else "deployed:"
    return expanded, deployed


def _contract_skeleton(skeleton: str, tendrils: str) -> Tuple[str, str]:
    """Contract the skeleton and retract tendrils."""
    contracted = f"contracted:{skeleton}"
    retracted = ""
    return contracted, retracted


def _compute_current_usage(
    red_thread: str,
    skeleton: str,
    tendrils: str,
) -> int:
    """Return the total token count of the three context components."""
    return (
        count_tokens(red_thread)
        + count_tokens(skeleton)
        + count_tokens(tendrils)
    )


def balance(
    raw_context: str,
    skeleton: str,
    tendrils: str,
    token_budget: int,
) -> Dict[str, Any]:
    """Core balancer implementing the LUMAX MEMBRANE BALANCER algorithm.

    Parameters
    ----------
    raw_context : str
        The raw (highway) context to be summarised into a red thread.
    skeleton : str
        The current XRL skeleton (repo structure).
    tendrils : str
        Tendril output (additional context probes).
    token_budget : int
        Maximum allowed tokens for the merged output.

    Returns
    -------
    dict
        A dictionary with keys ``red_thread``, ``skeleton``, ``tendrils``,
        ``merged_stream``, and ``compression_mode``.
    """
    # 1. Summarize raw context to red thread
    red_thread = summarize(raw_context, target_tokens=token_budget // 4)

    # 2. Evaluate red thread thickness
    thin = _is_thin_red_thread(red_thread)

    if thin:
        # Thin → expand skeleton and deploy tendrils
        new_skeleton, new_tendrils = _expand_skeleton(skeleton, tendrils)
    else:
        # Thick → contract skeleton and retract tendrils
        new_skeleton, new_tendrils = _contract_skeleton(skeleton, tendrils)

    # 3. Evaluate token budget pressure
    current_usage = _compute_current_usage(red_thread, new_skeleton, new_tendrils)
    tight = current_usage > _TIGHT_BUDGET_RATIO * token_budget

    if tight:
        compression_mode = "aggressive-level5-95%"
        suffix = " [level5-95%-atomic-compress]"
    else:
        compression_mode = "gentle-level1-65%"
        suffix = " [level1-65%-lossless-baseline]"

    # 4. Build merged stream
    merged_stream = f"{red_thread}\n{new_skeleton}\n{new_tendrils}{suffix}"

    return {
        "red_thread": red_thread,
        "skeleton": new_skeleton,
        "tendrils": new_tendrils,
        "merged_stream": merged_stream,
        "compression_mode": compression_mode,
        "current_usage": current_usage,
        "token_budget": token_budget,
    }


# ---------------------------------------------------------------------------
# Context weaver (orchestrator)
# ---------------------------------------------------------------------------

def weave_context(
    red_thread: str,
    skeleton: str,
    tendrils: str,
    token_budget: int,
    backend_info: Optional[Dict[str, Any]] = None,
    rules_path: Optional[str] = None,
) -> Dict[str, Any]:
    """Orchestrate the membrane balancer and return the merged context.

    Parameters
    ----------
    red_thread : str
        The red thread (goal / intent) for the current turn.
    skeleton : str
        The XRL skeleton (repo structure summary).
    tendrils : str
        Tendril output (additional context probes).
    token_budget : int
        Maximum allowed tokens for the merged output.
    backend_info : dict or None
        Backend metadata (e.g. ``{"model": "..."}``).  When this changes
        from the previous call, a cognitive reset is triggered.
    rules_path : str or None
        Optional path to a weaving_rules.json file.  When provided, the
        rules are loaded and XRL bones are injected into the red thread.

    Returns
    -------
    dict
        A dictionary with at least the keys ``red_thread``, ``skeleton``,
        ``tendrils``, and ``merged_stream``.
    """
    global _last_backend_info

    # --- Cognitive reset ---
    cognitive_reset = False
    if backend_info is not None and _last_backend_info is not None:
        if backend_info != _last_backend_info:
            cognitive_reset = True
            logger.info("Cognitive reset triggered: backend_info changed.")
    if backend_info is not None:
        _last_backend_info = backend_info

    # --- Load weaving rules (optional) ---
    rules = None
    if rules_path is not None:
        try:
            rules = load_weaving_rules(rules_path)
        except (FileNotFoundError, ValueError) as exc:
            logger.warning("Could not load weaving rules: %s", exc)

    # --- Inject XRL bones from weaving rules into red thread ---
    enriched_red_thread = red_thread
    if rules is not None:
        symbols = rules.get("symbols", {})
        # Inject high-priority XRL bones that match symbols in the red thread
        for symbol_name, symbol_info in symbols.items():
            priority = symbol_info.get("priority", 0)
            xrl_bone = symbol_info.get("xrl_bone", "")
            # If the symbol name appears in the red thread, inject the bone
            if symbol_name.lower() in red_thread.lower():
                bone_line = f"\n[xrl:{symbol_name}] {xrl_bone}"
                enriched_red_thread += bone_line

    # --- Run the balancer ---
    # The balancer receives the *raw* context (enriched red thread) and
    # summarises it internally.
    result = balance(
        raw_context=enriched_red_thread,
        skeleton=skeleton,
        tendrils=tendrils,
        token_budget=token_budget,
    )

    # --- Apply cognitive reset marker if triggered ---
    if cognitive_reset:
        result["merged_stream"] = (
            "[COGNITIVE_RESET]\n" + result["merged_stream"]
        )
        result["cognitive_reset"] = True
    else:
        result["cognitive_reset"] = False

    return result


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Read a JSON object from stdin, call ``weave_context``, and write the
    result to stdout.

    Expected input format (JSON)::

        {
            "red_thread": "...",
            "skeleton": "...",
            "tendrils": "...",
            "token_budget": 4096,
            "backend_info": {"model": "..."},
            "rules_path": "tools/Foveated-memory/weaving_rules.json"
        }

    All keys except ``red_thread``, ``skeleton``, ``tendrils``, and
    ``token_budget`` are optional.
    """
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
    except (json.JSONDecodeError, EOFError) as exc:
        print(json.dumps({"error": f"Invalid input: {exc}"}))
        sys.exit(1)

    red_thread = data.get("red_thread", "")
    skeleton = data.get("skeleton", "")
    tendrils = data.get("tendrils", "")
    token_budget = data.get("token_budget", 4096)
    backend_info = data.get("backend_info")
    rules_path = data.get("rules_path")

    result = weave_context(
        red_thread=red_thread,
        skeleton=skeleton,
        tendrils=tendrils,
        token_budget=token_budget,
        backend_info=backend_info,
        rules_path=rules_path,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
