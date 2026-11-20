"""
[새 파일] 화면 그림 계약. 웹 어댑터와 데스크톱 포트가 만들고 vision이 쓴다(둘 다 core만 가져오면 된다).

불변식:
 - 그림 바이트는 MaskedShot으로만 다닌다. MaskedShot은 가리기가 끝났다는 MaskReport(complete=True) 없이는 만들어지지 않는다.
   가리기에 실패하면 만드는 쪽은 CaptureRefusal을 돌려준다(가리지 못한 그림은 보낼 길이 없다).
 - 좌표는 이 계약에 없다. 가릴 자리의 좌표는 찍는 코드 안에서만 쓰고 버린다.
 - 한 번에 창 하나(웹은 청음이 쓰는 탭의 보이는 부분, 데스크톱은 설명하는 창 하나)만 찍는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

Surface = Literal["web", "desktop"]
AuthKind = Literal["login", "verification", "other"]


@dataclass(frozen=True)
class ShotSubject:
    """
    찍기 전에 이미 아는 것(관찰에서 나온 사실). 찍을지 말지(safety/shot_policy.py)와 그림 답 검증의 근거.
    title·text·names는 화면에서 온 비신뢰 글이다. text는 원문(검증용), 모델에 보낼 때는 redact_text를 거친다.
    """

    surface: Surface
    # 말할 대상 이름(코드가 만든 것): "웹 페이지", "파일 탐색기 창", "카카오톡 창"
    label: str
    title: str
    # 관찰로 이미 읽은 글(웹: 제목·소제목·본문, 데스크톱: UIA 이름). 그림 답의 숫자를 이 글과 맞춘다.
    text: str
    # 누를 수 있는 것의 이름(웹: outline.items 이름 그대로). 그림 답이 말한 이름 중 여기 있는 것만 '누를 수 있다'고 말한다.
    names: tuple[str, ...]
    secret_inputs: bool
    captcha: bool
    auth: AuthKind
    # 데스크톱: 자격 증명·인증서·보안 모듈 창
    credential: bool = False
    # 데스크톱: 바탕화면·작업 표시줄(셸) 창
    shell: bool = False
    minimized: bool = False


@dataclass(frozen=True)
class MaskReport:
    """가린 자리 수(종류별)와 가리기를 끝까지 했는지. complete=False면 MaskedShot을 만들 수 없다."""

    inputs: int
    personal: int
    frames: int
    complete: bool

    @property
    def total(self) -> int:
        raise NotImplementedError


@dataclass(frozen=True)
class MaskedShot:
    """가린 뒤 찍은 PNG. 저장·기록하지 않고 모델 호출 한 번에만 쓴 뒤 버린다."""

    png: bytes
    width: int
    height: int
    report: MaskReport

    def __post_init__(self) -> None:
        """report.complete가 아니면 ValueError(가리지 못한 그림은 이 타입이 될 수 없다). 긴 변 2000px 이하."""
        raise NotImplementedError


@dataclass(frozen=True)
class CaptureRefusal:
    """찍지 않은 이유. speech는 코드가 만든 한국어 문장."""

    code: Literal["captcha", "auth", "secret-input", "credential-window", "shell", "minimized", "mask-failed", "capture-failed", "off"]
    speech: str


class ShotSource(Protocol):
    """
    찍을 대상 하나. WebExecutionAgent.shot_source(view)와 DesktopAgent.shot_source(view)가 만든다.
    부르는 곳은 vision.ScreenPicture.explain 하나뿐이다(정책 확인 → 찍기 순서를 그 안에서 지킨다).
    """

    async def subject(self) -> ShotSubject: ...

    async def capture(self) -> MaskedShot | CaptureRefusal: ...
