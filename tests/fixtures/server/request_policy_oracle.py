# Writes request-policy.json. Run from the Python reference worktree: uv run --frozen python -I <this file> > request-policy.json
import json, base64, binascii
from starlette.datastructures import Headers
from starlette.requests import Request
from cheongeum.server.request_policy import origin_refusal, request_refusal
def H(pairs): return Headers(raw=[(k.encode("latin-1"), v.encode("latin-1")) for k, v in pairs])
origin = [
 ([("host","localhost:8787")], "http", 8787, False), ([("host","LOCALHOST:8787")], "http", 8787, False),
 ([("host","127.0.0.1:8787")], "http", None, False), ([("host","[::1]:8787")], "http", 8787, False),
 ([("host","localhost")], "http", 80, False), ([("host","localhost")], "https", 443, False), ([("host","localhost")], "http", 8787, False),
 ([("host","localhost:0")], "http", None, False), ([("host","localhost:65536")], "http", None, False), ([("host","localhost:99999")], "http", None, False),
 ([("host","localhost:123456")], "http", None, False), ([("host","evil.test:8787")], "http", 8787, False), ([("host","localhost:8787"),("host","localhost:8787")], "http", 8787, False),
 ([], "http", 8787, False), ([("host","localhost:8787 ")], "http", 8787, False),
 ([("host","localhost:8787"),("origin","http://localhost:8787")], "http", 8787, False), ([("host","localhost:8787"),("origin","HTTP://LOCALHOST:8787")], "http", 8787, False),
 ([("host","localhost:8787"),("origin","http://127.0.0.1:8787")], "http", 8787, False), ([("host","localhost:8787"),("origin","null")], "http", 8787, False),
 ([("host","localhost:8787")], "http", 8787, True), ([("host","localhost:8787"),("origin","http://localhost:8787")], "http", 8787, True),
 ([("host","localhost:8787"),("origin","http://localhost:8787"),("origin","http://localhost:8787")], "http", 8787, False),
 ([("host","localhost:8787"),("sec-fetch-site","cross-site")], "http", 8787, False), ([("host","localhost:8787"),("sec-fetch-site","same-site")], "http", 8787, False),
 ([("host","localhost:8787"),("sec-fetch-site","same-origin")], "http", 8787, False), ([("host","localhost:8787"),("sec-fetch-site","none"),("sec-fetch-site","cross-site")], "http", 8787, False),
 ([("host","localhost:8787"),("origin","https://localhost:8787")], "https", 8787, False),
]
out = {"origin": [[p, s, port, req, origin_refusal(H(p), s, port, required=req)] for p, s, port, req in origin]}
def req(method, path, pairs):
    scope = {"type": "http", "method": method, "path": path, "scheme": "http", "headers": [(k.encode("latin-1"), v.encode("latin-1")) for k, v in pairs], "query_string": b""}
    return Request(scope)
base = [("host","localhost:8787")]
reqs = [
 ("GET", "/api/health", []), ("POST", "/api/turn", [("content-type","application/json"),("content-length","10")]),
 ("POST", "/api/turn", [("content-type","application/json; charset=utf-8")]), ("POST", "/api/turn", [("content-type","Application/JSON")]),
 ("POST", "/api/turn", []), ("POST", "/api/session", []), ("POST", "/api/session/abc/cancel", []), ("POST", "/api/session/abc/cancel", [("content-length","1")]),
 ("POST", "/api/session/abc/detach", [("content-type","text/plain")]), ("POST", "/api/session/a/b/cancel", []), ("DELETE", "/api/session/abc", []),
 ("DELETE", "/api/session/abc", [("content-length","0")]), ("DELETE", "/api/session/abc", [("content-length","5")]),
 ("POST", "/api/audio/turn", [("content-type","audio/webm")]), ("POST", "/api/audio/turn", [("content-type","application/json")]),
 ("POST", "/api/audio/transcribe", [("content-type","application/json")]), ("POST", "/api/audio/transcribe", [("content-type","audio/webm;codecs=opus"),("content-length","10485760")]),
 ("POST", "/api/audio/transcribe", [("content-type","audio/webm"),("content-length","10485761")]), ("POST", "/api/turn", [("content-type","application/json"),("content-length","16385")]),
 ("POST", "/api/turn", [("content-type","application/json"),("content-length","16384")]), ("POST", "/api/turn", [("content-type","application/json"),("content-length","")]),
 ("POST", "/api/turn", [("content-type","application/json"),("content-length","-1")]),
 ("POST", "/api/turn", [("content-type","application/json"),("content-length","0000000000001")]), ("POST", "/api/turn", [("content-type","application/json"),("content-type","application/json")]),
 ("POST", "/api/audio/stop", []), ("POST", "/api/audio/recording", [("content-type","audio/x-m4a")]), ("PUT", "/api/turn", [("content-type","text/plain")]),
 ("POST", "/api/turn", [("content-type","application/json"),("content-length","12"),("content-length","999999")]),
]
out["request"] = [[m, p, h, request_refusal(req(m, p, base + h), 8787)] for m, p, h in reqs]
print(json.dumps(out, ensure_ascii=False))
