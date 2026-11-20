import csv
import json

import pytest

from cheongeum.agents.welfare.open_data import OpenData
from cheongeum.agents.welfare.open_data.datasets import DATASETS
from cheongeum.agents.welfare.open_data.sync import main
from cheongeum.core.places import is_place_request
from cheongeum.core.region import parse_region_mention


@pytest.fixture(scope="module")
def data():
    return OpenData.load()


def test_bundled_programs_have_own_source_and_application_rules(data):
    entries = data.programs.entries("2026-11-18")
    program = next(e for e in entries if e["servNm"] == "꿈장학(초중고등학생)")
    assert program["targets"] == ["저소득"]
    assert program["source"]["lastCheckedAt"] == "2025-11-05"
    assert program["enfcEndYmd"] is None
    assert program["documents"] and program["source"]["url"].endswith("15116392/fileData.do")
    ids = {(e["organization"], e["servNm"]) for e in entries}
    ended = {(r.organization, r.name) for r in data.programs.records if r.end.isoformat() < "2026-11-18"}
    assert ended and ids.isdisjoint(ended)

    # Applications can open before the program itself begins.
    upcoming = max(data.programs.records, key=lambda r: r.start)
    earlier = f"{upcoming.start.year - 1}-12-31"
    assert any(e["servNm"] == upcoming.name for e in data.programs.entries(earlier))


def test_place_from_real_administrative_and_legal_dong(data):
    finder = data.places
    initial = finder.answer("우리 동네 주민센터 어디야?")
    assert initial.ask
    choices = finder.follow_up(initial.ask, "서울 강남구 개포동")
    assert choices.ask and "개포1동" in choices.speech and "개포2동" in choices.speech
    reply = finder.follow_up(choices.ask, "1번")
    assert reply.ask is None and "개포1동 주민센터" in reply.speech and "선릉로 35" in reply.speech
    assert "전화번호가 없어요" in reply.speech and "2025년 12월 31일" in reply.speech
    assert finder.follow_up(choices.ask, "대신 현재 화면 설명해줘") is None
    assert finder.answer("강남구 개포일동 주민센터 위치").sources == reply.sources


def test_pension_office_in_address_district(data):
    reply = data.places.answer("서대문구 국민연금 지사 전화번호")
    assert "충정로 36" in reply.speech and "공이, 이일칠육" in reply.speech
    assert reply.sources[0]["note"] == "02-2176-9949"
    en = data.places.answer("서대문구 국민연금 지사 전화번호", lang="en")
    assert reply.sources[0]["note"] in en.speech
    absent = data.places.answer("가상구 국민연금 지사 주소")
    assert not absent.sources and not absent.ask


def test_missing_kind_and_region_ambiguity(data, tmp_path):
    assert "내려받지" in OpenData.load(tmp_path).places.answer("국민연금 지사 어디야").speech
    assert parse_region_mention("광주시").districts == ("광주시",)
    assert not parse_region_mention("광주시").province
    ambiguous = data.places.answer("중앙동 주민센터 어디야")
    assert ambiguous.ask and not ambiguous.sources


@pytest.mark.parametrize("answer", ["부산이요", "부산에서요", "부산 살아요", "부산이고…", "부산광역시에요.", "지역은 부산, 나이는 25살"])
def test_spoken_discovery_province_answers(answer):
    from cheongeum.agents.welfare.discovery import parse_profile_answer

    assert parse_profile_answer(answer, "ctpv")["ctpv"] == "부산광역시"


def test_mobility_csv_uses_booking_number_and_row_reference_date(tmp_path):
    spec = DATASETS["15028207"]
    path = tmp_path / "예약.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=spec.headers)
        writer.writeheader()
        for i in range(spec.floor):
            writer.writerow({"교통약자이동지원센터명": f"테스트{i}센터",
                             "소재지지번주소": f"경기도 가상{i}시 예시동 1",
                             "예약접수전화번호": "1566-9999", "관리기관전화번호": "031-000-0000",
                             "데이터기준일자": "2025-01-01"})
    assert main(["--dir", str(tmp_path), "--csv", f"15028207={path}", "--reference-date", "15028207=2026-11-02"]) == 0
    finder = OpenData.load(tmp_path).places
    ask = finder.answer("장애인 콜택시 어디에 예약해?").ask
    reply = finder.follow_up(ask, "가상1시")
    assert "일오육육, 구구구구" in reply.speech and "2025년 1월 1일" in reply.speech
    assert reply.sources[0]["note"] == "1566-9999"


