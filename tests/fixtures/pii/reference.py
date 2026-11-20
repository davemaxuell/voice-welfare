"""
Records what the Python PiiModel finds in a Korean corpus, so tests/unit/pii-node-parity.test.ts can replay it in Node.

Rerun from the repository root (needs models/koelectra-ko-pii-ner, see npm run setup-models):
uv run --no-project --with onnxruntime==1.32.0 --with tokenizers==0.23.3 --with numpy==2.5.5 python -I tests/fixtures/pii/reference.py

The versions are the ones the Python app locks in uv.lock at 77aad3e. Offsets are code points, as Python counts them.
"""
import csv
import importlib.metadata
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODEL_DIR = ROOT / "models" / "koelectra-ko-pii-ner"
PYTHON_MODEL = ROOT / "src" / "cheongeum" / "safety" / "pii_model.py"
SENTENCES = ROOT / "docs" / "stt-eval" / "sentences.csv"
OUT = Path(__file__).resolve().parent / "cases.json"
CLASSES_OUT = Path(__file__).resolve().parent / "char-classes.json"

FILLER = "오늘 날씨가 좋아서 동네 한 바퀴 산책을 했어요 "
UNICODE_PROBES = [
    "\U00000890", "\U000008e2", "\U000110cd", "\U00013430", "\U0000166d", "\U000111c9", "\U0000061d", "\U00002e43", "\U00002e52",
    "\U00000378", "\U0000e000", "\U0000fa6e", "\U0002b81e", "\U0002b820", "\U00009fff", "\U00030000", "\U000000ad", "\U0000200b",
    "\U0000200d", "\U0000feff", "\u000b", "\u0085", "\U00003000", "\U000000a0", "\U0000fffd", "\u0000", "\U00004e00", "\U0000ff0d",
]

