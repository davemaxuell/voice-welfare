"""실제 시나리오와 pytest의 공개 세션 호출을 세 번 기록해 재생용 대조 자료를 만든다."""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import hashlib
import json
import re
import runpy
import subprocess
import sys
import tempfile
from contextlib import ExitStack, redirect_stdout
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))
from conftest import create_test_runtime
from cheongeum.agents.web.browser import stop_playwright
from cheongeum.agents.web.profile import FieldProfile
from cheongeum.core import jsutil
from cheongeum.evaluation import DEMO_SCENARIO_PATH, SYNTHETIC_SCENARIO_PATH, load_scenario_file, run_scenario
from cheongeum.personal import action_log, commands, dialogue
from cheongeum import practice_site
from cheongeum.practice_site import ensure_mock_site
from cheongeum.server.runtime import AgentRuntime

FIXTURES = ROOT / "tests/fixtures/transcripts"
PROBE = ROOT / ".audit/evidence/u7u8_probe.py"
CALLS = ("handle_turn", "confirm", "consent_to", "cancel", "set_language")
SLOTS = ("approval", "awaiting", "clarification", "profile_question", "vault_confirm", "guided", "auth_resume")
UUID = re.compile(r"\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b", re.I)
REF = re.compile(r"\b(?:r\d+|cheongeum-\d+)-[a-z0-9]{4}\b")
RECEIPT = re.compile(r"MOCK-\d{8}-\d{4}")
DAY = "2026-11-18"


class FixedDate(date):
    @classmethod
    def today(cls):
        return cls.fromisoformat(DAY)


class FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        instant = datetime(2026, 11, 18, 3, tzinfo=timezone.utc)
        return instant.astimezone(tz) if tz else instant.replace(tzinfo=None)


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class Normalizer:
    def __init__(self):
        self.ids = {}
        self.refs = {}

    def ordinal(self, value):
        return self.ids.setdefault(value, f"$id{len(self.ids) + 1}")

    def clean(self, value, key=""):
        if key == "reply":
            # 모델이 반환한 명시적 null도 그대로 재생한다.
            return value
        if isinstance(value, FieldProfile):
            # 되묻기 후보는 프로필의 필드 참조다. 호출 가능한 검증기는 실행 코드다.
            value = {"fieldId": value.field_id}
        elif dataclasses.is_dataclass(value):
            value = dataclasses.asdict(value)
        if isinstance(value, dict):
            return {k: self.clean(value[k], k) for k in sorted(value) if value[k] is not None and k not in {"atMs", "latencyMs"}}
        if isinstance(value, (tuple, list)):
            return [self.clean(x) for x in value]
        if isinstance(value, str):
            if key == "id" and re.fullmatch(r"\d{13}", value):
                return self.ordinal(value)
            text = UUID.sub(lambda m: self.ordinal(m[0]), value)
            text = REF.sub(lambda m: self.refs.setdefault(m[0], f"$ref{len(self.refs) + 1}"), text)
            return RECEIPT.sub("$receipt", text)
        return value


def personal(session):
    store = session._personal
    return {"vault": store.vault(), "applications": store.applications(), "speech": store.speech(), "allowedSites": store.allowed_sites()}


def log_rows(session):
    log = session.deps.action_log
    if log is None:
        return []
    # prev/hash는 날짜와 승인 ID에도 의존한다. 의미 있는 입력과 각 쓰기의 순서를 대조한다.
    return [{k: v for k, v in row.items() if k not in {"prev", "hash", "at", "day"}} for row in log.recent(10_000)]


def llms(session):
    deps = session.deps
    return {"default": deps.llm, "goal": deps.goal_llm, "web": deps.web_llm, "welfare": deps.welfare.llm}


