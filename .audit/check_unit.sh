#!/usr/bin/env bash
# Usage: bash .audit/check_unit.sh <label>   (run from the repo root)
# Runs the full suite and the scenario report, and compares both with the baseline in .audit/baseline/.
# The summary is printed and saved to .audit/runs/<label>/summary.txt. Exit 0 only when nothing is missing or failing
# and the scenario report is identical apart from timing.
set -u
label="${1:-unit}"
out=".audit/runs/$label"
mkdir -p "$out"
# 다른 세션이 같은 작업 트리에서 pytest를 돌리면 그쪽 모의 사이트(:5174)를 재사용하다 중간에 끊긴다(U6 첫 실행 47 실패).
owner=$(netstat -ano 2>/dev/null | grep -E ":5174 .*LISTEN" | awk '{print $NF}' | sort -u | head -1)
if [ -n "$owner" ]; then
  echo "PREFLIGHT: :5174 is already served by PID $owner; another test run owns the mock site. Wait for it to end, then rerun."
  exit 2
fi
bad=0
{
  uv run pytest -q -p no:cacheprovider -rA > "$out/pytest.txt" 2>&1
  grep -E "^PASSED" "$out/pytest.txt" | sort > "$out/passed.txt"
  echo "pytest: $(tail -1 "$out/pytest.txt")"
  missing=$(comm -23 .audit/baseline/passed.txt "$out/passed.txt")
  [ -n "$missing" ] && echo "MISSING vs baseline:" && echo "$missing"
  grep -E "^(FAILED|ERROR)" "$out/pytest.txt" | head -20
  timeout 420 uv run python scripts/run_scenarios.py > "$out/scenarios.txt" 2>&1
  rc=$?
  [ $rc -eq 124 ] && echo "SCENARIOS TIMED OUT after 420s (normal run is under a minute); rerun them"
  [ $rc -ne 0 ] && [ $rc -ne 124 ] && echo "run_scenarios exited $rc"
  cp reports/evaluation-report.md "$out/evaluation-report.md"
  echo "scenarios: $(python .audit/report_facts.py .audit/baseline/evaluation-report.md "$out/evaluation-report.md")"
} | tee "$out/summary.txt"
grep -qE "^(MISSING|FAILED|ERROR|SCENARIOS TIMED OUT|run_scenarios exited)" "$out/summary.txt" && bad=1
grep -q "^scenarios: identical apart from timing$" "$out/summary.txt" || bad=1
exit $bad
