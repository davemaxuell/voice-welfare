"""
받아쓰기 평가: 녹음을 로컬 모델(이 컴퓨터)과 OpenAI로 받아써 비교 → reports/stt-eval.md, reports/stt-eval.json
  문장 목록: docs/stt-eval/sentences.csv (id, lang, kind, text=정답, read_as=읽는 법, expect=기대 결과)
  녹음: recordings/<id>.(webm|m4a|wav|mp3|ogg|mp4) — 사용자 목소리라 git에 넣지 않는다. 없는 녹음은 건너뛴다.
사용: uv run python scripts/eval_stt.py
  EVAL_STT=local,local+prompt,openai   (기본 local,openai; openai는 .env의 키가 있을 때만)
  EVAL_STT_RECORDINGS=다른/폴더          (기본 recordings/)
  STT_LOCAL_MODEL, STT_LOCAL_BEAM, STT_MODEL은 .env와 같은 뜻
"""
from __future__ import annotations

import asyncio
import csv
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
from cheongeum.core.jsutil import jdumps, now_iso
from cheongeum.evaluation.asr import cer, digit_runs, has_spelled_numbers
from cheongeum.language.i18n import detect_lang_switch
from cheongeum.safety import detect_sensitive, redact_text
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, is_stop_utterance
from cheongeum.voice import LocalWhisperStt, OpenAISttProvider

