"""Python에서 실제로 컴파일한 정규식과 음성 말뭉치의 일치 구간(코드 포인트)을 기록한다."""
from __future__ import annotations

import ast
import csv
import hashlib
import importlib
import json
import pkgutil
import sys
import unicodedata
from collections import defaultdict
from functools import cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "cheongeum"
OUT = ROOT / "tests" / "fixtures" / "regex"
NOISY = OUT / "recognizer-texts.json"


def noisy_texts() -> list[str]:
    report = ROOT / "reports" / "stt-eval.json"
    if report.is_file():
        rows = json.loads(report.read_text(encoding="utf-8"))["results"]
        return sorted({row["text"] for row in rows if row["text"]})
    return json.loads(NOISY.read_text(encoding="utf-8"))


def corpus_texts() -> list[str]:
    with (ROOT / "docs" / "stt-eval" / "sentences.csv").open(encoding="utf-8-sig", newline="") as file:
        rows = csv.DictReader(file)
        phrases = {row[key] for row in rows for key in ("text", "read_as") if row[key]}
    return sorted(phrases.union(noisy_texts()))


def mutated_corpus() -> list[str]:
    fullwidth = str.maketrans("0123456789", "０１２３４５６７８９")
    # 문장에 드문 숫자·경계·개행은 짧은 예문으로 항상 포함한다.
    phrases = [*corpus_texts(), "", "123456-1234567", "１２３４５６-1２３４５６７", "1234 5678 9012 3456", "한A A한", "PIN 인증", "가 １２3"]
    corpus = set()
    for phrase in phrases:
        corpus.update((
            phrase, phrase.translate(fullwidth), phrase.replace(" ", "\u00a0"), phrase.replace(" ", "\u3000"),
            "\ufeff" + phrase, phrase + "\n", "😀" + phrase, unicodedata.normalize("NFD", phrase), "A한" + phrase,
        ))
    return sorted(corpus)


def compact(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def capture_patterns() -> dict:
    import cheongeum
    from cheongeum.core import jsutil

    patterns = defaultdict(set)
    compile_rx = jsutil.rx

    @cache
    def source_path(filename):
        return Path(filename).resolve().relative_to(ROOT).as_posix()

    def trace(pattern, flags=0):
        caller = sys._getframe(1)
        patterns[pattern, int(flags)].add((source_path(caller.f_code.co_filename), caller.f_lineno))
        return compile_rx(pattern, flags)

    # from ... import rx로 복사되기 전에 바꿔야 모듈 상수와 실행 중 조립된 식이 모두 잡힌다.
    jsutil.rx = trace
    for info in pkgutil.walk_packages(cheongeum.__path__, "cheongeum."):
        importlib.import_module(info.name)

    import pytest
    from cheongeum.agents.web.digest import digest_page, text_offset
    from cheongeum.agents.web.profile import match_option
    from cheongeum.understanding.filters import vague_question

    page = digest_page({"url": "https://example.kr/", "outline": {"mainText": "지금 신청"}})
    text_offset(page, "지금 신청")
    for reply in ("잘 모르겠다", "전혀 없다", "조금 있다"):
        match_option(reply, ["잘 모르겠음", "없음", "있음"])
    for phrase in corpus_texts():
        vague_question(phrase)
    if pytest.main(["-q", str(ROOT / "tests" / "unit")]) != 0:
        raise RuntimeError("정규식 추적 중 Python 단위 테스트 실패")

    # 실행하지 않은 분기의 리터럴도 기록한다. 새로 생긴 동적 호출에 예제가 없으면 실패한다.
    seen = {site for sites in patterns.values() for site in sites}
    missing = []
    for file in sorted(SOURCE.rglob("*.py")):
        path = file.relative_to(ROOT).as_posix()
        for call in ast.walk(ast.parse(file.read_text(encoding="utf-8"))):
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "rx":
                continue
            site = (path, call.lineno)
            if site in seen:
                continue
            flags = "0" if len(call.args) == 1 else ast.unparse(call.args[1])
            known_flags = {"0": 0, "I": int(jsutil.I), "regex.IGNORECASE": int(jsutil.I)}
            arg = call.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str) and not call.keywords and flags in known_flags:
                patterns[arg.value, known_flags[flags]].add(site)
            else:
                missing.append(f"{path}:{call.lineno}")
    if missing:
        raise RuntimeError("동적 정규식을 컴파일하는 예제 누락: " + ", ".join(missing))
    return patterns


def main() -> None:
    import regex

    patterns = capture_patterns()
    corpus = mutated_corpus()
    rows = []
    for (source, flags), sites in sorted(patterns.items()):
        pattern = regex.compile(source, flags)
        matches = {}
        for index, phrase in enumerate(corpus):
            spans = [m.span() for m in pattern.finditer(phrase)]
            if spans:
                matches[index] = spans
        identifier = hashlib.sha256(compact([source, flags]).encode()).hexdigest()[:20]
        rows.append(compact({
            "id": identifier, "source": source, "flags": flags, "sites": sorted(sites), "matches": matches,
        }))
    OUT.mkdir(parents=True, exist_ok=True)
    NOISY.write_text(json.dumps(noisy_texts(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (OUT / "corpus.json").write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (OUT / "patterns.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8", newline="\n")
    print(f"정규식 {len(rows)}개, 입력 {len(corpus)}개")


if __name__ == "__main__":
    main()
