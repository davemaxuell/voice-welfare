"""Regroup src/cheongeum by pipeline stage: move/split files, write package inits, rewrite every cheongeum import.

Usage: python organize.py <repo root>. Run on the step-1 tree (restore from the snapshot to rerun).
"""
from __future__ import annotations

import ast
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
PKG = ROOT / "src" / "cheongeum"

MOVES = {
    "agent_core/parser.py": "understanding/rules.py",
    "agent_core/sites.py": "understanding/sites.py",
    "agent_core/i18n.py": "language/i18n.py",
    "agent_core/orchestrator.py": "orchestrator/session.py",
    "agent_core/autopilot.py": "agents/web/autopilot.py",
    "agent_core/events.py": "core/events.py",
    "jsutil.py": "core/jsutil.py",
    "contracts/__init__.py": "core/actions.py",
    "shared/schemas.py": "core/turn.py",
    "shared/grounding.py": "safety/verify.py",
    "policy/guard.py": "safety/guard.py",
    "policy/sensitive.py": "safety/privacy.py",
    "policy/gates.py": "safety/gates.py",
    "web_agent/agent.py": "agents/web/agent.py",
    "web_agent/digest.py": "agents/web/digest.py",
    "web_agent/profile.py": "agents/web/profile.py",
    "browser_adapter": "agents/web/browser",
    "welfare_agent/agent.py": "agents/welfare/agent.py",
    "welfare_agent/discovery.py": "agents/welfare/discovery.py",
    "welfare_agent/rag.py": "agents/welfare/rag.py",
    "welfare_data": "agents/welfare/data",
    "mock_welfare/__init__.py": "practice_site/__init__.py",
    "mock_welfare/serve.py": "practice_site/serve.py",
    "mock_welfare/site": "practice_site/site",
}

REST = None
SPLITS = {
    "agent_core/llm.py": [
        (
            "core/llm.py",
            '"""\nLLM 호출(모든 단계가 함께 씀): OpenAI 호환 Chat Completions + strict json_schema.\n'
            "openai·ollama·qwen/openai-compatible. 모델 ID는 코드에 두지 않고 .env로만. 실패하면 None(호출자가 규칙으로 대체).\n"
            '의도 계획 프롬프트·스키마는 understanding/llm_planner.py.\n"""',
            {"log", "LlmConfig", "OPENAI_BASE_URL", "OLLAMA_BASE_URL", "_post_json", "_message_content", "OpenAIStructuredLlm", "create_structured_llm"},
        ),
        (
            "understanding/llm_planner.py",
            '"""\nLLM 의도 이해(보조): 규칙 파서가 먼저, LLM은 규칙이 이해 못 한 발화와 여러 명령 계획에만.\n'
            '승인·중단 의도는 LLM이 만들 수 없다.\n"""',
            REST,
        ),
    ],
    "agent_core/voice.py": [
        ("voice/errors.py", '"""STT·TTS 공급자 오류."""', {"VoiceNotSupportedError", "VoiceProviderError"}),
        (
            "voice/stt.py",
            '"""\nSTT(① 듣기): 서버가 키를 갖고 공급자를 호출하며, 클라이언트는 키를 모른다. 오디오는 저장·로그하지 않는다.\n"""',
            {"UnsupportedSttProvider", "EXTENSIONS", "audio_extension", "STT_PROMPT", "PROMPT_TERMS", "PROMPT_TERMS_EN", "is_prompt_echo", "OpenAISttProvider"},
        ),
        ("voice/tts.py", '"""\nTTS(⑥ 말하기): 서버가 키를 갖고 공급자를 호출한다. 오디오는 저장·로그하지 않는다.\n"""', {"UnsupportedTtsProvider", "OpenAITtsProvider"}),
        ("voice/config.py", '"""\nSTT·TTS 공급자 고르기. 설정하지 않으면 미지원(웹은 브라우저 음성으로 대체).\n"""', REST),
    ],
    "agent_core/personal.py": [
        (
            "personal/store.py",
            '"""\n사용자 본인의 정보(기능 4: 개인 정보 금고)와 신청 기록(기능 5: 신청 후 추적)을 두는 곳.\n'
            "- 사용자가 말해서 저장을 확인한 것만 이 컴퓨터에 둔다(파일 권한 600). 경로가 없으면 이번 대화(메모리)에서만.\n"
            '- 비밀번호·주민등록번호·계좌·카드번호는 저장하지 않는다(처리 전에 이미 가려지고, 여기서도 거부).\n"""',
            {"VAULT_KEYS", "VAULT_LABELS", "PersonalStore", "SECRET"},
        ),
        (
            "personal/commands.py",
            '"""\n금고·신청 기록 명령 이해와 기한 알림 문장.\n'
            '실제 접수 상태는 로그인해야 볼 수 있어 조회하지 않는다. 사용자가 알려 준 신청·기한을 기억했다가 알려 준다.\n"""',
            REST,
        ),
    ],
}

