"""Node·Python 서버가 함께 배포하는 음성 모델, 목소리, 말투와 속도."""
from importlib.resources import files
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field


class VoiceProfile(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", str_min_length=1)
    model: str
    voice: str
    instructions: str
    speed: float = Field(ge=0.25, le=4)
    normalRate: float = Field(ge=0.5, le=2)


def _read_profile() -> VoiceProfile:
    asset = files("cheongeum.core").joinpath("voice_profile.json")
    if not asset.is_file():  # 소스 체크아웃에서는 TS 모듈과 같은 파일을 읽는다.
        asset = Path(__file__).resolve().parents[2] / "core" / "voice_profile.json"
    return VoiceProfile.model_validate_json(asset.read_text(encoding="utf-8"))


VOICE_PROFILE = _read_profile()


def speech_pace(rate: object) -> float | None:
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or not 0.5 <= rate <= 2:
        return None
    return rate / VOICE_PROFILE.normalRate
