"""
[새 파일] 폴더 읽기와 경로 만들기. 파일 시스템이 진실이고 탐색기 창은 그것을 보여 주는 화면이다.
청음은 탐색기 창의 목록을 읽지 않는다(가상화된 목록·최소화된 창에서는 일부만 보인다, probe-facts.md).
폴더는 여기서 직접 읽고, 창은 DesktopPort.show_folder로 같은 폴더를 보이게 할 뿐이다.

이 파일은 Windows 전용이 아니다(pathlib·os만 쓴다). 그래서 시험은 임시 폴더로 어느 OS에서나 돈다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Mapping

from cheongeum.core.desk import SafePath

# 한 번에 읽어 두는 항목 수(더 많으면 entryCount만 맞게 적고 최근 것부터 자른다)
MAX_ENTRIES = 200

# 장소 id → 실제 폴더. 실행 때 OS의 '알려진 폴더'에서 읽어 넘긴다(server/runtime). 시험은 임시 폴더를 넘긴다.
PlaceRoots = Mapping[str, Path]


class Escaped(Exception):
    """이름을 따라 내려갔더니 장소 밖이었다(바로 가기·연결 폴더). 열지 않는다."""


def safe_path(roots: PlaceRoots, at: dict, name: str | None = None) -> SafePath:
    """
    FolderRef(+ 그 안의 항목 이름) → 실제 경로. SafePath를 만드는 유일한 곳.

      1. roots[at["place"]]가 없으면 KeyError(그 장소는 이 컴퓨터에서 꺼져 있다)
      2. 뿌리에서 parts를 하나씩 내려간다. 단계마다 그 이름이 실제 디렉터리 목록에 있어야 한다(대소문자·정규화 차이는 목록의 이름으로 맞춘다)
      3. 끝까지 간 경로를 resolve()해서 뿌리의 resolve() 아래인지 확인한다. 아니면 Escaped.
         (연결 폴더·심볼릭 링크로 C:\\Windows나 다른 사용자 폴더로 새는 것을 막는다)
      4. name이 있으면 그 폴더의 목록에 있는 이름이어야 한다
    """
    raise NotImplementedError


def read_folder(roots: PlaceRoots, at: dict) -> tuple[list[dict], int]:
    """
    폴더 안 항목(core.desk.Entry 모양)과 전체 개수. 숨김·시스템 속성, 점으로 시작하는 이름, desktop.ini는 뺀다.
    순서: 폴더 먼저(이름순), 그다음 파일(고친 시각이 최근인 것부터). 사람이 "어제 받은 파일"을 먼저 듣게.
    읽을 수 없으면(권한) PermissionError를 그대로 올린다(DesktopAgent가 "이 폴더는 읽을 수 없어요"로 바꾼다).
    """
    raise NotImplementedError


def find_entry(entries: list[dict], said: str) -> tuple[dict | None, list[str]]:
    """
    말한 이름으로 항목 찾기(WebExecutionAgent._locate의 짝). (하나로 정해진 항목, 맞은 이름들)
    확장자를 빼고도 맞춘다("진단서" → "진단서.pdf"). 완전히 같은 것 → 앞부분이 같은 것 → 들어 있는 것 순서.
    둘 이상 맞으면 (None, 후보)로 돌려 되묻게 한다. 추측하지 않는다.
    """
    raise NotImplementedError
