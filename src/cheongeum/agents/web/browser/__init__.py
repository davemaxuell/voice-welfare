"""
Agent A의 PC 실행 어댑터: Playwright Chromium + 접근성 locator.
관찰은 문자열 스크립트(observe.js)로 브라우저 안에서 돌린다. 비밀번호 입력란의 값은 읽지 않는다.
"""
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from importlib import resources
from pathlib import Path
from typing import Any, AsyncIterator, Sequence
from weakref import WeakSet

from playwright.async_api import Browser, BrowserContext, Locator, Page, Playwright, async_playwright

from cheongeum.core.actions import parse_observation
from cheongeum.core.jsutil import AbortSignal, now_iso, parse_url, race_abort, rx, try_url


def _asset(name: str) -> str:
    return resources.files(__package__).joinpath(name).read_text(encoding="utf-8")


OBSERVE_SCRIPT = _asset("observe.js")
REST_CURSOR_SCRIPT = _asset("rest_cursor.js")
_CURSOR_TEMPLATE = _asset("cursor.js")
WAITING_HTML = _asset("waiting.html")


def cursor_script(x: int, y: int, ripple: bool) -> str:
    """시연용 가상 커서: 대상 위치로 동그랗게 번지는 빛이 움직이고, 누를 때 물결처럼 퍼진다(페이지 DOM은 건드리지 않는 오버레이)."""
    return _CURSOR_TEMPLATE.replace("__X__", str(x)).replace("__Y__", str(y)).replace("__RIPPLE__", "true" if ripple else "false")


class AdapterError(Exception):
    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code


_playwright: Playwright | None = None
_playwright_lock: asyncio.Lock | None = None  # 지연 생성(이벤트 루프 안에서)


async def _pw() -> Playwright:
    global _playwright, _playwright_lock
    if _playwright_lock is None:
        _playwright_lock = asyncio.Lock()
    async with _playwright_lock:
        if _playwright is None:
            _playwright = await async_playwright().start()
    return _playwright


async def stop_playwright() -> None:
    global _playwright
    if _playwright is not None:
        await _playwright.stop()
        _playwright = None


async def launch_browser(headless: bool, slow_mo_ms: int = 0) -> Browser:
    pw = await _pw()
    return await pw.chromium.launch(headless=headless, slow_mo=slow_mo_ms or 0)


async def launch_chrome_profile(user_data_dir: str, slow_mo_ms: int = 0) -> BrowserContext:
    """
    설치된 Google Chrome을 영구 프로필로 띄운다(로그인·쿠키 유지). 크롬 보안 정책상 기본 프로필에는
    자동화를 붙일 수 없어 별도 폴더를 쓴다. 자동화 표시는 그대로 두며 탐지를 피하는 설정은 하지 않는다.
    """
    pw = await _pw()
    return await pw.chromium.launch_persistent_context(
        user_data_dir,
        channel="chrome",
        headless=False,
        no_viewport=True,
        locale="ko-KR",
        slow_mo=slow_mo_ms or 0,
        accept_downloads=True,
    )


# 공유 컨텍스트에 라우팅·탭 추적을 한 번만 설치하기 위한 표시
_prepared_contexts: "WeakSet[BrowserContext]" = WeakSet()
_claimed_pages: "WeakSet[Page]" = WeakSet()
# 공유 크롬에서 '마지막 탭인가'를 보고 닫기까지를 한 세션씩(둘이 동시에 닫으면 둘 다 남은 탭이 있다고 본다)
_shared_close_lock = asyncio.Lock()


async def _error_page_settled(page: Page) -> None:
    """막히거나 실패한 이동은 크롬 오류 화면으로 끝나고, 그 화면은 조금 늦게 들어선다. 들어서기 전에는 다음 이동이 끊긴다."""
    try:
        await page.wait_for_url(lambda u: u.startswith("chrome-error://"), wait_until="commit", timeout=3000)
    except Exception:  # noqa: BLE001
        pass