EXTRA = [
    # 사람 이름
    "제 이름은 홍길동입니다", "어머니 성함은 이순자예요", "김민수 씨한테 연락해 줘", "보호자는 최영희, 연락처는 010-2222-3333",
    "신청인 박지훈 대리인 정다은", "이름 김하늘 생년월일 1990년 1월 1일", "담당자 이름은 윤서연이에요", "저는 강감찬이고 아들은 강민준이에요",
    # 주소
    "서울특별시 강남구 테헤란로 123 4층", "경기도 수원시 팔달구 효원로 241", "제주특별자치도 제주시 첨단로 242",
    "대구광역시 중구 공평로 88, 우편번호 41911", "주소는 전라남도 순천시 장명로 30 순천시청", "강원특별자치도 춘천시 중앙로 1",
    "부산 해운대구 우동 1408-5", "인천광역시 남동구 정각로 29 인천시청 2층",
    # 전화번호
    "010-1234-5678로 문자 주세요", "01012345678", "+82 10-1234-5678", "집 전화는 02-123-4567이에요", "(031) 123-4567",
    "보건복지상담센터는 129번이에요", "공일공에 일이삼사에 오육칠팔", "휴대폰 010.4321.8765", "전화 주실 번호는 010 2468 1357입니다",
    # 주민·외국인등록번호
    "주민등록번호는 850315-2345678입니다", "주민번호 앞자리 850315 뒷자리 2345678", "제 주민번호는 팔오공삼일오 다시 이삼사오육칠팔이에요",
    "외국인등록번호 900101-5123456", "주민번호는 900101-1234567 이에요", "주민번호 9001011234567",
    # 계좌
    "국민은행 123456-01-234567로 입금해 주세요", "신한 110-345-678901", "계좌는 농협 302-1234-5678-91이야", "우리은행 1002-123-456789",
    "계좌번호 일일공 삼사오 육칠팔구공일", "계좌번호 110-123-456789로 보내 주세요", "수급비 받을 통장은 카카오뱅크 3333-01-2345678",
    # 카드
    "카드번호는 4111-1111-1111-1111이고 유효기간은 12/27이에요", "CVC는 123", "카드 뒷면 세 자리는 456이에요", "유효기간 2028년 3월",
    "5555 4444 3333 2222 카드로 결제", "카드번호 사일일일 일일일일 일일일일 일일일일", "카드 유효기간 오월 이십팔년",
    # 신분증·아이핀
    "여권번호 M12345678", "운전면허번호는 11-12-345678-90", "아이핀 번호 1234567890123", "운전면허 서울 12-345678-90",
    # 비밀번호·인증
    "제 비밀번호는 A2UfgtKg!W1x 입니다", "비번은 qwer1234!", "비밀번호 hunter2", "공동인증서 암호는 sky2026!!", "핀번호 0000",
    "OTP 739201", "비밀번호는 일이삼사오육이야", "인증번호 사팔이구일삼 입력해줘", "주민번호 뒷자리는 일이삼사오육칠",
    # 이메일·주소·아이디·IP
    "메일은 test.user+gov@korea.kr로 보내 주세요", "아이디는 haneul_kim88", "https://www.bokjiro.go.kr 열어줘", "IP 주소 192.168.0.1",
    "www.gov.kr에서 확인", "이메일 주소는 김하늘 골뱅이 네이버 닷컴",
    # 차량·우편번호·날짜·수량
    "차량번호 12가 3456", "123허 4567 차량", "우편번호 06236", "2026년 11월 20일 오후 3시에 방문", "월 소득 300만 원, 재산 1억 2천만 원",
    "가구원 4명", "생년월일 천구백구십년 일월 일일", "내일 오전 열 시 반에 주민센터 가요",
    # 기관·부서·직위
    "서울시청 복지정책과 김주무관", "국민연금공단 상담원", "해운대구청 주민센터 사회복지과", "보건복지부 장관",
    # 전각 숫자
    "주민번호 ９００１０１－１２３４５６７", "０１０－１２３４－５６７８", "계좌 １１０－１２３－４５６７８９", "카드번호 ４１１１ １１１１ １１１１ １１１１",
    # 영어 섞인 말
    "My phone number is 010-1234-5678", "password: Secret123!", "Card 4111 1111 1111 1111 exp 12/27 cvc 123",
    "My name is John Smith and I live at 10 Downing Street",
    # 일상 명령(개인정보 없음)
    "다음으로", "장애인연금 신청 도와줘", "연락처는 010-1234-5678", "주소는 부산광역시 예시구 예시로 10", "이름은 김하늘",
    # 빈 글·공백
    "", " ", "   \t\n ", "\n주민번호\n900101-1234567\n",
    # 그림 문자
    "😀 여기로 110-123-456789 부탁해요", "👨‍👩‍👧 가족 연락처 010-1111-2222", "🇰🇷 주민번호 900101-1234567", "❤️ 김하늘 ❤️",
    "계좌🏦110-123-456789", "좋아요🥰 비밀번호는 abc123", "👍🏽 확인", "😀" * 30, "이름은 김하늘😀 연락처는 010😀1234😀5678",
    # 특수 토큰처럼 생긴 글
    "[CLS] 비밀번호는 1234 [SEP]", "주민번호 [MASK] 900101-1234567", "[UNK]", "[PAD][PAD]", "[unk] 계좌 110-123-456789",
    # 한자·자모·악센트
    "金하늘 主民番號 900101-1234567", "大韓民國 서울特別市", "\U00001100\U00001161\U000011ab 주소", "café 주소는 서울",
    # 아주 긴 낱말
    "가" * 101, "a" * 150 + " 010-1234-5678", "가" * 100 + " 주민번호 900101-1234567",
]


