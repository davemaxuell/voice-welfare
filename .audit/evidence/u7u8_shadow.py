"""Lists every function that binds a local named NAME (param, assignment, loop or comprehension target) in files importing NAME, and whether it also calls NAME(...)."""
import ast, pathlib, sys
NAME = sys.argv[1]
for p in pathlib.Path("src/cheongeum").rglob("*.py"):
    tree = ast.parse(p.read_text(encoding="utf-8"))
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        binds = any(a.arg == NAME for a in ast.walk(fn.args) if isinstance(a, ast.arg))
        binds |= any(isinstance(n, ast.Name) and n.id == NAME and isinstance(n.ctx, ast.Store) for n in ast.walk(fn))
        calls = any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == NAME for n in ast.walk(fn))
        if binds:
            print(f"{p}:{fn.lineno} {getattr(fn, 'name', 'lambda')} binds {NAME}; calls it: {calls}")
