"""
화면 사진과 그것을 보는 모델의 경계. 사진에 대한 규칙은 이 파일 한 곳에서 시작한다.

 - MaskedShot은 마스킹을 마쳤다는 기록(MaskReport.complete)이 없으면 만들어지지 않는다.
   날것의 화면 사진은 사진을 찍는 어댑터(웹: browser/__init__.py, 앱: desktop/win32.py) 밖으로 나가지 않는다.
 - VisionModel은 MaskedShot만 받는다. 글만 보는 StructuredLlm(turn.py:373)과 일부러 다른 문이다.
   WEB 역할이 로컬 Ollama일 수 있고, 로컬 모델이든 OpenAI 호환 다른 곳이든 사진은 가지 않는다(주인 결정: 사진은 OpenAI로).
 - 사진 속 위치(좌표)는 가리는 데에만 쓴다. ActionTarget(actions.py:55)에는 좌표가 없고 앞으로도 없다.
   모델이 사진을 보고 낸 답은 이름(글자)일 뿐이며, 누르는 일은 언제나 이름으로 관찰 항목을 찾는 길(follow_link)로만 한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from cheongeum.core.actions import MediaHint  # 글로 읽히지 않는 것의 흔적(observe.js가 센 outline.media). 두 모양을 따로 두지 않는다.
from cheongeum.core.execctx import ExecContext
from cheongeum.core.jsutil import AbortSignal, rx
from cheongeum.core.llm import LlmConfig

Surface = Literal["web", "app"]

# 사용자가 '사진으로' 보기를 말로 청한 것. 규칙 파서(DESCRIBE_SCREEN)와 Sight.advise가 같은 목록을 쓴다(손으로 두 곳에 적지 않는다).
PICTURE_ASK = rx(r"(사진|그림|이미지|어떻게\s*생|생김새|모양|배치|차트|그래프|도표)")


# ---------------------------------------------------------------- 사진


@dataclass(frozen=True)
class MaskReport:
    """찍기 전에 한 가리기의 기록. 어댑터가 실제로 한 일만 적는다(계획이 아니라 결과)."""

    fields: int  # 가린 입력 칸 수(input·textarea·select·편집 가능 영역, 앱은 편집 상자)
    texts: int  # 민감한 줄을 찾아 덮은 수
    frames: int  # 안을 볼 수 없어 통째로 덮은 액자(iframe) 수
    overlay_hidden: bool  # 청음 자신의 화면 커서 표시를 가렸는가(cursor.js:18 #__cheongeum_cursor)
    unmatched: int  # 가려야 하는데 화면에서 찾지 못한 민감한 줄 수. 0이 아니면 사진을 쓰지 않는다.

    @property
    def complete(self) -> bool:
        return self.unmatched == 0 and self.overlay_hidden


@dataclass(frozen=True)
class ShotMeta:
    """사진에 붙는 꼬리표. 사용자 글·창 제목·파일 이름은 넣지 않는다(기록에 남을 수 있어서)."""

    surface: Surface
    subject: str  # 웹: 출처+경로, 앱: 앱 id
    width: int
    height: int
    taken_at: str


class MaskedShot:
    """
    마스킹을 마친 사진 한 장. 만드는 길은 하나다: complete인 MaskReport와 함께.
    PNG 바이트를 꺼내는 공개 속성은 없다. 읽는 곳은 이 모듈의 shot_data_url 하나이고,
    그것을 부르는 곳은 OpenAIVisionLlm뿐이다. 이 경계는 tests/unit/test_shot_boundary.py가 가져오기와 생성자 호출을 세어 지킨다.
    """

    __slots__ = ("_png", "meta", "report")

    def __init__(self, png: bytes, meta: ShotMeta, report: MaskReport) -> None:
        if not report.complete:
            raise ValueError("마스킹이 끝나지 않은 사진은 만들 수 없습니다.")
        self._png = png
        self.meta = meta
        self.report = report


def shot_data_url(shot: MaskedShot) -> str:
    """OpenAI 이미지 입력용 data URL. OpenAIVisionLlm만 부른다."""
    raise NotImplementedError


ShotRefusalReason = Literal[
    "login",  # 로그인 화면: 아이디·비밀번호 칸 주변은 사진 길에서 뺀다
    "verification",  # 본인인증 화면
    "captcha",  # 보안문자(글로 못 잡는 그림 포함): 읽지도 풀지도 않는다
    "blocked",  # 자동 접속 차단 안내(digest.BLOCKED)
    "unmaskable",  # 가려야 할 민감한 줄을 화면에서 찾지 못했다 → 가리지 못하니 찍지 않는다
    "no-tier",  # 가드가 이 화면에 사진을 허락하지 않았다(허용되지 않은 주소·앱)
    "stopped",
    "unavailable",  # 사진 보는 모델이 없다(LLM_VISION_* 미설정, 또는 OpenAI가 아님)
    "minimized",  # 앱 창이 최소화돼 있어 찍을 수 없다(창을 앞으로 가져오는 것은 따로 묻는다)
]


@dataclass(frozen=True)
class ShotRefusal:
    """사진을 찍지 않기로 한 이유. 말은 sight/policy.py의 refusal_speech가 코드로 만든다."""

    reason: ShotRefusalReason


class ShotSource(Protocol):
    """사진을 찍어 주는 쪽(웹 에이전트, 앱 에이전트). 가드·마스킹·기록을 모두 지난 사진만 돌려준다."""

    async def capture(self, ctx: ExecContext) -> MaskedShot | ShotRefusal: ...


# ---------------------------------------------------------------- 화면에 대해 이미 아는 것(사진 길과 글 길이 같이 쓴다)


@dataclass(frozen=True)
class ScreenFacts:
    """
    화면(웹 쪽이든 앱 창이든)에 대해 글로 이미 아는 것. 사진 길(Sight)은 웹과 앱을 모르고 이것만 본다.
    모두 비신뢰 데이터이며 모델에는 redact_text를 거쳐 가고, 검증(숫자·인용)에는 원문을 쓴다.
    """

    surface: Surface
    subject: str  # 말할 이름: 사이트 이름(site_label) 또는 앱 이름
    title: str
    kind: str  # digest.kind 또는 창 종류
    text: str  # 정리한 본문(검증 근거). 사진 속 숫자가 여기 없으면 '사진에서만 읽은 숫자'다.
    pressables: tuple[str, ...]  # 지금 이름으로 누를 수 있는 것들(관찰의 items 이름). 사진에서 누를 것을 고르는 유일한 기준.
    media: MediaHint | None
    blocked: Literal["login", "verification", "captcha", "blocked"] | None


# ---------------------------------------------------------------- 사진을 보는 모델


class VisionModel(Protocol):
    """MaskedShot을 받아 구조화된 답을 돌려준다. 실패하면 None(호출자가 글 설명으로 대신한다)."""

    name: str

    async def look(
        self, *, system: str, user: str, shot: MaskedShot, schemaName: str, schema: dict, signal: AbortSignal | None = None
    ) -> Any | None: ...


class OpenAIVisionLlm:
    """
    OpenAI Chat Completions + 이미지 입력(content 배열의 image_url data URL) + strict json_schema.
    요청 본문은 core/llm.py의 chat_request를 generate와 함께 쓴다(헤더·response_format·reasoning_effort를 두 곳에 적지 않는다).
    시간 한도는 글 호출(30초)보다 길게(기본 45초): 사진 올리기와 읽기가 걸린다. signal이 오면 바로 멈춘다(post_json이 race_abort).
    """

    def __init__(
        self, *, model: str, api_key: str, base_url: str, reasoning_effort: str | None = None, detail: Literal["low", "high", "auto"] = "auto", timeout_ms: int = 45_000
    ) -> None:
        self.model = model
        self.name = f"openai-vision({model})"
        raise NotImplementedError

    async def look(
        self, *, system: str, user: str, shot: MaskedShot, schemaName: str, schema: dict, signal: AbortSignal | None = None
    ) -> Any | None:
        # 1) content = [{"type":"text","text":user}, {"type":"image_url","image_url":{"url":shot_data_url(shot),"detail":self.detail}}]
        # 2) body = chat_request(model, system, content, schemaName, schema, reasoning_effort)
        # 3) post_json(.../chat/completions, headers, body, timeout, signal) → message_content → json.loads. 실패는 모두 None.
        raise NotImplementedError


OPENAI_ONLY = "openai"


def create_vision_llm(cfg: LlmConfig) -> OpenAIVisionLlm | None:
    """
    provider가 정확히 openai이고 모델·키가 있을 때만 만든다. 그 밖(mock·ollama·qwen·openai-compatible)은 None.
    None이면 사진 설명은 꺼진 것이고, 사용자가 사진을 청하면 '사진 설명이 켜져 있지 않아요'라고 말한다(조용히 로컬 모델로 보내지 않는다).
    base_url을 따로 줘도 OpenAI 주소가 아니면 None(주인 결정 2026-11-18: 사진은 OpenAI로).
    """
    raise NotImplementedError
