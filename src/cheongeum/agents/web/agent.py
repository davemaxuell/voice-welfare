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

from cheongeum.agents.web.effect import Churn, Effect, diff_views, item_changed, looks_loading, opened_dialog, unconfirmed_message
from cheongeum.agents.web.profile import FieldProfile, SiteProfile, normalize_term
from cheongeum.core.actions import LINK_ROLES
from cheongeum.core.jsutil import AbortSignal, I, nz, rx, try_url, uniq, uuid
from cheongeum.core.turn import AGENT_IDS
from cheongeum.safety import PolicyContext, PolicyGuard, redact_text
from cheongeum.speech.phrasing import speak_label


def _action_label(action: dict) -> str:
    """코드가 만든 짧은 조작 이름(화면 글·모델 글 없음). 기록용."""
    reason = (action.get("reason") or "").strip()
    if reason:
        return redact_text(reason)[:80]
    target = action.get("target") or {}
    name = target.get("name") or target.get("fieldId") or ""
    return f"{action.get('type') or 'action'} {name}".strip()[:80]


def _host_of(url: str | None) -> str:
    u = try_url(url)
    return u.hostname if u else ""


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


# unconfirmed: 승인받은 조작이 시간 안에 답하지 않았고 다시 봐도 됐는지 모른다(저절로 다시 하지 않는다)
OutcomeStatus = Literal["ok", "needs-clarification", "needs-approval", "validation-error", "policy-denied", "failed", "aborted", "unconfirmed"]


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
    # needs-approval: 사용자에게 묻고 승인받으면 그대로 실행할 액션
    pending: dict | None = None
    # point_at: 키보드 초점을 대상에 옮겼는지
    focused: bool = False
    effect: Effect | None = None
    revealed: str | None = None


MAX_TIMEOUT_RETRIES = 1
# 사용자를 기다린 틈으로 볼 최소 간격(기다림 반복 관찰은 poll=True로 따로 빠진다)
IDLE_GAP_S = 1.0
# 같은 화면에서 바뀐 뒤 새 글이 자리 잡기를 기다리는 한도·간격, 같아야 하는 연속 횟수(새 글 있음/없음)
REVEAL_MAX_S = 3.0
REVEAL_POLL_S = 0.3
REVEAL_STABLE_WITH_TEXT = 1
REVEAL_STABLE_WITHOUT_TEXT = 2
# 기다리는 동안 관찰이 이만큼 연달아 실패하면(페이지가 닫힘 등) 그만 기다린다
MAX_OBSERVE_FAILURES = 3
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
    "VERIFY_FAILED": "누르려던 대상이 그사이 화면에서 바뀌어 누르지 않았습니다.",
    "TIMEOUT": "화면이 제때 응답하지 않았습니다.",
    "NAVIGATION_FAILED": "페이지를 열지 못했습니다. 인터넷 연결이나 사이트 상태를 확인해 주세요.",
    "RESUBMIT_BLOCKED": "이전 화면은 양식을 보낸 결과 화면이라, 같은 내용을 다시 보내지 않도록 돌아가지 않았습니다.",
    "LOG_FAILED": "조작 기록을 남기지 못해 승인된 조작을 실행하지 않았습니다.",
}


def _outline(v: dict) -> dict:
    return v.get("outline") or {}


def _item_target(item: dict) -> dict:
    return {"ref": item["ref"], "role": item["role"], "name": item["name"]}


def _timed_out(result: dict | None) -> bool:
    return bool(result) and result.get("errorCode") == "TIMEOUT"


def _field_value(view: dict, action: dict) -> str | None:
    fid = (action.get("target") or {}).get("fieldId")
    f = next((f for f in view["fields"] if f["fieldId"] == fid), None)
    return f["value"] if f else None