OLD_DIRS = ["agent_core", "contracts", "shared", "policy", "web_agent", "browser_adapter", "welfare_agent", "welfare_data", "mock_welfare"]
OLD_REEXPORT_PACKAGES = {"cheongeum.agent_core", "cheongeum.shared", "cheongeum.policy", "cheongeum.web_agent", "cheongeum.welfare_agent", "cheongeum.mock_welfare"}
OLD_INITS = {
    "cheongeum.agent_core": "agent_core/__init__.py",
    "cheongeum.shared": "shared/__init__.py",
    "cheongeum.policy": "policy/__init__.py",
    "cheongeum.web_agent": "web_agent/__init__.py",
    "cheongeum.welfare_agent": "welfare_agent/__init__.py",
}
PRACTICE_SITE_EXPORTS = {"SITE_DIR", "MockSite", "is_reachable", "start_mock_site"}

INIT_DOCS = {
    "voice": "STT·TTS 공급자(① 듣기, ⑥ 말하기). 마이크·스피커 쪽 처리(VAD·끼어들기·재생)는 브라우저 web/static에서 한다.",
    "understanding": "② 의도 이해: 규칙 파서가 먼저, LLM 계획은 보조. 사이트 이름 → 주소.",
    "language": "다국어: 외국어 발화를 한국어로 옮겨 같은 흐름으로 처리하고, 답을 다시 옮긴다.",
    "orchestrator": "③ 오케스트레이터: 세션 상태, 턴 순서, 에이전트 라우팅.",
    "agents": "④ 두 에이전트: web(Agent A, 웹 탐색·실행)과 welfare(Agent B, 복지 정보·대화).",
    "agents/web": "④ Agent A 웹 탐색·실행: 모든 조작은 PolicyGuard → 실행 → 재관찰. browser/는 Playwright 실행기.",
    "agents/welfare": "④ Agent B 복지 정보·대화: 공식 데이터만 근거로 답한다. data/는 공식 API 클라이언트와 fixture.",
    "personal": "개인 정보 금고와 신청 기록(기획 기능 4·5).",
    "safety": "⑤ 안전·검증: PolicyGuard, 동의·멈춤 문, 비식별화, 근거 검증.",
    "core": "공통 바탕: 데이터 계약(actions·turn), LLM 호출, 이벤트 기록, JS 동작 맞춤 도구(jsutil). 각 모듈에서 바로 가져다 쓴다.",
}
REEXPORT_PACKAGES = ["voice", "understanding", "language", "orchestrator", "agents/web", "agents/welfare", "personal", "safety"]
EXTRA_EXPORTS = {"cheongeum.safety.gates": ["ALLOWED_WITHOUT_CONSENT", "GateRefusal", "gate_refusal"]}

LINE_LIMIT = 160
DUPLICATE = {"log"}  # each split file gets its own logger instead of importing one


def mod_of(rel: str) -> str:
    parts = Path(rel).with_suffix("").parts
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(("cheongeum",) + parts)


def defined_names(node: ast.stmt) -> set[str]:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, ast.Assign):
        return {n.id for t in node.targets for n in ast.walk(t) if isinstance(n, ast.Name)}
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
        return {node.target.id}
    return set()


def used_names(nodes: list[ast.stmt]) -> set[str]:
    return {n.id for s in nodes for n in ast.walk(s) if isinstance(n, ast.Name)}


missing = [old for old in list(MOVES) + list(SPLITS) if not (PKG / old).exists()]
if missing:
    sys.exit(f"not the step-1 tree, missing: {missing}")
old_init_texts = {pkg: (PKG / rel).read_text(encoding="utf-8") for pkg, rel in OLD_INITS.items()}

# ---------------------------------------------------------------- 1. old → new module table
old_to_new: dict[str, list[str]] = defaultdict(list)
for old, new in MOVES.items():
    src = PKG / old
    if src.is_dir():
        for f in sorted(src.rglob("*.py")):
            r = f.relative_to(src).as_posix()
            old_to_new[mod_of(f"{old}/{r}")].append(mod_of(f"{new}/{r}"))
    else:
        old_to_new[mod_of(old)].append(mod_of(new))
for old, parts in SPLITS.items():
    old_to_new[mod_of(old)] += [mod_of(dest) for dest, _, _ in parts]
for pkg in OLD_REEXPORT_PACKAGES:
    old_to_new[pkg] = sorted({m for o, ms in old_to_new.items() if o.startswith(pkg + ".") for m in ms})
