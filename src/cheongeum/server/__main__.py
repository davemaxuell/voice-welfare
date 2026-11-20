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
import socket
import sys
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path

import uvicorn
from dotenv import dotenv_values, load_dotenv

from cheongeum.agents.web.browser import stop_playwright
from cheongeum.practice_site import is_reachable, start_mock_site
from cheongeum.server.app import close_all, create_app, mount_web_ui
from cheongeum.server.runtime import AgentRuntime, load_config
from cheongeum.server.settings import SettingsStore

ROOT = Path(__file__).resolve().parents[3]


def _bind_local(sock: socket.socket, host: str, port: int, port_file: Path | None) -> int:
    # Keeping the same origin preserves the user's microphone selection between app launches.
    if port_file:
        try:
            saved = int(port_file.read_text(encoding="ascii"))
            if 1024 <= saved <= 65535:
                port = saved
        except (OSError, ValueError):
            pass
    try:
        sock.bind((host, port))
    except OSError:
        if port_file is None:
            raise
        sock.bind((host, 0))
    sock.listen()
    port = sock.getsockname()[1]
    if port_file:
        try:
            port_file.write_text(str(port), encoding="ascii")
        except OSError:
            pass
    return port


def build(desktop: bool = False, env: dict | None = None, *, port: int | None = None):
    env = dict(os.environ if env is None else env)
    if desktop:
        # 데스크톱 앱은 실제 사이트 모드가 기본(연습 신청서는 "연습"이라고 할 때만). PRACTICE_MODE=true로 바꿀 수 있다.
        env.setdefault("PRACTICE_MODE", "false")
        # 금고·신청 기록은 이 컴퓨터의 ~/.cheongeum/personal.json(권한 600)에만
        env.setdefault("CHEONGEUM_DATA_DIR", str(Path.home() / ".cheongeum"))
        if runtime_dir := env.get("CHEONGEUM_DESKTOP_RUNTIME"):
            models = Path(runtime_dir) / "models"
            env.setdefault("PII_MODEL", str(models / "koelectra-ko-pii-ner"))
    settings_dir = Path(env.get("CHEONGEUM_SETTINGS_DIR") or Path.home() / ".cheongeum")
    runtime = AgentRuntime(load_config(env), SettingsStore(settings_dir / "preferences.json"))

    @asynccontextmanager
    async def lifespan(app):
        await app.state.workflows.reconfigure()
        try:
            yield
        finally:
            await app.state.workflows.close()
            await close_all(app.state.sessions)
            await runtime.close()
            await stop_playwright()

    api, _sessions = create_app(runtime, lifespan=lifespan, port=port, workflow_dsn=env.get("CHEONGEUM_DATABASE_URL") or "")
    mount_web_ui(api, csp=desktop)
    return api, runtime


def main() -> None:
    parser = argparse.ArgumentParser(description="청음 서버(API + 웹 UI)")
    parser.add_argument("--port", type=int, default=None, help="기본 PORT 환경변수 또는 8787 (데스크톱은 DESKTOP_PORT 또는 8790)")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--desktop", action="store_true", help="데스크톱 앱 뒤쪽 프로세스로 실행")
    parser.add_argument("--no-mock", action="store_true", help="모의 사이트를 띄우지 않음")
    parser.add_argument("--env-file", type=Path, default=ROOT / ".env", help="서비스 설정 파일")
    args = parser.parse_args()
    if args.desktop and os.environ.get("CHEONGEUM_DESKTOP_RUNTIME"):
        # Imported service settings are app configuration, not environment variables for child browsers.
        settings = dotenv_values(args.env_file, encoding="utf-8-sig")
        env = {**{k: v for k, v in settings.items() if v is not None}, **os.environ}
    else:
        load_dotenv(args.env_file, encoding="utf-8-sig")
        env = dict(os.environ)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if sys.platform == "win32":
        # Playwright는 하위 프로세스를 쓰므로 Proactor 루프가 필요하다(기본값이지만 명시).
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    configured_port = env.get("DESKTOP_PORT" if args.desktop else "PORT")
    port = args.port if args.port is not None else int(configured_port or (8790 if args.desktop else 8787))
    if args.host not in ("localhost", "127.0.0.1", "::1"):
        parser.error("--host는 루프백 주소여야 합니다.")
    child = args.desktop and env.get("CHEONGEUM_PARENT_PIPE") == "1"
    bundled = child and env.get("CHEONGEUM_DESKTOP_RUNTIME")
    with ExitStack() as stack:
        listener = None
        if child or port == 0:
            # Keep the loopback socket from port allocation through Uvicorn startup.
            family = socket.AF_INET6 if args.host == "::1" else socket.AF_INET
            listener = stack.enter_context(socket.socket(family))
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            auto = bundled and args.port is None and not configured_port
            port = _bind_local(listener, args.host, port, args.env_file.with_name("service-port") if auto else None)
        if not args.no_mock:
            if bundled and not env.get("MOCK_SITE_URL"):
                mock = start_mock_site(0)
                stack.callback(mock.close)
                env["MOCK_SITE_URL"] = f"http://localhost:{mock.port}"
            elif not is_reachable("http://localhost:5174"):
                stack.callback(start_mock_site(5174).close)
        api, runtime = build(desktop=args.desktop, env=env, port=port)
        tag = "desktop" if args.desktop else "server"
        host = f"[{args.host}]" if ":" in args.host else args.host
        url = f"http://{host}:{port}"
        print(f"[{tag}] {url}  (LLM: {runtime.intent_provider.name}, 복지데이터: {runtime.welfare_provider.mode})")
        print(f"[{tag}] 허용 출처: {', '.join(runtime.allowed_origins)}  · 브라우저: {'headless' if runtime.config.headless else 'headed'}")
        server = uvicorn.Server(uvicorn.Config(api, host=args.host, port=port, log_level="warning"))
        if child:
            _exit_when_parent_closes(server)
        if args.desktop:
            print(f"[desktop] ready {url}", flush=True)
        server.run(sockets=[listener] if listener else None)


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
