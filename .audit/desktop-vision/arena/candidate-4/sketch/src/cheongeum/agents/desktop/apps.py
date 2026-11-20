"""앱 표. `understanding/sites.py`의 KNOWN_SITES와 같은 자리다. 이름 → 고정된 앱 항목.

앱의 등급(tier)과 실행 인자는 여기서만 정한다. 모델이나 화면 글은 이 표를 바꿀 수 없다.
타입 AppEntry는 core/desktop.py에 있다.
"""

from __future__ import annotations

from cheongeum.core.desktop import AppEntry

APPS: tuple[AppEntry, ...] = (
    AppEntry("explorer", ("파일 탐색기", "탐색기", "explorer"), "explorer.exe", "CabinetWClass", ("explorer.exe",), "act", True),
    # 메모장·계산기·그림판·한글은 PLAN U8 전에 실제 실행 경로를 확인한다(APPS.md 참조).
)


def resolve_app(spoken: str, extra: tuple[AppEntry, ...] = ()) -> AppEntry | None:
    """말한 이름을 앱 하나로 바꾼다. 여러 개 맞으면 None(되묻기). 모르면 None(추측하지 않는다)."""
    raise NotImplementedError
