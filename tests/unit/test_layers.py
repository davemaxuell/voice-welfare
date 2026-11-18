"""
파이프라인 단계별 패키지가 서로 어느 방향으로 가져오는지 고정한다.
아래 표에 없는 가져오기가 생기면 실패한다. 의도한 변경이면 표를 고치고, 순환이 생기지 않는지 확인한다.
TYPE_CHECKING 안의 가져오기는 실행되지 않으므로 세지 않는다.
"""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "src"

# 단계 → 가져와도 되는 단계(자기 자신 제외)
ALLOWED = {
    "cheongeum": set(),
    "agents": set(),
    "core": set(),
    "safety": {"core"},
    "voice": {"core"},
    "understanding": {"core"},
    "language": {"core", "safety"},
    "speech.phrasing": {"core", "safety"},
    "personal": {"core", "speech.phrasing"},
    "agents.web": {"core", "safety", "speech.phrasing"},
    "speech.screen": {"agents.web", "core", "safety", "speech.phrasing"},
    "agents.web.skills": {"agents.web", "core", "safety", "speech.phrasing", "speech.screen", "understanding"},
    "agents.welfare": {"core", "safety"},
    "evaluation": {"agents.welfare", "core", "safety"},
    "orchestrator": {
        "agents.web",
        "agents.web.skills",
        "agents.welfare",
        "core",
        "language",
        "personal",
        "safety",
        "speech.phrasing",
        "speech.screen",
        "understanding",
    },
    "server": {"agents.web", "agents.welfare", "core", "orchestrator", "personal", "practice_site", "safety", "understanding", "voice"},
    "practice_site": set(),
}


def layer(module: str) -> str:
    parts = module.split(".")[1:]
    if parts[:3] == ["agents", "web", "skills"]:
        return "agents.web.skills"
    if parts[:1] == ["agents"] and len(parts) > 1:
        return f"agents.{parts[1]}"
    if parts[:1] == ["speech"]:
        # speech/__init__은 phrasing만 다시 내보낸다
        return "speech.screen" if parts[1:2] == ["screen"] else "speech.phrasing"
    return parts[0] if parts else "cheongeum"


def module_of(path: Path) -> str:
    parts = list(path.relative_to(ROOT).with_suffix("").parts)
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


def runtime_imports(tree: ast.Module) -> list[tuple[int, str]]:
    skip: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and "TYPE_CHECKING" in ast.unparse(node.test):
            skip.update(id(n) for n in ast.walk(node))
    found = []
    for node in ast.walk(tree):
        if id(node) in skip:
            continue
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("cheongeum"):
            found.append((node.lineno, node.module))
        elif isinstance(node, ast.Import):
            found += [(node.lineno, a.name) for a in node.names if a.name.startswith("cheongeum")]
    return found


def test_imports_follow_pipeline_layers():
    wrong = []
    for path in sorted((ROOT / "cheongeum").rglob("*.py")):
        source = layer(module_of(path))
        assert source in ALLOWED, f"{path.relative_to(ROOT)}: 새 단계 '{source}'를 ALLOWED 표에 넣어 주세요"
        for line, target in runtime_imports(ast.parse(path.read_text(encoding="utf-8"))):
            dest = layer(target)
            if dest != source and dest not in ALLOWED[source]:
                wrong.append(f"{path.relative_to(ROOT)}:{line} {source} → {dest} ({target})")
    assert not wrong, "단계 방향을 어긴 가져오기:\n" + "\n".join(wrong)


def test_layer_table_has_no_cycle():
    seen: dict[str, str] = {}

    def visit(name: str, trail: tuple[str, ...]) -> None:
        if seen.get(name) == "done":
            return
        assert seen.get(name) != "open", "순환: " + " → ".join((*trail, name))
        seen[name] = "open"
        for dep in ALLOWED[name]:
            visit(dep, (*trail, name))
        seen[name] = "done"

    for name in ALLOWED:
        visit(name, ())