class SessionRecording:
    def __init__(self, case, runtime, session):
        self.normal = Normalizer()
        self.session = session
        self.rows = [self.normal.clean({
            "kind": "session", "case": case, "calendarDay": DAY,
            "config": {k: getattr(runtime.config, k) for k in (
                "mockSiteUrl", "searchUrlTemplate", "requireConsent", "practiceMode", "readOnlyClicks", "readOnlyWeb"
            )},
            "initialPersonal": personal(session), "actionLogEnabled": session.deps.action_log is not None,
        })]
        for name in CALLS:
            setattr(session, name, self.wrap(name, getattr(session, name)))

    def trace_llms(self, stack, calls):
        roles = llms(self.session)
        for model in {id(model): model for model in roles.values() if model is not None}.values():
            original = model.generate

            async def generate(*args, _original=original, **kw):
                call = {"schemaName": kw["schemaName"], "user": kw["user"],
                        "systemHash": hashlib.sha256(kw["system"].encode()).hexdigest()}
                calls.append(call)
                try:
                    reply = await _original(*args, **kw)
                except Exception as exc:
                    call["error"] = {"name": type(exc).__name__, "message": str(exc)}
                    raise
                call["reply"] = {"value": reply} if reply is not None else {}
                return reply

            stack.enter_context(patch.object(model, "generate", generate))
        return sorted(role for role, model in roles.items() if model is not None)

    def wrap(self, name, original):
        def finish(args, result, roles, calls, before):
            row = {"kind": "turn", "call": {"method": name, "args": list(args)},
                   "roles": roles, "llm": calls, "result": result,
                   "slots": {k: getattr(self.session.dialogue, k) for k in SLOTS},
                   "personal": personal(self.session), "actionLog": log_rows(self.session)[before:]}
            self.rows.append(self.normal.clean(row))
            return result

        if name == "cancel":
            def run_sync(*args):
                before = len(log_rows(self.session))
                with ExitStack() as stack:
                    calls = []
                    roles = self.trace_llms(stack, calls)
                    return finish(args, original(*args), roles, calls, before)
            return run_sync

        async def run_async(*args):
            before = len(log_rows(self.session))
            with ExitStack() as stack:
                calls = []
                roles = self.trace_llms(stack, calls)
                result = await original(*args)
                return finish(args, result, roles, calls, before)
        return run_async


# 공개 호출로 같은 조건을 만들 수 없는 테스트. 테스트 함수 이름은 매개변수 확장 전에 대조한다.
SUITE_REASONS = {"test_api": "HTTP", "test_web_ui": "UI", "test_shared_browser": "adapter",
                 "test_history_safety": "adapter", "test_slow_pages": "timing"}
EXCLUSIONS = {
    "adapter": {"test_assist_fill_dropped_when_the_field_changed", "test_auth_done_speaks_title_and_resumes_pending_form",
                "test_login_click_is_dropped_when_the_button_changed", "test_cloned_elements_get_their_own_ref",
                "test_changed_element_is_not_clicked", "test_elements_are_classified_for_the_guard",
                "test_value_changed_after_read_back_cancels_mock_submit"},
    "patch": {"test_other_service_context_does_not_open_disability_form", "test_real_site_mode",
              "test_approval_after_two_minutes_reads_the_summary_again", "test_timed_out_mock_submit_is_not_sent_again",
              "test_timed_out_mock_submit_that_went_through_reports_the_receipt", "test_timed_out_low_risk_click_is_retried_once",
              "test_web_answer_hides_resident_number_from_llm"},
    "timing": {"test_stop_interrupts_inflight_and_blocks_later", "test_progress_question_mid_goal_names_the_current_step",
               "test_stop_still_interrupts_a_goal", "test_voice_tab_click_reads_revealed_text_quickly",
               "test_slow_tab_panel_is_read_after_it_loads", "test_rotating_notice_is_not_read_as_the_click_effect",
               "test_content_that_arrived_late_does_not_hide_the_next_click", "test_link_acting_as_tab_finishes_quickly",
               "test_link_inside_popup_can_be_pressed", "test_rotating_notice_does_not_cancel_an_approval"},
    "portal2-autopilot": {"test_menu_buttons_reach_the_model", "test_clicks_elements_missed_before", "test_tab_reveals_its_panel",
                          "test_expander_opens_in_place", "test_find_moves_the_text_window", "test_nothing_changed_is_reported",
                          "test_safe_mode_allows_information_tabs_only"},
}


