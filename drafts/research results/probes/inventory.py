"""
Print the intent, semantic action, session state, action type, and LLM schema tables from source.
Read-only. No network, no browser. Run from the repository root:

    uv run python "drafts/research results/probes/inventory.py"

The counts in "agent skills tools - fit for cheongeum.md" come from this output.
"""
import json
import re
import sys
from pathlib import Path

from cheongeum.core.actions import ACTION_TYPES, EXECUTION_ERROR_CODES
from cheongeum.core.turn import INTENT_MODELS, INTENT_TYPES, SEMANTIC_ACTIONS, SESSION_STATES
from cheongeum.orchestrator.session import ROUTES
from cheongeum.safety.gates import ALLOWED_WITHOUT_CONSENT
from cheongeum.understanding.llm_planner import LLM_INTENT_TYPES

SRC = Path(__file__).resolve().parents[3] / "src" / "cheongeum"
PY = {p: p.read_text(encoding="utf-8") for p in SRC.rglob("*.py")}


def rel(p: Path) -> str:
    return p.relative_to(SRC).as_posix()


def files_with(pattern: str, skip: tuple[str, ...] = ()) -> list[str]:
    r = re.compile(pattern)
    return sorted(rel(p) for p, text in PY.items() if rel(p) not in skip and r.search(text))


def quoted(name: str) -> str:
    return r"""["']""" + re.escape(name) + r"""["']"""


rules = PY[SRC / "understanding" / "rules.py"]
session = PY[SRC / "orchestrator" / "session.py"]

out: dict = {}

out["intents"] = []
for model, name in zip(INTENT_MODELS, INTENT_TYPES):
    fields = [f for f in model.model_fields if f != "type"]
    by_rules = bool(re.search(r"""["']type["']:\s*["']""" + name + r"""["']|with_service\(["']""" + name + r"""["']\)""", rules))
    out["intents"].append(
        {
            "type": name,
            "fields": fields,
            "rules": by_rules,
            "llm": name in LLM_INTENT_TYPES,
            "routed": name in ROUTES,
            "beforeConsent": name in ALLOWED_WITHOUT_CONSENT,
        }
    )

out["turnLabelsOutsideIntentTypes"] = sorted(
    set(re.findall(r"""intentType = f?["']([A-Z_]+)""", session)) - set(INTENT_TYPES)
)

turn_py = ("core/turn.py",)
out["semanticActions"] = {a: files_with(quoted(a), turn_py) for a in SEMANTIC_ACTIONS}
out["sessionStates"] = {s: files_with(quoted(s), turn_py) for s in SESSION_STATES}
out["actionTypes"] = {
    a: files_with(r"""["']type["']:\s*""" + quoted(a) + r"""|type=""" + quoted(a), ("core/actions.py",)) for a in ACTION_TYPES
}
out["executionErrorCodes"] = {c: files_with(quoted(c), ("core/actions.py",)) for c in EXECUTION_ERROR_CODES}
out["llmSchemas"] = {}
for p, text in PY.items():
    for name in re.findall(r"""schemaName=["']([a-z_]+)["']""", text):
        out["llmSchemas"].setdefault(name, []).append(rel(p))

if "--json" in sys.argv:
    print(json.dumps(out, ensure_ascii=False, indent=1))
    sys.exit(0)

print(f"intent types: {len(INTENT_TYPES)}")
print("type | fields | rules | llm | routed | before consent")
for i in out["intents"]:
    yn = lambda b: "yes" if b else "no"  # noqa: E731
    print(f"{i['type']} | {','.join(i['fields']) or '-'} | {yn(i['rules'])} | {yn(i['llm'])} | {yn(i['routed'])} | {yn(i['beforeConsent'])}")
print("\nturn labels outside INTENT_TYPES:", ", ".join(out["turnLabelsOutsideIntentTypes"]))
for title, key in (
    ("semantic actions", "semanticActions"),
    ("session states", "sessionStates"),
    ("action types", "actionTypes"),
    ("execution error codes", "executionErrorCodes"),
    ("LLM schema names", "llmSchemas"),
):
    table = out[key]
    print(f"\n{title}: {len(table)}")
    for name, where in table.items():
        print(f"{name} | {', '.join(sorted(set(where))) or 'NOT USED outside its definition'}")
