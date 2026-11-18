"""pytest·시나리오·받아쓰기 말뭉치에서 실제 Python 호출을 모아 TypeScript 대조 자료를 만든다."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import inspect
import json
import os
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from functools import wraps
from importlib import import_module
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
TARGETS = {
    "understanding.rules": "RuleBasedIntentProvider.parse_sync RuleBasedIntentProvider.split_commands is_stop_utterance is_progress_question clean_value",
    "understanding.filters": "strip_address short_reply_kind split_questions vague_question is_question_like strip_filler",
    "understanding.chat": "chat_route",
    "understanding.sites": "site_name_from mentions_known_site near_site site_label resolve_site",
    "language.i18n": "foreign_confirmation detect_lang_switch detect_script_lang",
    "safety.privacy": "detect_sensitive redact_text",
    "speech.phrasing": "josa speak_label speak_date chunk_text readback",
    "safety.verify": "quote_in_source unsupported_numbers check_grounding",
    "safety.guard": "PolicyGuard.check",
    "agents.web.digest": "digest_page",
    "agents.web.effect": "diff_views Churn.observe",
    "agents.web.auth_page": "auth_page_kind",
    "agents.web.approval": "fingerprint",
    "agents.welfare.rag": "retrieve",
    "agents.welfare.discovery": "parse_profile_answer next_profile_slot match_services",
    "agents.welfare.agent": "application_open_status",
    "personal.commands": "parse_personal_command",
}


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":"))


def wire(value):
    if dataclasses.is_dataclass(value):
        return {f.name: wire(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {k: wire(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [wire(v) for v in value]
    if isinstance(value, (frozenset, set)):
        return sorted(map(wire, value), key=dumps)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"대조 자료로 변환할 수 없음: {type(value).__name__}")


UUID = re.compile(r"\b[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\b", re.I)
DOM_REF = re.compile(r"\b(r\d+|cheongeum-\d+)-[a-z\d]{4}\b")
RECEIPT = re.compile(r"\bMOCK-\d{8}-\d{4}\b")
CAPTURE_DATE = re.compile(r'("capturedAt":")\d{4}-\d\d-\d\dT[\d:.]+Z"')
TICKER = re.compile(r"알림: 전산 점검 안내 (\d+)호")
REFERENCE_DAY = date(2026, 11, 18)
STOP_RACE = "test_safety.py::test_stop_interrupts_inflight_and_blocks_later"
MOCK_ORIGINS = ("http://localhost:5174/", "http://127.0.0.1:5174/")


class ReferenceDate(date):
    @classmethod
    def today(cls):
        return REFERENCE_DAY


class ReferenceDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        instant = datetime(2026, 11, 18, 3, tzinfo=timezone.utc)
        return instant.astimezone(tz) if tz is not None else instant.replace(tzinfo=None)


def canonical(row):
    # 브라우저와 Python이 새로 붙인 식별자는 한 호출 안의 참조 관계를 유지한다.
    line = dumps(row)
    ids = {}
    refs = defaultdict(dict)

    def uuid(match):
        ordinal = ids.setdefault(match[0], len(ids) + 1)
        return f"00000000-0000-4000-8000-{ordinal:012d}"

    def ref(match):
        names = refs[match[1]]
        ordinal = names.setdefault(match[0], len(names))
        return f"{match[1]}-{ordinal:04d}"

    line = UUID.sub(uuid, line)
    line = DOM_REF.sub(ref, line)
    line = RECEIPT.sub("MOCK-20000101-0000", line)
    # portal2의 배너는 700ms마다 증가한다. 두 관찰 사이에서 번호가 바뀌었는지는 보존한다.
    ticks = {n: i for i, n in enumerate(sorted(set(map(int, TICKER.findall(line)))), start=1)}
    line = TICKER.sub(lambda m: f"알림: 전산 점검 안내 {ticks[int(m[1])]}호", line)
    return CAPTURE_DATE.sub(r'\g<1>2000-01-01T00:00:00.000Z"', line)


class RecordedLlm:
    def __init__(self, llm):
        self.llm = llm
        self.calls = []

    async def generate(self, **kwargs):
        value = await self.llm.generate(**kwargs)
        self.calls.append({"schemaName": kwargs["schemaName"], "response": wire(value)})
        return value


def call_inputs(name, bound):
    args = dict(bound.arguments)
    if "self" in args:
        receiver = args.pop("self")
        if name.startswith("RuleBasedIntentProvider."):
            args["vocabulary"] = [v["alias"] for v in receiver.aliases]
        elif name == "PolicyGuard.check":
            args["config"] = receiver.config
        elif name == "Churn.observe":
            args["state"] = wire(receiver)
            args["idle"] = args["idle_prev"] is not None
            # 이 상태 기계가 비교하는 것은 페이지(주소·제목)와 본문 줄이다.
            for key in ("view", "idle_prev"):
                view = args[key]
                if view is not None:
                    args[key] = {"url": view["url"], "title": view["title"],
                                 "outline": {"mainText": (view.get("outline") or {}).get("mainText")}}
    if name == "readback":
        field = args["field_"]
        args["field_"] = {f.name: getattr(field, f.name) for f in dataclasses.fields(field) if f.name != "validate"}
    if name == "parse_personal_command":
        args["today"] = REFERENCE_DAY.isoformat()
    if "llm" in args:
        model = args["llm"]
        args["llm"] = None if model is None else model.calls
    if "signal" in args:
        signal = args["signal"]
        args["signal"] = None if signal is None else {"aborted": signal.aborted}
    return args


def unstable_browser_sample(name, args):
    # 모의 HTML에는 모두 title이 있다. 이동 직후 아직 문서가 없는 순간은 폴링 속도에 달렸다.
    for key in ("before", "after", "view", "idle_prev"):
        view = args.get(key)
        if view and view.get("url", "").startswith(MOCK_ORIGINS) and view.get("title") == "" and not (view.get("outline") or {}).get("mainText"):
            return True
    if name == "Churn.observe":
        page = args["state"]["page"]
        if page and page[0].startswith(MOCK_ORIGINS) and page[1] == "":
            return True
    if name == "diff_views":
        # 회전 배너를 누르는 e2e에서 폴링 중간의 글 조합은 달라진다.
        # test_effect.py에서 배너만 바뀐 경우와 누른 곳도 바뀐 경우를 각각 기록한다.
        return all(v.get("url", "").startswith(MOCK_ORIGINS) and "rotate=1" in v["url"]
                   for v in (args["before"], args["after"]))
    return False


class Recorder:
    def __init__(self):
        self.rows = defaultdict(set)
        self.seen = set()
        self.errors = set()

    def wrap(self, module, name, original):
        signature = inspect.signature(original)
        identity = f"{module}.{name}"

        def save(args, result):
            # 중단 경합 테스트는 각 실행에서 서로 다른 호출 사이에 멈춘다. 테스트 자체는 전부 실행한다.
            if os.environ.get("PYTEST_CURRENT_TEST", "").split(" ", 1)[0].endswith(STOP_RACE):
                return
            if module == "agents.web.effect" and unstable_browser_sample(name, args):
                return
            try:
                self.rows[module].add(canonical({"fn": identity, "args": wire(args), "result": wire(result)}))
                self.seen.add(identity)
            except Exception as exc:
                # 호출자가 예외를 복구해도 기록 자체의 실패를 놓치지 않는다.
                self.errors.add(f"{identity}: {exc}")
                raise

        if inspect.iscoroutinefunction(original):
            @wraps(original)
            async def capture_async(*args, **kwargs):
                bound = signature.bind(*args, **kwargs)
                bound.apply_defaults()
                if bound.arguments["llm"] is not None:
                    bound.arguments["llm"] = RecordedLlm(bound.arguments["llm"])
                inputs = call_inputs(name, bound)
                result = await original(*bound.args, **bound.kwargs)
                save(inputs, result)
                return result
            return capture_async

        @wraps(original)
        def capture(*args, **kwargs):
            bound = signature.bind(*args, **kwargs)
            bound.apply_defaults()
            inputs = call_inputs(name, bound)
            result = original(*args, **kwargs)
            if module == "safety.privacy":
                privacy = sys.modules["cheongeum.safety.privacy"]
                if privacy._finder is not None and inputs.get("model", True):
                    return result
                if name == "detect_sensitive":
                    inputs["model"] = False
            if name == "Churn.observe":
                churn = bound.arguments["self"]
                save(inputs, {"state": churn, "volatile": churn.volatile()})
            elif name == "application_open_status" and inputs["today"] is None:
                # 오늘을 받는 테스트는 PR0의 한국 날짜 경계까지 검증한다.
                inputs["today"] = original.__globals__["today_iso"]()
                save(inputs, result)
            else:
                save(inputs, result)
            return result
        return capture

    @contextlib.contextmanager
    def installed(self):
        aliases = {}
        with contextlib.ExitStack() as patches:
            for module, names in TARGETS.items():
                source = import_module(f"cheongeum.{module}")
                for name in names.split():
                    owner = source
                    *parents, attr = name.split(".")
                    for parent in parents:
                        owner = getattr(owner, parent)
                    original = getattr(owner, attr)
                    wrapper = self.wrap(module, name, original)
                    aliases[id(original)] = (original, wrapper)
                    patches.enter_context(patch.object(owner, attr, wrapper))
            for module, imported in tuple(sys.modules.items()):
                if imported is None or not module.startswith("cheongeum"):
                    continue
                for attr, value in tuple(vars(imported).items()):
                    alias = aliases.get(id(value))
                    if alias is not None and value is alias[0]:
                        patches.enter_context(patch.object(imported, attr, alias[1]))
            # 날짜가 바뀐 뒤에도 같은 발화의 신청 기간·상대 기한을 재현한다.
            patches.enter_context(patch("cheongeum.core.jsutil.datetime", ReferenceDatetime))
            patches.enter_context(patch("cheongeum.personal.commands.date", ReferenceDate))
            patches.enter_context(patch("cheongeum.personal.dialogue.date", ReferenceDate))
            yield

    def write(self, out):
        inventory = {module: [f"{module}.{name}" for name in names.split()] for module, names in TARGETS.items()}
        missing = {fn for names in inventory.values() for fn in names} - self.seen
        if self.errors or missing:
            raise ValueError(f"기록 실패: {sorted(self.errors)}, 누락: {sorted(missing)}")
        out.mkdir(parents=True, exist_ok=True)
        for module, rows in self.rows.items():
            (out / f"{module}.jsonl").write_text("\n".join(sorted(rows)) + "\n", encoding="utf-8", newline="\n")
        (out / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"oracle: {len(self.seen)} functions, {sum(map(len, self.rows.values()))} cases")


async def feed_corpus():
    from regex_trace import corpus_texts
    from cheongeum.understanding import filters, rules, sites
    from cheongeum.agents.web.profile import create_mock_welfare_profile, field_vocabulary
    from cheongeum.agents.welfare import discovery
    from cheongeum.language import i18n
    from cheongeum.personal import commands
    from cheongeum.safety import privacy
    from cheongeum.speech import phrasing

    vocabulary = field_vocabulary(create_mock_welfare_profile("http://localhost:5174"))
    parser = rules.RuleBasedIntentProvider(vocabulary)
    for text in corpus_texts():
        parser.parse_sync(text, rules.IntentContext(state="IDLE"))
        parser.split_commands(text)
        rules.is_stop_utterance(text)
        rules.is_progress_question(text)
        rules.clean_value(text)
        filters.strip_address(text)
        filters.short_reply_kind(text)
        filters.strip_filler(text)
        filters.is_question_like(text)
        filters.vague_question(text)
        await filters.split_questions(None, text, [], None)
        sites.resolve_site(text)
        sites.near_site(text)
        sites.mentions_known_site(text)
        sites.site_name_from(text)
        i18n.detect_lang_switch(text)
        i18n.detect_script_lang(text)
        for lang in ("en", "zh", "ja", "ko"):
            i18n.foreign_confirmation(text, lang)
        privacy.detect_sensitive(text, model=False)
        privacy.redact_text(text)
        phrasing.josa(text, "은", "는")
        phrasing.chunk_text(text, 0)
        phrasing.speak_label(text)
        discovery.parse_profile_answer(text)
        commands.parse_personal_command(text)


def main():
    import pytest
    from run_scenarios import main as run_scenarios

    options = argparse.ArgumentParser()
    options.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/oracle")
    args = options.parse_args()
    recorder = Recorder()
    with recorder.installed():
        if pytest.main([str(ROOT / "tests"), "-q"]) != 0:
            raise SystemExit("pytest 실패")
        if asyncio.run(run_scenarios()) != 0:
            raise SystemExit("시나리오 실패")
        asyncio.run(feed_corpus())
    recorder.write(args.output)


if __name__ == "__main__":
    main()
