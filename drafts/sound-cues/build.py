"""신호음 후보 모으기·재기: SND01 스프라이트를 잘라 파일로, Kenney 후보를 복사, 둘 다 길이·날카로움을 재서 manifest.js로.

uv run python drafts/sound-cues/build.py  (ffmpeg 필요, _src/에 원본이 있어야 함)

잰 값이 mic.js의 두 감지기와 맞닿는 곳:
- loudMs: 소리가 큰 구간 길이. 마이크가 열려 있을 때(멈춤 듣기 중) 200ms(VoiceLoop.MIN_SPEECH_MS) 넘으면 말로 오인될 수 있다.
- crest: 512샘플 창의 봉우리/RMS 최댓값. 박수 감지기가 4 넘는 창을 박수로 본다(마이크에 0.3 이상으로 들어올 때).
"""

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
SRC = HERE / "_src"
SR = 48000

# 상태별 후보(파일 이름은 Kenney 원본, SND01은 스프라이트 키)
KENNEY = {
    "start": ["open_002", "maximize_008"],
    "listen": ["glass_002", "maximize_007"],
    "heard": ["pluck_001", "select_001"],
    "thinking": ["drop_002", "drop_003"],
    "working": ["drop_001", "bong_001"],
    "approve": ["question_001", "question_003"],
    "handoff": ["question_002", "glass_001"],
    "success": ["confirmation_002", "confirmation_004"],
    "problem": ["error_006", "error_008"],
    "stopped": ["minimize_008", "close_001"],
    "end": ["close_002", "minimize_001"],
    "reminder": ["glass_004", "maximize_004"],
}
SND = {
    "start": ["toggle_on"],
    "listen": ["transition_up"],
    "heard": ["select"],
    "thinking": ["button"],
    "working": ["progress_loop"],
    "approve": ["notification"],
    "handoff": ["ringtone_loop"],
    "success": ["celebration"],
    "problem": ["caution"],
    "stopped": ["transition_down"],
    "end": ["toggle_off"],
    "reminder": ["notification"],
}


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32)


def measure(x: np.ndarray) -> dict:
    peak = float(np.abs(x).max()) if x.size else 0.0
    frame = SR // 20  # 50ms: mic.js VAD가 재는 간격
    frames = [x[i : i + frame] for i in range(0, len(x), frame)]
    rms = np.array([np.sqrt(np.mean(f**2)) for f in frames if f.size])
    loud = int((rms > rms.max() * 10 ** (-30 / 20)).sum()) * 50 if rms.size else 0
    crest = 0.0
    for i in range(0, max(1, len(x) - 512), 256):
        w = x[i : i + 512]
        p = float(np.abs(w).max())
        if p < peak * 0.25:
            continue
        crest = max(crest, p / max(float(np.sqrt(np.mean(w**2))), 1e-6))
    return {"ms": round(len(x) / SR * 1000), "loudMs": loud, "crest": round(crest, 2)}


def main() -> None:
    sprite = json.loads((SRC / "snd01.json").read_text(encoding="utf-8"))["spritemap"]
    out_snd = HERE / "snd"
    out_kenney = HERE / "kenney"
    out_snd.mkdir(exist_ok=True)
    out_kenney.mkdir(exist_ok=True)
    kenney_dir = next(SRC.joinpath("kenney").rglob("glass_001.ogg")).parent

    manifest: dict[str, dict[str, list[dict]]] = {"snd": {}, "kenney": {}}
    for state, keys in SND.items():
        for key in keys:
            dest = out_snd / f"{key}.ogg"
            if not dest.exists():
                seg = sprite[key]
                subprocess.run(
                    ["ffmpeg", "-v", "error", "-y", "-i", str(SRC / "snd01.ogg"), "-ss", str(seg["start"]),
                     "-to", str(seg["end"]), "-c:a", "libvorbis", "-q:a", "5", str(dest)],
                    check=True,
                )
            manifest["snd"].setdefault(state, []).append({"name": key, "src": f"snd/{key}.ogg", **measure(decode(dest))})
    for state, names in KENNEY.items():
        for name in names:
            dest = out_kenney / f"{name}.ogg"
            shutil.copyfile(kenney_dir / f"{name}.ogg", dest)
            manifest["kenney"].setdefault(state, []).append({"name": name, "src": f"kenney/{name}.ogg", **measure(decode(dest))})

    (HERE / "manifest.js").write_text(
        "// build.py가 만든다. 손으로 고치지 않는다.\nwindow.CANDIDATES = " + json.dumps(manifest, ensure_ascii=False, indent=1) + ";\n",
        encoding="utf-8",
    )
    for pack, states in manifest.items():
        for state, items in states.items():
            for it in items:
                print(f"{pack:7} {state:9} {it['name']:18} {it['ms']:5}ms  loud {it['loudMs']:4}ms  crest {it['crest']:5}")


if __name__ == "__main__":
    main()
