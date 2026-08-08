import os
import json
from llama_cpp import Llama

# -----------------------------------------------------------
# CONFIG
# -----------------------------------------------------------

GGUF_MODEL_PATH = r"C:\Users\danie\.cache\huggingface\hub\models--unsloth--Qwen3.5-4B-MTP-GGUF\snapshots\86835bf9949e4d14d6860f7910b1340ad4f271a9\Qwen3.5-4B-UD-Q4_K_XL.gguf"

WORK_DIR = os.path.abspath(".")
XRL_DIR = os.path.join(WORK_DIR, "xrl_encoded")

os.makedirs(XRL_DIR, exist_ok=True)

THREAD_PROMPTS = [
    "Explain semantic compression.",
    "Write a Python function that adds two numbers.",
    "Describe pruning vs quantization.",
    "Summarize the concept of attention in transformers.",
]


# -----------------------------------------------------------
# LAYER 0 — GGUF MODEL LOAD
# -----------------------------------------------------------

def load_gguf_model():
    print(f"=== Loading GGUF model from: {GGUF_MODEL_PATH} ===")
    llm = Llama(
        model_path=GGUF_MODEL_PATH,
        n_ctx=4096,
        n_gpu_layers=-1
    )
    print("=== GGUF model loaded ===\n")
    return llm


# -----------------------------------------------------------
# LAYER 1 — XRL THREADING (GGUF)
# -----------------------------------------------------------

def xrl_trace_threads_gguf(llm):
    print("=== XRL threading (GGUF): tracing semantic paths via logits/confidence ===")

    threads = []

    for prompt in THREAD_PROMPTS:
        # echo=True returns prompt + completion tokens
        result = llm(
            prompt,
            max_tokens=128,
            echo=True,
            temperature=0.7
        )

        # llama_cpp returns text; token IDs are internal
        text = result["choices"][0]["text"]

        # Some builds expose logits; many do not.
        logits_seq = result.get("logits", None)

        if logits_seq is None:
            # Fallback: text-only thread
            threads.append({
                "prompt": prompt,
                "thread": {
                    "text": text,
                    "note": "logits not available; text-only thread"
                }
            })
            continue

        confidence_path = []
        for step_idx, step_logits in enumerate(logits_seq):
            # step_logits: list/array of logits for vocab
            avg_strength = sum(abs(l) for l in step_logits) / len(step_logits)
            confidence_path.append({
                "step": step_idx,
                "avg_logit_strength": avg_strength
            })

        threads.append({
            "prompt": prompt,
            "thread": {
                "text": text,
                "confidence_path": confidence_path
            }
        })

    threads_path = os.path.join(XRL_DIR, "threads_gguf.json")
    with open(threads_path, "w", encoding="utf-8") as f:
        json.dump(threads, f, indent=2)

    print(f"=== GGUF XRL threads saved to {threads_path} ===\n")
    return threads


# -----------------------------------------------------------
# LAYER 2 — XRL PRINCIPATION (GGUF)
# -----------------------------------------------------------

import math

