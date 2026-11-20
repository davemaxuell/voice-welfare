"""세션 패키지의 기준 표를 Python 77aad3e에서 다시 만든다.

Python 기준 작업 트리에서 실행한다(쓰는 곳은 인자로 준 폴더뿐):
  uv run --frozen python -I <이 파일> <77aad3e 기록의 regex 폴더> <출력 폴더>
"""
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, "src")

from cheongeum.core.jsutil import rx  # noqa: E402
from cheongeum.language.i18n import FIXED  # noqa: E402
from cheongeum.orchestrator import task_review as review  # noqa: E402

recorded, out = Path(sys.argv[1]), Path(sys.argv[2])
corpus = json.loads((recorded / "corpus.json").read_text("utf-8"))
EXTRA = [
    "", " ", "1번", "제2번이요", "첫 번째요", "두번째", "３번", "1 번이요.", "제1번", "3번",
    "정부24요", "정부24입니다", "복지로이요", "요", "네요\n", "아니", "아니요.", "보내지 마!", "보내지  마。", "거절해",
    "네. 좋아요!  다음", "끝。다음", "멈췄습니다. 이어서", "中止しました。続けるには", "已停止。要继续", "Stopped. Say resume",
    "천천히 다시", "느리게 말해줘", "전화번호 다시", "우리 동네 주민센터", "우리동네", "내 주변 약국", "거주지 근처", "가까운 지사",
    "필요한서류는", "그럼신청은어떻게", "여기서발급", "제출할서류", "그건언제까지", "수수료는얼마", "온라인으로돼", "서류", "이서류",
    "연금신청", "눌러줘", "대신신청해줘", "장려금", "열어줘", "가 줘", "켜줘", "띄워줘", "이동해", "들어가", "접속",
    "좋아요~ ", "네!!\t", "맞아요.　", "네\u001f", "한글", "abc", "가", "힣", "ㄱ", "１２３", "x\ny\n",
]
texts = corpus + [text for text in EXTRA if text not in corpus]

SESSION = "src/cheongeum/orchestrator/session.py"
rows = []
for line in (recorded / "patterns.jsonl").read_text("utf-8").splitlines():
    row = json.loads(line)
    sites = [site for site in row["sites"] if site[0] == SESSION]
    if not sites:
        continue
    pattern = rx(row["source"], row["flags"])
    matches = {}
    for index, text in enumerate(texts):
        spans = [list(m.span()) for m in pattern.finditer(text)]
        if spans:
            matches[str(index)] = spans
    again = {key: value for key, value in matches.items() if int(key) < len(corpus)}
    assert again == row["matches"], row["source"]
    rows.append({"id": row["id"], "source": row["source"], "flags": row["flags"], "sites": sites, "matches": matches})
(out / "regex.json").write_text(json.dumps({"corpus": texts, "patterns": rows}, ensure_ascii=False) + "\n", "utf-8")

