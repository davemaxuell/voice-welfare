"""Build the rebrand-audit manifest: every live file goes to exactly one worker slice or one exclusion rule.

Run from the repo root: python manifest.py <repo> <outdir> <n_slices>
Writes <outdir>/manifest.tsv (path, bucket, bytes, reason) and <outdir>/slice-<k>.txt (one path per line).
"""
import json
import re
import subprocess
import sys
from pathlib import Path

repo, out, n = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)


def git(*args):
    r = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=repo, capture_output=True, text=True, encoding="utf-8", check=True)
    return [p for p in r.stdout.splitlines() if p]


paths = sorted(set(git("ls-files") + git("ls-files", "--others", "--exclude-standard")))

EXCLUDE = [
    (r"^\.audit/", "session logs, run reports and merge evidence from past work (history)"),
    (r"\.(ogg|wav|mp3)$", "audio asset, no text"),
    (r"^scripts/vendor/", "third-party axe-core bundle and license"),
    (r"^drafts/sound-cues/_src/kenney/", "third-party Kenney sound pack and its license/links"),
    (r"(^|/)(uv\.lock|package-lock\.json)$", "generated lockfile"),
    (r"^src/cheongeum/agents/welfare/(data/fixtures|open_data/snapshots)/", "official government welfare data (verbatim API responses)"),
    (r"^tests/fixtures/.*\.xml$", "official government welfare API responses used as test fixtures"),
    (r"\.svg$", "blank placeholder image"),
    (r"^docs/architecture\.png$", "raster diagram, checked by the coordinator by eye"),
]

rows, text = [], []
for p in paths:
    f = repo / p
    if not f.exists():
        rows.append((p, "MISSING", 0, "listed by git but absent on disk"))
        continue
    size = f.stat().st_size
    reason = next((why for pat, why in EXCLUDE if re.search(pat, p)), None)
    if reason:
        rows.append((p, "EXCLUDED", size, reason))
    else:
        text.append((p, size))

# Keep a folder's files together where possible: sort by path, then cut into n slices of similar total size.
total = sum(s for _, s in text)
target = total / n
slices, cur, acc = [], [], 0
for p, s in text:
    if cur and acc + s > target * 1.15 and len(slices) < n - 1:
        slices.append(cur)
        cur, acc = [], 0
    cur.append((p, s))
    acc += s
slices.append(cur)

for k, sl in enumerate(slices, 1):
    (out / f"slice-{k}.txt").write_text("\n".join(p for p, _ in sl) + "\n", encoding="utf-8")
    for p, s in sl:
        rows.append((p, f"slice-{k}", s, ""))

rows.sort()
with open(out / "manifest.tsv", "w", encoding="utf-8") as fh:
    fh.write("path\tbucket\tbytes\treason\n")
    for r in rows:
        fh.write("\t".join(map(str, r)) + "\n")

summary = {"files": len(paths), "excluded": sum(r[1] == "EXCLUDED" for r in rows), "missing": sum(r[1] == "MISSING" for r in rows),
           "slices": [{"slice": k, "files": len(sl), "kb": round(sum(s for _, s in sl) / 1024)} for k, sl in enumerate(slices, 1)]}
print(json.dumps(summary, ensure_ascii=False, indent=1))
