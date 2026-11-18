"""한국어 개인정보 토큰화와 CPU 추론. JSON 한 줄은 입력 문장 한 묶음이다.

문장마다 창별 BIO 태그, 확률과 원문의 코드 포인트 위치를 돌려준다.
추론하지 못한 문장은 null이다. 등급과 임계값은 TypeScript에서 적용한다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


def windows(text: str):
    size = 200
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        if end < len(text):
            space = text.rfind(" ", start + size // 2, end)
            if space > start:
                end = space
        yield start, text[start:end]
        start = end


class PiiModel:
    def __init__(self, directory: Path):
        model = next(directory / name for name in ("model_int8.onnx", "model_quantized.onnx", "model.onnx")
                     if (directory / name).is_file())
        options = ort.SessionOptions()
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.no_padding()
        self.tokenizer.enable_truncation(max_length=512)
        config = json.loads((directory / "config.json").read_text(encoding="utf-8"))
        self.labels = {int(i): label for i, label in config["id2label"].items()}

    def tags(self, text: str) -> list:
        batches = []
        for base, chunk in windows(text):
            encoded = self.tokenizer.encode(chunk)
            if not encoded.ids:
                continue
            feeds = {"input_ids": np.array([encoded.ids], dtype=np.int64)}
            if "attention_mask" in self.inputs:
                feeds["attention_mask"] = np.array([encoded.attention_mask], dtype=np.int64)
            if "token_type_ids" in self.inputs:
                feeds["token_type_ids"] = np.array([encoded.type_ids], dtype=np.int64)
            logits = self.session.run(None, feeds)[0][0]
            exponentials = np.exp(logits - logits.max(axis=-1, keepdims=True))
            probs = exponentials / exponentials.sum(axis=-1, keepdims=True)
            batches.append([
                [self.labels.get(int(probs[i].argmax()), "O"), float(probs[i].max()), base + start, base + end]
                for i, ((start, end), special) in enumerate(zip(encoded.offsets, encoded.special_tokens_mask))
                if not special and end > start
            ])
        return batches


def main():
    model = PiiModel(Path(sys.argv[1]))
    for line in sys.stdin.buffer:
        result = []
        for text in json.loads(line):
            try:
                result.append(model.tags(text))
            except Exception as exc:
                # 오류 메시지에도 입력값이 섞일 수 있어 예외 이름만 기록한다.
                print(f"PII inference failed ({type(exc).__name__})", file=sys.stderr, flush=True)
                result.append(None)
        print(json.dumps(result, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
