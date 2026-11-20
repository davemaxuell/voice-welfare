"""PolicyGuard: 모델/에이전트가 제안한 모든 액션의 단일 관문."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AbstractSet, Literal, Sequence

from cheongeum.core.actions import parse_action
from cheongeum.core.jsutil import I, rx, try_url
from cheongeum.safety.privacy import detect_sensitive

AccessTier = Literal["full", "read-only", "none"]


@dataclass
class PolicyConfig:
    # 지원 사이트(전용 프로필이 있는 출처): 신청서 입력·모의접수까지 허용
    allowedOrigins: Sequence[str]
    allowedActionTypes: Sequence[str]
    # fill/select/check가 허용되는 필드 ID (지원 사이트)
    allowedFieldIds: Sequence[str]
    # 에이전트가 절대 입력하지 않는 필드(비밀번호 등). 인증은 사용자에게 인계한다.
    secretFieldIds: Sequence[str]
    maxActionsPerTurn: int
    # 그 외 모든 웹사이트를 읽기 전용으로 허용할지. 허용하면 이동·링크·뒤로·스크롤·읽기·검색창 입력만 된다.
    readOnlyWeb: bool = False
    # 지원 사이트에서 이름이 RISKY_BUTTON에 걸려도 그냥 누르는 버튼(사이트 프로필의 다음·이전·팝업 닫기)
    safeButtons: Sequence[str] = ()
    # 직접 만든 설정은 닫힌 쪽이 기본. 제품 기본값(safe)은 server.runtime.load_config가 정한다.
    readOnlyClicks: Literal["any", "safe"] = "safe"
    publicLookupOnly: bool = False
    defaultActionsPerTurn: int | None = None


@dataclass
class PolicyContext:
    currentUrl: str | None = None
    stopped: bool = False
    approvals: AbstractSet[str] = field(default_factory=set)
    actionsThisTurn: int = 0
    public_lookup: bool = False
    action_limit: int | None = None


def decision(allowed: bool, code: str, reason: str) -> dict:
    return {"allowed": allowed, "code": code, "reason": reason}


def deny(code: str, reason: str) -> dict:
    return decision(False, code, reason)


INPUT_TYPES = ("fill", "select", "check")
READ_ONLY_TYPES = ("navigate", "back", "click", "fill", "press", "scroll", "read", "focus", "capture")
SECRET_LABEL = rx(r"(비밀\s*번호|password|OTP|인증\s*번호|주민\s*(등록)?\s*번호|계좌|카드\s*번호)", I)
WEB_SCHEMES = ("http:", "https:")
# 실제 사이트에서도 사용자에게 묻고 누를 수 있는 이름(로그인 화면 열기·로그인 누르기). 로그아웃은 아니다.
LOGIN_NAME = rx(r"(로그인|log\s*-?\s*in|sign\s*-?\s*in)", I)
# 실제 사이트에서는 역할과 이름으로 바로 누를 항목, 물어볼 항목, 거부할 항목을 가른다.
# (이름만 보는 휴리스틱이라 완벽하지 않다 — 문서에 한계로 명시)
RISKY_BUTTON = rx(
    r"(신청|제출|접수|등록|삭제|결제|송금|이체|구매|주문|동의|승인|확인|저장|보내기|전송|발송|로그인|로그아웃|탈퇴|가입|변경|수정|취소|인증|업로드|첨부|발급|예약|투표|좋아요|구독|submit|send|pay|buy|order|delete|confirm|login|sign)",
    I,
)
HARD_ACTION = rx(
    r"(신청|제출|접수|등록|삭제|결제|송금|이체|구매|주문|동의|승인|저장|보내기|전송|발송|로그아웃|탈퇴|가입|인증|업로드|첨부|발급|예약|투표|좋아요|구독"
    r"|submit|send|pay|buy|order|delete|sign\s*-?\s*(?:up|out)|log\s*-?\s*out)", I,
)
_ACTION_ANYWHERE = rx(
    r"하기(?![가-힣])|탈퇴|결제|송금|이체|삭제|구매|주문|로그인|로그아웃|회원\s*가입"
    r"|(?<![a-z])(pay|buy|order|delete|submit|log\s*(in|out)|sign\s*(in|up|out))(?![a-z])",
    I,
)
# 이름이 동작 낱말로 끝나면 동작(신청서 제출·본인 인증·전체 동의). 신청방법·제출서류처럼 뒤에 다른 말이 붙으면 정보.
_ACTION_ENDING = rx(
    r"(신청|제출|접수|등록|동의|승인|확인|저장|보내기|전송|발송|변경|수정|취소|인증|업로드|첨부|발급|예약|투표|좋아요|구독|가입|합니다|하세요"
    r"|(?<![a-z])(send|confirm|save|apply|ok))$",
    I,
)
_TRAILING_NOISE = rx(r"(\s*(새\s*창(\s*열림)?|[^\w가-힣]+))+$")


def is_action_name(name: str) -> bool:
    n = _TRAILING_NOISE.sub("", rx(r"\s+").sub(" ", name).strip())
    return bool(_ACTION_ANYWHERE.search(n) or _ACTION_ENDING.search(n))


def click_tier(role: str | None, name: str) -> Literal["free", "ask", "hard"]:
    if role == "link":
        return "free"
    if not name.strip() or (HARD_ACTION.search(name) and is_action_name(name)):
        return "hard"
    if role in ("tab", "scriptlink"):
        return "ask" if is_action_name(name) else "free"
    if role in ("button", "menuitem"):
        return "ask" if RISKY_BUTTON.search(name) else "free"
    return "ask"


class PolicyGuard:
    """
    모델/에이전트가 제안한 모든 액션의 단일 관문. 통과하지 않은 액션은 어댑터로 가지 않는다.
    민감 작업 승인은 실행 "전"에 확인한다(approvals에 해당 액션 ID가 있어야 함).
    """

    def __init__(self, config: PolicyConfig) -> None:
        self.config = config

    def is_allowed_url(self, url: str | None) -> bool:
        """지원 사이트(전체 기능) 여부"""
        u = try_url(url)
        return bool(u) and u.origin in self.config.allowedOrigins

    def tier_of(self, url: str | None) -> AccessTier:
        if not url:
            return "none"
        if self.is_allowed_url(url):
            return "full"
        u = try_url(url)
        if u is None:
            return "none"
        return "read-only" if self.config.readOnlyWeb and u.protocol in WEB_SCHEMES else "none"

    def check(self, candidate: Any, ctx: PolicyContext) -> dict:
        action = parse_action(candidate)
        if action is None:
            return deny("DENIED_SCHEMA", "액션 형식이 계약과 맞지 않습니다.")

        if ctx.stopped:
            return deny("DENIED_STOPPED", "사용자가 중단을 요청했습니다.")
        limit = ctx.action_limit if ctx.action_limit is not None else self.config.defaultActionsPerTurn
        ceiling = self.config.maxActionsPerTurn
        if ctx.actionsThisTurn >= (min(ceiling, limit) if limit is not None else ceiling):
            return deny("DENIED_RATE_LIMIT", "한 번의 요청에서 허용된 조작 횟수를 넘었습니다.")
        if action["type"] not in self.config.allowedActionTypes:
            return deny("DENIED_ACTION_TYPE", f"허용되지 않은 액션 유형({action['type']})입니다.")

        # 이동은 목적지, 그 외는 현재 화면의 출처로 접근 등급을 정한다.
        tier = self.tier_of(action.get("url") if action["type"] == "navigate" else ctx.currentUrl)
        if action["type"] == "navigate" and not action.get("url"):
            return deny("DENIED_ORIGIN", "이동할 주소가 없습니다.")
        if tier == "none":
            return deny("DENIED_ORIGIN", "허용되지 않은 주소라서 열거나 조작하지 않습니다.")
        if self.config.publicLookupOnly or ctx.public_lookup:
            target = action.get("target") or {}
            role, name = target.get("role"), target.get("name") or ""
            if (action["risk"] != "low" or action["requiresConfirmation"]
                    or action["type"] in ("capture", "select", "check")
                    or (action["type"] in ("fill", "press") and role != "searchbox")
                    or (action["type"] == "click" and (role not in ("link", "tab", "scriptlink", "button", "menuitem")
                                                        or not name or is_action_name(name) or LOGIN_NAME.search(name)))):
                return deny("DENIED_TASK_SCOPE", "정보를 찾는 요청으로는 이 동작을 할 수 없어요.")
            return self._check_read_only(action, ctx)
        if tier == "read-only":
            return self._check_read_only(action, ctx)

        target = action.get("target") or {}
        if action["type"] in INPUT_TYPES:
            field_id = target.get("fieldId")
            if field_id and field_id in self.config.secretFieldIds:
                return deny("DENIED_SECRET", "비밀번호 등 인증 정보는 에이전트가 입력하지 않습니다.")
            if SECRET_LABEL.search(target.get("label") or ""):
                return deny("DENIED_SECRET", "민감 정보 입력란은 사용자가 직접 입력해야 합니다.")
            if not field_id or field_id not in self.config.allowedFieldIds:
                return deny("DENIED_FIELD", "허용된 입력 필드가 아닙니다.")
            # 규칙만(결정적으로): 사용자 말은 턴 입구에서 이미 모델까지 거쳤다
            if action.get("value") and detect_sensitive(action["value"], model=False).hasSecretValue:
                return deny("DENIED_SECRET", "입력값에 민감 정보로 보이는 내용이 있어 입력하지 않았습니다.")

        # 위험도는 부르는 쪽이 높일 수만 있다: 동작 이름의 버튼은 낮게 적어 와도 승인을 받는다.
        if action["risk"] != "low" or action["requiresConfirmation"] or (action["type"] == "click" and self._risky_control(target)):
            if action["id"] in ctx.approvals:
                return decision(True, "APPROVED", "사용자가 실행 전에 승인했습니다.")
            return deny("NEEDS_CONFIRMATION", "실행 전에 사용자 승인이 필요합니다.")
        return decision(True, "ALLOWED", "허용된 저위험 조작입니다.")

    def _risky_control(self, target: dict) -> bool:
        name = target.get("name") or ""
        role = target.get("role")
        if role == "link" or (role == "button" and name in self.config.safeButtons):
            return False
        if role in ("tab", "scriptlink"):
            return is_action_name(name)
        return bool(RISKY_BUTTON.search(name))

    def _check_read_only(self, action: dict, ctx: PolicyContext) -> dict:
        """지원하지 않는 사이트: 읽고 이동하고 검색하는 것까지만."""

        def read_only(reason: str) -> dict:
            return deny("DENIED_READ_ONLY", f"지원하지 않는 사이트라 읽기 전용입니다. {reason}")

        target = action.get("target") or {}
        value = action.get("value")
        # 입력 도우미: 실제 사이트의 일반 입력란은 '사용자가 이 값을 확인·승인한 경우에만' 채운다(sensitive + 승인).
        # 비밀번호·인증번호·주민번호 등은 승인과 무관하게 거부, 제출 같은 consequential 동작은 항상 사용자가 직접.
        if action["type"] in INPUT_TYPES and target.get("role") != "searchbox":
            label = f"{target.get('label') or ''} {target.get('name') or ''}"
            if SECRET_LABEL.search(label) or (value and detect_sensitive(value, model=False).hasSecretValue):
                return deny("DENIED_SECRET", "민감 정보 입력란은 사용자가 직접 입력해야 합니다.")
            if action["risk"] != "sensitive" or not action["requiresConfirmation"]:
                return read_only("입력은 사용자 확인을 받은 경우에만 합니다.")
            if action["id"] in ctx.approvals:
                return decision(True, "APPROVED", "사용자가 이 입력을 확인했습니다.")
            return deny("NEEDS_CONFIRMATION", "이 칸에 입력하기 전에 사용자 확인이 필요합니다.")
        if action["type"] not in READ_ONLY_TYPES:
            return read_only("입력·선택은 하지 않습니다.")
        if action["risk"] != "low" or action["requiresConfirmation"]:
            return read_only("중요한 동작은 하지 않습니다.")
        if action["type"] == "click":
            role = target.get("role")
            name = target.get("name") or ""
            tier = click_tier(role, name) if self.config.readOnlyClicks == "safe" else "free"
            if tier == "hard":
                return read_only("신청·제출·동의 같은 동작은 누르지 않습니다.")
            if tier == "ask" and (self.config.publicLookupOnly or ctx.public_lookup):
                return read_only("정보를 찾는 동안에는 확인이 필요한 버튼을 누르지 않습니다.")
            if tier == "ask" or LOGIN_NAME.search(name):
                if action["id"] in ctx.approvals:
                    return decision(True, "APPROVED", "사용자가 누르라고 확인했습니다.")
                return deny("NEEDS_CONFIRMATION", "누르기 전에 사용자 확인이 필요합니다.")
        if action["type"] in ("fill", "press"):
            if target.get("role") != "searchbox":
                return read_only("검색창에만 입력할 수 있습니다.")
            if action["type"] == "press" and value != "Enter":
                return read_only("검색 실행(Enter)만 할 수 있습니다.")
            if action["type"] == "fill" and (not value or len(value) > 100 or detect_sensitive(value, model=False).hasSecretValue):
                return deny("DENIED_SECRET", "검색어에 민감 정보로 보이는 내용이 있거나 너무 길어 입력하지 않았습니다.")
        return decision(True, "ALLOWED_READ_ONLY", "읽기 전용 범위의 조작입니다.")
