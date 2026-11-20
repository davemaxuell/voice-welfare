"""Merge worker TSVs into findings.tsv and findings.md (every row, grouped by category, severity, file).

Usage: python report.py <outdir with result-*.tsv> <destdir>
"""
import sys
from collections import defaultdict
from pathlib import Path

src, dest = Path(sys.argv[1]), Path(sys.argv[2])
dest.mkdir(parents=True, exist_ok=True)

CAT_ORDER = ["ID", "META", "ASSUME", "GAP", "PLAIN", "COUPLED"]
CAT_TITLE = {
    "ID": "ID: text that still names blind users as the audience",
    "META": "META: names, titles, diagrams",
    "ASSUME": "ASSUME: behavior built for blind screen-reader users",
    "GAP": "GAP: groups of 정보취약계층 left out",
    "PLAIN": "PLAIN: words a 정보취약계층 user may not know",
    "COUPLED": "COUPLED: tests and fixtures that pin text or behavior above",
}
SEV_ORDER = ["must", "should", "consider"]

rows = []
for f in sorted(src.glob("result-*.tsv")):
    for line in f.read_text(encoding="utf-8").splitlines():
        c = line.split("\t")
        if len(c) == 7 and c[2] != "CHECKED":
            rows.append(c)

with open(dest / "findings.tsv", "w", encoding="utf-8") as fh:
    fh.write("path\tline\tcategory\tseverity\texcerpt\twhy\tsuggestion\n")
    for r in sorted(rows, key=lambda r: (CAT_ORDER.index(r[2]), SEV_ORDER.index(r[3]), r[0], int(r[1]) if r[1].isdigit() else 0)):
        fh.write("\t".join(r) + "\n")

grouped = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
for r in rows:
    grouped[r[2]][r[3]][r[0]].append(r)


def cell(s: str) -> str:
    return s.replace("|", "\\|")


out = ["# 리브랜딩 전수 조사: 발견 목록 전체", "",
       f"발견 {len(rows)}건. 분류별, 중요도(must > should > consider)별, 파일별로 정리했다. 요약과 묶음은 `README.md`.", ""]
for cat in CAT_ORDER:
    n = sum(len(v) for sev in grouped[cat].values() for v in sev.values())
    out += [f"## {CAT_TITLE[cat]} ({n})", ""]
    for sev in SEV_ORDER:
        files = grouped[cat].get(sev)
        if not files:
            continue
        out += [f"### {sev} ({sum(len(v) for v in files.values())})", ""]
        for path in sorted(files):
            out += [f"#### `{path}`", "", "| 줄 | 원문 | 이유 | 제안 |", "|---|---|---|---|"]
            for r in sorted(files[path], key=lambda r: int(r[1]) if r[1].isdigit() else 0):
                out.append(f"| {r[1]} | {cell(r[4])} | {cell(r[5])} | {cell(r[6])} |")
            out.append("")
(dest / "findings.md").write_text("\n".join(out), encoding="utf-8")
print(f"rows: {len(rows)} -> {dest / 'findings.md'}")
