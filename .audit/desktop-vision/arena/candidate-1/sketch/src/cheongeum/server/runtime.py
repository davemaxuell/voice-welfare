"""
[바뀌는 부분만] server/runtime.py

설정(.env):
  DESKTOP_APPS=true|false  데스크톱 앱·파일 기능. 기본: --desktop(Electron 셸)이면 true, 아니면 false. 윈도가 아니면 언제나 꺼짐.
  VISION=auto|on-demand|off  그림 설명. 기본 auto(요청할 때 + 글이 적은 화면을 설명할 때).
  LLM_VISION_PROVIDER|MODEL|BASE_URL|API_KEY|REASONING_EFFORT  그림 설명 역할(_llm_role). OpenAI만 만든다(주인 결정 2026-11-18).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass
class RuntimeConfig:
    # ... 지금 칸 그대로(runtime.py:31-62) ...
    desktopApps: bool = False
    vision: Literal["auto", "on-demand", "off"] = "auto"
    llmVision: "LlmConfig | None" = None  # noqa: F821


class AgentRuntime:
    def __init__(self, config: RuntimeConfig, desktop_port=None) -> None:
        """
        지금 생성자에 더한다:
            self.vision_llm = None if config.vision == "off" else create_vision_llm(config.llmVision or config.llm)
            # 포트는 프로세스에 하나(COM 스레드 하나). 시험은 desktop_port=FakeDesktop(...)을 넘긴다.
            self.desktop_port = desktop_port if desktop_port is not None else create_desktop_port(config.desktopApps)
        """
        raise NotImplementedError

    async def create_session(self):
        """
        지금 조립에 더한다(세션마다):
            desktop = DesktopAgent(self.desktop_port, DesktopGuard(policy()), action_log=self._action_log) if self.desktop_port else None
            OrchestratorDeps(..., desktop=desktop, vision_llm=self.vision_llm, vision_mode=self.config.vision)
        """
        raise NotImplementedError

    def llm_roles(self) -> dict:
        """지금 역할에 'vision'을 더한다(동의 안내·/api/health가 그림을 어디로 보내는지 말할 수 있게)."""
        raise NotImplementedError
