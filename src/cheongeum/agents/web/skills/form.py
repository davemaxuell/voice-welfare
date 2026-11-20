"""④ Agent A 신청서 다루기: 값 넣기·읽기·고치기, 단계 이동, 검토, 모의접수 승인 요청과 승인된 실행."""
from __future__ import annotations

from dataclasses import dataclass

from cheongeum.agents.web.agent import ExecContext, WebExecutionAgent, WebOutcome
from cheongeum.agents.web.approval import fingerprint
from cheongeum.agents.web.profile import FieldProfile
from cheongeum.agents.web.skills.common import ask_again, browse_state, fill_confirmed, is_form_open, not_open, outcome_failure
from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import nz, try_url
from cheongeum.core.turn import AGENT_IDS, draft
from cheongeum.safety import mask_value
from cheongeum.speech.phrasing import josa, readback, speak_label
from cheongeum.speech.screen import Narrator


@dataclass(frozen=True)
class NextStep:
    speech: str
    field_id: str | None = None


def _next_step(view: dict) -> NextStep:
    """다음에 할 일을 먼저 묻는 말과, 그 말이 값을 묻는 항목(비어 있는 필수 항목. 묻지 않으면 None). 상태는 바꾸지 않는다."""
    step = view.get("step")
    if view.get("pageId") != "mock-welfare" or not step or view.get("status"):
        return NextStep("")
    nxt = next((f for f in view["fields"] if f.get("visible") and f.get("required") and not f.get("filled") and f["type"] != "checkbox"), None)
    if nxt:
        return NextStep(f"{josa(speak_label(nxt['label']), '을', '를')} 말씀해 주세요.", nxt["fieldId"])
    if step["index"] < step["total"]:
        optional = [
            speak_label(f["label"]) for f in view["fields"] if f.get("visible") and not f.get("required") and not f.get("filled") and f["type"] != "checkbox"
        ]
        if optional:
            return NextStep(f"{josa(', '.join(optional), '은', '는')} 선택이에요. 넣으려면 '{optional[0]}는 …'처럼 말하고, 넘어가려면 '다음으로'라고 해 주세요.")
        return NextStep("다음 단계로 가려면 '다음으로'라고 해 주세요.")
    return NextStep("")


