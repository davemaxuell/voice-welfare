import json
import os
import sys
from datetime import date

import pytest
from conftest import FIXTURES

from cheongeum.agents.welfare import match_services, next_profile_slot, parse_profile_answer
from cheongeum.agents.welfare.data import FixtureWelfareDataProvider, parse_service_catalog, parse_welfare_detail
from cheongeum.core.jsutil import compact
from cheongeum.personal import PersonalStore, due_reminder, parse_date, parse_personal_command, parse_vault_values, vault_key_for_label

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
    # 지자체 상세만 시행(신청) 기간 필드를 준다(중앙 상세에는 없음).
    assert d["enfcBgngYmd"] == "20240101"
    assert d["enfcEndYmd"] == "99991231"


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


def test_store_sealed(tmp_path):
    from cheongeum.personal.seal import Seal

    path = tmp_path / "personal.json"
    seal = Seal(key=os.urandom(32))
    PersonalStore(str(path), seal=seal).save_vault({"name": "김하늘"})
    raw = path.read_bytes()
    assert seal.is_sealed(raw)
    with pytest.raises(Exception):
        json.loads(raw.decode("utf-8"))
    assert PersonalStore(str(path), seal=seal).vault()["name"] == "김하늘"
    # 평문 → 봉인 이주
    plain = tmp_path / "plain.json"
    plain.write_text(json.dumps({"vault": {"phone": "010"}, "applications": []}), encoding="utf-8")
    migrated = PersonalStore(str(plain), seal=seal)
    assert migrated.vault()["phone"] == "010"
    assert seal.is_sealed(plain.read_bytes())


TODAY = date(2026, 11, 16)


def test_personal_commands():
    assert compact(parse_personal_command("기초연금 신청했어, 접수번호는 A12345678")) == {"kind": "app-record", "service": "기초연금", "receiptNo": "A12345678"}
    assert parse_personal_command("기초연금 신청했어?") is None
    r = parse_personal_command("보완 서류는 12월 3일까지래")
    assert (r["kind"], r["note"]) == ("app-due", "보완 서류 제출")
    assert parse_personal_command("기초연금 12월 25일까지 신청해야 해?") is None
    assert parse_personal_command("신청한 거 어떻게 됐어?") == {"kind": "app-status"}
    assert parse_personal_command("내 정보 지워줘") == {"kind": "vault-clear"}


def test_speech_pref_commands():
    assert parse_personal_command("천천히 말해줘") == {"kind": "speech-set", "values": {"rate": 0.9}}
    assert parse_personal_command("빨리 말해줘") == {"kind": "speech-set", "values": {"rate": 1.5}}
    assert parse_personal_command("짧게 말해줘") == {"kind": "speech-set", "values": {"length": "short"}}
    assert parse_personal_command("자세히 말해줘") == {"kind": "speech-set", "values": {"length": "detailed"}}
    assert parse_personal_command("진행 상황 말해줘") == {"kind": "speech-set", "values": {"progressSpoken": True}}
    assert parse_personal_command("조용히 해") == {"kind": "speech-set", "values": {"progressSpoken": False}}
    assert parse_personal_command("말하기 설정 알려줘") == {"kind": "speech-read"}
    assert parse_personal_command("말하기 설정 초기화") == {"kind": "speech-clear"}
    assert parse_personal_command("목소리는 기본으로 해줘") == {"kind": "speech-set", "values": {"voice": None}}


def test_speech_prefs_persist(tmp_path):
    path = tmp_path / "personal.json"
    store = PersonalStore(str(path))
    store.save_speech({"rate": 0.9, "progressSpoken": False})
    again = PersonalStore(str(path))
    assert again.speech()["rate"] == 0.9
    assert again.speech()["progressSpoken"] is False
    again.clear_speech()
    assert PersonalStore(str(path)).speech()["rate"] == 1.25


def test_speech_dialogue_applies():
    from cheongeum.core.dialogue import DialogueState
    from cheongeum.personal.dialogue import PersonalDialogue

    seen: list[dict] = []
    store = PersonalStore()
    d = PersonalDialogue(store, DialogueState("IDLE"), on_speech=seen.append)
    out = d.run({"kind": "speech-set", "values": {"rate": 0.9, "progressSpoken": False}})
    assert out["semanticAction"] == "none"
    assert "천천히" in out["speech"]
    assert seen[-1]["rate"] == 0.9
    assert seen[-1]["progressSpoken"] is False
    read = d.run({"kind": "speech-read"})
    assert "진행 상황 알림은 끕니다" in read["speech"]


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