# task_review.py는 re 모듈을 쓴다. 기록 도구가 보지 않으므로 여기서 직접 잰다.
REVIEW_TEXTS = [
    "", "sk-abcdefghij1234", "key sk-abcdefghij", "xsk-abcdefghij1234", "가sk-abcdefghij1234", " SK-ABCDEFGHIJ", "ſK-abcdefghijkl", "sK-abcdefghijkl",
    "tvly-dev-0123456789", "TVLY-prod-abcdef.=-_1", "Bearer   abc.def-ghi=jkl", "bearer　abcdefghijk", "Bearer\u001fabcdefghijk", "Bearer 가나다라마바사아자차",
    "Bearer １２３４５６７８９０", "sk-short", "https://a.example/x?y=1 그리고 HTTP://B.EXAMPLE/경로", "http://x.example/a(b)c", "https://x.example/a]b", "see <https://x.example/p>.",
    "[제목](https://office.example/a?b=1) 과 [다른](http://x.example/y)", "[a\nb](https://x.example)", "[a](https://x.example/p q)", "[A](HTTPS://X.EXAMPLE/P)",
    "Click Next twice.", "Click Next TWICE", "twıce", "TWİCE", "twiced", "atwice", "two times", "two  times", "Two Times.", "thrice", "three times", "THREE TİMES",
    "3 times", "12 tımes", "３ times", "1234 times", "x3 times", "가3 times", "3 timesx", "다음을 2번", "다음를3 번", "연속 2번", "연속으로 ４번", "2번", "두 번", "두번째", "두 번 눌러",
    "세번", "세 번째", "两次", "二回", "三次", "三回", "3次", "5 回", "and", "And then please", "a,b", "그리고 그다음", "해줘 주세요", "然后并且", "それから", "してから。", "candy", "and1",
    "_", "한", "1", " and ", "AND", "alſo", "PLEAſE", "tHEN", "02-1234-5678", "031 123 4567", "070-1234-5678", "0212345678", "010-1234-5678", "02-12-5678", "０２-1234-5678", "02-１２３４-５６７８",
    "I filled 2 fields and 10 more, then 11 and ３.", "no digits", "99 100 7",
]
URLS = [
    "", "https://office.example/start?token=private-link-token", "http://A.Example:8080/Path/한글?q=1#frag", "https://user@x.example/a", "https://user:pw@x.example/a",
    "https://@x.example/a", "https://:@x.example/a", "ftp://x.example/a", "//x.example/a", "x.example/a", "https:///nohost", "https://x.example", "https://[::1]:8080/a?b",
    "https://[::1/a", "https://[1.2.3.4]/a", "https://[v1.x]/a", "https://[fe80::1%25eth0]/a", "  https://x.example/a\n", "https://x.exa\tmple/a", "HTTPS://X.EXAMPLE/A",
    "https://x.example:80/a", "https://x.example:abc/a", "https://ｘ.example/a", "https://x.example/a;b?c", "javascript:alert(1)", "https://x.example/a#b?c", "https://x.example?a/b",
    "https://x／y.example/a", "http://a@b@c.example/", "https://[a]@x.example/",
]
SAFE = [
    ["Fill name Name With Private Address on https://office.example/start?token=private-link-token", ["Name With Private Address"], []],
    ["  문의는 02-1234-5678 또는 010-1234-5678, a.b@example.com  ", [], ["02-1234-5678"]],
    ["02-1234-5678", [], ["02-1234-5678"]], ["02-1234-5678", [], []], ["비밀번호는 apple123 입니다", [], []], ["key sk-abcdefghij1234 ok", [], []],
    ["https://user:pw@x.example/a 와 https://x.example/b?c=d", [], []], ["김하늘 김하 김", ["김하", "김하늘"], []], ["", [], []], ["Applications close on November 28.", [], []],
    ["주민등록번호 900101-1234567", [], []], ["click 다음 단계", ["다음"], []],
]
COVERAGE = [
    ["Fill the applicant name, open the visit guide, and find the deadline.", ["Fill the applicant name", "open the visit guide", "find the deadline"]],
    ["Fill the applicant name, open the visit guide, and find the deadline.", ["Fill the applicant name", "find the deadline"]],
    ["Fill the applicant name, open the visit guide, and find the deadline.", ["find the deadline", "Fill the applicant name"]],
    ["행사 기간 그리고 접수 장소", ["행사 기간", "접수 장소"]], ["행사 기간 그리고 접수 장소 알려줘", ["행사 기간", "접수 장소"]], ["행사 기간 그리고 접수 장소 해줘", ["행사 기간", "접수 장소"]],
    ["Click Next and click Next.", ["Click Next", "click Next"]], ["Click Next and click Next.", ["Click Next"]], ["a then b", ["a", "b"]], ["a thenb", ["a", "b"]], ["", []], ["  ", []], ["x", []],
]


def spans(pattern, text):
    return [list(m.span()) for m in pattern.finditer(text)]


def run_safe(text, private, phones):
    try:
        return review._safe(text, private, phones)
    except ValueError:
        return None


glue = re.compile(r"(?:[\W_]|\b(?:and|then|also|please)\b|그리고|그다음|주세요|해줘|이어서|然后|并且|それから|してから)*", re.I)
phone = re.compile(r"0(?:2|[3-6][1-5]|70)[- ]?\d{3,4}[- ]?\d{4}")
stop_moved = {}
for key in ("stop", "stopBusy"):
    for lang, sentence in FIXED[key].items():
        first, *rest = rx(r"(?<=[.。])\s*").split(sentence, maxsplit=1)
        stop_moved[f"{key}:{lang}"] = " ".join([first, FIXED["stopMoved"][lang], *rest])
table = {
    "systemHash": hashlib.sha256(review._SYSTEM.encode()).hexdigest(),
    "schema": review._SCHEMA,
    "repairs": review._REPAIRS,
    "texts": REVIEW_TEXTS,
    "credential": [spans(review._CREDENTIAL, t) for t in REVIEW_TEXTS],
    "url": [spans(review._URL, t) for t in REVIEW_TEXTS],
    "link": [spans(review._LINK, t) for t in REVIEW_TEXTS],
    "glue": [bool(glue.fullmatch(t)) for t in REVIEW_TEXTS],
    "officePhone": [bool(phone.fullmatch(t)) for t in REVIEW_TEXTS],
    "repetitions": [review._repetitions(t) for t in REVIEW_TEXTS],
    "digits": [re.findall(r"\d+", t) for t in REVIEW_TEXTS],
    "location": [[u, review._location(u)] for u in URLS],
    "safe": [[*case, run_safe(*case)] for case in SAFE],
    "coverage": [[*case, review._coverage(*case)] for case in COVERAGE],
    "stopMoved": stop_moved,
}
(out / "task-review.json").write_text(json.dumps(table, ensure_ascii=False) + "\n", "utf-8")
print(len(rows), "session patterns,", len(texts), "texts")
