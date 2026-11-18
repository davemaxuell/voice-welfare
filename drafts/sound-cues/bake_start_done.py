"""Bake start.ogg / done.ogg from SND01 (first soft pulse only — full clips fail clap crest)."""
import subprocess
from pathlib import Path
import numpy as np
SR = 48000
ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "drafts/sound-cues/snd"
OUT = ROOT / "src/cheongeum/web/static/cues"

def load(p):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)

def save(path, x):
    subprocess.run(["ffmpeg", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0", "-c:a", "libvorbis", "-q:a", "5", str(path)], input=x.astype(np.float32).tobytes(), check=True, capture_output=True)

def soft(x, attack=0.012, release=0.012):
    n = len(x)
    env = np.ones(n)
    a, r = min(n, int(attack * SR)), min(n, int(release * SR))
    if a: env[:a] = np.linspace(0, 1, a, endpoint=False)
    if r: env[-r:] = np.linspace(1, 0, r)
    return x * env

for srcn, dstn in [("toggle_on.ogg", "start.ogg"), ("select.ogg", "done.ogg")]:
    x = load(SRC / srcn)
    frame = SR // 200
    start = next((i for i in range(0, len(x), frame) if np.abs(x[i : i + frame]).max() > 0.1), 0)
    y = soft(x[start : start + int(0.022 * SR)])
    peak = float(np.abs(y).max()) or 1
    save(OUT / dstn, y * (0.55 / peak))
    print("wrote", dstn)
