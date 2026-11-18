"""
Agent A: 웹 탐색·실행. 모든 액션은 PolicyGuard → 어댑터 → 재관찰(검증) 순서로만 실행한다.
화면 텍스트는 비신뢰 데이터로 다루며 명령으로 해석하지 않는다.
"""
from __future__ import annotations

import asyncio
import time
from contextlib import contextmanager
from dataclasses import dataclass, field as dc_field, replace
from typing import Any, Callable, Iterator, Literal

from cheongeum.agents.web.profile import FieldProfile, SiteProfile, normalize_term
from cheongeum.core.jsutil import AbortSignal, I, nz, rx, try_url, uniq, uuid
from cheongeum.core.turn import AGENT_IDS
from cheongeum.safety import PolicyContext, PolicyGuard
from cheongeum.speech.phrasing import speak_label


@dataclass
class ExecContext:
    signal: AbortSignal
    approvals: set[str]
    is_stopped: Callable[[], bool]
    trace: Callable[..., None]  # trace(phase, agent, note=None)
    counter: dict = dc_field(default_factory=lambda: {"actions": 0})

    @contextmanager
    def granted(self, ids: list[str]) -> Iterator[None]:
        """이 액션들을 블록 안에서만 승인된 것으로 둔다(PolicyGuard가 approvals를 본다)."""
        self.approvals.update(ids)
        try:
            yield
        finally:
            self.approvals.difference_update(ids)


@dataclass
class FieldResolution:
    kind: Literal["ok", "ambiguous", "not-visible", "not-found"]
    field: FieldProfile | None = None
    candidates: list[FieldProfile] = dc_field(default_factory=list)


OutcomeStatus = Literal["ok", "needs-clarification", "validation-error", "policy-denied", "failed", "aborted"]


@dataclass
class WebOutcome:
    status: OutcomeStatus
    actions: list[dict]
    view: dict | None = None
    message: str | None = None
    readValue: str | None = None
    # 사이트가 오류로 표시한 필드 라벨
    missing: list[dict] | None = None
    dismissedDialogs: list[str] | None = None
    requiredFieldsComplete: bool | None = None
    atLastStep: bool = False
    atFirstStep: bool = False
    receipt: str | None = None
    # 링크 이름이 여러 개 맞거나 못 찾았을 때 후보
    candidates: list[str] | None = None


MAX_TIMEOUT_RETRIES = 1
MAX_STEPS = 6

_SYNONYMS: dict[str, list[str]] = {
    "이름": ["성명", "이름", "신청인"],
    "주소": ["주소", "거주지", "도로명"],
    "연락처": ["연락처", "전화", "휴대폰", "휴대전화", "핸드폰"],
    "이메일": ["이메일", "전자우편", "email"],
    "생년월일": ["생년월일", "생일"],
}
_ASSIST_SECRET = rx(r"(비밀\s*번호|password|인증\s*번호|otp|주민|계좌|카드)", I)

_FAIL_MESSAGES = {
    "TARGET_NOT_FOUND": "화면에서 조작할 대상을 찾지 못했습니다.",
    "AMBIGUOUS_TARGET": "같은 이름의 대상이 여러 개라서 실행하지 않았습니다.",
    "TIMEOUT": "화면이 제때 응답하지 않았습니다.",
    "NAVIGATION_FAILED": "페이지를 열지 못했습니다. 모의 사이트가 실행 중인지 확인해 주세요.",
}


def _outline(v: dict) -> dict:
    return v.get("outline") or {}