class Recorder:
    def __init__(self):
        self.current = None
        self.records = {}
        self.exclusions = {}
        self.collected = set()

    def pytest_collection_modifyitems(self, config, items):
        kept, dropped = [], []
        for item in items:
            reason = SUITE_REASONS.get(item.path.stem) or next((why for why, names in EXCLUSIONS.items() if item.originalname in names), None)
            if reason:
                self.exclusions[item.nodeid] = reason
                dropped.append(item)
            else:
                self.collected.add(item.nodeid)
                kept.append(item)
        config.hook.pytest_deselected(items=dropped)
        items[:] = kept

    def pytest_runtest_setup(self, item):
        self.current = item.nodeid

    def hook(self, original):
        owner = self

        async def create(runtime):
            caller = sys._getframe(1)
            case = owner.current
            if caller.f_code.co_filename == str(PROBE):
                case = "probe/" + caller.f_locals["name"]
                if any(isinstance(step, tuple) and step[0] == "patch" for step in caller.f_locals["steps"]):
                    owner.exclusions[case] = "patch"
            if case is None or case in owner.records:
                raise ValueError(f"세션 기록 이름 중복 또는 누락: {case}")
            session = await original(runtime)
            recording = SessionRecording(case, runtime, session)
            owner.records[case] = recording.rows
            return session
        return create

    async def scenarios(self):
        site = ensure_mock_site(5174)
        runtime = create_test_runtime()
        # 봉인 파일 없이도 기록의 쓰기 순서·승인 ID를 검사한다.
        try:
            for file in (DEMO_SCENARIO_PATH, SYNTHETIC_SCENARIO_PATH):
                for scenario in load_scenario_file(file).scenarios:
                    self.current = "scenario/" + scenario.id
                    runtime._personal = None
                    runtime._action_log = action_log.ActionLog()
                    s = await runtime.create_session()
                    try:
                        await run_scenario(scenario, s)
                    finally:
                        await s.close()
        finally:
            await runtime.close()
            await stop_playwright()
            if site:
                site.close()

    def run(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(AgentRuntime, "create_session", self.hook(AgentRuntime.create_session)))
            for module in (action_log, commands, dialogue):
                stack.enter_context(patch.object(module, "date", FixedDate))
            stack.enter_context(patch.object(jsutil, "datetime", FixedDateTime))
            result = pytest.main(["-q", "--tb=short", str(ROOT / "tests/e2e")], plugins=[self])
            if result != pytest.ExitCode.OK:
                raise RuntimeError(f"pytest: {result}")
            if missing := self.collected - self.records.keys():
                raise ValueError(f"재생 대상으로 분류했지만 세션이 없습니다: {sorted(missing)}")
            asyncio.run(self.scenarios())
            self.current = None
            stack.enter_context(patch.object(sys, "argv", [str(PROBE), str(ROOT / "src"), "5174"]))
            # 같은 체크아웃 서버가 이미 떠 있을 때는 probe도 재사용하고 종료 권한은 원래 실행자에게 둔다.
            stack.enter_context(patch.object(practice_site, "start_mock_site", lambda port: ensure_mock_site(port) or ExitStack()))
            with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as quiet, redirect_stdout(quiet):
                runpy.run_path(str(PROBE), run_name="__main__")
        return {"cases": self.records, "exclusions": self.exclusions}


def stable(values, path, unstable):
    """세 번의 값이 다른 가장 작은 경로를 남긴다. 같은 모양인 배열·객체의 다른 항목은 계속 검사한다."""
    first = values[0]
    if all(first == value for value in values[1:]):
        return first
    if all(isinstance(value, dict) for value in values):
        merged = {}
        for key in sorted(set().union(*values)):
            field = [*path, key]
            if all(key in value for value in values):
                merged[key] = stable([value[key] for value in values], field, unstable)
            else:
                unstable.append(field)
        return merged
    if all(isinstance(value, list) and len(value) == len(first) for value in values):
        return [stable([value[i] for value in values], [*path, i], unstable) for i in range(len(first))]
    unstable.append(path)
    return None


