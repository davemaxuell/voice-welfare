"""
청음 서버 실행: python -m cheongeum.server (또는 cheongeum-server)
 - API(/api/*) + 웹 UI(정적 파일, 빌드 없음)를 한 포트로 서빙한다(기본 8787).
 - 모의 사이트(5174)가 떠 있지 않으면 함께 띄운다(--no-mock으로 끔).
 - --desktop: 데스크톱 앱(Electron) 뒤쪽 프로세스. 자기 출처만 쓰는 CSP, 실제 사이트 모드 기본, 금고는 ~/.cheongeum.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

from cheongeum.agents.web.browser import stop_playwright
from cheongeum.practice_site import is_reachable, start_mock_site
from cheongeum.server.app import close_all, create_app, mount_web_ui
from cheongeum.server.runtime import AgentRuntime, load_config

ROOT = Path(__file__).resolve().parents[3]


def build(desktop: bool = False, env: dict | None = None):
    env = dict(os.environ if env is None else env)
    if desktop:
        # 데스크톱 앱은 실제 사이트 모드가 기본(연습 신청서는 "연습"이라고 할 때만). PRACTICE_MODE=true로 바꿀 수 있다.
        env.setdefault("PRACTICE_MODE", "false")
        # 금고·신청 기록은 이 컴퓨터의 ~/.cheongeum/personal.json(권한 600)에만
        env.setdefault("CHEONGEUM_DATA_DIR", str(Path.home() / ".cheongeum"))
    runtime = AgentRuntime(load_config(env))

    @asynccontextmanager
    async def lifespan(app):
        # 로컬 받아쓰기 모델은 시작을 막지 않고 백그라운드 스레드에서 미리 불러온다(첫 말이 늦지 않게)
        warm = getattr(runtime.stt, "warm", None)
        if warm:
            asyncio.get_running_loop().run_in_executor(None, warm)
        yield
        await close_all(app.state.sessions)
        await runtime.close()
        await stop_playwright()

    api, _sessions = create_app(runtime, lifespan=lifespan)
    mount_web_ui(api, csp=desktop)
    return api, runtime


def main() -> None:
    parser = argparse.ArgumentParser(description="청음 서버(API + 웹 UI)")
    parser.add_argument("--port", type=int, default=None, help="기본 PORT 환경변수 또는 8787 (데스크톱은 DESKTOP_PORT 또는 8790)")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--desktop", action="store_true", help="데스크톱 앱 뒤쪽 프로세스로 실행")
    parser.add_argument("--no-mock", action="store_true", help="모의 사이트를 띄우지 않음")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if sys.platform == "win32":
        # Playwright는 하위 프로세스를 쓰므로 Proactor 루프가 필요하다(기본값이지만 명시).
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    port = args.port or int(os.environ.get("DESKTOP_PORT" if args.desktop else "PORT") or (8790 if args.desktop else 8787))
    mock = None
    if not args.no_mock and not is_reachable("http://localhost:5174"):
        mock = start_mock_site(5174)
    api, runtime = build(desktop=args.desktop)
    cfg = runtime.config
    tag = "desktop" if args.desktop else "server"
    print(f"[{tag}] http://localhost:{port}  (LLM: {runtime.intent_provider.name}, 복지데이터: {runtime.welfare_provider.mode})")
    print(f"[{tag}] 허용 출처: {', '.join(runtime.allowed_origins)}  · 브라우저: {'headless' if cfg.headless else 'headed'}")
    server = uvicorn.Server(uvicorn.Config(api, host=args.host, port=port, log_level="warning"))
    if args.desktop:
        print(f"[desktop] ready http://localhost:{port}", flush=True)
        if os.environ.get("CHEONGEUM_PARENT_PIPE") == "1":
            _exit_when_parent_closes(server)
    try:
        server.run()
    finally:
        if mock:
            mock.close()


def _exit_when_parent_closes(server: uvicorn.Server) -> None:
    """데스크톱 앱(부모)이 stdin 파이프를 닫으면(종료·비정상 종료) 서버를 정리하고 끝낸다."""
    import threading

    def watch() -> None:
        try:
            while sys.stdin.read(1024):
                pass
        except (OSError, ValueError):
            pass
        server.should_exit = True

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()


if __name__ == "__main__":
    main()
