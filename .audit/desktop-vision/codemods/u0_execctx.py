"""U0: ExecContext·OutcomeStatus를 core/execctx.py로 옮기고 가져오는 곳을 모두 고친다. 다시 돌려도 같은 결과."""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
src = root / "src/cheongeum"
agent = src / "agents/web/agent.py"
text = agent.read_text(encoding="utf-8")

CTX = '''@dataclass
class ExecContext:
    signal: AbortSignal
    approvals: set[str]
    is_stopped: Callable[[], bool]
    trace: Callable[..., None]  # trace(phase, agent, note=None)
    counter: dict = dc_field(default_factory=lambda: {"actions": 0})

    @contextmanager
    def granted(self, ids: list[str]) -> Iterator[None]:
        """이 액션들을 블록 안에서만 승인된 것으로 둔다(PolicyGuard가 approvals를 본다)."""
        self.approvals.update(ids)
        try:
            yield
        finally:
            self.approvals.difference_update(ids)


'''
STATUS = '''# unconfirmed: 승인받은 조작이 시간 안에 답하지 않았고 다시 봐도 됐는지 모른다(저절로 다시 하지 않는다)
OutcomeStatus = Literal["ok", "needs-clarification", "needs-approval", "validation-error", "policy-denied", "failed", "aborted", "unconfirmed"]


'''
target = src / "core/execctx.py"
if CTX in text:
    assert STATUS in text
    text = text.replace(CTX, "").replace(STATUS, "")
    target.write_text(
        '"""\n실행 문맥: 한 턴 동안 모든 에이전트가 함께 쓰는 멈춤 신호·승인·조작 수, 그리고 조작 결과 상태.\n'
        '웹과 데스크톱 에이전트가 같은 문맥을 받으므로 core에 둔다.\n"""\n'
        "from __future__ import annotations\n\n"
        "from contextlib import contextmanager\n"
        "from dataclasses import dataclass, field as dc_field\n"
        "from typing import Callable, Iterator, Literal\n\n"
        "from cheongeum.core.jsutil import AbortSignal\n\n\n" + CTX + STATUS.rstrip() + "\n",
        encoding="utf-8",
    )
    text = text.replace(
        "from cheongeum.core.actions import LINK_ROLES\n",
        "from cheongeum.core.actions import LINK_ROLES\nfrom cheongeum.core.execctx import ExecContext, OutcomeStatus\n",
    )
    text = text.replace("from contextlib import contextmanager\n", "")
    text = text.replace("from typing import Any, Callable, Iterator, Literal\n", "from typing import Any, Callable, Literal\n")
    agent.write_text(text, encoding="utf-8")

# 가져오는 곳: agents.web.agent / agents.web 에서 ExecContext를 빼고 core.execctx에서 가져온다
pat = re.compile(r"^from cheongeum\.agents\.web(\.agent)? import (.+)$", re.M)
for f in list(src.rglob("*.py")) + list((root / "tests").rglob("*.py")):
    if f == agent or f == target:
        continue
    s = f.read_text(encoding="utf-8")
    if "ExecContext" not in s:
        continue

    def fix(m: re.Match) -> str:
        names = [n.strip() for n in m.group(2).split(",")]
        if "ExecContext" not in names:
            return m.group(0)
        rest = [n for n in names if n != "ExecContext"]
        line = "from cheongeum.core.execctx import ExecContext"
        return (f"from cheongeum.agents.web{m.group(1) or ''} import {', '.join(rest)}\n" if rest else "") + line

    s2 = pat.sub(fix, s)
    if f.name == "__init__.py" and f.parent.name == "web":
        s2 = s2.replace("from cheongeum.core.execctx import ExecContext\n", "").replace('    "ExecContext",\n', "")
    if s2 != s:
        f.write_text(s2, encoding="utf-8")
        print("fixed", f.relative_to(root))
