"""
S4 규칙 동등성: 규칙 파서가 모든 예문과 새 문장을 여러 상태에서 어떻게 읽는지 TSV로 적는다.
사용: <worktree>/.venv/Scripts/python.exe -B s4_parity.py <out.tsv>   (작업 트리 안에서 실행)
두 실행의 TSV를 비교하면 바뀐 줄만 보인다: python s4_parity.py --diff before.tsv after.tsv
"""
import asyncio
import json
import sys

STATES = ["IDLE", "BROWSING", "APPLICATION_OPEN", "WAITING_FOR_USER_CONFIRMATION", "APP_OPEN"]

NEW = [
    "파일 탐색기 열어줘", "탐색기 열어", "내 파일 열어줘", "메모장 열어줘", "계산기 켜줘", "카카오톡 열어줘", "공동인증서 열어줘",
    "다운로드 폴더 열어줘", "다운로드 폴더에 뭐 있어?", "다운로드 폴더 보여줘", "문서 폴더 열어줘", "바탕화면에 뭐 있어?",
    "바탕 화면에 뭐 있어", "사진 폴더에 뭐 있어?", "음악 폴더 열어줘", "동영상 폴더 열어", "내 문서 열어줘",
    "1번 읽어줘", "2번 열어줘", "3번", "신청서 파일 열어줘", "신청서 파일 읽어줘", "기초연금 안내 읽어줘", "설치 파일 열어줘",
    "목록 더", "목록 더 알려줘", "더 읽어줘", "뒤로 가줘", "뒤로", "위 폴더로 가줘", "상위 폴더로", "화면 설명해줘", "지금 화면 뭐야",
    "화면 사진으로 설명해줘", "사진으로 설명해줘", "사진 찍어서 설명해줘", "이 화면 그림으로 설명해줘", "1번 눌러줘",
    "다운로드 읽어줘", "받은 파일 읽어줘", "받은 파일 목록", "복지로 열어줘", "네이버 열어줘", "파일 열어줘", "폴더 열어줘",
    "창으로 보여줘", "탐색기 창으로 보여줘", "사진 보여줘", "멈춰", "진행해", "거절",
]


def run(out_path: str) -> None:
    from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
    from cheongeum.core.intents import INTENTS
    from cheongeum.core.turn import SESSION_STATES
    from cheongeum.understanding import IntentContext, RuleBasedIntentProvider

    rules = RuleBasedIntentProvider(field_vocabulary(create_mock_welfare_profile("http://localhost:5174")))
    texts = []
    for i in INTENTS:
        for e in i.examples:
            texts.append(e.text)
    texts += NEW
    seen = set()
    rows = []
    for t in texts:
        if t in seen:
            continue
        seen.add(t)
        for st in STATES:
            if st not in SESSION_STATES:
                continue
            r = rules.parse_sync(t, IntentContext(state=st))
            rows.append(f"{t}\t{st}\t{r['type']}\t{json.dumps({k: v for k, v in r.items() if k != 'type'}, ensure_ascii=False, sort_keys=True)}")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    print(f"{len(rows)} rows -> {out_path}")


def diff(a: str, b: str) -> None:
    def load(p):
        d = {}
        for line in open(p, encoding="utf-8"):
            t, st, typ, params = line.rstrip("\n").split("\t")
            d[(t, st)] = (typ, params)
        return d

    A, B = load(a), load(b)
    for k in sorted(set(A) | set(B)):
        if A.get(k) != B.get(k):
            print(f"{k[0]}\t{k[1]}\t{A.get(k)}\t->\t{B.get(k)}")


if __name__ == "__main__":
    if sys.argv[1] == "--diff":
        diff(sys.argv[2], sys.argv[3])
    else:
        run(sys.argv[1])
