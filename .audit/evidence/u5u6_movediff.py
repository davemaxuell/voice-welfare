"""
Proof for a move: for every moved name, print the unified diff between its text in the pre-unit snapshot of session.py
and its new home, and assert the old name is gone from session.py.
Usage: python movediff.py <U5|U6> <snapshot session.py>
"""
import ast
import difflib
import pathlib
import sys
import textwrap

SRC = pathlib.Path("C:/Users/user/Desktop/voice-welfare/src/cheongeum")
SESSION = SRC / "orchestrator/session.py"
FORM = SRC / "agents/web/skills/form.py"
COMMON = SRC / "agents/web/skills/common.py"
BROWSE = SRC / "agents/web/skills/browse.py"

U5 = {
    "_d": (COMMON, None, "_d"),
    "NextStep": (FORM, None, "NextStep"),
    "_next_step": (FORM, None, "_next_step"),
    "_browse_state": (COMMON, None, "browse_state"),
    "_is_form_open": (COMMON, None, "is_form_open"),
    "_not_open": (COMMON, None, "not_open"),
    "_outcome_failure": (COMMON, None, "outcome_failure"),
    "_form_state": (FORM, "FormSkill", "form_state"),
    "_ask_next": (FORM, "FormSkill", "ask_next"),
    "_assist_fill_request": (FORM, "FormSkill", "_assist_fill_request"),
    "_fill": (FORM, "FormSkill", "fill"),
    "_resolve": (FORM, "FormSkill", "_resolve"),
    "_fill_one": (FORM, "FormSkill", "fill_one"),
    "_read_field": (FORM, "FormSkill", "read_field"),
    "_resolve_for_read": (FORM, "FormSkill", "_resolve_for_read"),
    "_edit_field": (FORM, "FormSkill", "edit_field"),
    "_next": (FORM, "FormSkill", "next"),
    "_prev": (FORM, "FormSkill", "prev"),
    "_after_step_move": (FORM, "FormSkill", "_after_step_move"),
    "_review_values": (FORM, "FormSkill", "_review_values"),
    "_review": (FORM, "FormSkill", "review"),
    "_prepare_submit": (FORM, "FormSkill", "prepare_submit"),
    "_reject": (FORM, "FormSkill", "reject"),
    # 승인: 문은 세션에 남고 실행 반쪽이 FormSkill로
    "_approve": (SESSION, "SessionOrchestrator", "_approve"),
    "_approve#assist": (FORM, "FormSkill", "assist_approved"),
    "_approve#submit": (FORM, "FormSkill", "submit_approved"),
    "_explain": (SESSION, "SessionOrchestrator", "_explain"),
}
U6 = {
    "LINKS_PER_PAGE": (BROWSE, None, "LINKS_PER_PAGE"),
    **{
        old: (BROWSE, "BrowseSkill", new)
        for old, new in {
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
        }.items()
    },
    "_unknown": (SESSION, "SessionOrchestrator", "_unknown"),
}


def find(path: pathlib.Path, cls: str | None, name: str) -> str | None:
    src = path.read_text(encoding="utf-8")
    lines = src.splitlines(keepends=True)
    tree = ast.parse(src)
    body = tree.body
    if cls:
        body = next(n.body for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls)
    for n in body:
        names = [getattr(n, "name", None)] + [t.id for t in getattr(n, "targets", []) if isinstance(t, ast.Name)]
        if name in names:
            start = n.decorator_list[0].lineno if getattr(n, "decorator_list", None) else n.lineno
            return textwrap.dedent("".join(lines[start - 1 : n.end_lineno]))
    return None


def main() -> None:
    unit = {"U5": U5, "U6": U6}[sys.argv[1]]
    snapshot = pathlib.Path(sys.argv[2])
    missing, still_there = [], []
    for old, (path, cls, new) in unit.items():
        base = old.split("#")[0]
        before = find(snapshot, "SessionOrchestrator", base) or find(snapshot, None, base)
        after = find(path, cls, new)
        if after is None:
            missing.append(f"{old} -> {path.name}:{new}")
            continue
        if path != SESSION and (find(SESSION, "SessionOrchestrator", base) or find(SESSION, None, base)):
            still_there.append(base)
        diff = list(difflib.unified_diff(before.splitlines(), after.splitlines(), f"old {base}", f"new {path.name}:{new}", lineterm="", n=0))
        print(f"==== {old} -> {path.name}:{new}  ({len([d for d in diff if d[:1] in '+-' and d[:3] not in ('+++', '---')])} changed lines)")
        for d in diff[2:]:
            print(d)
    print("MISSING:", missing or "none")
    print("STILL IN session.py:", sorted(set(still_there)) or "none")


if __name__ == "__main__":
    main()