@pytest.mark.parametrize(("text", "valid"), [
    ("장애인 콜택시 어디에 예약해?", True), ("행정복지센터 전화번호 좀 알려줘", True),
    ("국민연금 지사 위치 알려줘", True), ("개포면사무소 주소 알려줘", True),
    ("기초연금 신청은 주민센터 어디서 해?", False), ("주소는 개포1동 주민센터야", False),
    ("이 페이지에서 주민센터 전화번호 읽어줘", False), ("주민센터 전화번호 링크 눌러", False),
])
def test_place_phrases(text, valid):
    assert is_place_request(text) == valid


def test_csv_validation_preserves_good_snapshot_and_check_detects_corruption(tmp_path):
    spec = DATASETS["15010814"]
    csv_file = tmp_path / "pension.csv"
    with csv_file.open("w", encoding="cp949", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(spec.headers)
        for i in range(spec.floor):
            writer.writerow([i + 1, f"테스트{i}지사", "12345", "서울특별시 강남구 가상로 1", "02-123-4567", ""])
    args = ["--dir", str(tmp_path), "--csv", f"{spec.id}={csv_file}", "--reference-date", f"{spec.id}=2026-08-01"]
    assert main(args) == 0
    snapshot = tmp_path / "15010814.json"
    original = snapshot.read_bytes()
    csv_file.write_text("성명,주소\n이름,주소\n", encoding="utf-8")
    assert main(args) == 1 and snapshot.read_bytes() == original
    tampered = json.loads(original)
    tampered["records"][0]["phone"] = "02-000-0000"
    snapshot.write_text(json.dumps(tampered), encoding="utf-8")
    assert "내려받지" in OpenData.load(tmp_path).places.answer("강남구 국민연금 지사 전화번호").speech


def test_bundled_central_welfare_links_cover_bokjiro_and_related_sites(data):
    links = data.links
    assert len(links.records) >= DATASETS["15083323"].floor
    assert links.reference_date and links.citation()["url"].endswith("15083323/fileData.do")

    childcare = links.by_name("아이돌봄서비스")
    assert childcare and childcare.serv_id == "WLF00000024"
    assert childcare.detail_url.startswith("https://www.bokjiro.go.kr/")
    assert "wlfareInfoId=WLF00000024" in childcare.detail_url
    assert any(site.url == "https://idolbom.go.kr/" for site in childcare.sites)

    # 공식 CSV의 https;// 오타가 정규화되어 유효한 주소로 저장된다.
    assistant = links.by_name("근로지원인 지원")
    assert assistant and [s.url for s in assistant.sites] == [
        "https://www.esingo.or.kr",
        "https://www.kead.or.kr/sprlbsprt/cntntsPage.do?menuId=MENU0632",
    ]
    # 사이트 칸에 전화번호만 있는 행은 주소로 오인하지 않는다.
    special = links.by_name("건강보험 산정특례")
    assert special and special.sites == ()

    assert links.related_site("문화누리카드").url == "https://www.mnuri.kr"
    assert links.related_site("마이홈").url == "https://www.myhome.go.kr"
    assert links.related_site("에너지바우처").url == "https://www.energyv.or.kr"
    # 서로 다른 도메인이 섞인 라벨은 추측하지 않는다.
    assert links.related_site("근로복지넷") is None
    assert links.match_in_text("아이돌봄서비스 서류 알려줘").serv_id == "WLF00000024"
    assert links.match_in_text("산재 보상금 알려줘") is None


def test_15083323_csv_import_validates_bokjiro_urls_and_parses_sites(tmp_path):
    spec = DATASETS["15083323"]
    csv_file = tmp_path / "central_links.csv"
    with csv_file.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(spec.headers)
        for i in range(spec.floor):
            sid = f"WLF{i:08d}"
            url = f"https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId={sid}&wlfareInfoReldBztpCd=01"
            sites = "테스트포털www.example.go.kr 안내https;//sub.example.or.kr/guide" if i == 0 else ""
            writer.writerow([sid, f"테스트복지서비스{i}", url, "요약", sites, "129", "보건복지부", "복지과", "2026", "2026-08-19"])
        # wlfareInfoId가 다른 잘못된 행은 2% 이하 오류로 걸러진다.
        writer.writerow(["WLF99999999", "잘못된서비스", "https://www.bokjiro.go.kr/?wlfareInfoId=WLF00000000", "요약", "", "129", "보건복지부", "복지과", "2026", "2026-08-19"])
    assert main(["--dir", str(tmp_path), "--csv", f"15083323={csv_file}", "--reference-date", "15083323=2026-08-19"]) == 0
    loaded = OpenData.load(tmp_path).links
    assert len(loaded.records) == spec.floor
    assert loaded.by_id("WLF99999999") is None
    first = loaded.by_name("테스트복지서비스0")
    assert first and [s.url for s in first.sites] == ["https://www.example.go.kr", "https://sub.example.or.kr/guide"]
    assert loaded.related_site("테스트포털").url == "https://www.example.go.kr"
