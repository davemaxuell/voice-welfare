"""
.env의 LLM 설정을 실제 API로 확인한다: 키 유효성, LLM_MODEL 존재 여부, 의도 분류 1회 호출.
사용: uv run python scripts/check_llm.py
"""
import asyncio
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

from ieum.agents.web import create_mock_welfare_profile, field_vocabulary
from ieum.core.jsutil import jdumps, rx
from ieum.core.llm import OPENAI_BASE_URL, LlmConfig
from ieum.understanding import IntentContext, create_intent_provider

ROOT = Path(__file__).resolve().parents[1]


async def main() -> int:
    load_dotenv(ROOT / ".env")
    provider = (os.environ.get("LLM_PROVIDER") or "mock").lower()
    api_key = (os.environ.get("LLM_API_KEY") or "").strip()
    model = (os.environ.get("LLM_MODEL") or "").strip()
    base_url = ((os.environ.get("LLM_BASE_URL") or "").strip() or (OPENAI_BASE_URL if provider == "openai" else "")).rstrip("/")

    if provider == "mock":
        print("LLM_PROVIDER=mock 입니다. 키 없이 규칙 파서만 사용합니다.")
        return 0
    if not api_key or not model or not base_url:
        missing = ", ".join(k for k, v in (("LLM_API_KEY", api_key), ("LLM_MODEL", model), ("LLM_BASE_URL", base_url)) if not v)
        print(f".env에 {missing} 값이 비어 있습니다. 키를 넣은 뒤 다시 실행하세요.", file=sys.stderr)
        return 1

    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(f"{base_url}/models", headers={"Authorization": f"Bearer {api_key}"})
    if not res.is_success:
        print(f"모델 목록 조회 실패 (HTTP {res.status_code}). 키가 올바른지, 결제/크레딧이 설정됐는지 확인하세요.", file=sys.stderr)
        return 1
    ids = sorted(m["id"] for m in res.json().get("data", []))
    print(f"✓ 키 확인 완료 (사용 가능 모델 {len(ids)}개)")
    if model not in ids:
        small = [i for i in ids if rx(r"(mini|nano|flash|luna|terra)", regex_flags()).search(i)][:15]
        hint = f"\n  후보(소형): {', '.join(small)}" if small else ""
        print(f'✗ LLM_MODEL="{model}" 은(는) 이 키로 쓸 수 없습니다.{hint}', file=sys.stderr)
        return 1
    print(f'✓ LLM_MODEL="{model}" 사용 가능')

    intent = create_intent_provider(
        LlmConfig(provider=provider, model=model, apiKey=api_key, baseUrl=base_url, reasoningEffort=(os.environ.get("LLM_REASONING_EFFORT") or "").strip() or None),
        field_vocabulary(create_mock_welfare_profile("http://localhost:5174")),
    )
    sample = "사는 데가 부산광역시 예시구 예시로 10이에요"
    t0 = time.monotonic()
    result = await intent.parse(sample, IntentContext(state="APPLICATION_OPEN"))
    print(f'✓ 의도 분류 테스트 ({int((time.monotonic() - t0) * 1000)}ms): "{sample}" → {jdumps(result)}')
    if result["type"] == "UNKNOWN":
        print("  ⚠ UNKNOWN이 나왔습니다. 모델이 strict json_schema를 지원하는지, 응답이 거절되지 않았는지 확인하세요.")
    return 0


def regex_flags() -> int:
    import regex

    return regex.IGNORECASE


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
