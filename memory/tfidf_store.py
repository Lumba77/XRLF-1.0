"""
memory/tfidf_store.py — Pure-Python TF-IDF Index
=================================================
Zero external dependencies. Indexes text documents by ID,
supports BM25-style TF-IDF scoring, serializes to bytes.
Used by MembraneEngine for semantic recall (ring 5).
"""

import json
import math
import re
from collections import defaultdict
from typing import Dict, List, Optional, Tuple


_STOPWORDS = frozenset({
    "a","an","and","are","as","at","be","been","being","by","do","does","for",
    "from","has","have","he","her","him","his","how","i","in","is","it","its",
    "me","my","not","of","on","or","our","she","so","that","the","their","them",
    "then","there","they","this","to","up","us","was","we","were","what","when",
    "which","who","will","with","you","your",
})


def _tokenize(text: str) -> List[str]:
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return [t for t in tokens if t not in _STOPWORDS and len(t) > 1]


class TFIDFStore:
    """
    Lightweight TF-IDF store for semantic memory search.
    Documents are identified by string IDs.
    """

    def __init__(self):
        self._docs: Dict[str, List[str]] = {}       # id → tokens
        self._idf: Dict[str, float] = {}             # term → idf
        self._dirty: bool = False

    def index(self, doc_id: str, text: str):
        tokens = _tokenize(text)
        self._docs[doc_id] = tokens
        self._dirty = True

    def remove(self, doc_id: str):
        if doc_id in self._docs:
            del self._docs[doc_id]
            self._dirty = True

    def search(self, query: str, top_k: int = 5) -> List[Tuple[str, float]]:
        """Return [(doc_id, score)] sorted by relevance, best first."""
        if self._dirty:
            self._recompute_idf()

        q_tokens = _tokenize(query)
        if not q_tokens or not self._docs:
            return []

        scores: Dict[str, float] = {}
        for doc_id, doc_tokens in self._docs.items():
            tf = _tf(doc_tokens)
            score = sum(tf.get(t, 0) * self._idf.get(t, 0) for t in q_tokens)
            if score > 0:
                scores[doc_id] = score

        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return ranked[:top_k]

    def _recompute_idf(self):
        N = len(self._docs)
        if N == 0:
            self._idf = {}
            self._dirty = False
            return
        df: Dict[str, int] = defaultdict(int)
        for tokens in self._docs.values():
            for term in set(tokens):
                df[term] += 1
        self._idf = {
            term: math.log((N + 1) / (count + 1)) + 1
            for term, count in df.items()
        }
        self._dirty = False

    def serialize(self) -> bytes:
        """Serialize the index to bytes for XRLF embedding."""
        payload = {
            "docs": {k: v for k, v in self._docs.items()},
        }
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")

    def deserialize(self, data: bytes):
        """Restore the index from serialized bytes."""
        payload = json.loads(data.decode("utf-8"))
        self._docs = payload.get("docs", {})
        self._dirty = True

    def __len__(self):
        return len(self._docs)


def _tf(tokens: List[str]) -> Dict[str, float]:
    freq: Dict[str, int] = defaultdict(int)
    for t in tokens:
        freq[t] += 1
    total = len(tokens) or 1
    return {t: c / total for t, c in freq.items()}
