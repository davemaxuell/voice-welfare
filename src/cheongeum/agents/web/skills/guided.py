"""④ Agent A 실제 사이트 칸 채우기: 지금 페이지의 입력 칸을 하나씩 묻고, 대답한 값을 넣은 뒤 다시 읽어 확인한다(제출은 사용자가 직접)."""
from __future__ import annotations

from typing import Callable

from cheongeum.agents.web.agent import ExecContext, WebExecutionAgent
from cheongeum.agents.web.skills.common import outcome_failure
from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import I, rx
from cheongeum.core.turn import draft
from cheongeum.speech.phrasing import josa, speak_label
from cheongeum.speech.screen import Narrator
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, clean_value


class GuidedFill:
    def __init__(
        self,
        web: WebExecutionAgent,
        dialogue: DialogueState,
        narrator: Narrator,
        rules: RuleBasedIntentProvider,
        saved_value: Callable[[str], str | None],
    ) -> None:
        self.web = web
        self.dialogue = dialogue
        self.narrator = narrator
        # 대답이 칸 채우기와 상관없는 분명한 명령인지 가린다(오케스트레이터와 같은 규칙 파서)
        self._rules = rules
        # 입력 칸 이름에 맞는 개인 정보 금고 값(없으면 None)
        self._saved_value = saved_value

    def active(self) -> bool:
        """칸 채우기 중이고 아직 그 페이지에 있으면 True. 다른 페이지로 갔으면 칸 채우기를 접고 False."""
        g = self.dialogue.guided
        if not g:
            return False
        view = self.web.current_view
        if not view or view["url"] != g["url"]:
            self.dialogue.end_guided()
            return False
        return True

    async def answer(self, text: str, ctx: ExecContext) -> dict | None:
        """칸 채우기 중의 대답: 값·'응'(저장된 값)·건너뛰기·그만. 다른 명령이면 칸 채우기를 접고 None. active()가 True일 때만 부른다."""
        g = self.dialogue.guided
        view = self.web.current_view
        assert g is not None and view is not None
        if rx(r"^(그만|끝|됐어|중단)").search(text):
            self.dialogue.end_guided()
            return draft("BROWSING", "none", "칸 채우기를 멈췄어요. 제출 버튼은 직접 눌러 주세요.")

        async def nxt(prefix: str) -> dict:
            g["index"] += 1
            now = await self.web.observe(ctx)
            if g["index"] >= len(g["fieldIds"]):
                self.dialogue.end_guided()
                return draft(
                    "BROWSING", "fill", f"{prefix} 입력 칸을 모두 지나왔어요. 내용을 확인하신 뒤 제출이나 신청 버튼은 직접 눌러 주세요.", view=now
                )
            return draft("BROWSING", "fill", f"{prefix} {self._question(now)}".strip(), view=now)

        if rx(r"^(건너뛰|넘어가|패스|다음\s*칸|비워)").search(text):
            return await nxt("건너뛸게요.")
        # 칸 채우기와 상관없는 분명한 명령이면 접고 그 명령을 처리한다
        other = await self._rules.parse(text, IntentContext(state=self.dialogue.state))
        if other["type"] not in ("UNKNOWN", "FILL", "APPROVE", "REJECT"):
            self.dialogue.end_guided()
            return None
        field_ = next((f for f in view["fields"] if f["fieldId"] == g["fieldIds"][g["index"]]), None)
        if not field_:
            return await nxt("")
        if rx(r"^(응|네|예|맞아|그래|좋아)").search(text) and g.get("suggestion"):
            value = g["suggestion"]
        else:
            value = clean_value(rx(r"^(응|네)[,\s]+").sub("", text, count=1))
        if not value or rx(r"^(응|네|예|맞아|그래|좋아)$").search(value):
            return draft("BROWSING", "clarify", f"{speak_label(field_['label'])}에 넣을 값을 말씀해 주세요.")
        # 사용자가 이 칸에 넣을 값을 직접 말했으므로 그 말이 확인이다. 넣은 뒤 화면 값을 다시 읽어 확인한다(제출은 하지 않음).
        action = self.web.build_assist_action(field_, value)
        with ctx.granted([action["id"]]):
            out = await self.web.assist_fill([action], ctx)
            if out.status != "ok":
                self.dialogue.end_guided()
                return outcome_failure(out, "BROWSING")
            return await nxt(f"{speak_label(field_['label'])}에 '{value}' 넣었어요.")

    def wants_start(self, text: str) -> bool:
        """'하나씩 채워줘'처럼 칸 채우기를 시작하라는 말이고 지금 외부(실제) 사이트에 있는가"""
        current = self.web.current_view
        return bool(
            rx(r"(하나씩|차례로|순서대로|전부|다)\s*(채워|입력|써)|입력\s*(칸|란)\s*(을|를)?\s*(채워|입력해)").search(text)
            and current
            and current.get("pageId") == "external"
        )

    async def start(self, ctx: ExecContext) -> dict:
        """지금 페이지에서 채울 수 있는 칸(비밀·검색·동의 칸 제외)을 모아 하나씩 묻기 시작"""
        view = await self.web.observe(ctx)
        secret = rx(r"(비밀\s*번호|password|인증\s*번호|otp|주민|계좌|카드|동의|약관)", I)
        fields = [
            f
            for f in view["fields"]
            if f.get("visible")
            and not f.get("sensitive")
            and not f.get("searchable")
            and f["type"] not in ("checkbox", "password")
            and not secret.search(f["label"])
        ]
        if not fields:
            return draft(self.dialogue.state, "none", "이 화면에는 제가 채울 수 있는 입력 칸이 없어요. 로그인이나 인증 칸은 직접 입력해 주세요.", view=view)
        self.dialogue.start_guided(view["url"], [f["fieldId"] for f in fields])
        return draft("BROWSING", "fill", f"입력 칸이 {len(fields)}개 있어요. 하나씩 여쭤볼게요. {self._question(view)}", view=view)

    def _question(self, view: dict) -> str:
        g = self.dialogue.guided
        assert g is not None
        field_ = next((f for f in view["fields"] if f["fieldId"] == g["fieldIds"][g["index"]]), None)
        if not field_:
            return ""
        saved = self._saved_value(field_["label"])
        g["suggestion"] = saved
        label = speak_label(field_["label"])
        first = self.narrator.once("guided", " 건너뛰려면 '건너뛰기', 그만하려면 '그만'.")
        if saved:
            quoted = josa(f"'{saved}'", "을", "를")
            return f"{g['index'] + 1}번째, {label}. 저장된 {quoted} 넣을까요? 맞으면 '응', 다르면 넣을 값을 말씀하세요.{first}"
        return f"{g['index'] + 1}번째, {label}. 무엇을 넣을까요?{first}"