class WebExecutionAgent:
    id = AGENT_IDS.web

    def __init__(self, adapter: Any, guard: PolicyGuard, profile: SiteProfile) -> None:
        self.adapter = adapter
        self.guard = guard
        self.profile = profile
        self._last_view: dict | None = None

    @property
    def current_view(self) -> dict | None:
        return self._last_view

    async def show_browser(self) -> None:
        """브라우저 창을 사용자 앞으로"""
        fn = getattr(self.adapter, "bring_to_front", None)
        if fn:
            await fn()

    def access_mode(self, view: dict | None = ..., ) -> str:  # type: ignore[assignment]
        """현재(또는 주어진) 화면의 접근 등급: full=지원 사이트, read-only=그 외 웹사이트"""
        if view is ...:
            view = self._last_view
        return self.guard.tier_of((view or {}).get("url"))

    async def open_site(self, url: str, ctx: ExecContext) -> WebOutcome:
        """어떤 웹사이트든 연다. 지원 사이트가 아니면 이후 조작은 PolicyGuard가 읽기 전용으로 제한한다."""
        log: list[dict] = []
        u = try_url(url)
        host = u.host if u else url
        ctx.trace("PLANNING", self.id, f"open {host}")
        r = await self._run(self._action(type="navigate", url=url, reason=f"사용자가 요청한 사이트 열기: {host}"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r)
        ctx.trace("VERIFYING", self.id, "페이지 내용 확인")
        view = await self._observe_until(ctx, lambda v: v["url"] != "about:blank" and self._has_content(v), 6000)
        return WebOutcome(status="ok", actions=log, view=await self._settle(ctx, view))

    async def follow_link(self, name: str, ctx: ExecContext) -> WebOutcome:
        """링크 이름(일부만 말해도 됨)으로 찾아 누른다. 여러 개가 맞으면 누르지 않고 후보를 돌려준다."""
        log: list[dict] = []
        view = await self.observe(ctx)
        links = _outline(view).get("links") or []
        # 복지로처럼 메뉴를 버튼으로 만든 사이트가 많아 버튼 이름도 함께 찾는다(링크 우선).
        buttons = [b["name"] for b in (_outline(view).get("buttons") or []) if not b.get("disabled")]
        m = normalize_term(name)

        def match(names: list[str]) -> list[str]:
            exact = [x for x in names if normalize_term(x) == m]
            return uniq(exact if exact else [x for x in names if m in normalize_term(x) and len(m) >= 2])

        link_hits = match(links)
        button_hits = [] if link_hits else match(buttons)
        role = "link" if link_hits else "button"
        pool = links if role == "link" else buttons
        distinct = link_hits or button_hits
        if not distinct:
            return WebOutcome(status="needs-clarification", actions=log, view=view, message=f"'{name}' 링크를 이 화면에서 찾지 못했습니다.", candidates=[])
        if len(distinct) > 1:
            return WebOutcome(
                status="needs-clarification",
                actions=log,
                view=view,
                message=f"'{name}'에 맞는 링크가 {len(distinct)}개입니다.",
                candidates=distinct[:5],
            )
        target = distinct[0]
        before = {"url": view["url"], "title": view["title"]}
        tgt: dict = {"role": role, "name": target}
        if len([x for x in pool if x == target]) > 1:
            tgt["nth"] = 0
        r = await self._run(self._action(type="click", target=tgt, reason=f"'{target}' {'링크' if role == 'link' else '버튼'} 열기"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, view)
        ctx.trace("VERIFYING", self.id, "이동 확인")
        after = await self._observe_until(
            ctx, lambda v: (v["url"] != before["url"] or v["title"] != before["title"]) and self._has_content(v), 6000
        )
        return WebOutcome(status="ok", actions=log, view=await self._settle(ctx, after), readValue=target)

    async def back(self, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        view = await self.observe(ctx)
        r = await self._run(self._action(type="back", reason="이전 페이지로 돌아가기"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, view)
        if not r.get("verified"):
            return WebOutcome(status="failed", actions=log, view=view, message="더 돌아갈 이전 페이지가 없습니다.")
        return WebOutcome(
            status="ok", actions=log, view=await self._observe_until(ctx, lambda v: v["url"] != view["url"] and self._has_content(v), 6000)
        )

    async def search(self, query: str, ctx: ExecContext) -> WebOutcome:
        """화면의 검색창에 검색어를 넣고 Enter. 검색창이 아닌 입력란에는 쓰지 않는다."""
        log: list[dict] = []
        view = await self.observe(ctx)
        box = next((f for f in view["fields"] if f.get("visible") and f.get("searchable")), None)
        if not box:
            return WebOutcome(status="failed", actions=log, view=view, message="이 화면에서 검색창을 찾지 못했습니다.")
        target = {"fieldId": box["fieldId"], "role": "searchbox"}
        r = await self._run(self._action(type="fill", target=target, value=query, reason=f"검색어 입력: {query}"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, view)
        r = await self._run(self._action(type="press", target=target, value="Enter", reason="검색 실행"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, view)
        ctx.trace("VERIFYING", self.id, "검색 결과 확인")
        after = await self._observe_until(
            ctx, lambda v: (v["url"] != view["url"] or v["title"] != view["title"]) and self._has_content(v), 6000
        )
        return WebOutcome(status="ok", actions=log, view=await self._settle(ctx, after, 8000))

    def assist_candidates(self, mention: str, view: dict | None = ...) -> list[dict]:  # type: ignore[assignment]
        """
        입력 도우미(실제 사이트): 사용자가 말한 칸 이름으로 화면의 입력란을 찾는다.
        사이트 전용 설정이 없으니 레이블·placeholder로 느슨하게 맞추고, 비밀 칸은 후보에서 뺀다.
        """
        if view is ...:
            view = self._last_view
        m = normalize_term(mention)
        keys = [m]
        for k, v in _SYNONYMS.items():
            if normalize_term(k) == m or any(normalize_term(x) == m for x in v):
                keys.extend(normalize_term(x) for x in v)
        return [
            f
            for f in (view or {}).get("fields", [])
            if f.get("visible")
            and not f.get("sensitive")
            and not f.get("searchable")
            and not _ASSIST_SECRET.search(f["label"])
            and any(len(k) >= 2 and k in normalize_term(f["label"]) for k in keys)
        ]

    def build_assist_action(self, field_: dict, value: str) -> dict:
        """승인 전용 입력 액션(sensitive + 확인 필요). PolicyGuard가 승인 없이는 실행하지 않는다."""
        target = {"fieldId": field_["fieldId"], "name": field_["label"]}
        base = {
            "id": uuid(),
            "target": target,
            "reason": f"실제 사이트 '{field_['label']}' 칸 입력(사용자 확인 후)",
            "risk": "sensitive",
            "requiresConfirmation": True,
        }
        if field_["type"] == "checkbox":
            return {**base, "type": "check", "checked": bool(rx(r"^(예|네|응|체크)").search(value))}
        if field_["type"] == "select":
            return {**base, "type": "select", "value": value}
        return {**base, "type": "fill", "value": value}

    async def assist_fill(self, actions: list[dict], ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        await self.observe(ctx)
        for action in actions:
            r = await self._run(action, ctx, log)
            if not r or not r.get("ok"):
                return self._failed(log, r, self._last_view)
        ctx.trace("VERIFYING", self.id, "입력값 재확인")
        view = await self.observe(ctx)

        def observed(a: dict) -> str | None:
            fid = (a.get("target") or {}).get("fieldId")
            f = next((f for f in view["fields"] if f["fieldId"] == fid), None)
            return f["value"] if f else None

        mismatch = next((a for a in actions if a["type"] == "fill" and observed(a) != a.get("value")), None)
        if mismatch:
            return WebOutcome(
                status="failed",
                actions=log,
                view=view,
                message=f"'{(mismatch.get('target') or {}).get('name')}' 칸의 값이 요청과 달라 확인이 필요해요.",
            )
        return WebOutcome(status="ok", actions=log, view=view)

    def is_approved_url(self, url: str) -> bool:
        """Agent B가 넘긴 주소가 허용 목록(PolicyGuard)에 있는지."""
        return self.guard.is_allowed_url(url)

    def field(self, field_id: str) -> FieldProfile | None:
        return next((f for f in self.profile.fields if f.field_id == field_id), None)

    async def close(self) -> None:
        await self.adapter.close()

    async def observe(self, ctx: ExecContext | None = None) -> dict:
        if ctx is not None:
            ctx.trace("OBSERVING", self.id)
        obs = await self.adapter.observe()
        self._last_view = {**obs, "pageId": self.profile.classify(obs["url"])}
        return self._last_view

    async def _observe_until(self, ctx: ExecContext, done: Callable[[dict], bool], timeout_ms: int = 5000) -> dict:
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            try:
                v = await self.observe(ctx)
                if done(v) or time.monotonic() > deadline:
                    return v
            except Exception:
                # 페이지 이동 중에는 실행 컨텍스트가 사라질 수 있다. 시간 안에서만 재시도.
                if time.monotonic() > deadline:
                    raise
            if ctx.signal.aborted:
                return await self.observe(ctx)
            await asyncio.sleep(0.1)

    async def _settle(self, ctx: ExecContext, view: dict, max_ms: int = 6000) -> dict:
        """늦게 채워지는 내용(검색 결과 등)이 더 이상 바뀌지 않을 때까지 잠깐 기다린다(최대 max_ms)."""
        deadline = time.monotonic() + max_ms / 1000
        prev = view
        while time.monotonic() < deadline and not ctx.signal.aborted:
            await asyncio.sleep(0.7)
            try:
                nxt = await self.observe(ctx)
            except Exception:  # noqa: BLE001
                nxt = prev
            same = (_outline(nxt).get("mainText") or "") == (_outline(prev).get("mainText") or "") and nxt["url"] == prev["url"]
            prev = nxt
            if same:
                break
        return prev

    @staticmethod
    def _has_content(v: dict) -> bool:
        """화면에 내용이 그려졌는지(SPA는 주소가 먼저 바뀌고 내용이 나중에 채워진다)."""
        o = _outline(v)
        return (nz(o.get("linkCount"), 0) + len(o.get("buttons") or []) + len(v.get("fields") or [])) > 0 or bool(o.get("mainText"))

    @staticmethod
    def _action(**partial: Any) -> dict:
        return {"id": uuid(), "risk": "low", "requiresConfirmation": False, **partial}

    async def _run(self, action: dict, ctx: ExecContext, log: list[dict]) -> dict | None:
        """PolicyGuard 검사 후에만 어댑터를 호출한다. TIMEOUT만 제한적으로 재시도."""
        ctx.trace("POLICY_CHECK", self.id, action["type"])
        policy = self.guard.check(
            action,
            PolicyContext(
                currentUrl=(self._last_view or {}).get("url"),
                stopped=ctx.is_stopped() or ctx.signal.aborted,
                approvals=ctx.approvals,
                actionsThisTurn=ctx.counter["actions"],
            ),
        )
        entry: dict = {"agent": self.id, "action": action, "policy": policy}
        log.append(entry)
        if not policy["allowed"]:
            return None
        ctx.counter["actions"] += 1
        ctx.trace("EXECUTING", self.id, action["type"])
        result = await self.adapter.execute(action, ctx.signal)
        i = 0
        while i < MAX_TIMEOUT_RETRIES and not result["ok"] and result.get("errorCode") == "TIMEOUT" and not ctx.signal.aborted:
            result = await self.adapter.execute(action, ctx.signal)
            i += 1
        entry["result"] = result
        return result

    @staticmethod
    def _failed(log: list[dict], result: dict | None, view: dict | None = None) -> WebOutcome:
        last = log[-1] if log else None
        if not result:
            return WebOutcome(status="policy-denied", actions=log, view=view, message=last["policy"]["reason"] if last else None)
        if result.get("errorCode") == "ABORTED":
            return WebOutcome(status="aborted", actions=log, view=view, message="중단되었습니다.")
        return WebOutcome(status="failed", actions=log, view=view, message=_FAIL_MESSAGES.get(result.get("errorCode") or "", "조작에 실패했습니다."))

    async def open_home(self, ctx: ExecContext) -> WebOutcome:
        """세션 준비: 빈 창 대신 모의 사이트 첫 화면을 띄워 둔다."""
        log: list[dict] = []
        r = await self._run(self._action(type="navigate", url=self.profile.urls.home, reason="모의 복지 사이트 첫 화면 표시"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r)
        return WebOutcome(status="ok", actions=log, view=await self.observe(ctx))

    async def open_application(self, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        try:
            before = await self.observe(ctx)
        except Exception:  # noqa: BLE001
            before = None
        if before and before["pageId"] == "mock-welfare" and before.get("step") and not before.get("status"):
            return WebOutcome(status="ok", actions=log, view=before)
        ctx.trace("PLANNING", self.id, "home → 신청 링크")
        r = await self._run(self._action(type="navigate", url=self.profile.urls.home, reason="모의 복지 사이트 첫 화면으로 이동"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r)
        await self._observe_until(ctx, lambda v: v["pageId"] == "mock-home")
        r = await self._run(
            self._action(type="click", target={"role": "link", "name": self.profile.links.application}, reason="장애인연금 모의 신청 링크 클릭"),
            ctx,
            log,
        )
        if not r or not r.get("ok"):
            return self._failed(log, r)
        ctx.trace("VERIFYING", self.id, "신청서 1단계 확인")
        view = await self._observe_until(ctx, lambda v: v["pageId"] == "mock-welfare" and bool(v.get("step")))
        if view["pageId"] != "mock-welfare" or not view.get("step"):
            return WebOutcome(status="failed", actions=log, view=view, message="신청서 화면을 확인하지 못했습니다.")
        return WebOutcome(status="ok", actions=log, view=view)

    async def open_login(self, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        ctx.trace("PLANNING", self.id, "모의 본인인증 화면")
        r = await self._run(
            self._action(type="navigate", url=self.profile.urls.login, reason="가상 본인인증 화면 열기(입력은 사용자가 직접)"), ctx, log
        )
        if not r or not r.get("ok"):
            return self._failed(log, r)
        ctx.trace("VERIFYING", self.id)
        view = await self._observe_until(ctx, lambda v: v["pageId"] == "mock-login")
        return WebOutcome(status="ok" if view["pageId"] == "mock-login" else "failed", actions=log, view=view)

    def resolve_field(self, mention: str, view: dict | None = ...) -> FieldResolution:  # type: ignore[assignment]
        """사용자가 말한 필드 이름을 화면 기준으로 해석. 둘 이상이면 실행하지 않고 되묻는다."""
        if view is ...:
            view = self._last_view
        m = normalize_term(mention)
        fields = [f for f in self.profile.fields if f.sensitivity != "secret"]

        def is_visible(f: FieldProfile) -> bool:
            return any(o["fieldId"] == f.field_id and o.get("visible") for o in (view or {}).get("fields", []))

        specific = [f for f in fields if any(normalize_term(a) == m for a in f.aliases) or normalize_term(f.label) == m]
        if len(specific) == 1:
            return FieldResolution("ok", specific[0]) if is_visible(specific[0]) else FieldResolution("not-visible", specific[0])
        generic = [f for f in fields if any(normalize_term(a) == m for a in f.generic_aliases)]
        visible = [f for f in generic if is_visible(f)]
        if len(visible) == 1:
            return FieldResolution("ok", visible[0])
        if len(visible) > 1:
            return FieldResolution("ambiguous", candidates=visible)
        if generic:
            return FieldResolution("not-visible", generic[0])
        return FieldResolution("not-found")

    def pick_candidate(self, reply: str, candidates: list[FieldProfile]) -> FieldProfile | None:
        """되묻기 응답("실거주지 쪽")으로 후보 중 하나를 고른다."""
        r = normalize_term(reply)
        hits = [c for c in candidates if any(normalize_term(a) in r for a in [c.label, *c.aliases])]
        return hits[0] if len(hits) == 1 else None

    def observed_field(self, field_id: str, view: dict | None = ...) -> dict | None:  # type: ignore[assignment]
        if view is ...:
            view = self._last_view
        return next((f for f in (view or {}).get("fields", []) if f["fieldId"] == field_id), None)

    async def fill(self, field_: FieldProfile, raw_value: str, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        view = await self.observe(ctx)
        if view["pageId"] != "mock-welfare":
            return WebOutcome(status="failed", actions=log, view=view, message="신청서가 열려 있지 않습니다.")
        observed = self.observed_field(field_.field_id, view)
        if not observed or not observed.get("visible"):
            return WebOutcome(
                status="needs-clarification", actions=log, view=view, message=f"{speak_label(field_.label)} 항목은 지금 화면에 없습니다."
            )
        ctx.trace("PLANNING", self.id, f"fill {field_.field_id}")
        validation = field_.validate(raw_value) if field_.validate else None
        if validation is not None and not validation.ok:
            return WebOutcome(status="needs-clarification", actions=log, view=view, message=validation.message)
        value = validation.value if validation is not None else raw_value.strip()
        target = {"label": field_.label, "fieldId": field_.field_id}
        reason = f"사용자가 요청한 {speak_label(field_.label)} 입력"
        if field_.kind == "checkbox":
            action = self._action(type="check", target=target, checked=value == "예", reason=reason)
        elif field_.kind == "select":
            action = self._action(type="select", target=target, value=value, reason=reason)
        else:
            action = self._action(type="fill", target=target, value=value, reason=reason)
        r = await self._run(action, ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, view)

        ctx.trace("VERIFYING", self.id, f"{field_.field_id} 값 재확인")
        after = await self.observe(ctx)
        now = self.observed_field(field_.field_id, after)
        matches = bool(now) and now["value"] == value and bool(r.get("verified"))
        if not matches:
            return WebOutcome(status="failed", actions=log, view=after, message="입력 후 화면의 값이 요청과 달라 확인이 필요합니다.")
        return WebOutcome(status="ok", actions=log, view=after, readValue=now["value"])

    async def read(self, field_: FieldProfile, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        view = await self.observe(ctx)
        observed = self.observed_field(field_.field_id, view)
        if not observed:
            return WebOutcome(status="failed", actions=log, view=view, message="해당 항목을 화면에서 찾지 못했습니다.")
        if not observed.get("visible"):
            # 다른 단계에 있는 필드는 DOM 관찰값으로 읽는다(조작 없음).
            return WebOutcome(status="ok", actions=log, view=view, readValue=observed["value"])
        r = await self._run(
            self._action(
                type="read", target={"label": field_.label, "fieldId": field_.field_id}, reason=f"{speak_label(field_.label)} 값 다시 읽기"
            ),
            ctx,
            log,
        )
        if not r or not r.get("ok"):
            return self._failed(log, r, view)
        return WebOutcome(status="ok", actions=log, view=view, readValue=nz(r.get("readValue"), observed["value"]))

    async def _handle_dialogs(self, view: dict, ctx: ExecContext, log: list[dict]) -> dict:
        """정보성 팝업(버튼이 '닫기' 하나뿐)만 닫는다. 그 외 팝업은 사용자에게 묻는다."""
        dismissed: list[str] = []
        current = view
        for _ in range(3):
            if not current["dialogs"]:
                break
            d = current["dialogs"][0]
            closable = len(d["buttons"]) == 1 and d["buttons"][0] in self.profile.buttons.dismiss_dialog
            if not closable:
                return {"view": current, "dismissed": dismissed, "blocked": d["title"] or "알 수 없는 팝업"}
            r = await self._run(
                self._action(type="click", target={"role": "button", "name": d["buttons"][0]}, reason=f"안내 팝업 '{d['title']}' 닫기"),
                ctx,
                log,
            )
            if not r or not r.get("ok"):
                return {"view": current, "dismissed": dismissed, "blocked": d["title"]}
            dismissed.append(d["title"])
            current = await self.observe(ctx)
        return {"view": current, "dismissed": dismissed, "blocked": None}

    async def next(self, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        before = await self.observe(ctx)
        step = before.get("step")
        if before["pageId"] != "mock-welfare" or not step:
            return WebOutcome(status="failed", actions=log, view=before, message="신청서가 열려 있지 않습니다.")
        if step["index"] >= step["total"]:
            return WebOutcome(status="ok", actions=log, view=before, atLastStep=True)

        ctx.trace("PLANNING", self.id, "click 다음")
        r = await self._run(
            self._action(type="click", target={"role": "button", "name": self.profile.buttons.next}, reason="다음 단계로 이동"), ctx, log
        )
        if not r or not r.get("ok"):
            return self._failed(log, r, before)

        ctx.trace("VERIFYING", self.id, "단계 이동·오류 확인")
        after = await self.observe(ctx)
        if after["errors"] or (after.get("step") or {}).get("index") == step["index"]:
            missing = [
                {k: v for k, v in {"fieldId": f["fieldId"], "label": speak_label(f["label"]), "error": f.get("error")}.items() if v is not None}
                for f in after["fields"]
                if f.get("visible") and f.get("invalid")
            ]
            return WebOutcome(status="validation-error", actions=log, view=after, missing=missing)
        dialogs = await self._handle_dialogs(after, ctx, log)
        after = dialogs["view"]
        required_complete = all(f.get("filled") for f in before["fields"] if f.get("required") and f.get("visible"))
        if dialogs["blocked"]:
            return WebOutcome(
                status="needs-clarification",
                actions=log,
                view=after,
                message=f"예상하지 못한 팝업('{dialogs['blocked']}')이 있어 진행을 멈췄습니다.",
                dismissedDialogs=dialogs["dismissed"],
            )
        return WebOutcome(status="ok", actions=log, view=after, dismissedDialogs=dialogs["dismissed"], requiredFieldsComplete=required_complete)

    async def prev(self, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        before = await self.observe(ctx)
        step = before.get("step")
        if before["pageId"] != "mock-welfare" or not step:
            return WebOutcome(status="failed", actions=log, view=before, message="신청서가 열려 있지 않습니다.")
        if step["index"] <= 1:
            return WebOutcome(status="ok", actions=log, view=before, atFirstStep=True)
        r = await self._run(
            self._action(type="click", target={"role": "button", "name": self.profile.buttons.prev}, reason="이전 단계로 이동"), ctx, log
        )
        if not r or not r.get("ok"):
            return self._failed(log, r, before)
        ctx.trace("VERIFYING", self.id)
        after = await self.observe(ctx)
        a_step = after.get("step")
        return WebOutcome(status="ok" if a_step and a_step["index"] < step["index"] else "failed", actions=log, view=after)

    async def go_to_final_step(self, ctx: ExecContext) -> WebOutcome:
        """검토(마지막) 단계까지 '다음'을 눌러 이동. 중간 검증 오류가 있으면 멈춘다."""
        log: list[dict] = []
        dismissed: list[str] = []
        for _ in range(MAX_STEPS):
            out = await self.next(ctx)
            log.extend(out.actions)
            dismissed.extend(out.dismissedDialogs or [])
            if out.status != "ok" or out.atLastStep:
                return replace(out, actions=log, dismissedDialogs=dismissed)
        return WebOutcome(status="failed", actions=log, message="검토 단계에 도달하지 못했습니다.")

    def build_submit_action(self) -> dict:
        """모의접수 클릭 액션. consequential이므로 승인 없이는 PolicyGuard가 막는다."""
        return {
            "id": uuid(),
            "type": "click",
            "target": {"role": "button", "name": self.profile.buttons.submit},
            "reason": "사용자 승인 후 모의접수 버튼 클릭(실제 제출 아님)",
            "risk": "consequential",
            "requiresConfirmation": True,
        }

    def preview_policy(self, action: dict, ctx: ExecContext) -> dict:
        """승인 없이 정책 판단만 미리 기록(실행하지 않음)."""
        ctx.trace("POLICY_CHECK", self.id, f"{action['type']} (승인 전 사전 확인)")
        policy = self.guard.check(
            action,
            PolicyContext(
                currentUrl=(self._last_view or {}).get("url"),
                stopped=ctx.is_stopped(),
                approvals=ctx.approvals,
                actionsThisTurn=ctx.counter["actions"],
            ),
        )
        return {"agent": self.id, "action": action, "policy": policy}

    async def submit_approved(self, action: dict, ctx: ExecContext) -> WebOutcome:
        log: list[dict] = []
        before = await self.observe(ctx)
        step = before.get("step")
        if before["pageId"] != "mock-welfare" or not step or step["index"] != step["total"]:
            return WebOutcome(status="failed", actions=log, view=before, message="검토 단계가 아니어서 모의접수를 실행하지 않았습니다.")
        r = await self._run(action, ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, before)
        ctx.trace("VERIFYING", self.id, "모의 접수번호 확인")
        pattern = self.profile.receipt_pattern
        after = await self._observe_until(ctx, lambda v: bool(v.get("status")) and bool(pattern.search(v["status"])), 3000)
        m = pattern.search(after.get("status") or "")
        receipt = m.group(1) if m else None
        if not receipt:
            return WebOutcome(status="failed", actions=log, view=after, message="모의 접수번호를 확인하지 못했습니다.")
        return WebOutcome(status="ok", actions=log, view=after, receipt=receipt)
