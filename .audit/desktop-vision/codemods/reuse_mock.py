"""
pytest 플러그인(저장소 밖, 커밋하지 않음): 포트 5174를 다른 체크아웃의 모의 사이트가 쓰고 있어도
그 서버가 내보내는 파일이 이 체크아웃의 site/ 파일과 같으면(줄 끝 CRLF·LF 차이만 무시) '우리 것'으로 보고 재사용한다.
사용: PYTHONPATH=<이 폴더> uv run pytest -p reuse_mock ...
다르면 원래대로 기다린다. 실행 뒤에 같은지 다시 확인해 결과에 적는다.
"""
from __future__ import annotations

import sys

import httpx

import cheongeum.practice_site.serve as serve

_orig = serve.port_state
CR_LF = bytes([13, 10])
LF = bytes([10])


def _norm(b: bytes) -> bytes:
    return b.replace(CR_LF, LF)


def same_content(port: int = 5174) -> tuple[bool, str]:
    files = [p for p in serve.SITE_DIR.rglob("*") if p.is_file()]
    for p in files:
        rel = p.relative_to(serve.SITE_DIR).as_posix()
        try:
            r = httpx.get(f"http://127.0.0.1:{port}/{rel}", timeout=3, trust_env=False)
        except httpx.HTTPError as e:
            return False, f"{rel}: {e!r}"
        if r.status_code != 200 or _norm(r.content) != _norm(p.read_bytes()):
            return False, f"{rel}: status {r.status_code}, {len(r.content)} vs {p.stat().st_size} bytes"
    return True, f"{len(files)} files identical"


def _port_state(port: int):
    state = _orig(port)
    if state == "other":
        ok, why = same_content(port)
        print(f"[reuse_mock] other checkout on :{port}; content check: {why}", file=sys.stderr, flush=True)
        if ok:
            return "ours"
    return state


def pytest_configure(config):
    serve.port_state = _port_state


def pytest_sessionfinish(session, exitstatus):
    ok, why = same_content()
    print(f"\n[reuse_mock] after run: {why}", file=sys.stderr, flush=True)