def slice_for(case, rows):
    intents = {token for row in rows[1:] for token in re.findall(r"[A-Z_]+", row["result"]["intentType"])}
    actions = {row["result"]["semanticAction"] for row in rows[1:]}
    if any(i.startswith(("PERSONAL_", "VAULT_", "GUARDIAN_")) for i in intents) or "SET_LANGUAGE" in intents or "multilingual" in case:
        return "PR8d"
    if intents & {"GOAL", "LOGIN", "AUTH_DONE", "SECRET_DISCLOSURE"} or actions & {"auth-handoff", "web-task"} or "autopilot" in case:
        return "PR8c"
    if intents & {"START_APPLICATION", "FILL", "GUIDED_FILL", "READ_FIELD", "EDIT_FIELD", "NEXT", "PREV",
                  "REVIEW", "PRECHECK", "PREPARE_SUBMIT", "APPROVE", "REJECT", "DISCOVER", "PROFILE_ANSWER",
                  "POLICY_QUESTION", "SERVICE_DETAIL"} or "welfare-retrieval" in actions:
        return "PR8b"
    return "PR8a"


def filename(case):
    # pytest가 이스케이프한 한글 매개변수는 Windows 파일 이름 길이를 넘을 수 있다.
    slug = re.sub(r"[^\w.-]+", "-", case.split("[")[0]).strip("-")
    return f"{slug}-{hashlib.sha256(case.encode()).hexdigest()[:12]}.jsonl"


def publish(runs):
    first = runs[0]
    if any(set(run["cases"]) != set(first["cases"]) or run["exclusions"] != first["exclusions"] for run in runs):
        raise ValueError("회차별로 수집한 사례가 다릅니다.")
    FIXTURES.mkdir(parents=True, exist_ok=True)
    index = []
    with tempfile.TemporaryDirectory(dir=FIXTURES.parent) as work:
        staging = Path(work)
        for case, rows in sorted(first["cases"].items()):
            recordings = [run["cases"][case] for run in runs]
            if len(rows) < 2 or any(len(other) != len(rows) for other in recordings):
                raise ValueError(f"턴 수가 일정하지 않거나 기록이 비었습니다: {case}")
            stable_rows = []
            for turns in zip(*recordings, strict=True):
                # 같은 화면을 반복해서 보는 횟수는 응답 속도에 달렸다. 단계의 순서와 메모는 남긴다.
                for sample in turns:
                    if sample["kind"] == "turn":
                        trace = sample["result"]["trace"]
                        sample["result"]["trace"] = [step for i, step in enumerate(trace)
                            if i == 0 or step != trace[i - 1] or step.get("phase") != "OBSERVING"]
                unstable = []
                row = stable(turns, [], unstable)
                if unstable:
                    # 입력이나 모델 호출 순서까지 달라졌으면 이 사례로 순차 재생할 수 없다.
                    if any(path[0] in {"call", "roles", "llm", "kind"} for path in unstable):
                        raise ValueError(f"{case}: 호출이 달라졌습니다: {unstable}")
                    row["unstable"] = unstable
                stable_rows.append(row)
            file = filename(case)
            entry = {"case": case, "file": file, "slice": slice_for(case, rows), "turns": len(rows) - 1}
            if case in first["exclusions"]:
                entry["excluded"] = first["exclusions"][case]
            index.append(entry)
            (staging / file).write_bytes(("".join(dump(row) + "\n" for row in stable_rows)).encode())
        doc = {"cases": index, "exclusions": first["exclusions"]}
        (staging / "index.json").write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode())
        for new in staging.iterdir():
            new.replace(FIXTURES / new.name)
        filenames = {entry["file"] for entry in index}
        for old in FIXTURES.glob("*.jsonl"):
            if old.name not in filenames:
                old.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-pass", type=Path, help=argparse.SUPPRESS)
    opts = parser.parse_args()
    if opts.record_pass:
        opts.record_pass.write_text(dump(Recorder().run()), encoding="utf-8")
        return
    # pytest·Playwright·개인 정보 저장소가 새 프로세스에서 빈 상태로 시작한다.
    with tempfile.TemporaryDirectory() as folder:
        runs = []
        for n in range(3):
            path = Path(folder) / f"{n}.json"
            subprocess.run([sys.executable, __file__, "--record-pass", str(path)], cwd=ROOT, check=True)
            runs.append(json.loads(path.read_text(encoding="utf-8")))
        publish(runs)
        print(f"세션 대조 자료 {len(runs[0]['cases'])}개를 세 번 기록했습니다.")


if __name__ == "__main__":
    main()
