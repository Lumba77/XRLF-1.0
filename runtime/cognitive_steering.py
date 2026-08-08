"""
runtime/cognitive_steering.py — XRL Cognitive Steering Layer
=============================================================
Applies the XRL cognitive layer to guide generation:

  1. ProfileSelector    — classifies input → task profile (chat/code/vision/audio/reasoning)
  2. ClusterActivator   — scores XRL semantic clusters against the input embedding
  3. GraphTraverser     — enriches the prompt via semantic graph walks
  4. PrincipiaApplicator— injects XRL reasoning principia into the system prompt

Gemma-4-12B native multimodal: vision/audio/STT inputs are passed directly
to the model — the profile selector simply steers the system prompt accordingly.
"""

import re
from typing import Any, Dict, List, Optional, Tuple


# ── Profile Selector ──────────────────────────────────────────────────────────

class ProfileSelector:
    """
    Classifies the current input into a task profile.
    Uses keyword scoring + modality signals (has_image, has_audio).
    """

    def __init__(self, profiles: Dict):
        self.profiles = profiles.get("profiles", {})
        self.default_profile = profiles.get("default_profile", "chat")
        self.auto_detect = profiles.get("auto_detect", True)

    def select(
        self,
        user_message: str,
        has_image: bool = False,
        has_audio: bool = False,
        has_video: bool = False,
        force_profile: Optional[str] = None,
    ) -> Tuple[str, Dict]:
        """
        Returns (profile_name, profile_config).
        Modality signals override keyword triggers.
        """
        if force_profile and force_profile in self.profiles:
            return force_profile, self.profiles[force_profile]

        if has_video or has_image:
            return "vision", self.profiles.get("vision", {})

        if has_audio:
            return "audio", self.profiles.get("audio", {})

        if not self.auto_detect:
            return self.default_profile, self.profiles.get(self.default_profile, {})

        # Keyword scoring
        msg_lower = user_message.lower()
        scores: Dict[str, int] = {}
        for name, cfg in self.profiles.items():
            triggers = cfg.get("triggers", [])
            score = sum(1 for t in triggers if t in msg_lower)
            if score:
                scores[name] = score

        if scores:
            best = max(scores, key=scores.__getitem__)
            return best, self.profiles[best]

        return self.default_profile, self.profiles.get(self.default_profile, {})


# ── Cluster Activator ─────────────────────────────────────────────────────────

class ClusterActivator:
    """
    Scores XRL semantic clusters against the input to select relevant ones.
    Uses keyword overlap (embedding-based scoring when llama embed is available).
    """

    def __init__(self, clusters: Dict):
        self.clusters = clusters  # bucket_name → list of {token, importance, count}

    def activate(
        self,
        user_message: str,
        embedding: Optional[List[float]] = None,
        top_k: int = 3,
    ) -> List[str]:
        """
        Returns a list of activated token concepts from the top clusters.
        These are used to enrich the prompt prefix.
        """
        msg_words = set(re.findall(r"\b\w+\b", user_message.lower()))
        bucket_scores: Dict[str, float] = {}

        for bucket, items in self.clusters.items():
            if not isinstance(items, list):
                continue
            score = 0.0
            for item in items:
                tok = item.get("token", "").lower()
                imp = item.get("importance", 0)
                if tok in msg_words:
                    score += imp
            if score > 0:
                bucket_scores[bucket] = score

        # Sort buckets by score, pick top tokens
        sorted_buckets = sorted(bucket_scores, key=bucket_scores.__getitem__, reverse=True)
        activated_tokens = []
        for bucket in sorted_buckets[:top_k]:
            items = self.clusters.get(bucket, [])
            top_items = sorted(items, key=lambda x: x.get("importance", 0), reverse=True)[:3]
            activated_tokens.extend(i["token"] for i in top_items if "token" in i)

        return activated_tokens[:top_k * 3]


# ── Graph Traverser ───────────────────────────────────────────────────────────