class WebExecutionAgent:
    id = AGENT_IDS.web

    def __init__(self, adapter: Any, guard: PolicyGuard, profile: SiteProfile, action_log: Any = None) -> None:
        self.adapter = adapter
        self.guard = guard
        self.profile = profile
        # 조작 직전·직후 암호화 기록(없으면 안 씀). 승인 필요 조작은 쓰기 실패 시 실행하지 않는다.
        self.action_log = action_log
        self._last_view: dict | None = None
        self._last_view_at = 0.0
        self._acted_since_observe = False
        self._churn = Churn()

    @property
    def current_view(self) -> dict | None:
        return self._last_view

    async def show_browser(self) -> None:
        """브라우저 창을 사용자 앞으로"""
        fn = getattr(self.adapter, "bring_to_front", None)
        if fn:
            await fn()

    async def clear_login(self, *, current_only: bool = True) -> list[str]:
        """지금 사이트(또는 전부)의 로그인 쿠키·저장소를 지운다. 지운 호스트 목록."""
        fn = getattr(self.adapter, "clear_site_login", None)
        if not fn:
            return []
        return await fn(current_only=current_only)

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

    async def follow_link(self, name: str, ctx: ExecContext, links_only: bool = False) -> WebOutcome:
        """
        누를 수 있는 요소를 이름(일부만 말해도 됨)으로 찾아 누른다: 링크 우선, 없으면 버튼·탭·메뉴 항목·역할 없는 클릭 요소.
        여러 개가 맞으면 누르지 않고 후보를 돌려준다. 누른 뒤에는 화면이 어떻게 바뀌었는지(effect)를 함께 돌려준다.
        """
        log: list[dict] = []
        view = await self.observe(ctx)
        item, hits = self._locate(view, name, links_only=links_only)
        if item is None:
            return self._not_located(name, hits, view, log)
        r = await self._run(self._action(type="click", target=_item_target(item), reason=f"'{item['name']}' 누르기({item['role']})"), ctx, log)
        if not r or not r.get("ok"):
            return self._failed(log, r, view)
        ctx.trace("VERIFYING", self.id, "화면 변화 확인")
        after, effect, revealed = await self._await_effect(ctx, view, item)
        if effect == "moved":
            after = await self._settle(ctx, after)
        return WebOutcome(status="ok", actions=log, view=after, readValue=item["name"], effect=effect, revealed=revealed or None)

    @staticmethod
    def _locate(view: dict, name: str, prefer_button: bool = False, links_only: bool = False) -> tuple[dict | None, list[str]]:
        """
        이름으로 누를 관찰 항목을 찾는다: (항목, 맞은 이름들). 하나만 맞을 때만 항목이 있다.
        보통 링크(스크립트 링크 포함) 우선, 없으면 버튼·탭·메뉴 항목. 로그인 화면의 '로그인'처럼 prefer_button이면 그 반대.
        links_only: 주소로 가는 진짜 링크만(스크립트 링크는 javascript:로 무언가를 보낼 수 있다).
        """
        items = [it for it in _outline(view).get("items") or [] if not it.get("disabled")]
        m = normalize_term(name)

        def match(names: list[str]) -> list[str]:
            exact = [x for x in names if normalize_term(x) == m]
            return uniq(exact if exact else [x for x in names if m in normalize_term(x) and len(m) >= 2])

        def is_link(it: dict) -> bool:
            return it["role"] == "link" if links_only else it["role"] in LINK_ROLES

        links = [it for it in items if is_link(it)]
        others = [] if links_only else [it for it in items if not is_link(it)]
        for pool in (others, links) if prefer_button else (links, others):
            hits = match([it["name"] for it in pool])
            if not hits:
                continue
            if len(hits) > 1:
                return None, hits
            return next(it for it in pool if it["name"] == hits[0]), hits
        return None, []

    @staticmethod
    def _not_located(name: str, hits: list[str], view: dict, log: list[dict]) -> WebOutcome:
        if not hits:
            return WebOutcome(status="needs-clarification", actions=log, view=view, message=f"'{name}' 링크를 이 화면에서 찾지 못했습니다.", candidates=[])
        return WebOutcome(status="needs-clarification", actions=log, view=view, message=f"'{name}'에 맞는 링크가 {len(hits)}개입니다.", candidates=hits[:5])

    async def point_at(self, name: str, ctx: ExecContext, prefer_button: bool = False) -> WebOutcome:
        """
        누를 대상으로 키보드 초점(과 화면 커서)을 옮기고, 사용자가 승인하면 누를 클릭 액션을 pending으로 돌려준다. 누르지는 않는다.
        초점을 못 옮겨도 대상은 찾았으니 묻는 것은 계속한다(focused=False).
        """
        log: list[dict] = []
        view = await self.observe(ctx)
        item, hits = self._locate(view, name, prefer_button)
        if item is None:
            return self._not_located(name, hits, view, log)
        tgt = _item_target(item)
        r = await self._run(self._action(type="focus", target=dict(tgt), reason=f"'{item['name']}'(으)로 이동"), ctx, log)
        click = self._action(type="click", target=dict(tgt), reason=f"사용자 확인 후 '{item['name']}' 누르기")
        return WebOutcome(status="needs-approval", actions=log, view=view, pending=click, focused=bool(r and r.get("ok")))

    async def focus_field(self, field: dict, ctx: ExecContext, log: list[dict] | None = None) -> WebOutcome:
        """입력 칸으로 키보드 초점을 옮긴다(값은 넣지 않는다). 본인인증 인계 때 화면 낭독기가 첫 칸을 읽게 한다."""
        actions = log if log is not None else []
        fid = field.get("fieldId")
        if not fid:
            return WebOutcome(status="failed", actions=actions, view=self._last_view)
        target: dict = {"fieldId": fid}
        if field.get("label"):
            target["label"] = field["label"]
        label = field.get("label") or fid
        r = await self._run(self._action(type="focus", target=target, reason=f"'{label}' 칸으로 이동"), ctx, actions)
        return WebOutcome(
            status="ok" if r and r.get("ok") else "failed",
            actions=actions,
            view=self._last_view,
            focused=bool(r and r.get("ok")),
        )

    async def click_approved(self, action: dict, ctx: ExecContext) -> WebOutcome:
        """
        사용자가 승인한 클릭을 그대로 실행한다. 물어본 뒤 화면·대상이 그대로인지는 승인 문(SessionOrchestrator._approve)이 지문으로 봤고,
        누르기 직전에는 어댑터가 그 ref의 역할·이름을 다시 읽는다. 시간이 넘으면 다시 누르지 않고 화면이 바뀌었는지만 본다.
        """
        log: list[dict] = []
        view = await self.observe(ctx)
        target = action["target"]
        item = next((it for it in _outline(view).get("items") or [] if it["ref"] == target.get("ref")), target)
        r = await self._run(action, ctx, log)
        if not r or not (r.get("ok") or _timed_out(r)):
            return self._failed(log, r, view)
        ctx.trace("VERIFYING", self.id, "누른 뒤 화면 확인")
        after, effect, revealed = await self._await_effect(ctx, view, item)
        if _timed_out(r) and effect == "none":
            return WebOutcome(status="unconfirmed", actions=log, view=after, message=unconfirmed_message("눌렸는지"))
        if effect == "moved":
            after = await self._settle(ctx, after)
        return WebOutcome(status="ok", actions=log, view=after, readValue=item["name"], effect=effect, revealed=revealed or None)

    async def _await_effect(self, ctx: ExecContext, before: dict, item: dict) -> tuple[dict, Effect, str]:
        """
        다른 페이지가 열리거나, 팝업이 새로 뜨거나, 누른 요소 자신의 선택·펼침이 바뀌면 끝낸다. 본문 변화만으로는 끝내지 않는다:
        실제 사이트는 배너·속보가 저절로 바뀌어, 누른 효과로 잘못 알고 이동 전의 화면을 돌려줄 수 있다.
        복지로 상세의 '신청방법'은 링크지만 누르면 그 링크가 '선택됨'이 되어 바로 끝난다.
        """
        quick = item["role"] == "tab" or item.get("expanded") is not None

        def done(v: dict) -> bool:
            effect, _ = diff_views(before, v, item["ref"])
            if effect == "moved":
                return self._has_content(v)
            return opened_dialog(before, v) or item_changed(before, v, item["ref"])

        after = await self._observe_until(ctx, done, 1500 if quick else 6000)
        effect, revealed = diff_views(before, after, item["ref"], self._churn.volatile())
        if effect == "changed":
            return await self._await_revealed(ctx, before, after, item["ref"])
        return after, effect, revealed

    async def _await_revealed(self, ctx: ExecContext, before: dict, after: dict, ref: str) -> tuple[dict, Effect, str]:
        volatile = self._churn.volatile()
        effect, revealed = diff_views(before, after, ref, volatile)
        deadline = time.monotonic() + REVEAL_MAX_S
        same = failures = 0
        while time.monotonic() < deadline and not ctx.signal.aborted and failures < MAX_OBSERVE_FAILURES:
            await asyncio.sleep(REVEAL_POLL_S)
            try:
                nxt = await self.observe(ctx, poll=True)
            except Exception:  # noqa: BLE001
                failures += 1
                continue
            failures = 0
            nxt_effect, nxt_revealed = diff_views(before, nxt, ref, volatile)
            same = same + 1 if nxt_revealed == revealed else 0
            after, effect, revealed = nxt, nxt_effect, nxt_revealed
            stable = same >= (REVEAL_STABLE_WITH_TEXT if revealed else REVEAL_STABLE_WITHOUT_TEXT)
            if effect == "moved" or (stable and not looks_loading(revealed)):
                break
        return after, effect, revealed

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
            if _timed_out(r):
                # 다시 넣지 않는다: 화면에 그 값이 보이면 들어간 것이고, 아니면 들어갔는지 모른다
                seen = await self.observe(ctx)
                if action["type"] == "fill" and _field_value(seen, action) == action.get("value"):
                    continue
                name = (action.get("target") or {}).get("name")
                return WebOutcome(status="unconfirmed", actions=log, view=seen, message=unconfirmed_message(f"'{name}' 칸에 들어갔는지"))
            if not r or not r.get("ok"):
                return self._failed(log, r, self._last_view)
        ctx.trace("VERIFYING", self.id, "입력값 재확인")
        view = await self.observe(ctx)
        mismatch = next((a for a in actions if a["type"] == "fill" and _field_value(view, a) != a.get("value")), None)
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

    async def observe(self, ctx: ExecContext | None = None, poll: bool = False) -> dict:
        """poll=True는 무언가를 기다리며 반복해 보는 관찰: 저절로 바뀌는 자리를 배우는 데 쓰지 않는다."""
        if ctx is not None:
            ctx.trace("OBSERVING", self.id)
        obs = await self.adapter.observe()
        view = {**obs, "pageId": self.profile.classify(obs["url"])}
        now = time.monotonic()
        idle = not poll and not self._acted_since_observe and now - self._last_view_at >= IDLE_GAP_S
        self._churn.observe(view, self._last_view if idle else None)
        self._last_view, self._last_view_at, self._acted_since_observe = view, now, False
        return view

    async def _observe_until(self, ctx: ExecContext, done: Callable[[dict], bool], timeout_ms: int = 5000) -> dict:
        deadline = time.monotonic() + timeout_ms / 1000
        while True:
            try:
                v = await self.observe(ctx, poll=True)
                if done(v) or time.monotonic() > deadline:
                    return v
            except Exception:
                # 페이지 이동 중에는 실행 컨텍스트가 사라질 수 있다. 시간 안에서만 재시도.
                if time.monotonic() > deadline:
                    raise
            if ctx.signal.aborted:
                return await self.observe(ctx, poll=True)
            await asyncio.sleep(0.1)

    async def _settle(self, ctx: ExecContext, view: dict, max_ms: int = 6000) -> dict:
        """늦게 채워지는 내용(검색 결과 등)이 더 이상 바뀌지 않을 때까지 잠깐 기다린다(최대 max_ms)."""
        deadline = time.monotonic() + max_ms / 1000
        prev = view
        failures = 0
        while time.monotonic() < deadline and not ctx.signal.aborted and failures < MAX_OBSERVE_FAILURES:
            await asyncio.sleep(0.7)
            try:
                nxt = await self.observe(ctx, poll=True)
            except Exception:  # noqa: BLE001
                failures += 1
                continue  # 이동 중(실행 컨텍스트가 사라짐)은 '그대로'가 아니다
            failures = 0
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
        """
        PolicyGuard 검사 후에만 어댑터를 호출한다. 저위험이고 승인이 필요 없던 조작만 TIMEOUT을 한 번 다시 한다.
        중요한 조작은 이미 됐을 수 있어 다시 하지 않는다(부르는 쪽이 화면을 다시 보고 알린다).
        """
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
        if self.action_log is not None:
            try:
                self.action_log.append(
                    {
                        "host": _host_of((self._last_view or {}).get("url")),
                        "pageKind": (self._last_view or {}).get("pageId") or "",
                        "actionType": action["type"],
                        "label": _action_label(action),
                        "approvalId": action.get("id") if action.get("requiresConfirmation") else None,
                        "phase": "before",
                    }
                )
            except Exception:  # noqa: BLE001
                if action.get("requiresConfirmation") or policy["code"] == "APPROVED":
                    entry["result"] = {"ok": False, "errorCode": "LOG_FAILED", "latencyMs": 0}
                    return entry["result"]
        ctx.counter["actions"] += 1
        self._acted_since_observe = True
        ctx.trace("EXECUTING", self.id, action["type"])
        result = await self.adapter.execute(action, ctx.signal)
        retries = MAX_TIMEOUT_RETRIES if action["risk"] == "low" and policy["code"] != "APPROVED" else 0
        i = 0
        while i < retries and not result["ok"] and result.get("errorCode") == "TIMEOUT" and not ctx.signal.aborted:
            result = await self.adapter.execute(action, ctx.signal)
            i += 1
        entry["result"] = result
        if self.action_log is not None:
            try:
                self.action_log.append(
                    {
                        "host": _host_of((self._last_view or {}).get("url")),
                        "pageKind": (self._last_view or {}).get("pageId") or "",
                        "actionType": action["type"],
                        "label": _action_label(action),
                        "approvalId": action.get("id") if action.get("requiresConfirmation") else None,
                        "phase": "after",
                        "ok": bool(result.get("ok")),
                    }
                )
            except Exception:  # noqa: BLE001
                pass  # 이미 실행된 뒤라 결과만 못 적음
        return result

    @staticmethod
    def _failed(log: list[dict], result: dict | None, view: dict | None = None) -> WebOutcome:
        last = log[-1] if log else None
        if not result and last and last["policy"]["code"] == "NEEDS_CONFIRMATION":
            return WebOutcome(status="needs-approval", actions=log, view=view, message=last["policy"]["reason"], pending=last["action"])
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
        # 시간이 넘었어도 다시 누르지 않는다: 이미 접수됐을 수 있으니 접수번호가 보이는지만 본다
        if not r or not (r.get("ok") or _timed_out(r)):
            return self._failed(log, r, before)
        ctx.trace("VERIFYING", self.id, "모의 접수번호 확인")
        pattern = self.profile.receipt_pattern
        after = await self._observe_until(ctx, lambda v: bool(v.get("status")) and bool(pattern.search(v["status"])), 3000)
        m = pattern.search(after.get("status") or "")
        receipt = m.group(1) if m else None
        if not receipt and _timed_out(r):
            return WebOutcome(status="unconfirmed", actions=log, view=after, message=unconfirmed_message("접수됐는지"))
        if not receipt:
            return WebOutcome(status="failed", actions=log, view=after, message="모의 접수번호를 확인하지 못했습니다.")
        return WebOutcome(status="ok", actions=log, view=after, receipt=receipt)
