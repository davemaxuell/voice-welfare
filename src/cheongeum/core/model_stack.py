"""OpenAI roles in the public-service agent. Endpoints and credentials belong to the runtime."""
from __future__ import annotations

import math
from dataclasses import dataclass

from cheongeum.core.jsutil import AbortSignal
from cheongeum.core.llm import ModelConnections, OPENAI_BASE_URL, post_json


@dataclass(frozen=True)
class ModelStack:
    voice: str = "gpt-live-1"
    agent: str = "gpt-6.2-sol"
    utility: str = "gpt-6-luna"
    vision: str = "gpt-6.1-terra"
    recovery: str = "gpt-6.2-astra"
    embedding: str = "text-embedding-3-small"
    transcription: str = "gpt-transcribe"
    moderation: str = "omni-moderation-latest"


STACK = ModelStack()


class _OpenAIService:
    def __init__(self, key: str, model: str, connections: ModelConnections):
        self._key = key
        self.model = model
        self._connections = connections

    async def _request(self, endpoint: str, text: str, signal: AbortSignal | None) -> dict:
        if not text.strip():
            return {}
        data = await post_json(f"{OPENAI_BASE_URL}/{endpoint}", {"Authorization": f"Bearer {self._key}",
                               "Content-Type": "application/json"}, {"model": self.model, "input": text},
                               15, signal, self._connections)
        return data if isinstance(data, dict) else {}


class EmbeddingService(_OpenAIService):
    async def embed(self, text: str, *, signal: AbortSignal | None = None) -> list[float] | None:
        data = (await self._request("embeddings", text, signal)).get("data")
        if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
            return None
        vector = data[0].get("embedding")
        if not isinstance(vector, list) or not vector or not all(type(n) in (int, float) and math.isfinite(n) for n in vector):
            return None
        return vector


class ModerationService(_OpenAIService):
    async def screen(self, text: str, *, signal: AbortSignal | None = None) -> bool | None:
        results = (await self._request("moderations", text, signal)).get("results")
        if isinstance(results, list) and len(results) == 1 and isinstance(results[0], dict):
            flagged = results[0].get("flagged")
            if isinstance(flagged, bool):
                return flagged
        return None