ROOT = Path(__file__).resolve().parents[1]
SENTENCES = ROOT / "docs" / "stt-eval" / "sentences.csv"
AUDIO_EXT = {".webm": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg"}

# 로컬로 바꿀지 정하는 기준(제안). 보고서에 통과 여부를 적는다.
GATES = {"korean_cer_margin": 0.02, "digit_match": 0.95, "p95_ms": 2000, "silence_false_text": 0}


@dataclass
class Row:
    id: str
    lang: str
    kind: str
    text: str
    read_as: str
    expect: str
    audio: Path | None = None


@dataclass
class Result:
    provider: str
    row: Row
    text: str
    ms: int
    error: str | None = None
    checks: dict = field(default_factory=dict)


def load_rows(recordings: Path) -> list[Row]:
    with SENTENCES.open(encoding="utf-8", newline="") as f:
        rows = [Row(**{k: (v or "").strip() for k, v in r.items()}) for r in csv.DictReader(f)]
    for r in rows:
        r.audio = next((recordings / f"{r.id}{ext}" for ext in AUDIO_EXT if (recordings / f"{r.id}{ext}").is_file()), None)
    return rows


def providers() -> dict:
    wanted = [s.strip() for s in (os.environ.get("EVAL_STT") or "local,openai").split(",") if s.strip()]
    model_dir = os.environ.get("STT_LOCAL_MODEL") or "models/whisper-small-komixv2-ct2"
    model_dir = str(Path(model_dir) if Path(model_dir).is_absolute() else ROOT / model_dir)
    beam = int(os.environ.get("STT_LOCAL_BEAM") or 1)
    out: dict = {}
    for name in wanted:
        if name in ("local", "local+prompt"):
            if not LocalWhisperStt.available(model_dir):
                print(f"⚠ {name}: 모델 없음({model_dir}) — scripts/setup_local_models.py", file=sys.stderr)
                continue
            out[name] = LocalWhisperStt(model_dir, beam_size=beam, use_prompt=name == "local+prompt")
        elif name == "openai":
            key = os.environ.get("VOICE_API_KEY") or os.environ.get("LLM_API_KEY")
            if not key:
                print("⚠ openai: API 키 없음 — 건너뜀", file=sys.stderr)
                continue
            base = (os.environ.get("VOICE_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
            out[name] = OpenAISttProvider(api_key=key, base_url=base, model=os.environ.get("STT_MODEL") or "gpt-4o-mini-transcribe")
    return out


_RULES = RuleBasedIntentProvider(field_vocabulary(create_mock_welfare_profile("http://localhost:5174")))


def understood(text: str) -> tuple:
    """규칙이 이해한 명령(종류 + 입력값). 글자가 조금 달라도 같은 명령이면 같은 값."""
    intent = _RULES.parse_sync(text, IntentContext(state="IDLE"))
    # 값의 띄어쓰기·하이픈·끝 마침표는 입력 칸이 맞춰 주므로 비교하지 않는다("010-1234-5678" = "01012345678")
    fills = tuple((f.get("fieldMention"), re.sub(r"[\s\-.]", "", f.get("value") or "")) for f in intent.get("fills") or [])
    return intent["type"], fills


def check(r: Row, text: str) -> dict:
    """행 종류별 판정. 해당 없으면 None."""
    c: dict = {"cer": cer(r.text, text) if r.kind != "silence" else None}
    # 규칙이 정답 문장을 이해하는 행만(UNKNOWN이면 LLM 몫이라 여기서는 비교하지 않는다)
    want = understood(r.text) if r.lang == "ko" and r.kind in ("command", "stop", "value", "number") else None
    c["intent"] = (understood(text) == want) if want and want[0] != "UNKNOWN" else None
    want_digits = digit_runs(r.text)
    c["digits"] = (digit_runs(text) == want_digits) if want_digits and r.kind in ("number", "secret", "value") else None
    c["spelled"] = has_spelled_numbers(text) if r.kind == "number" else None
    c["stop"] = is_stop_utterance(text) if r.kind == "stop" and r.lang == "ko" else None
    c["switch"] = (detect_lang_switch(text) == r.expect) if r.kind == "switch" else None
    c["silence"] = (text == "") if r.kind == "silence" else None
    if r.expect in ("secret", "not-secret"):
        c["secret"] = detect_sensitive(text).hasSecretValue == (r.expect == "secret")
    return c


def rate(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(1 for v in vals if v) / len(vals) if vals else None


def mean(values: list) -> float | None:
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else None


def pct(sorted_ms: list[int], p: float) -> int | None:
    if not sorted_ms:
        return None
    return sorted_ms[min(len(sorted_ms) - 1, int(len(sorted_ms) * p))]


def summarize(results: list[Result]) -> dict:
    ok = [x for x in results if x.error is None]
    ms = sorted(x.ms for x in ok)
    by = lambda pred: [x for x in ok if pred(x.row)]  # noqa: E731
    out = {
        "clips": len(results),
        "errors": len(results) - len(ok),
        "koreanCer": mean([x.checks["cer"] for x in by(lambda r: r.lang == "ko" and r.kind not in ("silence", "switch"))]),
        "intentMatch": rate([x.checks["intent"] for x in ok]),
        "digitMatch": rate([x.checks["digits"] for x in ok]),
        "numbersAsDigits": rate([None if x.checks["spelled"] is None else not x.checks["spelled"] for x in ok]),
        "stopRecognized": rate([x.checks["stop"] for x in ok]),
        "switchRecognized": rate([x.checks["switch"] for x in ok]),
        "silenceEmpty": rate([x.checks["silence"] for x in ok]),
        "silenceFalseText": sum(1 for x in ok if x.checks["silence"] is False),
        "secretCorrect": rate([x.checks.get("secret") for x in ok]),
        "p50Ms": pct(ms, 0.5),
        "p95Ms": pct(ms, 0.95),
        "maxMs": ms[-1] if ms else None,
    }
    for lang in ("en", "zh", "ja"):
        out[f"{lang}Cer"] = mean([x.checks["cer"] for x in by(lambda r, lang=lang: r.lang == lang and r.kind != "silence")])
    return out


async def run_one(name: str, stt, row: Row) -> Result:
    audio = row.audio.read_bytes()  # type: ignore[union-attr]
    t0 = time.monotonic()
    try:
        out = await stt.transcribe(audio, language=row.lang, mime_type=AUDIO_EXT[row.audio.suffix])  # type: ignore[union-attr]
        text = out["text"]
        err = None
    except Exception as e:  # noqa: BLE001
        text, err = "", type(e).__name__
    res = Result(name, row, text, int((time.monotonic() - t0) * 1000), err)
    res.checks = check(row, text)
    return res


def fmt(v, kind: str = "pct") -> str:
    if v is None:
        return "—"
    if kind == "pct":
        return f"{v * 100:.1f}%"
    if kind == "ms":
        return f"{v:,} ms"
    return str(v)


def gates(summary: dict, names: list[str]) -> list[str]:
    if "local" not in summary:
        return []
    s = summary["local"]
    base = summary.get("openai", {}).get("koreanCer")
    lines = ["## 로컬로 바꿀지 판단(제안 기준)", "", "| 기준 | 로컬 | 통과 |", "| --- | --- | --- |"]

    def row(label: str, value: str, ok: bool | None) -> None:
        lines.append(f"| {label} | {value} | {'—' if ok is None else ('✅' if ok else '❌')} |")

    cer_ok = None if s["koreanCer"] is None or base is None else s["koreanCer"] <= base + GATES["korean_cer_margin"]
    row(f"한국어 CER ≤ OpenAI + {GATES['korean_cer_margin'] * 100:.0f}%p" + ("" if base is not None else " (OpenAI 결과 없음)"), fmt(s["koreanCer"]), cer_ok)
    row(f"숫자 덩어리 일치 ≥ {GATES['digit_match'] * 100:.0f}%", fmt(s["digitMatch"]), None if s["digitMatch"] is None else s["digitMatch"] >= GATES["digit_match"])
    row(f"지연 p95 ≤ {GATES['p95_ms']:,} ms", fmt(s["p95Ms"], "ms"), None if s["p95Ms"] is None else s["p95Ms"] <= GATES["p95_ms"])
    row("무음에서 지어낸 글 0건", str(s["silenceFalseText"]), s["silenceFalseText"] <= GATES["silence_false_text"])
    return [*lines, ""]


def report(rows: list[Row], results: list[Result], recordings: Path) -> tuple[str, dict]:
    names = list(dict.fromkeys(x.provider for x in results))
    summary = {n: summarize([x for x in results if x.provider == n]) for n in names}
    missing = [r.id for r in rows if r.audio is None]
    metrics = [
        ("녹음 수(오류)", lambda s: f"{s['clips']} ({s['errors']})"),
        ("한국어 글자 오류율 CER(낮을수록 좋음)", lambda s: fmt(s["koreanCer"])),
        ("명령 이해 일치(규칙이 정답과 같은 명령으로 이해)", lambda s: fmt(s["intentMatch"])),
        ("숫자 덩어리 일치(전화·생년월일 등)", lambda s: fmt(s["digitMatch"])),
        ("숫자를 숫자로 적음(‘공일공’ 아님)", lambda s: fmt(s["numbersAsDigits"])),
        ("‘멈춰’ 인식", lambda s: fmt(s["stopRecognized"])),
        ("언어 바꾸기 인식", lambda s: fmt(s["switchRecognized"])),
        ("무음 → 빈 글", lambda s: fmt(s["silenceEmpty"])),
        ("비밀번호 문장 판정 맞음", lambda s: fmt(s["secretCorrect"])),
        ("영어 CER", lambda s: fmt(s["enCer"])),
        ("중국어 CER", lambda s: fmt(s["zhCer"])),
        ("일본어 CER", lambda s: fmt(s["jaCer"])),
        ("지연 p50 / p95 / 최대", lambda s: f"{fmt(s['p50Ms'], 'ms')} / {fmt(s['p95Ms'], 'ms')} / {fmt(s['maxMs'], 'ms')}"),
    ]
    lines = [
        "# 받아쓰기 평가 — 로컬 모델 vs OpenAI",
        "",
        f"- 생성: {now_iso()}",
        f"- 녹음 폴더: `{recordings}` · 문장 {len(rows)}개 중 녹음 {len(rows) - len(missing)}개" + (f" (없음: {', '.join(missing[:20])}{' …' if len(missing) > 20 else ''})" if missing else ""),
        "- 받아쓴 글은 비식별화(`redact_text`)해서 적는다.",
        "",
        "## 요약",
        "",
        f"| 지표 | {' | '.join(names)} |",
        f"| --- | {' | '.join('---' for _ in names)} |",
        *(f"| {label} | {' | '.join(get(summary[n]) for n in names)} |" for label, get in metrics),
        "",
        *gates(summary, names),
        "## 녹음별",
        "",
        f"| id | 종류 | 정답 | {' | '.join(names)} |",
        f"| --- | --- | --- | {' | '.join('---' for _ in names)} |",
    ]
    by_id: dict[str, dict[str, Result]] = {}
    for x in results:
        by_id.setdefault(x.row.id, {})[x.provider] = x
    for r in rows:
        if r.id not in by_id:
            continue
        cells = []
        for n in names:
            x = by_id[r.id].get(n)
            if x is None:
                cells.append("—")
                continue
            c = x.checks
            mark = "" if c["cer"] is None else f" ({c['cer'] * 100:.0f}%)"
            if c["silence"] is not None:
                mark = " ✅" if c["silence"] else " ❌"
            cells.append((f"⚠{x.error}" if x.error else redact_text(x.text).replace("|", "/") or "(빈 글)") + mark)
        lines.append(f"| {r.id} | {r.kind} | {redact_text(r.text).replace('|', '/') or '(무음)'} | {' | '.join(cells)} |")
    return "\n".join(lines) + "\n", summary


async def main() -> int:
    load_dotenv(ROOT / ".env")
    recordings = Path(os.environ.get("EVAL_STT_RECORDINGS") or ROOT / "recordings")
    rows = load_rows(recordings)
    have = [r for r in rows if r.audio]
    if not have:
        print(f"녹음이 없습니다: {recordings}\\<id>.webm|m4a|wav … (문장 목록: docs/stt-eval/sentences.csv)", file=sys.stderr)
        return 1
    stts = providers()
    if not stts:
        print("평가할 받아쓰기 공급자가 없습니다(EVAL_STT).", file=sys.stderr)
        return 1
    results: list[Result] = []
    for name, stt in stts.items():
        warm = getattr(stt, "warm", None)
        if warm:
            warm()  # 모델 불러오는 시간은 지연에서 뺀다
        for r in have:
            res = await run_one(name, stt, r)
            results.append(res)
            c = "" if res.checks["cer"] is None else f"CER {res.checks['cer'] * 100:.0f}%"
            shown = f"⚠ {res.error}" if res.error else redact_text(res.text)[:60]
            print(f"{name:13} {r.id} {res.ms:6d}ms {c:9} {shown}", flush=True)
    md, summary = report(rows, results, recordings)
    out = ROOT / "reports"
    out.mkdir(exist_ok=True)
    (out / "stt-eval.md").write_text(md, encoding="utf-8")
    (out / "stt-eval.json").write_text(
        jdumps(
            {
                "generatedAt": now_iso(),
                "summary": summary,
                "gates": GATES,
                "results": [
                    {"provider": x.provider, "id": x.row.id, "kind": x.row.kind, "lang": x.row.lang, "ms": x.ms, "error": x.error, "text": redact_text(x.text), "checks": x.checks}
                    for x in results
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print("\n보고서: reports/stt-eval.md")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
