"""보호자 등록과 도움 요청. 수신자와 문구를 확인한 뒤 한 번만 발송한다."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal, Mapping, Protocol

import httpx

from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import jdumps
from cheongeum.core.turn import draft
from cheongeum.personal.store import MOBILE, PersonalStore

MESSAGE = "청음 사용자가 도움을 요청하니 연락해 주세요."
SETUP_HINT = "보호자의 동의를 받은 뒤 '보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘'처럼 말씀해 주세요."
_DIGITS = str.maketrans("영공일이삼사오육륙칠팔구", "001234566789")
_REGISTER = re.compile(
    r"(?:내\s*)?보호자\s*(?:이름(?:은|이)?\s*)?(?P<name>[가-힣a-zA-Z]{1,15}?)"
    r"(?:이고|님의|의|님)?[ ,]*(?:전화\s*번호|연락처|휴대폰)(?:는|은)?\s*"
    r"(?P<phone>[\d영공일이삼사오육륙칠팔구\s-]+?)(?:(?:이?라고|으로|로)?\s*(?:등록|저장|기억)\s*해(?:\s*줘|주세요)?)?"
)
_CONTACT = re.compile(r"(?:내\s*)?보호자(?:한테|에게|께)?\s*(?:도움\s*요청|연락|문자(?:\s*메시지)?(?:를)?\s*(?:보내)?)(?:해|해줘|해\s*주세요|줘|주세요|\s*보내\s*줘)?")


def guardian_command(text: str) -> dict | None:
    text = text.strip().rstrip(".!。")
    if "보호자" not in text:
        return None
    if _CONTACT.fullmatch(text):
        return {"kind": "guardian-send"}
    if re.fullmatch(r"(?:내\s*)?보호자(?:\s*(?:정보|연락처|번호))?(?:를)?\s*(?:삭제해|지워)(?:\s*줘|주세요)?", text):
        return {"kind": "guardian-clear"}
    if re.match(r"(?:내\s*)?보호자", text) and re.search(r"등록|저장|기억|(?:이름|번호|연락처).*\d", text):
        match = _REGISTER.fullmatch(text)
        if match:
            phone = re.sub(r"[\s-]", "", match["phone"].translate(_DIGITS))
            if MOBILE.fullmatch(phone):
                return {"kind": "guardian-save", "contact": {"name": match["name"], "phone": phone}}
        return {"kind": "guardian-help"}
    return None


Delivery = Literal["preview", "accepted", "failed", "unknown"]


class GuardianSender(Protocol):
    preview: bool

    async def send(self, phone: str, message: str) -> Delivery: ...


class PreviewSender:
    preview = True

    async def send(self, phone: str, message: str) -> Delivery:
        return "preview"


@dataclass(frozen=True)
class SolapiSender:
    key: str = field(repr=False)
    secret: str = field(repr=False)
    sender_number: str = field(repr=False)
    preview = False

    async def send(self, phone: str, message: str) -> Delivery:
        stamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        salt = secrets.token_hex(16)
        signature = hmac.new(self.secret.encode(), (stamp + salt).encode(), hashlib.sha256).hexdigest()
        auth = f"HMAC-SHA256 apiKey={self.key}, date={stamp}, salt={salt}, signature={signature}"
        body = {"messages": [{"to": phone, "from": self.sender_number, "text": message, "type": "SMS"}]}
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                response = await client.post("https://api.solapi.com/messages/v4/send-many/detail", headers={"Authorization": auth}, json=body)
            if 400 <= response.status_code < 500:
                return "failed"
            response.raise_for_status()
            result = response.json()
            if result["failedMessageList"]:
                return "failed"
            if result["groupInfo"]["count"]["registeredSuccess"] == 1:
                return "accepted"
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            pass
        return "unknown"


def guardian_sender(env: Mapping[str, str]) -> GuardianSender | None:
    provider = env.get("GUARDIAN_SMS_PROVIDER", "mock").strip().lower()
    if provider == "mock":
        return PreviewSender()
    key, secret, number = (env.get(k, "").strip() for k in ("SOLAPI_API_KEY", "SOLAPI_API_SECRET", "SOLAPI_SENDER_NUMBER"))
    number = number.replace("-", "")
    if provider == "solapi" and key and secret and re.fullmatch(r"[0-9]{8,11}", number):
        return SolapiSender(key, secret, number)
    return None


def screen_digest(view: dict) -> str:
    relevant = {key: view.get(key) for key in ("url", "title", "step", "fields", "dialogs", "status", "outline", "errors")}
    return hashlib.sha256(jdumps(relevant).encode()).hexdigest()


class GuardianDialogue:
    def __init__(self, store: PersonalStore, dialogue: DialogueState, sender: GuardianSender | None):
        self.store = store
        self.dialogue = dialogue
        self.sender = sender

    def take_pending(self) -> dict | None:
        pending = self.dialogue.vault_confirm
        if not pending or not pending["kind"].startswith("guardian-"):
            return None
        self.dialogue.take_vault_confirm()
        self.dialogue.commit(pending["resume"])
        return pending

    def ask(self, cmd: dict, view: dict | None, now: float, resume: str) -> dict:
        kind = cmd["kind"]
        if kind == "guardian-help":
            return draft(resume, "clarify", SETUP_HINT)
        contact = cmd.get("contact") or self.store.guardian()
        if not contact:
            return draft(resume, "clarify", "저장한 보호자가 없어요. " + SETUP_HINT)
        name, phone = contact["name"], contact["phone"]
        phone_read = " ".join("공일이삼사오육칠팔구"[int(d)] for d in phone)
        pending = {"kind": kind, "contact": contact, "at": now, "resume": resume}
        if kind == "guardian-save":
            speech = f"보호자 {name}님의 번호는 {phone_read}예요. 이분이 도움 요청 문자를 받는 데 동의했고 이 번호를 저장해도 되면 '네'라고 해 주세요."
        elif kind == "guardian-clear":
            speech = f"보호자 {name}님의 연락처를 지울까요?"
        else:
            if self.sender is None:
                return draft(resume, "none", "보호자 문자 발송 설정을 확인해 주세요.")
            pending.update(message=MESSAGE, screen=screen_digest(view or {}))
            action = "모의 문자로 미리 볼까요" if self.sender.preview else "문자로 보낼까요"
            speech = f"{name}님, 끝번호 {phone[-4:]}에게 “{MESSAGE}” {action}? 원하시면 '네'라고 말씀해 주세요."
        self.dialogue.ask_vault_confirm(pending)
        return draft("WAITING_FOR_USER_CONFIRMATION", "clarify", speech)

    async def approved(self, pending: dict, view: dict | None, now: float, ttl: float) -> dict:
        kind, contact, resume = pending["kind"], pending["contact"], pending["resume"]
        if kind != "guardian-save" and self.store.guardian() != contact:
            return self.ask({"kind": kind}, view, now, resume)
        if now - pending["at"] >= ttl or (kind == "guardian-send" and screen_digest(view or {}) != pending["screen"]):
            return self.ask(pending, view, now, resume)
        if kind == "guardian-save":
            self.store.set_guardian(contact)
            return draft(resume, "none", "보호자 연락처를 저장했어요.")
        if kind == "guardian-clear":
            self.store.set_guardian(None)
            return draft(resume, "none", "보호자 연락처를 지웠어요.")
        result = await self.sender.send(contact["phone"], pending["message"])
        speech = {
            "preview": f"모의 문자 내용은 “{pending['message']}”입니다. 실제 발송은 하지 않았어요.",
            "accepted": "보호자에게 보낼 문자가 발송 서비스에 접수됐어요.",
            "failed": "발송 서비스가 문자를 접수하지 못했어요. 다시 시도하려면 '보호자한테 연락해줘'라고 해 주세요.",
            "unknown": "문자 접수 여부를 확인하지 못했어요. 중복 발송을 피하려면 먼저 보호자에게 확인해 주세요.",
        }[result]
        return draft(resume, "none", speech)
