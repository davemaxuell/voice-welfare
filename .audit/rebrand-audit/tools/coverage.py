"""Check that worker results cover every slice file and follow the TSV contract.

Usage: python coverage.py <outdir>
Exit 0 only when every slice path has exactly one CHECKED row, every row has 7 fields, categories and severities are valid,
and each CHECKED count equals the number of finding rows for that path.
"""
import sys
from collections import Counter
from pathlib import Path

out = Path(sys.argv[1])
CATS = {"ID", "ASSUME", "PLAIN", "GAP", "META", "COUPLED"}
SEVS = {"must", "should", "consider"}

expected = {}
for f in sorted(out.glob("slice-*.txt")):
    k = f.stem.split("-")[1]
    for p in f.read_text(encoding="utf-8").splitlines():
        if p:
            expected[p] = k

problems, checked, findings = [], Counter(), Counter()
claimed = {}
cat_count, sev_count = Counter(), Counter()
for f in sorted(out.glob("result-*.tsv")):
    k = f.stem.split("-")[1]
    for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) != 7:
            problems.append(f"{f.name}:{i} has {len(cols)} fields")
            continue
        path, _, cat, sev, *_ = cols
        if path not in expected:
            problems.append(f"{f.name}:{i} path not in any slice: {path}")
        elif expected[path] != k:
            problems.append(f"{f.name}:{i} path belongs to slice-{expected[path]}: {path}")
        if cat == "CHECKED":
            checked[path] += 1
            try:
                claimed[path] = int(cols[4])
            except ValueError:
                problems.append(f"{f.name}:{i} CHECKED count not a number: {cols[4]}")
        elif cat in CATS:
            findings[path] += 1
            cat_count[cat] += 1
            if sev not in SEVS:
                problems.append(f"{f.name}:{i} bad severity {sev!r}")
            else:
                sev_count[sev] += 1
        else:
            problems.append(f"{f.name}:{i} bad category {cat!r}")

missing = [p for p in expected if checked[p] == 0]
dupes = [p for p in expected if checked[p] > 1]
mismatch = [f"{p}: CHECKED says {claimed[p]}, rows {findings[p]}" for p in claimed if claimed[p] != findings[p]]
results = {f.stem.split('-')[1] for f in out.glob('result-*.tsv')}
no_result = sorted({k for k in expected.values()} - results, key=int)

print(f"slice files: {len(expected)}  checked: {sum(1 for p in expected if checked[p])}  findings: {sum(findings.values())}")
print("by category:", dict(cat_count), " by severity:", dict(sev_count))
for label, items in [("slices with no result file", no_result), ("files never CHECKED", missing), ("files CHECKED twice", dupes),
                     ("count mismatches", mismatch), ("format problems", problems)]:
    if items:
        print(f"{label} ({len(items)}):")
        for x in items[:40]:
            print("  ", x)
sys.exit(1 if (missing or dupes or problems or mismatch or no_result) else 0)
