"""
server/runtime.py: 바뀌는 곳만. 조립은 한 곳(AgentRuntime.create_session, runtime.py:250)이고, 새 설정은 .env에서만 온다(모델 ID를 코드에 두지 않는다).

새 환경 변수(없으면 꺼짐/기존 동작):
  LLM_VISION_PROVIDER|MODEL|BASE_URL|API_KEY|REASONING_EFFORT   사진 보는 모델. _llm_role(runtime.py:96)이 읽는다. provider가 openai가 아니면 사진 설명은 꺼진다.
  DESKTOP_APPS=true|false                                       앱 조작. --desktop(Electron) 뒤쪽 프로세스에서는 기본 true, 그 밖(웹 서버)은 기본 false.
                                                                서버는 localhost에서만 듣지만(__main__.py:55 --host localhost) 컴퓨터를 만지는 기능은 명시적으로 켠 곳에서만 쓴다.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass

from cheongeum.core.llm import LlmConfig


@dataclass
class _RuntimeConfigChanges:
    """RuntimeConfig(runtime.py:31)에 칸 둘."""

    llmVision: LlmConfig | None = None  # runtime.py:60-62 옆. load_config(:109)가 _llm_role(env, "VISION", llm)로 채운다.
    desktopApps: bool = False


class _AgentRuntimeChanges:
    def __init__(self_) -> None:  # noqa: N805
        # __init__(runtime.py:191) 끝에서 한 번(프로세스당):
        #   self.vision_llm = create_vision_llm(config.llmVision or config.llm)     # None이면 사진 꺼짐
        #   self.desktop_port = Win32Port() if (config.desktopApps and sys.platform == "win32") else None
        pass

    async def create_session(self_) -> None:  # noqa: N805
        # create_session(runtime.py:250-308) 안에서:
        #
        # 1) PolicyConfig(runtime.py:262-271)에 두 칸 더:
        #      apps={a.id: AppRule(a.tier, a.verbs) for a in APPS}                  # 앱 표에서 만든다. 손으로 따로 적지 않는다.
        #      roots=[p for p in resolved_places.values()]                          # 알려진 폴더의 실제 경로(세션 시작 때 port.resolve_place로 푼다)
        #    allowedActionTypes(runtime.py:264) 목록에 "capture"를 더한다(웹 동작 한 가지).
        #
        # 2) 사진: OrchestratorDeps(..., vision=self.vision_llm)
        #
        # 3) 앱 에이전트: desktop_port가 있으면
        #      adapter = AppAdapter(port, roots)
        #      desktop = DesktopAgent(adapter, guard, action_log=self._action_log)   # 웹과 같은 guard, 같은 action_log
        #    OrchestratorDeps(..., desktop=desktop). 없으면 desktop=None(AppSkill이 '이 컴퓨터에서는 앱을 쓸 수 없어요'라고 답한다).
        #
        # 시험의 create_test_runtime(tests/conftest.py:29)은 DESKTOP_APPS를 켜지 않는다. 앱 시험은 FakeDesktopPort를 직접 꽂는다(tests/fakes/desktop_port.py).
        pass