def long_cases() -> list[str]:
    filler = (FILLER * 20)
    no_space = "가나다라마바사아자차카타파하" * 40
    paragraph = (
        "안녕하세요 저는 김하늘이고 부산광역시 해운대구 센텀중앙로 55 101동 1203호에 살아요 "
        "연락처는 010-1234-5678이고 주민번호는 900101-1234567이에요 "
        + FILLER * 3
        + "수급비는 국민은행 123456-01-234567로 받아요 카드번호는 4111-1111-1111-1111이에요 "
        + FILLER * 4
        + "보호자는 박서준이고 전화는 010-9876-5432예요 비밀번호는 sky2026!!이고요"
    )
    out = [
        filler[:190] + "주민번호 900101-1234567 이에요",
        no_space[:199] + "9001011234567 이에요",
        no_space[:195] + "01012345678" + no_space[:250],
        "😀가 " * 83 + "주민번호는 900101-1234567 이에요",
        "😀" * 199 + "주민번호 900101-1234567",
        paragraph,
        "\n".join(["연락처 010-1234-5678", "계좌 110-123-456789", FILLER.strip()] * 8),
        "\n".join(["연락처010-1234-5678", "계좌110-123-456789", "주민번호900101-1234567"] * 15),
        "\t".join(["카드4111-1111-1111-1111", "비밀번호sky2026!!", "이름김하늘"] * 15),
        (FILLER * 60)[:2000] + " 계좌 110-123-456789",
    ]
    for n in (199, 200, 201, 400):
        out.append((filler * 3)[: n - 14] + "900101-1234567")
    return out


def corpus() -> list[str]:
    texts: list[str] = []
    with SENTENCES.open(encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            texts += [row["text"], row["read_as"]]
    texts += EXTRA
    texts += [f"계좌번호는 110{ch}123456789 입니다" for ch in UNICODE_PROBES]
    texts += [f"주민번호 900101{ch}1234567" for ch in UNICODE_PROBES]
    texts += long_cases()
    return list(dict.fromkeys(texts))


def load_python_model():
    spec = importlib.util.spec_from_file_location("pii_model", PYTHON_MODEL)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.PiiModel


def char_classes() -> list[list]:
    """What the Rust normalizer and pre-tokenizer do with each code point alone, as runs of [first code point, class]."""
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
    normalizer, pre_tokenizer = tokenizer.normalizer, tokenizer.pre_tokenizer
    runs: list[list] = []
    for cp in range(0x110000):
        if 0xD800 <= cp <= 0xDFFF:
            kind = "surrogate"
        else:
            ch = chr(cp)
            normalized = normalizer.normalize_str(ch)
            parts = len(pre_tokenizer.pre_tokenize_str(f"a{ch}b"))
            if normalized == "":
                kind = "removed"
            elif normalized == " ":
                kind = "space"
            elif normalized == f" {ch} " or (normalized == ch and parts == 3):
                kind = "alone"
            elif normalized == ch and parts == 1:
                kind = "char"
            else:
                raise ValueError(f"unexpected tokenizer behavior for U+{cp:04X}")
        if not runs or runs[-1][1] != kind:
            runs.append([cp, kind])
    return runs


def main() -> int:
    CLASSES_OUT.write_text(json.dumps(char_classes()) + "\n", encoding="utf-8")
    PiiModel = load_python_model()
    everything = PiiModel(MODEL_DIR, threshold=0.0)
    gated = PiiModel(MODEL_DIR, threshold=0.5)
    cases = []
    for text in corpus():
        cases.append({
            "text": text,
            "spans": [[s.label, s.start, s.end, s.score] for s in everything.find(text)],
            "secret": [list(s) for s in gated.secret_spans(text)],
        })
    header = {
        "generator": "tests/fixtures/pii/reference.py",
        "python": {name: importlib.metadata.version(name) for name in ("onnxruntime", "tokenizers", "numpy")},
        "model": "atonlee/koelectra-ko-pii-ner@1e75c01e707232401883cf364151bbe2e560c708 onnx/model_int8.onnx",
        "threshold": 0.5,
    }
    lines = [json.dumps(case, ensure_ascii=False) for case in cases]
    OUT.write_text(
        "{\"header\": " + json.dumps(header, ensure_ascii=False) + ",\n\"cases\": [\n" + ",\n".join(lines) + "\n]}\n",
        encoding="utf-8",
    )
    print(f"{len(cases)} cases → {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
