"""첫 실행 설정의 키 확인: 모델 목록을 한 번 불러 키가 쓸 수 있는지 본다."""
from __future__ import annotations

from typing import Literal

import httpx

KeyCheck = Literal["ok", "invalid", "quota", "network"]


async def check_openai_key(key: str, base_url: str, *, timeout: float = 8.0) -> KeyCheck:
    """ok = 쓸 수 있음, invalid = 키가 틀림, quota = 사용 한도 초과, network = 연결·서버 문제."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(f"{base_url.rstrip('/')}/models", headers={"Authorization": f"Bearer {key}"})
    except httpx.HTTPError:
        return "network"
    if r.is_success:
        return "ok"
    if r.status_code in (401, 403):
        return "invalid"
    if r.status_code == 429:
        return "quota"
    return "network"