class FormSkill:
    def __init__(self, web: WebExecutionAgent, dialogue: DialogueState, narrator: Narrator) -> None:
        self.web = web
        self.dialogue = dialogue
        self.narrator = narrator
        # 마지막으로 넣거나 읽거나 설명한 항목('이 항목 뭐야'의 기본 대상)
        self._last_field_id: str | None = None

    @property
    def last_field_id(self) -> str | None:
        return self._last_field_id

    def field_explained(self, field_id: str) -> None:
        """이 항목을 설명했다. (SessionOrchestrator._explain)"""
        self._last_field_id = field_id

    def form_state(self) -> str:
        return "WAITING_FOR_USER_CONFIRMATION" if self.dialogue.state == "WAITING_FOR_USER_CONFIRMATION" and self.dialogue.approval else "APPLICATION_OPEN"

    def ask_next(self, view: dict) -> str:
        """
        다음에 할 일을 묻는다. 비어 있는 필수 항목을 물었으면 그 항목 값을 기다리는 상태로 두어,
        사용자가 "이름은" 없이 "김하늘"이라고만 말해도 입력되게 한다(음성 대화용).
        """
        step = _next_step(view)
        if step.field_id is not None:
            self.dialogue.ask_value(step.field_id)
        return step.speech

    async def _assist_fill_request(self, fills: list[dict], ctx: ExecContext) -> dict:
        """
        실제(지원하지 않는) 사이트의 입력 도우미: 칸을 찾아 무엇을 넣을지 읽어 주고, 사용자가 '응'해야 넣는다.
        비밀 칸은 후보에서 빠지고, 제출·신청 버튼은 누르지 않는다.
        """
        view = await self.web.observe(ctx)
        actions: list[dict] = []
        values: list[dict] = []
        for f in fills:
            found = self.web.assist_candidates(f["fieldMention"], view)
            if not found:
                return draft(
                    self.dialogue.state,
                    "clarify",
                    f"'{f['fieldMention']}' 칸을 화면에서 찾지 못했어요. '화면 설명해줘'라고 하시면 입력 칸을 알려 드려요.",
                    view=view,
                )
            if len(found) > 1:
                return draft(
                    self.dialogue.state,
                    "clarify",
                    f"'{f['fieldMention']}'에 맞는 칸이 여러 개예요: {', '.join(x['label'] for x in found[:4])}. 정확한 칸 이름을 말씀해 주세요.",
                    view=view,
                )
            actions.append(self.web.build_assist_action(found[0], f["value"]))
            values.append({"label": speak_label(found[0]["label"]), "value": f["value"]})
        u = try_url(view["url"])
        site = u.host if u else view["url"]
        listed = ", ".join(f'{v["label"]} 칸에 "{v["value"]}"' for v in values)
        description = f"{site}의 {listed}, 이렇게 넣을까요? 맞으면 '응', 아니면 '아니'라고 해 주세요."
        speech = description
        self.dialogue.ask_approval(
            {
                "kind": "assist",
                "url": view["url"],
                "action": actions[0],
                "actions": actions,
                "confirmation": {
                    "actionId": actions[0]["id"],
                    "kind": "field-entry",
                    "description": description,
                    "purpose": "실제 사이트 입력란 채우기(제출은 하지 않음)",
                    "site": site,
                    "values": values,
                    "realSubmission": False,
                },
                "fingerprint": fingerprint(view, actions, speech),
            }
        )
        return draft("WAITING_FOR_USER_CONFIRMATION", "prepare-submit", speech, view=view)

    async def fill(self, fills: list[dict], ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            current = self.web.current_view
            if current and current.get("pageId") == "external":
                return await self._assist_fill_request(fills, ctx)
            return not_open(self.web.current_view, self.dialogue.state)
        drafts: list[dict] = []
        for f in fills:
            field_, reply = self._resolve(f["fieldMention"], f["value"])
            d = reply if reply is not None else await self.fill_one(field_, f["value"], ctx)  # type: ignore[arg-type]
            drafts.append(d)
            if d["state"] != "APPLICATION_OPEN":
                break
        # 중간 항목은 한 줄 요약, 마지막 항목만 다음 할 일까지 안내한다.
        last = drafts[-1]
        return {
            **last,
            "actions": [a for d in drafts for a in d.get("actions") or []],
            "speech": " ".join([*(nz(d.get("summary"), d["speech"]) for d in drafts[:-1]), last["speech"]]),
            "summary": " ".join(nz(d.get("summary"), d["speech"]) for d in drafts),
        }

    def _resolve(self, mention: str, pending_value: str | None = None) -> tuple[FieldProfile | None, dict | None]:
        """필드 해석 실패 시 바로 사용자에게 보낼 Draft를 돌려준다. → (field, None) 또는 (None, draft)"""
        r = self.web.resolve_field(mention)
        if r.kind == "ok":
            return r.field, None
        if r.kind == "ambiguous":
            if pending_value:
                self.dialogue.ask_which(pending_value, r.candidates)
            names = ", ".join(speak_label(c.label) for c in r.candidates)
            return None, draft(
                "NEEDS_CLARIFICATION",
                "clarify",
                f"'{mention}' 입력란이 {len(r.candidates)}개 있습니다: {names}. 어느 쪽인지 말씀해 주세요. 확인 전에는 입력하지 않습니다.",
            )
        if r.kind == "not-visible":
            f = r.field
            assert f is not None
            return None, draft(
                self.form_state(),
                "none",
                "실거주지 주소 입력란은 '실거주지가 달라'라고 말씀하시면 나타납니다."
                if f.field_id == "residenceAddress"
                else f"{speak_label(f.label)} 항목은 {f.step}단계에 있습니다. '이전으로' 또는 '다음으로'라고 말해 이동해 주세요.",
                field=f.field_id,
            )
        return None, draft(self.dialogue.state, "none", f"'{mention}' 항목을 이 신청서에서 찾지 못했습니다.")

    async def fill_one(self, field_: FieldProfile, raw_value: str, ctx: ExecContext) -> dict:
        out = await self.web.fill(field_, raw_value, ctx)
        label = speak_label(field_.label)
        if out.status == "needs-clarification":
            self.dialogue.ask_value(field_.field_id)
            return draft(
                "NEEDS_CLARIFICATION",
                "clarify",
                f"{label}: {out.message or '다시 말씀해 주세요.'}",
                field=field_.field_id,
                actions=out.actions,
                view=out.view,
            )
        if out.status != "ok":
            return outcome_failure(out, self.form_state())
        self.dialogue.value_filled(field_.field_id)
        self._last_field_id = field_.field_id
        value = out.readValue or ""
        shown = readback(field_, value)
        guide = self.ask_next(out.view) if out.view else ""
        said = fill_confirmed(label, shown, guide)
        return draft(
            "APPLICATION_OPEN",
            "fill",
            said,
            field=field_.field_id,
            value=value,
            actions=out.actions,
            view=out.view,
            verification={"fieldValueMatches": True},
            masked=bool(field_.mask_on_readback),
            summary=fill_confirmed(label, shown),
        )

    async def read_field(self, mention: str, ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            return not_open(self.web.current_view, self.dialogue.state)
        field_, reply = self._resolve_for_read(mention)
        if reply is not None:
            return reply
        assert field_ is not None
        out = await self.web.read(field_, ctx)
        if out.status != "ok":
            return outcome_failure(out, self.form_state())
        self._last_field_id = field_.field_id
        value = out.readValue or ""
        label = speak_label(field_.label)
        return draft(
            self.form_state(),
            "read",
            f"{josa(label, '은', '는')} \"{readback(field_, value)}\"입니다. 틀렸으면 '{label} 수정해'라고 말씀해 주세요."
            if value
            else f"{josa(label, '은', '는')} 아직 비어 있습니다.",
            field=field_.field_id,
            actions=out.actions,
            view=out.view,
            masked=bool(field_.mask_on_readback),
        )

    def _resolve_for_read(self, mention: str) -> tuple[FieldProfile | None, dict | None]:
        """읽기/수정은 다른 단계의 필드도 대상으로 할 수 있다(조작 없이 관찰값 사용)."""
        r = self.web.resolve_field(mention)
        if r.kind == "not-visible":
            return r.field, None
        return self._resolve(mention)

    async def edit_field(self, mention: str, ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            return not_open(self.web.current_view, self.dialogue.state)
        field_, reply = self._resolve_for_read(mention)
        if reply is not None:
            return reply
        assert field_ is not None
        view = await self.web.observe(ctx)
        observed = self.web.observed_field(field_.field_id, view)
        label = speak_label(field_.label)
        if not observed or not observed.get("visible"):
            return draft(
                self.form_state(),
                "none",
                f"{label} 항목은 {field_.step}단계에 있습니다. 먼저 '이전으로'라고 말해 이동한 뒤 수정해 주세요.",
                field=field_.field_id,
                view=view,
            )
        self.dialogue.ask_value(field_.field_id)
        self.dialogue.clear_approval()
        return draft(
            "AWAITING_FIELD_VALUE",
            "edit-field",
            f"{josa(label, '을', '를')} 수정합니다. 현재 값은 \"{readback(field_, observed['value'])}\"입니다. 새 값을 말씀해 주세요."
            if observed["value"]
            else f"{josa(label, '을', '를')} 입력합니다. 값을 말씀해 주세요.",
            field=field_.field_id,
            view=view,
        )

    async def next(self, ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            return not_open(self.web.current_view, self.dialogue.state)
        out = await self.web.next(ctx)
        return self._after_step_move(out, "navigate-next")

    async def prev(self, ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            return not_open(self.web.current_view, self.dialogue.state)
        out = await self.web.prev(ctx)
        if out.status == "ok" and out.atFirstStep and out.view:
            return draft(self.form_state(), "navigate-prev", f"첫 단계입니다. {self.narrator.describe_view(out.view)}", view=out.view)
        return self._after_step_move(out, "navigate-prev")

    def _after_step_move(self, out: WebOutcome, semantic: str) -> dict:
        if out.status == "validation-error" and out.view:
            missing = out.missing or []
            if missing:
                self.dialogue.ask_value(missing[0]["fieldId"])
            details = ", ".join(f"{m['label']}{f'(사이트 안내: {m['error']})' if m.get('error') else ''}" for m in missing)
            first = f" 먼저 {missing[0]['label']} 값을 말씀해 주세요." if missing else ""
            return draft(
                "VALIDATION_ERROR",
                semantic,
                f"다음 단계로 넘어가지 못했습니다. 확인이 필요한 항목: {details or '화면의 오류 메시지를 확인해 주세요'}.{first}",
                actions=out.actions,
                view=out.view,
                missingFields=[m["label"] for m in missing],
            )
        if out.status == "needs-clarification":
            return draft("NEEDS_CLARIFICATION", semantic, out.message or "확인이 필요합니다.", actions=out.actions, view=out.view)
        if out.status != "ok" or not out.view:
            return outcome_failure(out, self.form_state())
        if out.atLastStep:
            return draft(
                self.form_state(),
                semantic,
                "마지막 검토 단계입니다. 내용을 확인했으면 '모의 접수 내용을 확인했어'라고 말씀해 주세요.",
                actions=out.actions,
                view=out.view,
            )
        self.dialogue.drop_value_wait()
        guide = self.ask_next(out.view)
        popup = f"안내 팝업 '{"', '".join(out.dismissedDialogs)}'이 떠서 닫았어요. " if out.dismissedDialogs else ""
        moved = "다음 단계로 넘어갔어요." if semantic == "navigate-next" else "이전 단계로 돌아왔어요."
        return draft(
            "APPLICATION_OPEN",
            semantic,
            f"{moved} {popup}{self.narrator.describe_view(out.view)} {guide}".strip(),
            actions=out.actions,
            view=out.view,
            verification={"requiredFieldsComplete": bool(out.requiredFieldsComplete)} if semantic == "navigate-next" else None,
            summary=f"{popup}{moved}",
        )

    def _review_values(self, view: dict) -> list[dict]:
        out = []
        for f in view["fields"]:
            if f.get("sensitive") or not f.get("filled") or f["type"] == "checkbox":
                continue
            profile = self.web.field(f["fieldId"])
            out.append({"label": speak_label(f["label"]), "value": readback(profile, f["value"]) if profile else mask_value(f["value"])})
        return out

    async def review(self, ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            return not_open(self.web.current_view, self.dialogue.state)
        view = await self.web.observe(ctx)
        values = self._review_values(view)
        missing = [speak_label(f["label"]) for f in view["fields"] if f.get("required") and not f.get("filled")]
        head = f"지금까지 입력한 내용입니다. {'. '.join(f'{v['label']}: {v['value']}' for v in values)}." if values else "아직 입력한 내용이 없습니다."
        return draft(
            self.form_state(),
            "review",
            head
            + f" 비어 있는 필수 항목: {', '.join(missing) if missing else '없음'}. 연락처 등은 일부를 가려서 읽었고, 비밀번호 같은 보안 정보는 읽지 않습니다.",
            view=view,
            masked=True,
            missingFields=missing,
        )

    async def prepare_submit(self, ctx: ExecContext) -> dict:
        if not is_form_open(self.web.current_view):
            return not_open(self.web.current_view, self.dialogue.state)
        ctx.trace("PLANNING", AGENT_IDS.orchestrator, "검토 단계로 이동 후 승인 요청")
        out = await self.web.go_to_final_step(ctx)
        if out.status != "ok" or not out.view:
            return self._after_step_move(out, "prepare-submit")
        action = self.web.build_submit_action()
        preview = self.web.preview_policy(action, ctx)
        values = self._review_values(out.view)
        profile = self.web.profile
        listed = ". ".join(f"{v['label']}: {v['value']}" for v in values)
        speech = (
            f"검토 단계입니다. {profile.name} ({profile.origin}, 로컬)에 모의접수할 내용: {listed}. "
            + "이 내용으로 모의접수할까요? 실제 복지로 접수가 아니며 어디에도 전송되지 않습니다. 승인하려면 '모의접수 승인', 그만두려면 '거절'이라고 말씀하세요. 항목을 고치려면 해당 항목을 말씀하세요."
        )
        self.dialogue.ask_approval(
            {
                "kind": "submit",
                "url": out.view["url"],
                "action": action,
                "confirmation": {
                    "actionId": action["id"],
                    "kind": "practice-submission",
                    "description": speech,
                    "purpose": "장애인연금 모의 신청서 모의접수 (실제 제출 아님)",
                    "site": f"{profile.name} ({profile.origin}, 로컬)",
                    "values": values,
                    "realSubmission": False,
                },
                # 읽어 준 칸만이 아니라 신청서 칸 전부: 비어 있던 칸에 값이 생겨도 읽어 주지 않은 내용이 접수된다
                "fingerprint": fingerprint(out.view, [action], speech, [f["fieldId"] for f in out.view["fields"]]),
            }
        )
        self.dialogue.drop_value_wait()
        return draft("WAITING_FOR_USER_CONFIRMATION", "prepare-submit", speech, actions=[*out.actions, preview], view=out.view, masked=True)

    async def assist_approved(self, actions: list[dict], ctx: ExecContext) -> dict:
        """승인받은 실제 사이트 입력란 채우기. 호출자가 ctx.granted로 감싼다."""
        out = await self.web.assist_fill(actions, ctx)
        if out.status == "unconfirmed":
            return ask_again(out, "fill", "다시 넣으려면 '응', 그만두려면 '아니'라고 해 주세요.")
        self.dialogue.clear_approval()
        if out.status != "ok" or not out.view:
            return outcome_failure(out, "BROWSING")
        return draft(
            browse_state(out.view),
            "fill",
            "넣고 확인했어요. 제출이나 신청 버튼은 직접 눌러 주세요. 다른 칸도 말씀하시면 같은 방식으로 도와드릴게요.",
            actions=out.actions,
            view=out.view,
        )

    async def submit_approved(self, action: dict, ctx: ExecContext) -> dict:
        """승인받은 모의접수. 호출자가 ctx.granted로 감싼다."""
        out = await self.web.submit_approved(action, ctx)
        if out.status == "unconfirmed":
            return ask_again(out, "submit", "다시 하려면 '승인', 그만두려면 '거절'이라고 말씀해 주세요.")
        if out.status != "ok":
            return outcome_failure(out, "WAITING_FOR_USER_CONFIRMATION")
        self.dialogue.clear_approval()
        return draft(
            "MOCK_SUBMITTED",
            "submit",
            f"모의접수를 마쳤습니다. 모의 접수번호는 {out.receipt}입니다. 실제 복지로 접수가 아니며 어떤 기관에도 전송되지 않았습니다.",
            actions=out.actions,
            view=out.view,
            verification={"receipt": out.receipt},
            value=out.receipt,
        )

    def reject(self) -> dict:
        if not self.dialogue.approval:
            return draft(self.dialogue.state, "reject", "거절할 승인 요청이 없어요.")
        kind = self.dialogue.approval.get("kind")
        self.dialogue.clear_approval()
        if kind == "research":
            return draft("IDLE", "reject", "자료 조사 요청을 취소했어요.")
        if kind == "visual":
            return draft("BROWSING", "reject", "화면 사진을 보내지 않았어요.")
        if kind == "file":
            view = self.web.current_view
            return draft(browse_state(view) if view else "IDLE", "reject", "파일을 보내지 않았어요.")
        if kind == "assist":
            return draft("BROWSING", "reject", "넣지 않았어요. 다시 말씀해 주세요.")
        if kind == "click":
            view = self.web.current_view
            return draft(browse_state(view) if view else "IDLE", "reject", "누르지 않았어요. 화면은 그대로예요.")
        return draft("APPLICATION_OPEN", "reject", "모의접수를 하지 않았어요. 입력 내용은 그대로 있어요.")
