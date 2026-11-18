"""
U5/U6 codemod: cut named SessionOrchestrator methods (and module-level names) out of session.py,
apply a substitution table to the cut text and to the remaining call sites, and print the cut pieces.
Usage: python move.py <U5|U6> <snapshot session.py>   (writes session.py in place, prints pieces to <unit>.pieces.py)
Rerunnable: always starts from the snapshot.
"""
import ast
import pathlib
import re
import sys

ROOT = pathlib.Path("C:/Users/user/Desktop/voice-welfare")
SESSION = ROOT / "src/cheongeum/orchestrator/session.py"
HERE = pathlib.Path(__file__).parent

# ruff: noqa
U5 = {
    "module": ["_d", "NextStep", "_next_step"],
    # old name -> new name (order = order in the new class)
    "methods": {
        "_form_state": "form_state",
        "_ask_next": "ask_next",
        "_assist_fill_request": "_assist_fill_request",
        "_fill": "fill",
        "_resolve": "_resolve",
        "_fill_one": "fill_one",
        "_read_field": "read_field",
        "_resolve_for_read": "_resolve_for_read",
        "_edit_field": "edit_field",
        "_next": "next",
        "_prev": "prev",
        "_after_step_move": "_after_step_move",
        "_review_values": "_review_values",
        "_review": "review",
        "_prepare_submit": "prepare_submit",
        "_reject": "reject",
        # common.py
        "_not_open": "not_open",
        "_browse_state": "browse_state",
        "_is_form_open": "is_form_open",
        "_outcome_failure": "outcome_failure",
    },
    "self": "self.form",
}

U6 = {
    "module": ["LINKS_PER_PAGE"],
    "methods": {
        "_mock_sites": "mock_sites",
        "_after_navigation": "after_navigation",
        "_search_url": "search_url",
        "_open_site": "open_site",
        "_follow_link": "follow_link",
        "_back": "back",
        "_readable_text": "_readable_text",
        "_read_main": "read_main",
        "_list_links": "list_links",
        "_search": "search",
        "_resume": "resume",
        "_screen": "screen",
        "_current_step": "current_step",
        "_about_site": "about_site",
        "_web_answer": "web_answer",
        "_run_goal": "run_goal",
        "_login": "login",
        "_auth_done": "auth_done",
    },
    "self": "self.browse",
}

COMMON = {"_not_open", "_browse_state", "_is_form_open", "_outcome_failure"}


def ranges(src: str) -> tuple[dict, dict]:
    tree = ast.parse(src)
    methods, module = {}, {}
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "SessionOrchestrator":
            for m in node.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    start = m.decorator_list[0].lineno if m.decorator_list else m.lineno
                    methods[m.name] = (start, m.end_lineno)
        else:
            start = node.decorator_list[0].lineno if getattr(node, "decorator_list", None) else node.lineno
            names = []
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name]
            elif isinstance(node, ast.Assign):
                names = [t.id for t in node.targets if isinstance(t, ast.Name)]
            for n in names:
                module[n] = (start, node.end_lineno)
    return methods, module


def call_site_subs(text: str, unit: dict) -> str:
    """Rewrites in what stays in session.py (and, for U6, inside the moved browse code before its own pass)."""
    owner = unit["self"]
    for old, new in unit["methods"].items():
        if old in COMMON:
            continue
        # self._x(..., turn) -> owner.x(..., turn.ctx)
        text = re.sub(rf"self\.{old}\(([^()]*?)\bturn\)", rf"{owner}.{new}(\1turn.ctx)", text)
        text = re.sub(rf"self\.{old}\(", rf"{owner}.{new}(", text)
    return text


def common_subs(text: str) -> str:
    text = text.replace("self._is_form_open()", "is_form_open(self.web.current_view)")
    text = text.replace("self._not_open()", "not_open(self.web.current_view, self.dialogue.state)")
    text = text.replace("self._outcome_failure(", "outcome_failure(")
    text = text.replace("self._browse_state(", "browse_state(")
    return text


def moved_subs(text: str, unit: dict, name: str) -> str:
    """Rewrites inside a moved method: Turn -> ctx, own methods drop the underscore."""
    text = text.replace("self._trace(turn, ", "ctx.trace(")
    text = text.replace("turn.ctx", "ctx")
    text = text.replace("turn: Turn", "ctx: ExecContext")
    for old, new in unit["methods"].items():
        if old in COMMON:
            continue
        text = re.sub(rf"self\.{old}\(([^()]*?)\bturn\)", rf"self.{new}(\1ctx)", text)
        text = re.sub(rf"self\.{old}\(", rf"self.{new}(", text)
    text = re.sub(rf"def {name}\(", f"def {unit['methods'][name]}(", text, count=1)
    return common_subs(text)


def main() -> None:
    unit_name, snapshot = sys.argv[1], pathlib.Path(sys.argv[2])
    unit = {"U5": U5, "U6": U6}[unit_name]
    src = snapshot.read_text(encoding="utf-8")
    lines = src.splitlines(keepends=True)
    methods, module = ranges(src)
    cut: dict[str, str] = {}
    drop: set[int] = set()
    for name in [*unit["module"], *unit["methods"]]:
        start, end = methods.get(name) or module[name]
        cut[name] = "".join(lines[start - 1 : end])
        span = range(start - 1, end)
        drop.update(span)
        # 뒤따르는 빈 줄(메서드 사이 1줄, 모듈 수준 2줄)도 지운다
        j = end
        while j < len(lines) and lines[j].strip() == "" and (j - end) < (2 if name in module else 1):
            drop.add(j)
            j += 1
    rest = "".join(l for i, l in enumerate(lines) if i not in drop)
    rest = common_subs(call_site_subs(rest, unit))
    SESSION.write_text(rest, encoding="utf-8", newline="\n")

    out = []
    for name in unit["module"]:
        out.append(f"# ---- {name}\n{cut[name]}")
    for name in unit["methods"]:
        body = moved_subs(cut[name], unit, name)
        out.append(f"# ---- {name} -> {unit['methods'][name]}\n{body}")
    (HERE / f"{unit_name}.pieces.py").write_text("\n".join(out), encoding="utf-8", newline="\n")
    print(f"cut {len(cut)} pieces; session.py now {rest.count(chr(10))} lines")


if __name__ == "__main__":
    main()
