"""
whisper-small-komixv2(transformers 형식) → CTranslate2 int8 + tokenizer.json.
scripts/setup-models.ts가 임시 환경(transformers·torch, 프로젝트 의존성에 넣지 않음)에서 부른다:
    uv run --no-project --with ctranslate2==<버전> --with transformers --with torch python python/convert_whisper_ct2.py <원본 폴더> <출력 폴더>
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path


def main(src: Path, out: Path) -> int:
    from ctranslate2.converters import TransformersConverter
    from transformers import AutoTokenizer

    tmp = out.with_name(out.name + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)
    TransformersConverter(str(src), copy_files=["preprocessor_config.json"]).convert(str(tmp), quantization="int8", force=True)
    # 저장소에 tokenizer.json이 없어 만든다(없으면 faster-whisper가 실행 중에 다른 토크나이저를 내려받으려 한다)
    with tempfile.TemporaryDirectory() as td:
        AutoTokenizer.from_pretrained(str(src), use_fast=True).save_pretrained(td)
        shutil.copy(Path(td) / "tokenizer.json", tmp / "tokenizer.json")
    if out.exists():
        shutil.rmtree(out)
    tmp.rename(out)
    print(f"변환 완료: {out}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("사용법: convert_whisper_ct2.py <원본 폴더> <출력 폴더>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]), Path(sys.argv[2])))