async def _step_and_settle(page: Page, step: Any) -> None:
    """
    기록 이동 하나(step: 인자 없이 부르면 이동을 시작하는 함수)를 하고 그 결과(새 화면이든, 막혀서 생긴 오류 화면이든)가 들어설 때까지 기다린다.
    이미 오류 화면에 있을 때도 다음 화면을 기다려야 하므로 주소가 아니라 이동 사건을 본다.
    """
    try:
        async with page.expect_event("framenavigated", predicate=lambda f: f == page.main_frame, timeout=3000):
            try:
                await step()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def _css_escape(v: str) -> str:
    return rx(r'["\\]').sub(lambda m: "\\" + m.group(0), v)


class PlaywrightExecutionAdapter:
    platform = "pc"

    def __init__(
        self,
        *,
        browser: Browser | None = None,
        context: BrowserContext | None = None,
        allowed_origins: Sequence[str],
        read_only_web: bool = False,
        visual_cursor: bool = False,
        action_timeout_ms: int = 5000,
        navigation_timeout_ms: int = 10_000,
    ) -> None:
        self._browser = browser
        self._given_context = context
        self.allowed_origins = list(allowed_origins)
        self.read_only_web = read_only_web
        self.visual_cursor = visual_cursor
        self.action_timeout = action_timeout_ms
        self.navigation_timeout = navigation_timeout_ms
        self.context: BrowserContext | None = None
        # 공유(영구 프로필) 컨텍스트면 닫을 때 컨텍스트가 아니라 내 탭만 닫는다
        self.shared = False
        self.page: Page | None = None
        self._native_dialogs: list[str] = []
        # 다운로드 저장소(DownloadStore). 경로에 받아 두고 이름을 말한다.
        self.downloads = None
        self._last_download: dict | None = None
        # 지금 화면을 가져온 이동의 방식(양식 결과면 POST). 되돌아갈 때 양식을 다시 보내지 않으려고 본다.
        self._doc_method = "GET"

    async def start(self) -> None:
        # 테스트용 Chromium: 세션마다 별도 컨텍스트(쿠키·저장소 분리). 실제 크롬: 공유 영구 프로필.
        self.shared = self._given_context is not None
        if self._given_context is not None:
            self.context = self._given_context
        else:
            assert self._browser is not None
            self.context = await self._browser.new_context(
                locale="ko-KR", viewport={"width": 1100, "height": 860}, accept_downloads=True
            )
        if self.shared and self.context in _prepared_contexts:
            await self._open_own_page()
            return
        _prepared_contexts.add(self.context)

        async def route_handler(route) -> None:
            url = route.request.url
            allowed = url.startswith("data:") or url.startswith("blob:")
            u = try_url(url)
            if u is not None:
                allowed = allowed or u.origin in self.allowed_origins
                # 읽기 전용 웹: 다른 사이트도 열되 http/https만. 입력·제출 차단은 PolicyGuard 몫.
                allowed = allowed or (self.read_only_web and u.protocol in ("https:", "http:"))
            try:
                if allowed:
                    await route.continue_()
                else:
                    await route.abort("blockedbyclient")
            except Exception:  # noqa: BLE001 — 페이지가 닫힌 뒤 늦게 온 요청
                pass

        await self.context.route("**/*", route_handler)
        await self._open_own_page()

    async def _open_own_page(self) -> None:
        ctx = self.context
        assert ctx is not None

        # 링크가 새 탭으로 열리면 그 탭을 따라간다(사용자에게는 같은 화면 흐름으로 안내).
        async def on_page(p: Page) -> None:
            # 내 탭이 연 새 탭만 따라간다(공유 프로필의 다른 세션 탭은 무시)
            try:
                opener = await p.opener()
            except Exception:  # noqa: BLE001
                return
            if opener is not None and opener == self.page:
                _claimed_pages.add(p)
                self._attach(p)

        ctx.on("page", lambda p: asyncio.ensure_future(on_page(p)))
        # 실제 크롬을 처음 띄우면 빈 탭이 하나 있으니 그것을 쓴다.
        blank = next((p for p in ctx.pages if p not in _claimed_pages and p.url == "about:blank"), None)
        page = blank or await ctx.new_page()
        _claimed_pages.add(page)
        self._attach(page)
        # 동의 전에는 아무 사이트도 열지 않는다. 빈 창 대신 이 창이 무엇인지 알려 주는 대기 화면을 보인다(주소는 about:blank 그대로).
        try:
            await page.set_content(WAITING_HTML)
        except Exception:  # noqa: BLE001
            pass

    async def bring_to_front(self) -> None:
        if self.page is not None:
            try:
                await self.page.bring_to_front()
            except Exception:  # noqa: BLE001
                pass

    def _attach(self, page: Page) -> None:
        self.page = page

        def on_request(req) -> None:
            if req.is_navigation_request() and req.frame == page.main_frame:
                self._doc_method = req.method

        page.on("request", on_request)

        def on_dialog(d) -> None:
            self._native_dialogs.append(d.message[:200])

            async def dismiss() -> None:
                try:
                    await d.dismiss()
                except Exception:  # noqa: BLE001
                    pass

            asyncio.ensure_future(dismiss())

        def on_close(_p) -> None:
            if self.page is page:
                pages = self.context.pages if self.context else []
                self.page = pages[-1] if pages else None

        page.on("dialog", on_dialog)
        page.on("close", on_close)

        def on_download(d) -> None:
            asyncio.ensure_future(self._save_download(d))

        page.on("download", on_download)

    async def _save_download(self, download) -> None:
        """Playwright download → downloads 폴더. 실패해도 조작은 이미 끝난 뒤다."""
        try:
            suggested = download.suggested_filename or f"download-{int(time.time())}"
            store = self.downloads
            if store is not None and getattr(store, "folder", None):
                dest = Path(store.folder) / suggested
                await download.save_as(str(dest))
                rec = store.remember(dest, suggested)
            else:
                path = await download.path()
                rec = {"name": suggested, "path": str(path) if path else "", "at": time.time()}
                if store is not None and path:
                    rec = store.remember(path, suggested)
            self._last_download = rec
        except Exception:  # noqa: BLE001
            pass

    def take_download_notice(self) -> str | None:
        """방금 받은 파일이 있으면 한 줄 안내(한 번만)."""
        d = self._last_download
        self._last_download = None
        if not d:
            return None
        return f"'{d['name']}' 파일을 받았어요. 읽어 드리려면 '받은 파일 읽어줘'라고 하세요."

    def _require_page(self) -> Page:
        if self.page is None:
            raise AdapterError("NOT_SUPPORTED", "어댑터가 시작되지 않았습니다.")
        return self.page

    async def execute(self, action: dict, signal: AbortSignal | None = None) -> dict:
        started = time.monotonic()

        def done(**p: Any) -> dict:
            out = {"actionId": action["id"], "ok": False, "verified": False, "latencyMs": int((time.monotonic() - started) * 1000)}
            out.update({k: v for k, v in p.items() if v is not None})
            return out

        if signal is not None and signal.aborted:
            return done(errorCode="ABORTED")
        try:
            work = self._perform(self._require_page(), action)
            result = await race_abort(work, signal, AdapterError("ABORTED")) if signal is not None else await work
            # 시연용 가상 커서: 페이지를 옮기면(새 문서·새 탭) 커서가 사라지므로 지금 화면에 다시 놓는다
            if self.visual_cursor and result.get("ok") and action["type"] != "read":
                try:
                    await self._rest_cursor()
                except Exception:  # noqa: BLE001
                    pass
            return done(**result)
        except AdapterError as e:
            return done(errorCode=e.code, message=e.message)
        except Exception as e:  # noqa: BLE001
            name = type(e).__name__
            msg = str(e)
            if name == "TimeoutError" or "Timeout" in msg:
                return done(errorCode="TIMEOUT")
            if action["type"] == "navigate":
                return done(errorCode="NAVIGATION_FAILED")
            return done(errorCode="UNKNOWN")

    async def _return_to(self, page: Page, prev: str, failed: str, prev_was_form: bool) -> None:
        """
        불러오지 못한 주소는 크롬 오류 화면(chrome-error://)을 남긴다. 사용자는 '열지 못했다'는 말만 듣고
        원래 화면에 있다고 여기므로 그 화면으로 돌아간다. 기록에서 한 칸 뒤로 가야 그 뒤의 '뒤로 가줘'도 맞다
        (주소를 다시 열면 오류 칸이 기록에 남아 다음 뒤로 가기가 그 칸에 걸린다). 다만 그 화면이 양식 결과(POST)였거나,
        실패한 주소가 지금 화면이었으면(크롬이 그 칸을 오류 화면으로 바꿨다) 주소를 GET으로 다시 연다.
        """
        try:
            await _error_page_settled(page)
            if not prev.startswith(("http://", "https://")):
                await page.goto("about:blank")
                return
            if not prev_was_form and prev.rstrip("/") != failed.rstrip("/"):
                async with self._no_form_resend(page) as blocked:
                    await _step_and_settle(page, lambda: page.go_back(wait_until="commit", timeout=self.navigation_timeout))
                if not blocked and page.url == prev:
                    try:
                        await page.wait_for_load_state("domcontentloaded", timeout=self.navigation_timeout)
                    except Exception:  # noqa: BLE001
                        pass
                    return
            try:
                await self._open(page, prev)
            except Exception as e:  # noqa: BLE001
                if "net::ERR_" in str(e):
                    await page.goto("about:blank")
        except Exception:  # noqa: BLE001
            pass  # 되돌리지 못해도 '열지 못함'은 그대로 알린다

    async def _open(self, page: Page, url: str) -> None:
        """
        주소를 연다. 응답이 들어오면(commit) 열린 것이고, 화면 글이 다 그려지기(DOMContentLoaded)는 같은 시간까지만 기다린다.
        공공 누리집은 응답이 바로 와도 막는 스크립트 때문에 첫 방문에 다 그리기까지 10초쯤 걸린다(복지로).
        그것을 실패로 알리면 사용자는 '열지 못했다'고 듣는데 화면은 곧 열린다.
        """
        await page.goto(url, wait_until="commit", timeout=self.navigation_timeout)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=self.navigation_timeout)
        except Exception:  # noqa: BLE001
            pass

    @asynccontextmanager
    async def _no_form_resend(self, page: Page) -> AsyncIterator[list[str]]:
        """
        기록 이동이 양식(POST)을 다시 보내지 않게 한다. 자동화된 크롬은 '양식 다시 제출 확인' 없이 그냥 다시 보낸다.
        다른 요청은 컨텍스트의 출처 검사로 넘긴다(공유 프로필에서는 그 검사가 세션 사이에 함께 쓰여 여기에 둔다).
        """
        blocked: list[str] = []

        async def guard(route) -> None:
            req = route.request
            if req.is_navigation_request() and req.method != "GET":
                blocked.append(req.url)
                await route.abort("blockedbyclient")
            else:
                await route.fallback()

        await page.route("**/*", guard)
        try:
            yield blocked
        finally:
            await page.unroute("**/*", guard)

    async def _perform(self, page: Page, action: dict) -> dict:
        kind = action["type"]
        target = action.get("target")
        if kind == "navigate":
            url = action.get("url")
            if not url:
                raise AdapterError("NAVIGATION_FAILED")
            prev, prev_was_form = page.url, self._doc_method != "GET"
            try:
                await self._open(page, url)
            except Exception as e:
                # 내려받기 등으로 이동이 취소된 것(ERR_ABORTED)은 오류 화면을 남기지 않는다
                if "net::ERR_" in str(e) and "ERR_ABORTED" not in str(e):
                    await self._return_to(page, prev, url, prev_was_form)
                raise
            # 실제 사이트는 내용을 늦게 그리는 경우가 많아 잠깐(최대 3초) 네트워크가 잠잠해지길 기다린다.
            # 지원 사이트(로컬 모의 사이트)는 바로 그려지므로 기다리지 않는다(응답 속도).
            if parse_url(url).origin not in self.allowed_origins:
                try:
                    await page.wait_for_load_state("networkidle", timeout=3000)
                except Exception:  # noqa: BLE001
                    pass
            return {"ok": True, "verified": parse_url(page.url).origin == parse_url(url).origin}
        if kind == "back":
            here = page.url
            async with self._no_form_resend(page) as blocked:
                try:
                    res = await page.go_back(wait_until="domcontentloaded", timeout=self.navigation_timeout)
                except Exception:
                    if not blocked:
                        raise
                if blocked:
                    # 막은 이동은 크롬 오류 화면으로 끝나고, 그 화면이 들어서기 전에는 앞으로 갈 수 없다.
                    # 있던 화면도 양식 결과면 앞으로 가기도 막히므로, 그때는 그 주소를 GET으로 다시 연다.
                    await _error_page_settled(page)
                    await _step_and_settle(page, lambda: page.go_forward(wait_until="commit", timeout=self.navigation_timeout))
                    if page.url != here:
                        try:
                            await self._open(page, here)
                        except Exception:  # noqa: BLE001
                            pass
                    raise AdapterError("RESUBMIT_BLOCKED")
            return {"ok": True, "verified": res is not None}
        if kind == "scroll":
            if target:
                await (await self._resolve(page, target)).scroll_into_view_if_needed()
            else:
                await page.mouse.wheel(0, 600)
            return {"ok": True, "verified": True}

        t = self.action_timeout
        if kind == "click" and target and not target.get("ref") and target.get("role") == "link" and target.get("name"):
            fallback = await self._link_fallback(page, target)
            if fallback:
                return fallback
        loc = await self._resolve(page, target)
        if self.visual_cursor and kind != "read":
            await self._show_cursor(page, loc, kind in ("click", "check", "press"))
            if target and target.get("ref"):
                loc = await self._resolve_ref(page, target)  # 커서를 움직이는 사이(0.65초)에 글자가 바뀌었을 수 있다
        if kind == "click":
            await loc.click(timeout=t)
            return {"ok": True, "verified": True}
        if kind == "focus":
            await loc.focus(timeout=t)
            return {"ok": True, "verified": True}
        if kind == "press":
            await loc.press(action.get("value") or "Enter", timeout=t)
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=t)
            except Exception:  # noqa: BLE001
                pass
            return {"ok": True, "verified": True}
        if kind == "fill":
            if (await loc.get_attribute("type")) == "password":
                raise AdapterError("NOT_SUPPORTED", "비밀번호 입력란은 조작하지 않습니다.")
            value = action.get("value") or ""
            await loc.fill(value, timeout=t)
            read_back = await loc.input_value(timeout=t)
            return {"ok": True, "verified": read_back == value, "readValue": read_back}
        if kind == "select":
            await loc.select_option(label=action.get("value") or "", timeout=t)
            label = ((await loc.locator("option:checked").text_content(timeout=t)) or "").strip()
            return {"ok": True, "verified": label == action.get("value"), "readValue": label}
        if kind == "check":
            want = bool(action.get("checked"))
            await loc.set_checked(want, timeout=t)
            checked = await loc.is_checked(timeout=t)
            return {"ok": True, "verified": checked == want, "readValue": "예" if checked else "아니오"}
        if kind == "read":
            type_ = await loc.get_attribute("type")
            if type_ == "password":
                return {"ok": True, "verified": True, "readValue": ""}
            if type_ == "checkbox":
                return {"ok": True, "verified": True, "readValue": "예" if await loc.is_checked(timeout=t) else "아니오"}
            if await loc.locator("option").count() > 0:
                v = await loc.input_value(timeout=t)
                text = ((await loc.locator("option:checked").text_content(timeout=t)) or "").strip() if v else ""
                return {"ok": True, "verified": True, "readValue": text}
            return {"ok": True, "verified": True, "readValue": await loc.input_value(timeout=t)}
        raise AdapterError("NOT_SUPPORTED")

    async def _link_fallback(self, page: Page, target: dict) -> dict | None:
        """
        링크 이름(화면 글자)과 접근성 이름이 다른 사이트(aria-label, "새창" 덧붙임 등)나 접힌 메뉴 속 링크:
        접근성 이름으로 못 찾을 때만 글자로 찾아 누르고, 보이지 않으면 그 링크 주소(http/https)로 이동한다.
        링크 이동은 PolicyGuard가 이미 허용한 동작이다. 처리하지 않았으면 None.
        """
        by_role = page.get_by_role("link", name=target["name"], exact=True).filter(visible=True)
        if await by_role.count() > 0:
            return None

        def norm(s: str) -> str:
            return rx(r"\s+").sub("", s)

        want = norm(target["name"])
        anchors = page.locator("a[href]")
        n = min(await anchors.count(), 400)
        hidden: str | None = None
        for i in range(n):
            a = anchors.nth(i)
            try:
                text = norm((await a.text_content()) or "")
            except Exception:  # noqa: BLE001
                text = ""
            if text != want:
                continue
            try:
                visible = await a.is_visible()
            except Exception:  # noqa: BLE001
                visible = False
            if visible:
                if self.visual_cursor:
                    await self._show_cursor(page, a, True)
                await a.click(timeout=self.action_timeout)
                return {"ok": True, "verified": True}
            if hidden is None:
                try:
                    hidden = await a.get_attribute("href")
                except Exception:  # noqa: BLE001
                    hidden = None
        if not hidden:
            return None
        try:
            url = parse_url(hidden, page.url)
        except ValueError:
            return None
        if url.protocol not in ("http:", "https:"):
            return None  # javascript: 등은 열지 않는다
        await page.goto(url.href, wait_until="domcontentloaded", timeout=self.navigation_timeout)
        return {"ok": True, "verified": True}

    async def _resolve(self, page: Page, target: dict | None) -> Locator:
        """접근성 우선 locator. 0개면 잠시 대기, 2개 이상이면 실행하지 않는다."""
        if not target:
            raise AdapterError("TARGET_NOT_FOUND")
        if target.get("ref"):
            return await self._resolve_ref(page, target)
        if target.get("label"):
            loc = page.get_by_label(target["label"], exact=True)
        elif target.get("role") and target.get("name"):
            loc = page.get_by_role(target["role"], name=target["name"], exact=True)  # type: ignore[arg-type]
        elif target.get("testId"):
            loc = page.get_by_test_id(target["testId"])
        elif target.get("fieldId"):
            fid = _css_escape(target["fieldId"])
            loc = page.locator(f'[id="{fid}"], [data-cheongeum-id="{fid}"]')
        else:
            raise AdapterError("TARGET_NOT_FOUND")
        loc = loc.filter(visible=True)
        if target.get("nth") is not None:
            nth = loc.nth(target["nth"])
            if await nth.count() == 0:
                raise AdapterError("TARGET_NOT_FOUND")
            return nth
        count = await loc.count()
        if count == 0:
            try:
                await loc.first.wait_for(state="visible", timeout=2000)
            except Exception:  # noqa: BLE001
                pass
            count = await loc.count()
        if count == 0:
            raise AdapterError("TARGET_NOT_FOUND")
        if count > 1:
            raise AdapterError("AMBIGUOUS_TARGET")
        return loc

    async def _resolve_ref(self, page: Page, target: dict) -> Locator:
        ref = target["ref"]
        raw = await page.evaluate(OBSERVE_SCRIPT)
        now = next((it for it in (raw.get("outline") or {}).get("items") or [] if it["ref"] == ref), None)
        if now is None:
            raise AdapterError("TARGET_NOT_FOUND")
        if now["role"] != target.get("role") or now["name"] != target.get("name"):
            raise AdapterError("VERIFY_FAILED", "누르려던 요소의 이름이나 역할이 바뀌었습니다.")
        loc = page.locator(f'[data-cheongeum-ref="{_css_escape(ref)}"]').filter(visible=True)
        if await loc.count() != 1:
            raise AdapterError("AMBIGUOUS_TARGET")
        return loc

    async def _rest_cursor(self) -> None:
        """
        커서가 없는 화면(방금 연 페이지)이면 큰 제목이나 본문 위에 놓아 둔다. 있으면 그대로(마지막 조작 위치) 둔다.
        화면 글을 읽거나 바꾸지 않는 오버레이라 사이트 동작에 영향이 없다.
        """
        page = self._require_page()
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:  # noqa: BLE001
            pass
        try:
            spot = await page.evaluate(REST_CURSOR_SCRIPT)
        except Exception:  # noqa: BLE001
            spot = None
        if spot:
            try:
                await page.evaluate(cursor_script(spot["x"], spot["y"], False))
            except Exception:  # noqa: BLE001
                pass

    async def _show_cursor(self, page: Page, loc: Locator, ripple: bool) -> None:
        try:
            await loc.scroll_into_view_if_needed(timeout=2000)
        except Exception:  # noqa: BLE001
            pass
        try:
            box = await loc.bounding_box()
        except Exception:  # noqa: BLE001
            box = None
        if not box:
            return
        try:
            await page.evaluate(cursor_script(round(box["x"] + box["width"] / 2), round(box["y"] + box["height"] / 2), ripple))
        except Exception:  # noqa: BLE001
            pass
        await page.wait_for_timeout(650 if ripple else 450)

    async def observe(self) -> dict:
        page = self._require_page()
        raw = await page.evaluate(OBSERVE_SCRIPT)
        errors = [*raw.get("errors", []), *(f"브라우저 경고창: {m}" for m in self._native_dialogs)]
        self._native_dialogs = []
        return parse_observation({**raw, "errors": errors, "platform": "pc", "url": page.url, "capturedAt": now_iso()})

    async def clear_site_login(self, *, current_only: bool = True) -> list[str]:
        """
        로그인 쿠키·저장소를 지운다. current_only면 지금 페이지 호스트(및 상위 도메인)만.
        반환: 지운 호스트 이름들(말하기용).
        """
        if self.context is None:
            return []
        cookies = await self.context.cookies()
        host = ""
        if current_only:
            if self.page is None:
                return []
            try:
                from urllib.parse import urlparse

                host = (urlparse(self.page.url).hostname or "").lower()
            except Exception:  # noqa: BLE001
                host = ""
            # 호스트를 모르면 전부 지우지 않는다(about:blank·오류 페이지에서 전 쿠키 삭제 방지).
            if not host:
                return []

        def matches(domain: str) -> bool:
            d = domain.lstrip(".").lower()
            if not current_only:
                return True
            return host == d or host.endswith(f".{d}") or d.endswith(f".{host}")

        targets = [c for c in cookies if matches(c.get("domain") or "")]
        hosts: list[str] = []
        for c in targets:
            d = (c.get("domain") or "").lstrip(".")
            if d and d not in hosts:
                hosts.append(d)
            try:
                await self.context.clear_cookies(name=c["name"], domain=c.get("domain"), path=c.get("path") or "/")
            except Exception:  # noqa: BLE001
                pass
        if self.page is not None and (not current_only or host):
            try:
                await self.page.evaluate("() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }")
            except Exception:  # noqa: BLE001
                pass
        return hosts

    async def close(self) -> None:
        try:
            if self.shared:
                if self.page is not None:
                    # 공유 크롬의 마지막 탭을 닫으면 크롬이 꺼지기 시작해, 곧바로 만든 다음 세션(화면 새로고침)이
                    # 탭을 열지 못한다. 빈 탭을 먼저 열어 두면 다음 세션이 그 탭을 쓴다.
                    async with _shared_close_lock:
                        ctx = self.context
                        if ctx is not None and all(p is self.page for p in ctx.pages):
                            await ctx.new_page()
                        await self.page.close()
            elif self.context is not None:
                await self.context.close()
        except Exception:  # noqa: BLE001
            pass
        self.context = None
        self.page = None
