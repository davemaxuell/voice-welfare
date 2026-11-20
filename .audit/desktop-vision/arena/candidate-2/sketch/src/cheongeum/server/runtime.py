"""
[바뀌는 것만] server/runtime.py — 조립.
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal, Mapping

from cheongeum.core.desk import DesktopPort
from cheongeum.core.llm import LlmConfig


class RuntimeConfig:
    # ... 기존 칸(runtime.py:31-62)은 그대로 ...
    # 화면 사진 역할. LLM_VISION_PROVIDER|MODEL|API_KEY|REASONING_EFFORT(_llm_role, :96). 비면 llm을 따르되 OpenAI일 때만 켜진다.
    llmVision: LlmConfig | None = None
    # DESKTOP=auto|off. auto는 Windows에서만 켠다. 기본 auto(시험 런타임은 off).
    desktop: Literal["auto", "off"] = "auto"


class AgentRuntime:
    def __init__(
        self,
        config: RuntimeConfig,
        # 시험이 가짜를 꽂는 자리(없으면 config.desktop에 따라 실제 포트를 만든다). 장소의 실제 폴더도 함께.
        desktop_port: DesktopPort | None = None,
        place_roots: Mapping[str, Path] | None = None,
    ) -> None:
        """
        더해지는 줄:
          self.vision_llm = create_vision_llm(config.llmVision or config.llm)     # OpenAI가 아니면 None
          self._desktop = desktop_port or create_desktop_port(config.desktop)     # 프로세스에 하나(브라우저처럼)
          self._roots = place_roots or (known_folders() if self._desktop else {})
        """
        raise NotImplementedError

    def llm_roles(self) -> dict:
        """(:211) "vision": 사진 모델 이름 또는 "off". 시작 동의 안내가 이것을 읽어 '화면 사진은 OpenAI로 보냅니다'를 말한다."""
        raise NotImplementedError

    async def create_session(self):
        """
        (:250) 바뀌는 곳:
          PolicyConfig(..., allowedActionTypes=[..., "capture"], desktopApps=[a.id for a in APPS] if self._desktop else [])
          vault = lambda: [v for v in self._personal.vault().values() if isinstance(v, str) and v]
          web = WebExecutionAgent(adapter, guard, self.profile, action_log=self._action_log, known_private=vault)
          desk = DesktopAgent(self._desktop, guard, self._roots, action_log=self._action_log, known_private=vault) if self._desktop else None
          OrchestratorDeps(..., vision=self.vision_llm, desk=desk)
        PolicyGuard 객체는 세션에 하나다. 웹 에이전트와 데스크톱 에이전트가 같은 것을 쓴다.
        """
        raise NotImplementedError
