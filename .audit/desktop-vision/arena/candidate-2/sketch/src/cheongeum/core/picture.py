"""
[새 파일] 화면 사진 계약: 가린 뒤에만 존재하는 사진(Picture), 무엇을 가릴지(MaskPlan), 찍지 않은 까닭(Refused),
사진을 받는 모델 경계(VisionLlm).

불변식
 - Picture는 가림이 끝난 바이트만 담는다. 만드는 길은 Picture.masked 하나이고, 부르는 곳은 두 어댑터의 capture뿐이다
   (tests/unit/test_picture_sources.py가 AST로 고정한다).
 - VisionLlm.see는 Picture만 받는다. 바이트·파일 경로·주소를 받는 길은 없다.
 - 좌표는 이 파일 어디에도 없다. 가릴 자리는 이름표(fieldId·요소 ref)와 글로만 가리키고, 사각형은 어댑터 안에서만 생겼다 사라진다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from cheongeum.core.jsutil import AbortSignal

# 사진이 찍힌 곳. core.actions.Platform("pc" = 브라우저 화면)에 "desktop"(앱 창)이 더해진다.
Surface = Literal["pc", "desktop"]

# 찍지 않은 까닭(말은 Refused.speech에, 코드는 이 값으로 갈래를 탄다)
RefusalWhy = Literal[
    "off",  # 사진 기능이 꺼져 있음(OpenAI 설정 없음)
    "auth",  # 로그인·본인인증 화면
    "blocked",  # 접속 차단·보안문자(CAPTCHA)
    "private",  # 가려야 할 글을 화면에서 찾지 못함(가리지 못하면 찍지 않는다)
    "policy",  # PolicyGuard가 막음(허용되지 않은 주소·앱)
    "failed",  # 찍기 실패(창이 닫힘, 시간 초과)
]


@dataclass(frozen=True)
class MaskPlan:
    """
    찍기 전에 가릴 것. 화면 관찰에서 순수 함수로 만든다(웹: agents/web/shot.mask_plan, 앱 창: agents/desktop/shot.mask_plan).
    anchors = 통째로 가릴 요소의 이름표(웹은 fieldId, 앱 창은 요소 ref). private = 가릴 글(그 글이 든 요소를 통째로 가린다).
    """

    anchors: tuple[str, ...]
    private: tuple[str, ...]
    # 다른 문서가 들어 있는 틀(iframe·웹뷰)은 속을 볼 수 없으니 통째로 가린다
    frames: bool = True


@dataclass(frozen=True)
class MaskReport:
    """어댑터가 실제로 가린 결과. 말할 때("입력 칸 3곳은 가리고 보냈어요")와 시험에 쓴다."""

    hidden: int
    kinds: tuple[str, ...]  # "field" | "frame" | "private-text"


@dataclass(frozen=True)
class Picture:
    """가림이 끝난 창 하나의 사진(PNG). 전체 바탕 화면은 담을 수 없다: 어댑터의 capture가 창·탭 하나만 찍는다."""

    png: bytes
    width: int
    height: int
    surface: Surface
    mask: MaskReport

    @classmethod
    def masked(cls, png: bytes, *, width: int, height: int, surface: Surface, mask: MaskReport) -> "Picture":
        """유일한 생성 길. 부르는 곳: PlaywrightExecutionAdapter.capture, WindowsDesktop.capture(와 시험용 가짜)."""
        raise NotImplementedError

    def data_url(self) -> str:
        """data:image/png;base64,... (core.llm.OpenAIVisionLlm만 부른다)"""
        raise NotImplementedError


@dataclass(frozen=True)
class Refused:
    why: RefusalWhy
    # 코드가 만든 한국어 한 문장. 예: "로그인 화면은 사진으로 보내지 않아요."
    speech: str


Shot = Picture | Refused


class VisionLlm(Protocol):
    """
    사진 한 장 + 글 → 구조화 출력. StructuredLlm.generate와 이름·인자가 달라 서로 바꿔 끼울 수 없다
    (글 전용 로컬 모델에 사진이 가거나, 사진 모델이 다른 역할을 대신하는 일을 타입에서 막는다).
    실패하면 None(부르는 쪽이 글 설명으로 대신한다).
    """

    name: str

    async def see(
        self, *, system: str, user: str, picture: Picture, schemaName: str, schema: dict, signal: AbortSignal | None = None
    ) -> Any | None: ...
