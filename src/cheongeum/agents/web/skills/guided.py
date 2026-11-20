"""④ Agent A 실제 사이트 칸 채우기: 지금 페이지의 입력 칸을 하나씩 묻고, 대답한 값을 넣은 뒤 다시 읽어 확인한다(제출은 사용자가 직접)."""
from __future__ import annotations

from typing import Callable

from cheongeum.agents.web.agent import ExecContext, WebExecutionAgent
from cheongeum.agents.web.approval import fingerprint
from cheongeum.agents.web.skills.common import outcome_failure
from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import I, rx, try_url
from cheongeum.core.turn import draft
from cheongeum.speech.phrasing import josa, speak_label
from cheongeum.speech.screen import Narrator
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, clean_value
from cheongeum.understanding.sites import site_label


class GuidedFill:
    def __init__(
        self,
        web: WebExecutionAgent,
        dialogue: DialogueState,
        narrator: Narrator,
        rules: RuleBasedIntentProvider,
        saved_value: Callable[[str], str | None],
        site_allowed: Callable[[str], bool] | None = None,
        allow_site: Callable[[str], None] | None = None,
    ) -> None:
        self.web = web
        self.dialogue = dialogue
        self.narrator = narrator
        # 대답이 칸 채우기와 상관없는 분명한 명령인지 가린다(오케스트레이터와 같은 규칙 파서)
        self._rules = rules
        # 입력 칸 이름에 맞는 개인 정보 금고 값(없으면 None)
        self._saved_value = saved_value
        # 출처(origin)마다 처음 한 번 금고 값 사용 허용을 묻는다
        self._site_allowed = site_allowed or (lambda _o: True)
        self._allow_site = allow_site or (lambda _o: None)

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

    def resume_after_auth(self, view: dict) -> str:
        """로그인·인증 뒤 같은 칸 채우기를 새 URL에 붙이고, 다음 질문을 돌려준다."""
        g = self.dialogue.guided
        if not g:
            return ""
        g["url"] = view["url"]
        visible = {f["fieldId"] for f in view.get("fields") or [] if f.get("visible")}
        kept = [fid for fid in g["fieldIds"] if fid in visible]
        if not kept:
            self.dialogue.end_guided()
            return "이 화면에는 이어서 채울 칸이 없어요. 필요하면 '칸 채워줘'라고 말씀해 주세요."
        g["fieldIds"] = kept
        g["index"] = min(g.get("index") or 0, len(kept) - 1)
        return self._question(view)

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

        # 이 사이트에 금고 값을 처음 쓸지 묻는 중
        if g.get("awaitSiteAllow"):
            yes = bool(rx(r"^(응|네|예|맞아|그래|좋아)").search(text))
            no = bool(rx(r"^(아니|아뇨|아니요|취소|됐어|하지\s*마)").search(text))
            origin = g.get("origin") or ""
            if yes and origin:
                self._allow_site(origin)
                g["awaitSiteAllow"] = False
                return draft("BROWSING", "fill", f"알겠어요. {self._question(view)}", view=view)
            if no:
                g["awaitSiteAllow"] = False
                g["suggestion"] = None
                g["skipVault"] = True
                return draft("BROWSING", "fill", f"이 사이트에는 저장된 값을 쓰지 않을게요. {self._question(view)}", view=view)
            site = site_label(view["url"]) or origin
            return draft("BROWSING", "clarify", f"{site}에 저장된 내 정보를 쓸까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.")

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
        # 승인 지문으로 _approve를 거친다(바로 넣지 않음)
        return self._ask_fill(field_, value, view)

    def _ask_fill(self, field_: dict, value: str, view: dict) -> dict:
        action = self.web.build_assist_action(field_, value)
        u = try_url(view["url"])
        site = site_label(view["url"]) or ((u.host if u else None) or view["url"])
        label = speak_label(field_["label"])
        speech = f"{site} {label} 칸에 '{value}' 넣을까요? 맞으면 '응', 아니면 '아니'라고 해 주세요."
        self.dialogue.ask_approval(
            {
                "kind": "assist",
                "url": view["url"],
                "guided": True,
                "action": action,
                "actions": [action],
                "confirmation": {
                    "actionId": action["id"],
                    "kind": "field-entry",
                    "description": speech,
                    "purpose": "실제 사이트 입력란 채우기(제출은 하지 않음)",
                    "site": site,
                    "values": [{"label": label, "value": value}],
                    "realSubmission": False,
                },
                "fingerprint": fingerprint(view, [action], speech),
            }
        )
        return draft("WAITING_FOR_USER_CONFIRMATION", "prepare-submit", speech, view=view)

    async def after_assist(self, filled: dict, ctx: ExecContext) -> dict:
        """승인 뒤 칸을 넣은 다음, 칸 채우기가 살아 있으면 다음 칸을 묻는다."""
        if not self.active():
            return filled
        g = self.dialogue.guided
        assert g is not None
        prefix = filled.get("speech") or "넣었어요."
        # assist_approved 안내를 짧게 줄이고 다음 칸으로
        g["index"] += 1
        now = await self.web.observe(ctx)
        if g["index"] >= len(g["fieldIds"]):
            self.dialogue.end_guided()
            return draft(
                "BROWSING",
                "fill",
                "넣고 확인했어요. 입력 칸을 모두 지나왔어요. 내용을 확인하신 뒤 제출이나 신청 버튼은 직접 눌러 주세요.",
                actions=filled.get("actions"),
                view=now,
            )
        return draft("BROWSING", "fill", f"넣고 확인했어요. {self._question(now)}", actions=filled.get("actions"), view=now)

    def wants_start(self, text: str) -> bool:
        """'하나씩 채워줘'처럼 칸 채우기를 시작하라는 말이고 지금 외부(실제) 사이트에 있는가"""
        current = self.web.current_view
        return bool(
            # "다 입력했어"(이미 직접 넣었다는 말)는 시작이 아니다
            rx(r"(하나씩|차례로|순서대로|전부|다)\s*(채워|입력|써)(?!했|었)|입력\s*(칸|란)\s*(을|를)?\s*(채워|입력해)").search(text)
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
        u = try_url(view["url"])
        origin = u.origin if u else view["url"]
        self.dialogue.start_guided(view["url"], [f["fieldId"] for f in fields])
        g = self.dialogue.guided
        assert g is not None
        g["origin"] = origin
        g["skipVault"] = False
        return draft("BROWSING", "fill", f"입력 칸이 {len(fields)}개 있어요. 하나씩 여쭤볼게요. {self._question(view)}", view=view)

    def _question(self, view: dict) -> str:
        g = self.dialogue.guided
        assert g is not None
        field_ = next((f for f in view["fields"] if f["fieldId"] == g["fieldIds"][g["index"]]), None)
        if not field_:
            return ""
        u = try_url(view["url"])
        origin = g.get("origin") or (u.origin if u else "")
        saved = None if g.get("skipVault") else self._saved_value(field_["label"])
        # 저장된 값을 쓰려면 이 출처에 대한 허용이 있어야 한다
        if saved and origin and not self._site_allowed(origin):
            g["suggestion"] = None
            g["awaitSiteAllow"] = True
            g["origin"] = origin
            site = site_label(view["url"]) or origin
            first = self.narrator.once("guided", " 건너뛰려면 '건너뛰기', 그만하려면 '그만'.")
            return f"{site}에 저장된 내 정보를 쓸까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.{first}"
        g["awaitSiteAllow"] = False
        g["suggestion"] = saved
        label = speak_label(field_["label"])
        first = self.narrator.once("guided", " 건너뛰려면 '건너뛰기', 그만하려면 '그만'.")
        if saved:
            quoted = josa(f"'{saved}'", "을", "를")
            return f"{g['index'] + 1}번째, {label}. 저장된 {quoted} 넣을까요? 맞으면 '응', 다르면 넣을 값을 말씀하세요.{first}"
        return f"{g['index'] + 1}번째, {label}. 무엇을 넣을까요?{first}"
