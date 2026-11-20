"""
[새 파일] 등록된 앱의 실행 프로필(사이트의 SiteProfile 짝). 이름(말)은 understanding/apps.py, 이 표는 실행·인식·허용.
앱은 창 제목이 아니라 '실행 파일 이름 + 창 종류'로 알아본다. 실행은 시스템 폴더 기준 절대 경로와 고정 인자로만.
이 표에서 DesktopPolicy(가드 설정)를 만든다(등급·허용 동작을 따로 적지 않는다).
"""
from __future__ import annotations

from dataclasses import dataclass

from cheongeum.core.desktop import APP_IDS, PLACE_IDS, AppId, AppTier, DesktopVerb, PlaceId
from cheongeum.safety.desktop_guard import DesktopPolicy


@dataclass(frozen=True)
class WindowMatch:
    process: str
    classes: tuple[str, ...]


@dataclass(frozen=True)
class LaunchSpec:
    # %SystemRoot% 기준 상대 경로(예: "explorer.exe", "System32\\notepad.exe"). PATH 검색을 하지 않는다.
    system_exe: str
    args: tuple[str, ...] = ()


@dataclass(frozen=True)
class AppSpec:
    id: AppId
    label: str
    match: WindowMatch
    launch: LaunchSpec
    tier: AppTier
    verbs: frozenset[DesktopVerb]
    # 설명 방식: explorer = 파일 시스템 + 셸 API로 코드가 말을 짬, uia = UIA 이름
    describer: str


REGISTRY: dict[AppId, AppSpec] = {
    "explorer": AppSpec(
        id="explorer",
        label="파일 탐색기",
        match=WindowMatch(process="explorer.exe", classes=("CabinetWClass",)),
        launch=LaunchSpec(system_exe="explorer.exe"),
        tier="control",
        verbs=frozenset({"launch_app", "show_folder", "select_item", "open_file", "read_file", "focus_window"}),
        describer="explorer",
    ),
}

assert set(REGISTRY) == set(APP_IDS), "agents/desktop/registry.py REGISTRY가 core.desktop.AppId와 다릅니다"


def app_of(window_process: str, window_class: str) -> AppId | None:
    """창 → 등록된 앱(실행 파일·창 종류가 모두 맞을 때만)."""
    raise NotImplementedError


def policy(places: tuple[PlaceId, ...] = PLACE_IDS, max_actions: int = 12) -> DesktopPolicy:
    """REGISTRY에서 가드 설정을 만든다(tiers·verbs는 표에서 그대로)."""
    raise NotImplementedError
