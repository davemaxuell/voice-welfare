"""
tests/unit/test_layers.py: 바뀌는 곳만. ALLOWED(test_layers.py:12-41)에 새 단계와 새 방향.
layer()(test_layers.py:44-53)는 그대로다: cheongeum/sight/*.py → "sight", cheongeum/agents/desktop/*.py → "agents.desktop"(agents/web/skills만 따로 센다),
cheongeum/speech/apps.py → "speech.phrasing"(speech/screen.py만 "speech.screen").
"""

ALLOWED_CHANGES = {
    # 신규
    "sight": {"core", "safety", "speech.phrasing"},
    "agents.desktop": {"core", "safety", "speech.phrasing", "sight"},
    # 바뀜(기존 줄에 한 이름씩 더)
    "agents.web.skills": {"agents.web", "core", "safety", "speech.phrasing", "speech.screen", "understanding", "sight"},
    "orchestrator": {
        "agents.web",
        "agents.web.skills",
        "agents.welfare",
        "agents.desktop",
        "core",
        "language",
        "personal",
        "safety",
        "sight",
        "speech.phrasing",
        "speech.screen",
        "understanding",
    },
    "server": {"agents.web", "agents.desktop", "agents.welfare", "core", "orchestrator", "personal", "practice_site", "safety", "sight", "understanding", "voice"},
}
# 바뀌지 않는 것이 규칙을 말한다:
#   core는 아무것도 가져오지 않는다(core/vision.py·apps.py·desktop.py·execctx.py가 safety·agents를 가져오지 않는다).
#   safety는 core만(executor.py·guard.py가 agents를 가져오지 않는다). 앱 표(core/apps.py)와 앱 계약(core/desktop.py)이 core에 있는 이유다.
#   agents.web과 agents.desktop은 서로를 가져오지 않는다. 둘이 같이 쓰는 것(ExecContext, OutcomeStatus, GuardedExecutor, MaskedShot)은 모두 그 아래 단계에 있다.
#   understanding은 core만: 앱 이름을 알아듣는 표(core/apps.py)가 core에 있어서 가능하다.

# 새로 지키는 경계 시험(구현 때):
#   test_shot_boundary.py     MaskedShot(...) 호출은 agents/web/browser/__init__.py, agents/desktop/win32.py 둘뿐. shot_data_url은 core/vision.py 안에서만.
#   test_desktop_boundary.py  os.startfile·subprocess·ctypes·comtypes·uiautomation 가져오기는 agents/desktop/win32.py 하나뿐(agents/web/browser의 playwright 하위 프로세스는 제외).
#   test_approvals_table.py   ask_approval에 쓰는 kind 값이 모두 APPROVALS 표에 있다.
#   test_apps_registry.py     AppSpec.names 중복 없음, verbs ⊂ AppVerb, tier != "none"이면 launch 있음, argv에 '{start}' 말고 자리 표시 없음, 표의 id가 AppAction.app 검증과 같음.