class GraphTraverser:
    """
    Walks the XRL semantic graph to find contextually relevant concepts.
    Breadth-first search from seed tokens found in the user message.
    """

    def __init__(self, graph: Dict):
        # graph = {"nodes": {...}, "edges": [...]}
        self.nodes = graph.get("nodes", {})
        self.edges = graph.get("edges", [])
        # Build adjacency map: from_token → [(to_token, strength)]
        self._adj: Dict[str, List[Tuple[str, float]]] = {}
        for edge in self.edges:
            frm = edge.get("from", "")
            to  = edge.get("to", "")
            strength = edge.get("strength", 0.0)
            if frm:
                self._adj.setdefault(frm, []).append((to, strength))

    def enrich(
        self,
        user_message: str,
        depth: int = 2,
        max_concepts: int = 5,
    ) -> List[str]:
        """
        BFS from message tokens through the semantic graph.
        Returns top related concept tokens to include as context hints.
        """
        if not self.nodes and not self.edges:
            return []

        msg_words = set(re.findall(r"\b\w+\b", user_message.lower()))
        seeds = [w for w in msg_words if w in self.nodes]
        if not seeds:
            return []

        visited = set(seeds)
        frontier = list(seeds)
        concepts: Dict[str, float] = {}

        for _ in range(depth):
            next_frontier = []
            for tok in frontier:
                for neighbor, strength in self._adj.get(tok, []):
                    if neighbor not in visited:
                        visited.add(neighbor)
                        next_frontier.append(neighbor)
                        node_info = self.nodes.get(neighbor, {})
                        importance = node_info.get("importance", 0)
                        concepts[neighbor] = strength * importance
            frontier = next_frontier

        sorted_concepts = sorted(concepts, key=concepts.__getitem__, reverse=True)
        return sorted_concepts[:max_concepts]


# ── Principia Applicator ──────────────────────────────────────────────────────

class PrincipiaApplicator:
    """
    Injects XRL reasoning principia into the system prompt.
    The principia encode the distilled reasoning style of the source model.
    """

    def __init__(self, principles: List[Dict]):
        self.principles = principles

    def build_system_prefix(
        self,
        profile_config: Dict,
        activated_clusters: List[str],
        graph_concepts: List[str],
    ) -> str:
        """
        Assemble a rich system prompt that steers the small model
        to behave like the source model that was distilled.
        """
        parts = []

        # 1. Profile system instruction
        profile_prefix = profile_config.get("system_prefix", "")
        if profile_prefix:
            parts.append(profile_prefix)

        # 2. Semantic cluster hints (active concepts)
        if activated_clusters:
            cluster_hint = "Active knowledge domains: " + ", ".join(activated_clusters[:5])
            parts.append(cluster_hint)

        # 3. Graph concept hints
        if graph_concepts:
            concept_hint = "Related concepts to consider: " + ", ".join(graph_concepts[:5])
            parts.append(concept_hint)

        # 4. XRL reasoning style from principia
        style_hints = self._extract_style_hints()
        if style_hints:
            parts.append(style_hints)

        return "\n".join(parts)

    def _extract_style_hints(self) -> str:
        """
        Derive a compact reasoning style description from the principles.
        Skips null/empty principles (text-only threads without confidence data).
        """
        roles = [p.get("role", "") for p in self.principles if p.get("role")]
        strengths = [
            p["principle_strength"]
            for p in self.principles
            if p.get("principle_strength") is not None
        ]

        hints = []
        if "confident_consistent_sequence" in roles:
            hints.append("Respond with high confidence and consistency.")
        if "mixed_confidence_sequence" in roles:
            hints.append("Explore multiple perspectives before concluding.")
        if strengths:
            avg = sum(strengths) / len(strengths)
            if avg > 5:
                hints.append("Use detailed, thorough explanations.")
            else:
                hints.append("Be concise and direct.")

        return " ".join(hints) if hints else ""