old_to_new["cheongeum.mock_welfare"] = ["cheongeum.practice_site.serve"]

# ---------------------------------------------------------------- 2. split files
for old, parts in SPLITS.items():
    text = (PKG / old).read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    body = list(ast.parse(text).body)
    assert isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
    future = [s for s in body if isinstance(s, ast.ImportFrom) and s.module == "__future__"]
    imports = [s for s in body[1:] if isinstance(s, (ast.Import, ast.ImportFrom)) and s not in future]
    stmts = [s for s in body[1:] if s not in future and s not in imports]
    prev_end = max(s.end_lineno for s in [body[0], *future, *imports])

    rest_dest = next(d for d, _, names in parts if names is REST)
    chunks: dict[str, list[tuple[ast.stmt, str]]] = defaultdict(list)
    for s in stmts:
        names = defined_names(s)
        dest = next((d for d, _, ns in parts if ns is not REST and names & ns), rest_dest)
        chunks[dest].append((s, "".join(lines[prev_end : s.end_lineno])))
        prev_end = s.end_lineno

    dup_lines = {n: "".join(lines[s.lineno - 1 : s.end_lineno]) for s in stmts for n in defined_names(s) if n in DUPLICATE}
    defined_in = {d: set().union(*(defined_names(s) for s, _ in chunks[d])) for d, _, _ in parts}
    imports_from: dict[str, set[str]] = defaultdict(set)
    import_text = "".join("".join(lines[s.lineno - 1 : s.end_lineno]) for s in imports)
    for dest, doc, _ in parts:
        own = chunks[dest]
        need = used_names([s for s, _ in own])
        cross = []
        for other, _, _ in parts:
            if other != dest:
                got = sorted(need & defined_in[other] - defined_in[dest] - DUPLICATE)
                if got:
                    imports_from[dest].add(other)
                    cross.append("from " + mod_of(other) + " import " + ", ".join(got) + "\n")
        own_dups = "".join(dup_lines[n] for n in sorted(need & DUPLICATE - defined_in[dest]))
        body_text = "".join(c for _, c in own).lstrip("\n")
        out = doc + "\nfrom __future__ import annotations\n\n" + import_text + "".join(cross) + "\n" + own_dups + "\n\n" + body_text
        target = PKG / dest
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(out, encoding="utf-8", newline="\n")
    for a, bs in imports_from.items():
        for b in bs:
            assert a not in imports_from.get(b, set()), f"import cycle between {a} and {b}"
    print(f"split {old} -> {', '.join(d for d, _, _ in parts)}")

# ---------------------------------------------------------------- 3. move files
for old, new in MOVES.items():
    src, dst = PKG / old, PKG / new
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__"))
    else:
        shutil.copy2(src, dst)
    print(f"move  {old} -> {new}")

for d in OLD_DIRS:
    shutil.rmtree(PKG / d)
(PKG / "jsutil.py").unlink()
for cache in list(PKG.rglob("__pycache__")):
    shutil.rmtree(cache)

# ---------------------------------------------------------------- 4. name index of the new tree
defs: dict[str, set[str]] = {}
for f in PKG.rglob("*.py"):
    m = mod_of(f.relative_to(PKG).as_posix())
    defs[m] = set().union(*(defined_names(s) for s in ast.parse(f.read_text(encoding="utf-8")).body))


def defining_module(old_mod: str, name: str) -> str:
    cands = [m for m in old_to_new[old_mod] if name in defs.get(m, set())]
    if len(cands) != 1:
        raise SystemExit(f"cannot place {old_mod}.{name}: {cands}")
    return cands[0]


# ---------------------------------------------------------------- 5. package inits
reexports: dict[str, list[str]] = {}
for pkg, text in old_init_texts.items():
    for s in ast.parse(text).body:
        if isinstance(s, ast.ImportFrom):
            for a in s.names:
                reexports.setdefault(defining_module(pkg, a.name), []).append(a.name)
for m, names in EXTRA_EXPORTS.items():
    reexports.setdefault(m, []).extend(names)

