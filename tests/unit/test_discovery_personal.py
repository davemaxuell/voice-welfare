import json
import os
import sys
from datetime import date

from conftest import FIXTURES

from ieum.agents.welfare import match_services, next_profile_slot, parse_profile_answer
from ieum.agents.welfare.data import FixtureWelfareDataProvider, parse_service_catalog, parse_welfare_detail
from ieum.core.jsutil import compact
from ieum.personal import PersonalStore, due_reminder, parse_date, parse_personal_command, parse_vault_values, vault_key_for_label

# ---------------------------------------------------------------- 맞춤 복지 찾기


def test_central_catalog():
    items = parse_service_catalog((FIXTURES / "welfare-list-all.xml").read_text(encoding="utf-8"), "central")
    assert len(items) == 461
    pension = next(s for s in items if s["servNm"] == "장애인연금")
    assert "장애인" in pension["targets"]
    assert pension["lifeStages"]


def test_local_catalog():
    items = parse_service_catalog((FIXTURES / "welfare-local-busan.xml").read_text(encoding="utf-8"), "local")
    assert len(items) == 284
    assert all(s["region"]["ctpv"] == "부산광역시" for s in items)


def test_profile_answer_many_at_once():
    r = parse_profile_answer("마흔다섯 살이고 심한 장애가 있고 부산 살아요")
    assert (r["age"], r["disability"], r["ctpv"]) == (45, "severe", "부산광역시")


def test_profile_short_answers():
    assert parse_profile_answer("아니요", "disability") == {"disability": "no"}
    assert parse_profile_answer("잘 모르겠어요", "income") == {"income": "unknown"}
    assert parse_profile_answer("건너뛰기", "ctpv") == {"ctpv": None}
    # 군말이 앞에 붙어도("음 맞아")
    assert parse_profile_answer("음 맞아.", "income") == {"income": "low"}
    assert parse_profile_answer("어, 있어요", "disability") == {"disability": "yes"}
    assert next_profile_slot({"age": 70, "disability": "no", "income": "unknown", "ctpv": None}) is None


def test_profile_unrelated():
    assert parse_profile_answer("네이버 열어줘", "age") == {}


provider = FixtureWelfareDataProvider.from_file()


async def test_rank_severe_basic():
    m = match_services(await provider.catalog(), {"age": 45, "disability": "severe", "income": "basic", "ctpv": None})
    assert "장애인연금" in [x.service["servNm"] for x in m[:5]]
    assert not any(x.service["targets"] and all(t == "다문화·탈북민" for t in x.service["targets"]) for x in m)


async def test_rank_senior_low_income():
    m = match_services(await provider.catalog(), {"age": 70, "disability": "no", "income": "low", "ctpv": None})
    assert "기초연금" in [x.service["servNm"] for x in m[:3]]
    assert all(not x.service["lifeStages"] or "노년" in x.service["lifeStages"] for x in m)


async def test_rank_with_region():
    m = match_services(await provider.catalog("부산광역시"), {"age": 45, "disability": "severe", "income": "basic", "ctpv": "부산광역시"})
    assert any(x.service["provider"] == "local" for x in m[:10])


def test_local_detail():
    d = parse_welfare_detail((FIXTURES / "welfare-local-detail.xml").read_text(encoding="utf-8"), "")
    assert d["servNm"] == "가임력 보존지원 사업"
    assert "기준중위소득" in d["target"]
    assert "거주기준" in d["criteria"]
    assert d["contacts"][0]["value"] == "051-888-3362"


# ---------------------------------------------------------------- 금고·신청 기록


def test_vault_values():
    assert parse_vault_values("내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이고 연락처는 010-1234-5678이라고 저장해줘") == {
        "name": "김하늘",
        "address": "부산광역시 예시구 예시로 10",
        "phone": "010-1234-5678",
    }
    assert parse_vault_values("주소는 [비공개]라고 저장해줘") == {}


def test_vault_key_for_label():
    assert vault_key_for_label("신청인 성명") == "name"
    assert vault_key_for_label("휴대전화 번호") == "phone"
    assert vault_key_for_label("비밀번호") is None


def test_store_file_mode(tmp_path):
    path = tmp_path / "personal.json"
    store = PersonalStore(str(path))
    store.save_vault({"name": "김하늘"})
    assert json.loads(path.read_text(encoding="utf-8"))["vault"]["name"] == "김하늘"
    if sys.platform != "win32":
        assert os.stat(path).st_mode & 0o777 == 0o600
    assert PersonalStore(str(path)).vault()["name"] == "김하늘"


TODAY = date(2026, 11, 16)


def test_personal_commands():
    assert compact(parse_personal_command("기초연금 신청했어, 접수번호는 A12345678")) == {"kind": "app-record", "service": "기초연금", "receiptNo": "A12345678"}
    assert parse_personal_command("기초연금 신청했어?") is None
    r = parse_personal_command("보완 서류는 12월 3일까지래")
    assert (r["kind"], r["note"]) == ("app-due", "보완 서류 제출")
    assert parse_personal_command("기초연금 12월 25일까지 신청해야 해?") is None
    assert parse_personal_command("신청한 거 어떻게 됐어?") == {"kind": "app-status"}
    assert parse_personal_command("내 정보 지워줘") == {"kind": "vault-clear"}


def test_parse_date():
    assert parse_date("12월 3일까지", TODAY) == "2026-12-03"
    assert parse_date("1월 5일", TODAY) == "2027-01-05"
    assert parse_date("3일 뒤", TODAY) == "2026-11-19"


def test_due_reminder():
    apps = [
        {"id": "1", "service": "기초연금", "appliedAt": "2026-11-01", "dueDate": "2026-11-18", "dueNote": "보완 서류 제출"},
        {"id": "2", "service": "장애수당", "appliedAt": "2026-11-01", "dueDate": "2026-12-30"},
    ]
    assert due_reminder(apps, TODAY) == "기초연금 보완 서류 제출이 11월 18일까지, 2일 남았어요."
    assert due_reminder([apps[1]], TODAY) is None
