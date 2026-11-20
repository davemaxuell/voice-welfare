"""금고·신청 기록 대화(기능 4·5): 저장·삭제 확인에 대한 대답, 금고·신청 기록 명령 실행, 입력 칸에 맞는 저장된 값. 오케스트레이터가 세션마다 만든다."""
from __future__ import annotations

from datetime import date

from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import rx
from cheongeum.core.lexicon import agree, approval, whole_rejection
from cheongeum.core.turn import draft
from cheongeum.personal.commands import days_until, vault_key_for_label
from cheongeum.personal.store import SPEECH_LABELS, VAULT_LABELS, PersonalStore
from cheongeum.speech.phrasing import speak_call_name, speak_date

_LENGTH_KO = {"short": "짧게", "normal": "보통", "detailed": "자세히"}

_VAULT_LABELS = {
    "ko": {**VAULT_LABELS, "callName": "부르는 이름"},
    "en": {"name": "Name", "address": "Address", "phone": "Phone", "email": "Email", "birth": "Date of birth", "callName": "Preferred name"},
    "zh": {"name": "姓名", "address": "地址", "phone": "电话", "email": "电子邮箱", "birth": "出生日期", "callName": "称呼"},
    "ja": {"name": "氏名", "address": "住所", "phone": "電話番号", "email": "メール", "birth": "生年月日", "callName": "呼び名"},
}
_SAVE_ON_DEVICE = {
    "ko": "이렇게 이 컴퓨터에 저장할까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.",
    "en": "Save these details on this computer? Say yes or no.",
    "zh": "要把这些信息保存在这台电脑上吗？请回答是或不是。",
    "ja": "この情報をこの端末に保存しますか。はい、またはいいえでお答えください。",
}
_SAVE_IN_SESSION = {
    "ko": "이렇게 기억할까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.",
    "en": "Remember these details for this conversation? Say yes or no.",
    "zh": "要在这次对话中记住这些信息吗？请回答是或不是。",
    "ja": "この会話の間だけこの情報を覚えておきますか。はい、またはいいえでお答えください。",
}
_READ_VAULT = {
    "ko": "저장된 정보는 {entries}이에요.",
    "en": "Your saved details are {entries}.",
    "zh": "您已保存的信息是：{entries}。",
    "ja": "保存されている情報は、{entries}です。",
}
_ASK_VAULT_FIELDS = {
    "ko": "무엇을 저장할까요? 예: '내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이라고 저장해줘'. 비밀번호·주민등록번호는 저장하지 않아요.",
    "en": "Which detail should I remember? Please ask me to save it again, giving the field name first and then its value.",
    "zh": "您想保存哪项信息？请重新说出保存请求，先说项目名称，再说相应的内容。",
    "ja": "どの情報を保存しますか。項目名とその内容を順に指定して、もう一度保存を依頼してください。",
}
_VAULT_VERBS = {
    "vault-save": rx(r"(?:저장해|기억해)\s*(?:줘요?|주세요)?"),
    "vault-clear": rx(r"(?:지워|삭제해)\s*(?:줘요?|주세요)?"),
}


def vault_reply(text: str, kind: str, lang: str) -> bool | None:
    """Match the complete, untranslated reply to the operation the user heard."""
    t = text.strip().rstrip(".!。！~").rstrip()
    if not t or t.endswith(("?", "？")):
        return None
    if lang != "ko":
        if approval(t, lang) == "approve":
            return True
        return False if whole_rejection(t, lang) else None
    if rx(r"[가-힣]").search(t) and (answer := agree(t)):
        return answer == "yes"
    phrase = rx(r"^(?:응|네|예)[,\s]+").sub("", t, count=1)
    if _VAULT_VERBS[kind].fullmatch(phrase) or (phrase.startswith("승인") and approval(phrase) == "approve"):
        return True
    if phrase in ("거절", "취소", "됐어") or rx(r"(?:지우지|저장하지|기억하지|삭제하지|하지)\s*마(?:세요|요)?").fullmatch(phrase):
        return False
    return None


