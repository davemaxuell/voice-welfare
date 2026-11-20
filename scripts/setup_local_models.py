"""
로컬 모델 준비(한 번, 인터넷 필요): models/ 아래에 받아 두면 이후에는 인터넷 없이 돈다.
  - 받아쓰기: seastar105/whisper-small-komixv2 → CTranslate2 int8(약 250MB) → models/whisper-small-komixv2-ct2
    변환에만 transformers·torch가 필요해 임시 환경(uv run --no-project)에서 돌린다(프로젝트 의존성에는 넣지 않음).
  - 개인정보 인식: atonlee/koelectra-ko-pii-ner ONNX int8(약 15MB) → models/koelectra-ko-pii-ner

사용법: uv run python scripts/setup_local_models.py [--only stt|pii] [--keep-download]
"""
from __future__ import annotations

import argparse
import importlib.metadata
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"
DOWNLOADS = MODELS / ".download"

# 받는 판을 고정한다(모델이 바뀌어도 결과가 같게). 바꿀 때는 평가(scripts/eval_stt.py)를 다시 돌린다.
STT_REPO = "seastar105/whisper-small-komixv2"
STT_REVISION = "bb0a94da846d5d1b7001bb90810dea630a333084"
STT_FILES = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "model.safetensors",
    "vocab.json",
    "merges.txt",
    "added_tokens.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
    "normalizer.json",
]
STT_OUT = MODELS / "whisper-small-komixv2-ct2"

PII_REPO = "atonlee/koelectra-ko-pii-ner"
PII_REVISION = "1e75c01e707232401883cf364151bbe2e560c708"
PII_FILES = {"onnx/model_int8.onnx": "model_int8.onnx", "tokenizer.json": "tokenizer.json", "config.json": "config.json", "README.md": "README.md"}
PII_OUT = MODELS / "koelectra-ko-pii-ner"


def download(repo: str, revision: str, files: list[str], dest: Path) -> Path:
    from huggingface_hub import snapshot_download

    print(f"내려받는 중: {repo}@{revision[:8]} ({len(files)}개 파일)")
    return Path(snapshot_download(repo_id=repo, revision=revision, allow_patterns=files, local_dir=str(dest)))


def setup_stt(keep_download: bool) -> bool:
    from cheongeum.voice import LocalWhisperStt

    if LocalWhisperStt.available(STT_OUT):
        print(f"✓ 받아쓰기 모델이 이미 있습니다: {STT_OUT.relative_to(ROOT)}")
        return True
    src = download(STT_REPO, STT_REVISION, STT_FILES, DOWNLOADS / "whisper-small-komixv2")
    # 실행할 때와 같은 CTranslate2 판으로 변환해야 모델 형식이 맞는다
    ct2 = importlib.metadata.version("ctranslate2")
    uv = shutil.which("uv")
    if not uv:
        print("✗ uv를 찾을 수 없습니다. https://docs.astral.sh/uv/ 에서 설치하세요.", file=sys.stderr)
        return False
    print(f"변환 중(CTranslate2 {ct2}, int8). 처음에는 transformers·torch를 임시로 받느라 몇 분 걸립니다…")
    cmd = [
        uv, "run", "--no-project",
        "--with", f"ctranslate2=={ct2}", "--with", "transformers", "--with", "torch",
        "python", str(ROOT / "scripts" / "convert_whisper_ct2.py"), str(src), str(STT_OUT),
    ]  # fmt: skip
    if subprocess.run(cmd, cwd=str(ROOT)).returncode != 0 or not LocalWhisperStt.available(STT_OUT):
        print("✗ 받아쓰기 모델 변환에 실패했습니다.", file=sys.stderr)
        return False
    if not keep_download:
        shutil.rmtree(src, ignore_errors=True)
    print(f"✓ 받아쓰기 모델 준비: {STT_OUT.relative_to(ROOT)}")
    return True


def setup_pii() -> bool:
    from cheongeum.safety.pii_model import PiiModel

    if PiiModel.available(PII_OUT):
        print(f"✓ 개인정보 인식 모델이 이미 있습니다: {PII_OUT.relative_to(ROOT)}")
        return True
    src = download(PII_REPO, PII_REVISION, list(PII_FILES), DOWNLOADS / "koelectra-ko-pii-ner")
    PII_OUT.mkdir(parents=True, exist_ok=True)
    for name, target in PII_FILES.items():
        shutil.copy(src / name, PII_OUT / target)
    shutil.rmtree(src, ignore_errors=True)
    model = PiiModel(PII_OUT)
    model.load()
    print(f"✓ 개인정보 인식 모델 준비: {PII_OUT.relative_to(ROOT)}")
    return True


def write_notes() -> None:
    (MODELS / "MODELS.md").write_text(
        "\n".join(
            [
                "# 로컬 모델 (scripts/setup_local_models.py가 만든 폴더, git에 넣지 않음)",
                "",
                "| 폴더 | 원본 | 판(commit) | 라이선스·비고 |",
                "| --- | --- | --- | --- |",
                f"| whisper-small-komixv2-ct2 | [{STT_REPO}](https://huggingface.co/{STT_REPO}) → CTranslate2 int8 | `{STT_REVISION}` | 프로젝트 팀이 함께 만든 모델(사용 확인됨). 학습 데이터: AI Hub 한국어 음성 |",
                f"| koelectra-ko-pii-ner | [{PII_REPO}](https://huggingface.co/{PII_REPO}) onnx/model_int8.onnx | `{PII_REVISION}` | Apache-2.0(학습 데이터 CC BY 4.0) |",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> int:
    # 변환은 하위 프로세스가 출력하므로 순서가 섞이지 않게 줄마다 내보낸다
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    parser = argparse.ArgumentParser(description="로컬 받아쓰기·개인정보 인식 모델 준비")
    parser.add_argument("--only", choices=["stt", "pii"], help="하나만 준비")
    parser.add_argument("--keep-download", action="store_true", help="변환 전 원본(약 1GB)을 지우지 않음")
    args = parser.parse_args()
    MODELS.mkdir(exist_ok=True)
    ok = True
    if args.only in (None, "pii"):
        ok = setup_pii() and ok
    if args.only in (None, "stt"):
        ok = setup_stt(args.keep_download) and ok
    write_notes()
    if ok:
        print("\n.env에 다음을 넣고 서버를 다시 시작하세요:")
        print(f"PII_MODEL={PII_OUT.relative_to(ROOT).as_posix()}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
