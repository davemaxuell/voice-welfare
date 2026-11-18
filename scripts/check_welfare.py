"""
.env의 복지 API 설정을 실제로 확인한다: 장애인연금 목록→상세 조회와 Agent B 답변 1회.
사용: uv run python scripts/check_welfare.py
"""
import asyncio
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from cheongeum.agents.welfare import WelfareInformationAgent
from cheongeum.agents.welfare.data import OfficialCentralWelfareApiProvider, create_welfare_data_provider
from cheongeum.server.runtime import load_config

ROOT = Path(__file__).resolve().parents[1]


async def main() -> int:
    load_dotenv(ROOT / ".env")
    cfg = load_config()
    provider = create_welfare_data_provider(api_key=cfg.welfareApiKey, api_base_url=cfg.welfareApiBaseUrl)
    if not isinstance(provider, OfficialCentralWelfareApiProvider):
        print("공식 API 모드가 아닙니다. .env에 WELFARE_DATA_MODE=official-api, WELFARE_API_KEY, WELFARE_API_BASE_URL을 설정하세요.")
        return 1
    t0 = time.monotonic()
    service = await provider.find_service("장애인연금")
    if not service or service.get("dataOrigin") != "official-api":
        print(f"✗ 공식 API 조회 실패 → fixture로 대체됨. 사유: {provider.last_error or '알 수 없음'}", file=sys.stderr)
        return 1
    print(f"✓ 조회 성공 ({int((time.monotonic() - t0) * 1000)}ms): {service['servNm']} ({service['servId']}), {service['source']['version']}")
    print(f"  출처: {service['source']['url']}")
    print(
        f"  필드: 대상 {len(service['target'])}자, 선정기준 {len(service.get('criteria') or '')}자, 지원내용 {len(service.get('benefit') or '')}자, "
        f"신청절차 {len(service.get('applySteps') or [])}단계, 서식 {len(service.get('forms') or [])}개"
    )
    answer = await WelfareInformationAgent(provider).answer_policy_question("장애인연금 지원대상과 신청 절차 알려줘")
    print(f"✓ Agent B 답변: {answer.speech}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