def _speak_speech(prefs: dict) -> str:
    """말하기 설정을 한 문장으로."""
    rate = prefs.get("rate", 1.25)
    if rate <= 1.0:
        speed = "천천히"
    elif rate >= 1.4:
        speed = "빨리"
    else:
        speed = "보통"
    length = _LENGTH_KO.get(prefs.get("length") or "normal", "보통")
    voice = prefs.get("voice") or "기본"
    progress = "켭니다" if prefs.get("progressSpoken", True) else "끕니다"
    return f"{SPEECH_LABELS['rate']}는 {speed}, {SPEECH_LABELS['length']}는 {length}, {SPEECH_LABELS['voice']}는 {voice}, {SPEECH_LABELS['progressSpoken']}은 {progress}."


class PersonalDialogue:
    def __init__(self, store: PersonalStore, dialogue: DialogueState, on_speech=None, action_log=None) -> None:
        self._store = store
        self.dialogue = dialogue
        # 말하기 설정이 바뀌면 오케스트레이터가 Progress.spoken 등을 맞춘다
        self._on_speech = on_speech
        self._action_log = action_log

    def saved_for(self, label: str) -> str | None:
        """입력 칸 이름에 맞는 금고 값(없으면 None)"""
        key = vault_key_for_label(label)
        return self._store.vault().get(key) if key else None

    def confirm(self, approved: bool) -> dict:
        pending = self.dialogue.take_vault_confirm()
        if not approved:
            return draft("IDLE", "none", "알겠어요. 그대로 둘게요.")
        if pending["kind"] == "vault-save":
            self._store.save_vault(pending["values"])
            where = "이 컴퓨터에만 저장했어요" if self._store.persistent else "이번 대화 동안 기억할게요"
            return draft("IDLE", "none", f"{where}. 입력 칸을 채울 때 먼저 여쭤보고 쓸게요.")
        if pending["kind"] != "vault-clear":
            raise ValueError("Unexpected vault confirmation")
        self._store.clear_vault()
        return draft("IDLE", "none", "저장된 내 정보를 모두 지웠어요.")

    def run(self, cmd: dict, *, lang: str = "ko") -> dict | None:
        """금고·신청 기록 명령(parse_personal_command의 결과). 모르는 종류면 None."""
        vault = self._store.vault()
        kind = cmd["kind"]
        if kind == "vault-save":
            entries = list(cmd["values"].items())
            if not entries:
                return draft(self.dialogue.state, "clarify", _ASK_VAULT_FIELDS[lang], lang=lang)
            self.dialogue.ask_vault_confirm(cmd)
            listed = ", ".join(f"{_VAULT_LABELS[lang][k]} {v}" for k, v in entries)
            question = _SAVE_ON_DEVICE if self._store.persistent else _SAVE_IN_SESSION
            return draft(
                "WAITING_FOR_USER_CONFIRMATION",
                "clarify",
                f"{listed}. {question[lang]}", lang=lang,
            )
        if kind == "vault-read":
            entries = [f"{_VAULT_LABELS[lang][k]} {v}" for k, v in vault.items()]
            if name := self._store.call_name():
                entries.append(f"{_VAULT_LABELS[lang]['callName']} {speak_call_name(name) if lang == 'ko' else name}")
            if entries:
                return draft(self.dialogue.state, "none", _READ_VAULT[lang].format(entries=", ".join(entries)), lang=lang)
            return draft(self.dialogue.state, "none", "저장된 정보가 없어요. '내 이름은 …이라고 저장해줘'처럼 말씀해 주세요.")
        if kind == "vault-clear":
            if not vault and not self._store.guardian() and not self._store.call_name():
                return draft(self.dialogue.state, "none", "저장된 정보가 없어요.")
            self.dialogue.ask_vault_confirm(cmd)
            return draft("WAITING_FOR_USER_CONFIRMATION", "clarify", "저장된 내 정보를 모두 지울까요? 맞으면 '응'이라고 해 주세요.")
        if kind == "app-record":
            applied_at = date.today().isoformat()
            self._store.add_application({"service": cmd["service"], "appliedAt": applied_at, "receiptNo": cmd.get("receiptNo")})
            receipt = f". 접수번호 {cmd['receiptNo']}" if cmd.get("receiptNo") else ""
            return draft(
                self.dialogue.state,
                "none",
                f"{cmd['service']} 신청을 기록했어요{receipt}. 보완 서류 기한이 생기면 '보완 서류는 12월 3일까지'처럼 알려 주세요. 사흘 전부터 알려 드릴게요.",
            )
        if kind == "app-due":
            apps = [a for a in self._store.applications() if not a.get("done")]
            svc = cmd.get("service")
            target = (next((a for a in apps if svc in a["service"] or a["service"] in svc), None) if svc else None) or (apps[-1] if apps else None)
            if not target:
                return draft(self.dialogue.state, "clarify", "어떤 신청의 기한인지 몰라요. 먼저 '기초연금 신청했어'처럼 신청을 알려 주세요.")
            self._store.update_application(target["id"], {"dueDate": cmd["dueDate"], "dueNote": cmd["note"]})
            left = days_until(cmd["dueDate"])
            return draft(
                self.dialogue.state,
                "none",
                f"{target['service']} {cmd['note']} 기한을 {speak_date(cmd['dueDate'])}로 적었어요. {left}일 남았어요. {'기한까지 매일 알려 드릴게요.' if left <= 3 else '사흘 전부터 알려 드릴게요.'}",
            )
        if kind == "app-status":
            apps = [a for a in self._store.applications() if not a.get("done")]
            if not apps:
                return draft(self.dialogue.state, "none", "기록된 신청이 없어요. 신청을 마치면 '기초연금 신청했어'라고 알려 주세요.")
            rows = []
            for i, a in enumerate(apps):
                due = ""
                if a.get("dueDate"):
                    left = days_until(a["dueDate"])
                    due = f", {a.get('dueNote') or '기한'} {speak_date(a['dueDate'])}까지({f'{left}일 남음' if left >= 0 else '기한 지남'})"
                rows.append(f"{i + 1}. {a['service']}, {speak_date(a['appliedAt'])} 신청{due}")
            return draft(
                self.dialogue.state,
                "none",
                f"기록된 신청은 {len(apps)}건이에요. {'. '.join(rows)}. 실제 처리 상태는 복지로에 로그인해서 신청 현황에서 볼 수 있어요. 로그인은 직접 하셔야 해요.",
            )
        if kind == "app-done":
            apps = [a for a in self._store.applications() if not a.get("done")]
            svc = cmd.get("service")
            target = (next((a for a in apps if svc in a["service"]), None) if svc else None) or (apps[0] if len(apps) == 1 else None)
            if not target:
                return draft(self.dialogue.state, "clarify", "어떤 신청이 끝났는지 제도 이름을 말씀해 주세요.")
            self._store.update_application(target["id"], {"done": True})
            return draft(self.dialogue.state, "none", f"{target['service']} 신청을 끝난 것으로 표시했어요. 수고하셨어요.")
        if kind == "speech-read":
            return draft(self.dialogue.state, "none", _speak_speech(self._store.speech()))
        if kind == "speech-clear":
            prefs = self._store.clear_speech()
            if self._on_speech:
                self._on_speech(prefs)
            return draft(self.dialogue.state, "none", f"말하기 설정을 기본값으로 돌렸어요. {_speak_speech(prefs)}")
        if kind == "speech-set":
            prefs = self._store.save_speech(cmd.get("values") or {})
            if self._on_speech:
                self._on_speech(prefs)
            return draft(self.dialogue.state, "none", f"알겠어요. {_speak_speech(prefs)}")
        if kind == "action-log-read":
            if self._action_log is None:
                return draft(self.dialogue.state, "none", "조작 기록을 이 세션에서는 쓰지 않아요.")
            return draft(self.dialogue.state, "none", self._action_log.speak_recent(5))
        if kind == "site-allow-read":
            sites = self._store.allowed_sites()
            if not sites:
                return draft(self.dialogue.state, "none", "저장된 정보를 쓰도록 허용한 사이트가 없어요.")
            return draft(self.dialogue.state, "none", f"허용한 사이트는 {', '.join(sites)}이에요.")
        if kind == "site-allow-clear":
            self._store.revoke_site()
            return draft(self.dialogue.state, "none", "사이트별 정보 공유 허용을 모두 지웠어요.")
        return None
