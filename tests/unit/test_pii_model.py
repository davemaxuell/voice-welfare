"""
실제 개인정보 인식 모델(koelectra ONNX) 확인. models/koelectra-ko-pii-ner가 있을 때만 돈다
(준비: uv run python scripts/setup_local_models.py --only pii).
"""
from pathlib import Path

import pytest

pytest.importorskip("onnxruntime")
pytest.importorskip("tokenizers")

from cheongeum.safety import detect_sensitive, redact_text, set_pii_model  # noqa: E402
from cheongeum.safety.pii_model import PiiModel  # noqa: E402

MODEL_DIR = Path(__file__).resolve().parents[2] / "models" / "koelectra-ko-pii-ner"
pytestmark = pytest.mark.skipif(not PiiModel.available(MODEL_DIR), reason="로컬 개인정보 인식 모델 없음(scripts/setup_local_models.py)")


@pytest.fixture(scope="module")
def model():
    m = PiiModel(MODEL_DIR)
    m.load()
    return m


@pytest.mark.parametrize("text", ["제 비밀번호는 A2UfgtKg!W1x 입니다", "주민번호 900101-1234567", "계좌번호 110-123-456789로 보내 주세요"])
def test_tier1_found(model, text):
    assert model.secret_spans(text), model.find(text)


@pytest.mark.parametrize("text", ["연락처는 010-1234-5678", "주소는 부산광역시 예시구 예시로 10", "이름은 김하늘", "장애인연금 신청 도와줘", "다음으로"])
def test_ordinary_form_values_not_tier1(model, text):
    # 신청서에 넣는 값(이름·주소·전화)은 2등급이라 막지 않는다
    assert model.secret_spans(text) == [], model.find(text)


def test_offsets_point_at_value(model):
    text = "주민번호는 900101-1234567 이에요"
    spans = model.secret_spans(text)
    assert any("1234567" in text[s:e] for _k, s, e in spans)


def test_wired_into_privacy(model):
    set_pii_model(model)
    try:
        d = detect_sensitive("제 비밀번호는 A2UfgtKg!W1x 입니다")
        assert d.hasSecretValue
        assert "A2UfgtKg" not in redact_text("제 비밀번호는 A2UfgtKg!W1x 입니다")
        assert detect_sensitive("이름은 김하늘").hasSecretValue is False
    finally:
        set_pii_model(None)
