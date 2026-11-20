# Writes workflows.json. Run from the Python reference worktree: uv run --frozen python -I <this file> > workflows.json
import json
from cheongeum.server.workflows import safe_input, public_result
inputs = ["", "   ", "국가장학금 신청 기간", "  국가장학금  ", "name@example.org", "password is 567812", "https://portal.example/?token=private",
  "sk-" + "x" * 40, "SK-" + "x" * 12, "sk-" + "x" * 11, "키sk-" + "x" * 12, "_sk-" + "x" * 12, "\u0301sk-" + "x" * 12, "(sk-" + "x" * 12,
  "sk-xxxxİxxxxxxxx", "https://user@portal.example/path", "HTTPS://portal.example/a?b", "https://portal.example/a ?b", "https://portal.example/a\x1c?b",
  "https://portal.example/a\ufeff?b", "https://por\u0085tal@x", "http://portal.example/path", "가" * 600, "가" * 601, "[비공개] 질문", "010-1234-5678 로 연락",
  "주민번호 900101-1234567", "Search for tvly-private-test-token", "😀" * 300]
safe = {s: safe_input(s, 600) for s in inputs}
safe_small = {s: safe_input(s, 3) for s in ["가나다", "가나다라", "😀😀😀"]}
results = [
  ("completed", {"text": "unsupported", "sources": []}),
  ("completed", {"text": "answer", "sources": [{"url": "javascript:alert(1)"}]}),
  ("completed", {"text": "answer", "sources": [{"url": "https://www.gov.kr/a", "title": "정부24"}]}),
  ("partial", {"text": "", "sources": [{"url": "https://www.gov.kr/a"}]}),
  ("needs_input", {"text": "", "sources": []}),
  ("failed", {"text": "x", "sources": [{"url": "https://www.gov.kr/a"}]}),
  ("completed", {"text": "연락처 010-1234-5678", "sources": [{"url": "https://u:p@www.gov.kr/a"}, {"url": "https://@www.gov.kr/b", "title": ""}, {"url": "HTTPS://WWW.GOV.KR/c", "title": None},
      {"url": "https://[::1/a"}, {"url": "https:///nohost"}, {"url": "http://www.gov.kr/d"}, {"url": "https://x.kr/" + "a" * 3000, "title": "가" * 200}]}),
  ("completed", {"text": "a", "sources": [{"url": f"https://s{i}.kr/"} for i in range(10)]}),
  ("completed", {"text": "가" * 2500, "sources": [{"url": "https://www.gov.kr/", "title": "메일 a@b.kr"}]}),
  ("completed", {"sources": [{"url": "https://www.gov.kr/"}]}),
]
pub = [[state, result, list(public_result(state, result))] for state, result in results]
print(json.dumps({"safe": safe, "small": safe_small, "public": pub}, ensure_ascii=False))
