"""[바뀌는 부분만] tests/unit/test_layers.py ALLOWED(test_layers.py:12-41)"""

ALLOWED_CHANGES = {
    # 새 단계
    "vision": {"core", "safety", "speech.phrasing"},
    "agents.desktop": {"core", "safety", "speech.phrasing", "understanding", "vision"},
    # 늘어나는 단계
    "agents.web.skills": {"agents.web", "core", "safety", "speech.phrasing", "speech.screen", "understanding", "vision"},
    "orchestrator": {
        "agents.desktop",  # 새
        "agents.web",
        "agents.web.skills",
        "agents.welfare",
        "core",
        "language",
        "personal",
        "safety",
        "speech.phrasing",
        "speech.screen",
        "understanding",
        "vision",  # 새
    },
    "server": {"agents.desktop", "agents.web", "agents.welfare", "core", "orchestrator", "personal", "practice_site", "safety", "understanding", "voice", "vision"},
}
# agents.web은 그대로 {"core", "safety", "speech.phrasing"}: 웹 그림의 계약(core/shot.py)은 core에 있어 vision을 가져오지 않는다.
# agents.desktop은 agents.web을 가져오지 않는다(ExecContext·read_document는 U0에서 core로 옮김).
