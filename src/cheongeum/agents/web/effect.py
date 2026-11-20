"""
조작 효과 판정(규칙): 무엇을 누른 뒤 화면이 어떻게 바뀌었는지.
 - moved: 주소나 제목이 바뀜(다른 페이지)
 - changed: 같은 페이지에서 본문·팝업·누른 요소의 상태(선택·펼침)가 바뀜. revealed에 새로 보이는 글
 - none: 보이는 변화 없음

결과 말 세 갈래(코드가 만듦): press_result / unconfirmed_message / click_note.
browse·form·autopilot이 같은 말을 쓰도록 agents.web에 둔다(skills는 common으로 다시 내보냄).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher
from typing import Literal, Mapping, NamedTuple

from cheongeum.core.jsutil import I, nz, rx
from cheongeum.speech.phrasing import chunk_text, josa

Effect = Literal["moved", "changed", "none"]
_LOADING = rx(r"(불러오는\s*중|로딩\s*중|읽어\s*오는\s*중|조회\s*중|처리\s*중|잠시만\s*기다려|loading|please\s*wait)", I)
LOADING_MAX_CHARS = 80
# 저절로 바뀌는 자리로 믿으려면 서로 다른 틈에서 몇 번 바뀌어야 하는지.
# 한 번만 바뀐 자리는 늦게 도착한 내용일 수 있다: 그것을 무시하면 그 자리에 생긴 진짜 결과를 숨긴다.
CHURN_CONFIRMATIONS = 2


def press_result(pressed: str, effect: Effect | None, *, revealed: str | None = None, moved: str | None = None) -> str:
    """
    누르기 결과 말 세 갈래(코드가 만듦. 화면 글·모델 글로 성공을 단정하지 않음).
    - 확인됨(moved/changed): 주소·제목·본문·상태가 바뀐 것을 보고 말함
    - 변화 없음(none): 눌렀지만 보이는 변화가 없음
    - 확인 못 함은 WebOutcome.status == unconfirmed → unconfirmed_message / ask_again
    pressed는 조사까지 붙인 대상(예: "'안내'를").
    """
    if effect == "none":
        return f"{pressed} 눌렀지만 화면이 바뀌지 않았어요."
    if effect == "changed":
        shown = chunk_text(rx(r"\n+").sub(" ", revealed), 0) if revealed else ""
        return f"{pressed} 눌렀어요. " + (f"새로 보이는 내용입니다. {shown}" if shown else "같은 화면에서 내용이 바뀌었어요.")
    return moved or f"{pressed} 눌렀어요."


def unconfirmed_message(what: str) -> str:
    """확인 못 함: 조작을 다시 하지 않고, 됐는지 모른다고 말한다."""
    return f"{what} 확인하지 못했어요."


def click_note(
    target: str,
    *,
    status: str,
    effect: Effect | None = None,
    revealed: str | None = None,
    title: str | None = None,
    message: str | None = None,
    candidates: list[str] | None = None,
) -> str:
    """목표 수행(autopilot) 클릭 기록용. 성공·변화 없음은 press_result, 확인 못 함은 unconfirmed_message."""
    pressed = josa(f"'{target}'", "을", "를")
    if status == "ok" and effect == "changed":
        first = (revealed or "").split("\n")[0].strip()
        return press_result(pressed, "changed", revealed=first or None)
    if status == "ok" and effect == "none":
        return press_result(pressed, "none")
    if status == "ok":
        return press_result(pressed, "moved", moved=f"'{title}' 열림" if title else None)
    if status == "unconfirmed":
        return message or unconfirmed_message("눌렸는지")
    if status == "policy-denied":
        return f"안전 규칙으로 막힘: {message or ''}"
    if candidates:
        return f"여러 개가 맞음: {', '.join(candidates)}"
    return message or "누르지 못함"


def looks_loading(text: str) -> bool:
    return len(text) < LOADING_MAX_CHARS and bool(_LOADING.search(text))


def has_content(view: dict) -> bool:
    """화면에 내용이 그려졌는지(SPA는 주소가 먼저 바뀌고 내용이 나중에 채워진다)."""
    o = view.get("outline") or {}
    return (nz(o.get("linkCount"), 0) + len(o.get("buttons") or []) + len(view.get("fields") or [])) > 0 or bool(o.get("mainText"))


def still_building(view: dict) -> bool:
    """아직 채워지는 화면: 그려진 것이 없거나 내용을 받아 오는 중이다. 빈 창(about:blank)은 열리는 중이 아니다."""
    return view.get("pageId") != "blank" and (bool(view.get("loading")) or not has_content(view))


NOT_READY = "화면이 아직 다 열리지 않았어요. 잠시 뒤 '본문 읽어줘'라고 말씀해 주세요."


def _lines(view: dict) -> list[str]:
    main = (view.get("outline") or {}).get("mainText") or ""
    return [line.strip() for line in main.split("\n") if line.strip()]


def _page(view: dict) -> tuple[str, str]:
    return view["url"], view["title"]


def _state(view: dict, ref: str | None) -> tuple | None:
    if not ref:
        return None
    item = next((it for it in (view.get("outline") or {}).get("items") or [] if it["ref"] == ref), None)
    return (item.get("selected"), item.get("expanded")) if item else None


def opened_dialog(before: dict, after: dict) -> bool:
    old = {d["title"] for d in before.get("dialogs") or []}
    return any(d["title"] not in old for d in after.get("dialogs") or [])


def item_changed(before: dict, after: dict, ref: str | None) -> bool:
    """누른 요소 자신의 선택·펼침이 바뀌었는지. 화면의 다른 곳(돌아가는 배너 등)이 바뀐 것은 세지 않는다."""
    return bool(ref) and _state(before, ref) != _state(after, ref)


class Block(NamedTuple):
    anchor: str  # 바뀐 덩어리 바로 앞 줄. 맨 앞이면 ""
    lines: list[str]  # 새 줄(지워지기만 했으면 빈 목록)


def changed_blocks(old: list[str], new: list[str]) -> list[Block]:
    ops = SequenceMatcher(a=old, b=new, autojunk=False).get_opcodes()
    return [Block(new[j1 - 1] if j1 > 0 else "", new[j1:j2]) for tag, _i1, _i2, j1, j2 in ops if tag != "equal"]


@dataclass
class Churn:
    """한 화면(주소+제목)에서 아무것도 누르지 않았는데 바뀐 자리: 자리별로 바뀐 틈의 수와 한 번에 바뀐 줄 수(최대)."""

    page: tuple[str, str] | None = None
    counts: dict[str, int] = field(default_factory=dict)
    widths: dict[str, int] = field(default_factory=dict)

    def observe(self, view: dict, idle_prev: dict | None) -> None:
        """새 관찰마다 부른다. idle_prev는 조작 없이 사용자를 기다린 틈의 앞 관찰(없으면 배우지 않음)."""
        if _page(view) != self.page:
            self.page, self.counts, self.widths = _page(view), {}, {}
        if idle_prev is None or _page(idle_prev) != self.page:
            return
        blocks = changed_blocks(_lines(idle_prev), _lines(view))
        for anchor in {b.anchor for b in blocks}:
            self.counts[anchor] = self.counts.get(anchor, 0) + 1
        for b in blocks:
            self.widths[b.anchor] = max(self.widths.get(b.anchor, 0), len(b.lines))

    def volatile(self) -> dict[str, int]:
        """믿을 만한 자리 → 그 자리에서 무시할 줄 수"""
        return {a: self.widths[a] for a, n in self.counts.items() if n >= CHURN_CONFIRMATIONS}


def diff_views(before: dict, after: dict, ref: str | None = None, volatile: Mapping[str, int] | None = None) -> tuple[Effect, str]:
    """
    (효과, 새로 보이는 글). 새로 보이는 글은 앞쪽 600자까지.
    volatile 자리에서는 그 자리가 저절로 바뀌던 만큼의 줄만 빼고, 그보다 많이 바뀐 줄은 누른 효과로 센다.
    """
    if _page(after) != _page(before):
        return "moved", ""
    volatile = volatile or {}
    old = _lines(before)
    seen = set(old)
    clicked = next((it["name"] for v in (after, before) for it in (v.get("outline") or {}).get("items") or [] if it["ref"] == ref), None)
    blocks: list[list[str]] = []
    for b in changed_blocks(old, _lines(after)):
        if b.anchor not in volatile:
            blocks.append(b.lines)
        elif rest := b.lines[volatile[b.anchor] :]:
            blocks.append(rest)
    revealed = [line for lines in blocks for line in lines if line not in seen and line.replace("선택됨", "").strip() != clicked]
    old_dialogs = {d["title"] for d in before.get("dialogs") or []}
    new_dialogs = [d for d in after.get("dialogs") or [] if d["title"] not in old_dialogs]
    if not revealed:
        revealed = [d["text"] for d in new_dialogs if d.get("text")]
    changed = bool(revealed) or bool(new_dialogs) or item_changed(before, after, ref) or bool(blocks)
    return ("changed", "\n".join(revealed)[:600]) if changed else ("none", "")
