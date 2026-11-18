"""
로컬 한국어 개인정보 인식 모델(atonlee/koelectra-ko-pii-ner, ONNX int8 약 15MB). 이 컴퓨터 안에서만 돈다.
여기서는 1등급(말하면 안 되는 값: 비밀번호·주민번호·계좌·카드·신분증 번호)만 비밀로 쓴다.
규칙(privacy.py)과 함께 쓰며, 둘 중 하나라도 걸리면 민감으로 본다.
"""
from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("cheongeum.privacy")

# 모델 라벨 → privacy.SENSITIVE_LABELS_KO의 종류. 여기 없는 라벨(이름·전화·주소 등 2등급, 장소·날짜 등)은 막지 않는다.
TIER1_KIND = {
    "SECRET": "password",
    "RRN": "rrn",
    "ALIEN_ID": "rrn",
    "ACCOUNT_NUMBER": "account",
    "CARD_NUMBER": "card",
    "CARD_EXPIRY": "card",
    "CVC": "card",
    "PASSPORT": "idnum",
    "DRIVER_LICENSE": "idnum",
    "IPIN": "idnum",
}

ONNX_FILES = ("model_int8.onnx", "model_quantized.onnx", "model.onnx")
# 한 번에 보는 글 길이(글자). 토큰 한도(512)를 넘지 않도록 넉넉히 자른다.
WINDOW_CHARS = 200


@dataclass(frozen=True)
class PiiSpan:
    label: str
    start: int
    end: int
    score: float


def merge_bio(tags: list[tuple[str, float, int, int]]) -> list[PiiSpan]:
    """
    토큰별 (BIO 태그, 확률, 시작, 끝) → 개체 구간. 이어지는 같은 라벨의 I-는 붙이고, B-는 새 개체를 시작한다.
    I-로 시작해도 새 개체로 본다(이 모델은 전화번호를 I-PHONE 조각들로 내기도 한다). 점수는 토큰 확률의 평균.
    """
    spans: list[PiiSpan] = []
    cur: list | None = None  # [label, start, end, probs]
    for tag, prob, start, end in tags:
        if tag == "O" or "-" not in tag:
            if cur:
                spans.append(_close(cur))
            cur = None
            continue
        prefix, label = tag.split("-", 1)
        if cur and cur[0] == label and prefix == "I":
            cur[2] = end
            cur[3].append(prob)
            continue
        if cur:
            spans.append(_close(cur))
        cur = [label, start, end, [prob]]
    if cur:
        spans.append(_close(cur))
    return spans


def _close(cur: list) -> PiiSpan:
    label, start, end, probs = cur
    return PiiSpan(label, start, end, sum(probs) / len(probs))


def _windows(text: str, size: int = WINDOW_CHARS) -> list[tuple[int, str]]:
    """(시작 위치, 조각). 가능하면 공백에서 자른다."""
    out: list[tuple[int, str]] = []
    i = 0
    while i < len(text):
        j = min(len(text), i + size)
        if j < len(text):
            k = text.rfind(" ", i + size // 2, j)
            j = k if k > i else j
        out.append((i, text[i:j]))
        i = j
    return out


class PiiModel:
    """onnxruntime + tokenizers. 처음 쓸 때 불러온다(load()로 미리 불러올 수 있다)."""

    def __init__(self, model_dir: str | Path, threshold: float = 0.5) -> None:
        self.dir = Path(model_dir)
        self.threshold = threshold
        self._lock = threading.Lock()
        self._session = None
        self._tokenizer = None
        self._labels: dict[int, str] = {}
        self._input_names: set[str] = set()

    @staticmethod
    def available(model_dir: str | Path) -> bool:
        d = Path(model_dir)
        return (d / "tokenizer.json").is_file() and (d / "config.json").is_file() and any((d / f).is_file() for f in ONNX_FILES)

    def load(self) -> None:
        with self._lock:
            if self._session is not None:
                return
            import onnxruntime as ort
            from tokenizers import Tokenizer

            onnx = next(self.dir / f for f in ONNX_FILES if (self.dir / f).is_file())
            options = ort.SessionOptions()
            options.log_severity_level = 3
            session = ort.InferenceSession(str(onnx), sess_options=options, providers=["CPUExecutionProvider"])
            tokenizer = Tokenizer.from_file(str(self.dir / "tokenizer.json"))
            tokenizer.no_padding()
            tokenizer.enable_truncation(max_length=512)
            config = json.loads((self.dir / "config.json").read_text(encoding="utf-8"))
            self._labels = {int(k): v for k, v in config["id2label"].items()}
            self._input_names = {i.name for i in session.get_inputs()}
            self._tokenizer = tokenizer
            self._session = session
            log.info("[privacy] 개인정보 인식 모델 준비: %s", onnx.name)

    def find(self, text: str) -> list[PiiSpan]:
        """모든 개체(2등급 포함). 위치는 text 기준."""
        import numpy as np

        self.load()
        spans: list[PiiSpan] = []
        for base, chunk in _windows(text):
            enc = self._tokenizer.encode(chunk)  # type: ignore[union-attr]
            if not enc.ids:
                continue
            feeds = {"input_ids": np.array([enc.ids], dtype=np.int64)}
            if "attention_mask" in self._input_names:
                feeds["attention_mask"] = np.array([enc.attention_mask], dtype=np.int64)
            if "token_type_ids" in self._input_names:
                feeds["token_type_ids"] = np.array([enc.type_ids], dtype=np.int64)
            logits = self._session.run(None, feeds)[0][0]  # type: ignore[union-attr]
            z = logits - logits.max(axis=-1, keepdims=True)
            probs = np.exp(z) / np.exp(z).sum(axis=-1, keepdims=True)
            tags = [
                (self._labels.get(int(probs[i].argmax()), "O"), float(probs[i].max()), base + s, base + e)
                for i, ((s, e), special) in enumerate(zip(enc.offsets, enc.special_tokens_mask))
                if not special and e > s
            ]
            spans += merge_bio(tags)
        return [s for s in spans if s.score >= self.threshold]

    def secret_spans(self, text: str) -> list[tuple[str, int, int]]:
        """privacy.SecretFinder: 1등급만 (종류, 시작, 끝)"""
        return [(TIER1_KIND[s.label], s.start, s.end) for s in self.find(text) if s.label in TIER1_KIND]