def xrl_principiate_gguf(threads):
    print("=== XRL principiation (GGUF): richer sequence-level principles ===")

    principles = []

    for t in threads:
        prompt = t["prompt"]
        thread = t["thread"]

        text = thread.get("text", "")
        confidence_path = thread.get("confidence_path", None)

        if not confidence_path:
            principles.append({
                "prompt": prompt,
                "text_preview": text[:120],
                "principle_strength": None,
                "volatility": None,
                "trend": None,
                "role": "text_only_thread",
                "note": "no confidence path available"
            })
            continue

        strengths = [step["avg_logit_strength"] for step in confidence_path]
        if not strengths:
            principles.append({
                "prompt": prompt,
                "text_preview": text[:120],
                "principle_strength": None,
                "volatility": None,
                "trend": None,
                "role": "empty_confidence_path"
            })
            continue

        # Core metrics
        avg_strength = sum(strengths) / len(strengths)
        # Volatility: standard deviation of strength
        mean = avg_strength
        var = sum((s - mean) ** 2 for s in strengths) / len(strengths)
        volatility = math.sqrt(var)

        # Trend: compare early vs late confidence
        split = max(1, len(strengths) // 3)
        early = strengths[:split]
        late = strengths[-split:]
        early_avg = sum(early) / len(early)
        late_avg = sum(late) / len(late)
        trend_delta = late_avg - early_avg

        if trend_delta > 0:
            trend = "strengthening"
        elif trend_delta < 0:
            trend = "weakening"
        else:
            trend = "stable"

        # Role classification: rough semantic behavior
        if avg_strength > 0 and volatility < avg_strength * 0.1:
            role = "confident_consistent_sequence"
        elif volatility > avg_strength * 0.5:
            role = "highly_volatile_sequence"
        else:
            role = "mixed_confidence_sequence"

        principles.append({
            "prompt": prompt,
            "text_preview": text[:160],
            "principle_strength": avg_strength,
            "volatility": volatility,
            "trend": trend,
            "role": role,
            "early_strength": early_avg,
            "late_strength": late_avg
        })

    principles_path = os.path.join(XRL_DIR, "principles_gguf.json")
    with open(principles_path, "w", encoding="utf-8") as f:
        json.dump(principles, f, indent=2)

    print(f"=== GGUF XRL principles saved to {principles_path} ===\n")
    return principles

#
#  Semantic xrl graph
#

def xrl_semantic_graph_gguf(threads):
    print("=== XRL semantic graph (GGUF): extracting concept transitions ===")

    graph = {
        "nodes": {},
        "edges": []
    }

    for t in threads:
        prompt = t["prompt"]
        thread = t["thread"]
        text = thread.get("text", "")

        confidence_path = thread.get("confidence_path", None)
        if not confidence_path:
            continue

        # Tokenize text into rough semantic units
        tokens = text.split()
        if len(tokens) < 2:
            continue

        # Build node weights from confidence
        strengths = [step["avg_logit_strength"] for step in confidence_path]
        avg_strength = sum(strengths) / len(strengths)

        # Node creation
        for idx, tok in enumerate(tokens):
            if tok not in graph["nodes"]:
                graph["nodes"][tok] = {
                    "count": 0,
                    "strength_sum": 0.0,
                    "prompts": []
                }

            graph["nodes"][tok]["count"] += 1
            graph["nodes"][tok]["strength_sum"] += avg_strength
            graph["nodes"][tok]["prompts"].append(prompt)

        # Edge creation (token transitions)
        for i in range(len(tokens) - 1):
            a = tokens[i]
            b = tokens[i + 1]

            graph["edges"].append({
                "from": a,
                "to": b,
                "strength": avg_strength
            })

    # Normalize node weights
    for tok, info in graph["nodes"].items():
        info["importance"] = info["strength_sum"] / max(1, info["count"])

    graph_path = os.path.join(XRL_DIR, "semantic_graph_gguf.json")
    with open(graph_path, "w", encoding="utf-8") as f:
        json.dump(graph, f, indent=2)

    print(f"=== GGUF semantic graph saved to {graph_path} ===\n")
    return graph

#
# Graph xrl clustering
#

def xrl_graph_clustering_gguf(graph):
    print("=== XRL graph clustering (GGUF): grouping semantic nodes ===")

    nodes = graph["nodes"]
    clusters = {}

    # Simple clustering: group by importance bands
    for tok, info in nodes.items():
        imp = info.get("importance", 0)

        if imp > 5:
            bucket = "high_importance"
        elif imp > 2:
            bucket = "medium_importance"
        else:
            bucket = "low_importance"

        if bucket not in clusters:
            clusters[bucket] = []

        clusters[bucket].append({
            "token": tok,
            "importance": imp,
            "count": info["count"],
            "prompts": info["prompts"]
        })

    cluster_path = os.path.join(XRL_DIR, "semantic_clusters_gguf.json")
    with open(cluster_path, "w", encoding="utf-8") as f:
        json.dump(clusters, f, indent=2)

    print(f"=== GGUF semantic clusters saved to {cluster_path} ===\n")
    return clusters

#
# graph xrl expansion
#

def xrl_graph_expansion_gguf(clusters):
    print("=== XRL graph expansion (GGUF): generating new prompts ===")

    expansions = []

    for cluster_name, items in clusters.items():
        # Pick top 3 tokens in each cluster
        top_tokens = sorted(items, key=lambda x: x["importance"], reverse=True)[:3]
        token_list = [t["token"] for t in top_tokens]

        if not token_list:
            continue

        # Generate new prompts based on cluster tokens
        expansions.append({
            "cluster": cluster_name,
            "tokens": token_list,
            "generated_prompts": [
                f"Explain the relationship between {token_list[0]} and {token_list[1]}.",
                f"Describe how {token_list[0]} influences {token_list[2]}.",
                f"What is the role of {token_list[1]} in {token_list[2]}?"
            ]
        })

    expansion_path = os.path.join(XRL_DIR, "semantic_expansion_gguf.json")
    with open(expansion_path, "w", encoding="utf-8") as f:
        json.dump(expansions, f, indent=2)

    print(f"=== GGUF semantic expansions saved to {expansion_path} ===\n")
    return expansions

#
# Graph xrl export
#

def xrl_graph_export_gguf(graph):
    print("=== XRL graph export (GGUF): preparing visualization format ===")

    export = {
        "nodes": [],
        "edges": []
    }

    # Convert nodes
    for tok, info in graph["nodes"].items():
        export["nodes"].append({
            "id": tok,
            "importance": info.get("importance", 0),
            "count": info.get("count", 0)
        })

    # Convert edges
    for edge in graph["edges"]:
        export["edges"].append({
            "from": edge["from"],
            "to": edge["to"],
            "weight": edge["strength"]
        })

    export_path = os.path.join(XRL_DIR, "semantic_graph_export_gguf.json")
    with open(export_path, "w", encoding="utf-8") as f:
        json.dump(export, f, indent=2)

    print(f"=== GGUF semantic graph export saved to {export_path} ===\n")
    return export

# -----------------------------------------------------------
# MAIN PIPELINE
# -----------------------------------------------------------

def main():
    llm = load_gguf_model()

    threads = xrl_trace_threads_gguf(llm)
    principles = xrl_principiate_gguf(threads)
    graph = xrl_semantic_graph_gguf(threads)

    clusters = xrl_graph_clustering_gguf(graph)
    expansions = xrl_graph_expansion_gguf(clusters)
    export = xrl_graph_export_gguf(graph)


    meta = {
        "model_path": GGUF_MODEL_PATH,
        "threads_file": "threads_gguf.json",
        "principles_file": "principles_gguf.json",
        "semantic_graph_file": "semantic_graph_gguf.json",
        "semantic_clusters_file": "semantic_clusters_gguf.json",
        "semantic_expansion_file": "semantic_expansion_gguf.json",
        "semantic_export_file": "semantic_graph_export_gguf.json",
        "thread_prompts": THREAD_PROMPTS
    }

    meta_path = os.path.join(XRL_DIR, "meta_gguf.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print(f"=== GGUF XRL meta saved to {meta_path} ===")
    print("=== GGUF XRL pipeline complete ===")


if __name__ == "__main__":
    main()
