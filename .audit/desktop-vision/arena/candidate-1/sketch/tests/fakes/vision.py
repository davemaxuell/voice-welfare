"""
[새 파일] FakeVision: VisionLlm의 시험용 구현(네트워크 없음). conftest의 FakeLlm은 images를 받지 않으므로 따로 둔다.
calls에 system·user·schemaName과 그림 수·크기를 남긴다(그림 바이트는 남기지 않는다: 시험에서도 같은 습관).
"""
from __future__ import annotations


class FakeVision:
    name = "fake-vision"

    def __init__(self, answer: dict | None) -> None:
        self.answer = answer
        self.calls: list[dict] = []

    async def generate(self, *, system, user, schemaName, schema, images, signal=None):  # noqa: N803
        raise NotImplementedError


def reading(summary: str, *, details=(), labels=(), blocked=False, instructions=False, kind="page") -> dict:
    """PICTURE_SCHEMA 모양의 가짜 답."""
    raise NotImplementedError
