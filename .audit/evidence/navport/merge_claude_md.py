from pathlib import Path

p = Path("CLAUDE.md")
raw = p.read_bytes().decode("utf-8")
crlf = "\r\n" in raw
t = raw.replace("\r\n", "\n")
s = t.index("<<<<<<< main\n")
m = t.index("=======\n", s)
e = t.index(">>>>>>> nav\n", m)
main = t[s + len("<<<<<<< main\n") : m].splitlines(keepends=True)
nav = t[m + len("=======\n") : e].splitlines(keepends=True)

old_login = "실제 사이트 로그인 인계(`BrowseSkill.login`)는 클릭 규칙과 상관없이 `links_only`로 주소가 있는 링크(`link`)만 누른다(`javascript:` 스크립트 링크는 로그인 요청을 보낼 수 있다)."
new_login = "실제 사이트 로그인(`BrowseSkill.login`, 주인 결정 2026-11-18)은 로그인 버튼·링크로 초점을 옮기고(`point_at`) 무엇을 왜 하는지 말한 뒤 '눌러'를 들으면 누른다(`click_approved`: 물은 뒤 주소가 바뀌었거나 그 ref가 없어졌으면 누르지 않음). 아이디·비밀번호는 사용자가 직접 입력한다."
assert old_login in nav[1]
agent_a = nav[1].replace(old_login, new_login)

seg_start = nav[5].index("읽기 전용 사이트의 클릭은")
seg_end = nav[5].index(" `gates.py`", seg_start)
seg = nav[5][seg_start:seg_end]
old_l = "실제 사이트의 로그인 이름(`LOGIN_NAME`)은 승인 후 누름."
assert old_l in main[5]
safety = main[5].replace(old_l, "실제 사이트의 로그인 이름(`LOGIN_NAME`)은 `READ_ONLY_CLICKS`와 상관없이 승인 후 누름. " + seg)

merged = "".join([main[0], agent_a, main[2], main[3], main[4], safety])
out = t[:s] + merged + t[e + len(">>>>>>> nav\n") :]
p.write_bytes((out.replace("\n", "\r\n") if crlf else out).encode("utf-8"))
print("ok", crlf)