package_exports: dict[str, set[str]] = defaultdict(set)
package_exports["cheongeum.practice_site"] = PRACTICE_SITE_EXPORTS
for pkg_rel, doc in INIT_DOCS.items():
    pkg_mod = mod_of(pkg_rel + "/__init__.py")
    header = f'"""{doc}"""\n'
    imports_out: list[str] = []
    all_names: list[str] = []
    if pkg_rel in REEXPORT_PACKAGES:
        for m in sorted(reexports):
            if m.rsplit(".", 1)[0] == pkg_mod:
                names = sorted(set(reexports[m]), key=lambda n: (not n.isupper(), n.lower()))
                all_names += names
                package_exports[pkg_mod] |= set(names)
                line = f"from {m} import {', '.join(names)}\n"
                if len(line) > LINE_LIMIT:
                    line = f"from {m} import (\n" + "".join(f"    {n},\n" for n in names) + ")\n"
                imports_out.append(line)
    text = header
    if imports_out:
        text += "\n" + "".join(imports_out) + "\n__all__ = [\n" + "".join(f'    "{n}",\n' for n in sorted(all_names)) + "]\n"
    (PKG / pkg_rel).mkdir(parents=True, exist_ok=True)
    (PKG / pkg_rel / "__init__.py").write_text(text, encoding="utf-8", newline="\n")
    print(f"init  {pkg_rel}/__init__.py ({len(all_names)} names)")


# ---------------------------------------------------------------- 6. rewrite imports
def render(indent: str, module: str, names: list[str]) -> str:
    line = f"{indent}from {module} import {', '.join(names)}"
    if len(line) <= LINE_LIMIT:
        return line
    return f"{indent}from {module} import (\n" + "".join(f"{indent}    {n},\n" for n in names) + f"{indent})"


def target_for(old_mod: str, name: str, file_mod: str) -> str:
    dm = defining_module(old_mod, name)
    parent = dm.rsplit(".", 1)[0]
    inside = file_mod == parent or file_mod.startswith(parent + ".")
    if old_mod in OLD_REEXPORT_PACKAGES and name in package_exports.get(parent, set()) and not inside:
        return parent
    return dm


def alias_text(a: ast.alias) -> str:
    return a.name if a.asname is None else f"{a.name} as {a.asname}"


def rewrite(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    file_mod = mod_of(path.relative_to(PKG).as_posix()) if path.is_relative_to(PKG) else "__outside__"
    edits = []
    for node in ast.walk(ast.parse(text)):
        if not (isinstance(node, ast.ImportFrom) and node.level == 0 and node.module in old_to_new):
            continue
        indent = lines[node.lineno - 1][: node.col_offset]
        assert indent.strip() == "", (path, node.lineno)
        trailing = lines[node.end_lineno - 1][node.end_col_offset :].strip()
        assert trailing == "" or trailing.startswith("#"), (path, node.lineno)
        comment = f"  {trailing}" if trailing else ""
        groups: dict[str, list[str]] = {}
        for a in node.names:
            groups.setdefault(target_for(node.module, a.name, file_mod), []).append(alias_text(a))
        rendered = [render(indent, m, ns) for m, ns in sorted(groups.items())]
        new = "\n".join(r.replace("\n", comment + "\n", 1) if "\n" in r else r + comment for r in rendered) + "\n"
        edits.append((node.lineno, node.end_lineno, new))
    for start, end, new in sorted(edits, reverse=True):
        lines[start - 1 : end] = [new]
    if edits:
        path.write_text("".join(lines), encoding="utf-8", newline="\n")
    return len(edits)


def sort_cheongeum_runs(path: Path) -> None:
    """Sort and merge each run of consecutive top-level `from cheongeum... import` statements."""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    runs: list[list[ast.ImportFrom]] = []
    cur: list[ast.ImportFrom] = []
    for s in ast.parse(text).body:
        is_cheongeum = (
            isinstance(s, ast.ImportFrom)
            and s.level == 0
            and (s.module or "").startswith("cheongeum")
            and lines[s.end_lineno - 1][s.end_col_offset :].strip() == ""
        )
        if is_cheongeum and cur and s.lineno == cur[-1].end_lineno + 1:
            cur.append(s)
            continue
        if cur:
            runs.append(cur)
        cur = [s] if is_cheongeum else []
    if cur:
        runs.append(cur)
    for run in reversed(runs):
        merged: dict[str, list[str]] = {}
        for s in run:
            names = merged.setdefault(s.module, [])
            for a in s.names:
                if alias_text(a) not in names:
                    names.append(alias_text(a))
        new = "".join(render("", m, ns) + "\n" for m, ns in sorted(merged.items()))
        lines[run[0].lineno - 1 : run[-1].end_lineno] = [new]
    path.write_text("".join(lines), encoding="utf-8", newline="\n")


total = 0
touched: list[Path] = []
for base in ("src", "tests", "scripts"):
    for f in sorted((ROOT / base).rglob("*.py")):
        n = rewrite(f)
        if n:
            total += n
            touched.append(f)
for f in sorted(set(touched) | set(PKG.rglob("*.py"))):
    sort_cheongeum_runs(f)
print(f"rewrote {total} import statements in {len(touched)} files")
