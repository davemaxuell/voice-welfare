"""
Writes the expected values for the welfare package's table-driven tests by running the Python reference (77aad3e).

Run it with the Python reference environment, never with the owner's checkout:
  cd <pyref worktree> && uv run --frozen python -I <this file>
It writes one JSON file per topic next to this script. The Vitest files under tests/unit read them.
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
sys.stdout.reconfigure(encoding="utf-8")


def write(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(name, len(value))


def attempt(fn, *args):
    try:
        return fn(*args)
    except ValueError:
        return {"error": "ValueError"}


def clean_urls():
    from cheongeum.agents.welfare.data import _clean_http_url
    from cheongeum.agents.welfare.open_data.sync import _clean_public_url

    inputs = [
        "", " ", "www.example.go.kr", "http://www.129.go.kr", "https;//sub.example.or.kr/guide", "http;//a.kr", "HTTPS://Example.COM/Path",
        "example.com", "example", "example.com/a b", "https://example.com/a b", "ftp://example.com", "javascript:alert(1)",
        "https://localhost/", "http://127.0.0.1:8080/x", "https://user:pw@example.com/", "https://user@example.com/",
        "https://@example.com/", "https://example.com:99999/", "https://example.com:80/", "https://[::1]/", "https://[1.2.3.4]/",
        "https://[::1/", "https://exa mple.com", "www.example.go.kr.", "https://example.com/a).", "한국.kr", "https://한국.kr/가",
        "bokjiro.go.kr/x?a=1&b=2", "https://www.bokjiro.go.kr/a?x=1#f", "http://example.com\n", "example..com", "-example.com",
        "ｅxample.com", "https://ex＠ample.com/", "https://ex℀ample.com/", "https://example.com/?a=b@c",
        "https://a:b@c@example.com/", "https://:pw@example.com/", "HTTP;//UPPER.kr", "http://example", "https://exa_mple.com/",
        "www.가나다.kr/경로", "  https://example.com/x,;  ", "https://example.com,", "https://v1.x]/", "https://[v1.x]/",
        "https://[vz.x]/", "https://[fe80::1%eth0]/", "http://１２３.com/", "https://example.com/\t", "ｗｗｗ.example.com",
        "www.example.com:８０/x", "www.example.com:80/x\ny",
    ]
    return [{"in": text, "http": attempt(_clean_http_url, text), "public": attempt(_clean_public_url, text)} for text in inputs]


def agent_regex(trace):
    """Replay new welfare expressions collected by regex_trace.py at the pinned reference."""
    import regex

    ids = {
        "e95e4dd91ecccfff11cd",  # stripCommand
        "019e3ae7c9ff6b45e500",  # siteCue
        "30d3bdc839f7083f6748",  # previousSelection
        "522ea46c30ab7498ce9d",  # stripSite
        "292a7c62666dacd67e57",  # formCue
        "92cbe67e11a7a0de687f",  # regionSuffix
        "c99d3f4a6e311ed5f2d8",  # residence
        "0ccecf1ed4710ed4e95d",  # documents
        "d60786939528ee1d04a9",  # selectionCriteria
        "f2748d38653bcc090288",  # amountQuestion
        "aee624cfe46e32cd8e84",  # openCommand
        "dac059e6342a64bbd7fe",  # duration
        "fe11f3d0eb2470275ee8",  # money
        "63b410165e5f2830b148",  # guideCue
        "d8a7d6cf8314214ef4a1",  # bareUrl
        "d74fe0153e04150001ba",  # bokjiroPrefix
        "11dc57b485b25dff5f20",  # referenceDate
        "2ecaf00e1fc0776a4256",  # isoDay
        "8d89c46fba3a93c287da",  # officialGuide
    }
    corpus = [
        "", "ASCII 123", "한글 지원금", "😀복지로 신청 금액", "공식 상세 페이지 열어주세요",
        "복지로에서 아이돌봄서비스 관련 사이트 찾아줘", "BOKJİRO에 이동해줘", "BOKJIRO 가서", "bokjıro",
        "지원 사업에 대한 신청 방법", "구비서류와 첨부 다운로드", "어디에서 신청", "우리 사업 선정 기준",
        "그거를", "이 제도를", "😀그 사업을", "신청 기간", "2026-11-20", "2026년 기준",
        "２０２６-１１-２０ 기준", "2026-11-20\n", "1년 이상 거주", "전입 후 ６개월", "６개월 동안",
        "기장군에 주민등록", "지원액은 349,700원", "월 ５０만 원", "금액은 8천만 원, 500원",
        "복지로 관련 공식 안내", "공식 홈페이지와 상세 페이지", "이 사업의", "이 사업에서\n",
        "공식\u00a0사이트", "서식\u001c서류", "상품을 열어줘", "전화번호", "간식에게 설명",
        "www.example.kr", "예시.한국:８０/경로", "www.invalid", "example.org\n",
    ]
    found = {}
    for line in trace.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row["id"] not in ids:
            continue
        expression = regex.compile(row["source"], row["flags"])
        matched = {}
        for index, text in enumerate(corpus):
            spans = [match.span() for match in expression.finditer(text)]
            if spans:
                matched[str(index)] = spans
        found[row["id"]] = matched
    if set(found) != ids:
        raise ValueError("Missing welfare patterns in the Python trace")
    return {"corpus": corpus, "matches": found}


if __name__ == "__main__" and len(sys.argv) == 2:
    write("agent-regex.json", agent_regex(Path(sys.argv[1])))
elif __name__ == "__main__":
    write("clean-url.json", clean_urls())
