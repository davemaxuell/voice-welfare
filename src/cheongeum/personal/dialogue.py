"""금고·신청 기록 대화(기능 4·5): 저장·삭제 확인에 대한 대답, 금고·신청 기록 명령 실행, 입력 칸에 맞는 저장된 값. 오케스트레이터가 세션마다 만든다."""
from __future__ import annotations

from datetime import date

from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import rx
from cheongeum.core.turn import draft
from cheongeum.personal.commands import days_until, vault_key_for_label
from cheongeum.personal.store import VAULT_LABELS, PersonalStore
from cheongeum.speech.phrasing import speak_date


class PersonalDialogue:
    def __init__(self, store: PersonalStore, dialogue: DialogueState) -> None:
        self._store = store
        self.dialogue = dialogue

    def saved_for(self, label: str) -> str | None:
        """입력 칸 이름에 맞는 금고 값(없으면 None)"""
        key = vault_key_for_label(label)
        return self._store.vault().get(key) if key else None

    def confirm(self, text: str) -> dict | None:
        """금고 저장·삭제 확인에 대한 대답. 확인 대기는 늘 접는다. '응'·'아니'가 아니면 None(그 말은 오케스트레이터가 이어서 처리)."""
        yes = bool(rx(r"^(응|네|예|맞아|그래|좋아|저장해|지워)").search(text))
        no = bool(rx(r"^(아니|아뇨|취소|됐어|하지\s*마)").search(text))
        pending = self.dialogue.take_vault_confirm()
        if yes and pending["kind"] == "vault-save":
            self._store.save_vault(pending["values"])
            where = "이 컴퓨터에만 저장했어요" if self._store.persistent else "이번 대화 동안 기억할게요"
            return draft("IDLE", "none", f"{where}. 입력 칸을 채울 때 먼저 여쭤보고 쓸게요.")
        if yes and pending["kind"] == "vault-clear":
            self._store.clear_vault()
            return draft("IDLE", "none", "저장된 내 정보를 모두 지웠어요.")
        if no:
            return draft("IDLE", "none", "알겠어요. 그대로 둘게요.")
        return None

    def run(self, cmd: dict) -> dict | None:
        """금고·신청 기록 명령(parse_personal_command의 결과). 모르는 종류면 None."""
        vault = self._store.vault()
        kind = cmd["kind"]
        if kind == "vault-save":
            entries = list(cmd["values"].items())
            if not entries:
                return draft(
                    self.dialogue.state,
                    "clarify",
                    "무엇을 저장할까요? 예: '내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이라고 저장해줘'. 비밀번호·주민등록번호는 저장하지 않아요.",
                )
            self.dialogue.ask_vault_confirm(cmd)
            listed = ", ".join(f"{VAULT_LABELS[k]} {v}" for k, v in entries)
            return draft(
                "WAITING_FOR_USER_CONFIRMATION",
                "clarify",
                f"{listed}. 이렇게 {'이 컴퓨터에 저장할까요' if self._store.persistent else '기억할까요'}? 맞으면 '응', 아니면 '아니'라고 해 주세요.",
            )
        if kind == "vault-read":
            entries = list(vault.items())
            return draft(
                self.dialogue.state,
                "none",
                f"저장된 정보는 {', '.join(f'{VAULT_LABELS[k]} {v}' for k, v in entries)}이에요."
                if entries
                else "저장된 정보가 없어요. '내 이름은 …이라고 저장해줘'처럼 말씀해 주세요.",
            )
        if kind == "vault-clear":
            if not vault:
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
        return None
