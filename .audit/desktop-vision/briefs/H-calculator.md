# Brief H: 계산기 by voice, buttons pressed by name (Milestone 4, app 8, calculator half)

Worktree: `C:\Users\user\Desktop\voice-welfare-desktop` (branch feat/desktop-vision), uncommitted. Everything built so far is there: folders, files, sound, status, windows, notes, settings. Read `CLAUDE.md` (the desktop bullet), `core/apps.py`, `core/desktop.py` (`AppAction`, `_TARGETS`), `safety/guard.py` `_check_app`, `agents/desktop/{port,win32,agent,skill}.py`, `tests/fakes/desktop_port.py` first; follow their patterns. Unit suite at start: 1803 passed, 11 skipped. Full suite at start: 1998 passed.

The plan row: "메모장, 계산기: dictate into a window, press buttons by name. Proves named control of a real window." This unit does the calculator only. Notepad stays not-yet (Windows 11 Notepad opens files as tabs in the owner's existing windows, so typing could land in their documents; that needs its own spike with the owner's go).

## Measured (spike S7, `C:\Users\user\Desktop\voice-welfare\.audit\desktop-vision\spikes\` will hold `s7_calc.py`)
- `%SystemRoot%\System32\calc.exe` opened a NEW Calculator window in about 1 s (class `ApplicationFrameWindow`, name contains "계산기"); none existed before.
- A UIA walk found 36 buttons in 85 ms with stable AutomationIds and Korean names, for example: num0Button "공", num1Button "1" … num9Button "9", plusButton "더하기", minusButton "빼기", multiplyButton "곱", divideButton "나누기", equalButton "일치", decimalSeparatorButton "소수점 구분 기호", negateButton "양수 음수", percentButton "백분율", clearButton "지우기", clearEntryButton "입력 지우기", backSpaceButton "백스페이스", squareRootButton "제곱근", xpower2Button "제곱".
- `InvokePattern.Invoke()` on num1, plus, num2, equal made the text control `AutomationId=CalculatorResults` read "표시는 3". `WindowPattern.Close()` closed only that window.

## What a user can say
```
"계산기 열어줘"                    → opens 청음's own Calculator window; "계산기를 열었어요. '3 더하기 5'처럼 말씀해 주세요."
"3 더하기 5" / "계산기로 12 곱하기 3 해줘" / "100 나누기 4는?"   → presses the buttons by id in 청음's Calculator, reads the display: "결과는 8이에요."
"지워줘" (on the calculator surface) → clear
"계산기 버튼 뭐 있어?"             → reads the button names in groups
```
Spoken numbers: digits as said ("12", "3.5"), Korean number words for simple cases (영, 일 … 구, 십, 백, 천, 만 combinations) if cheap; otherwise ask the user to say digits. Operators: 더하기, 빼기, 곱하기/곱, 나누기, and "의 제곱", "제곱근" optional. Anything else is not guessed: ask back.

## Design decisions (made; follow them)
- The calculator row in `core/apps.py` becomes control with verbs `launch_app` and `press_keys`. The program is launched only from a fixed table entry resolved to an absolute path through a known folder (FOLDERID_System for calc.exe); add whatever closed field `AppSpec` needs for that (for example a `(known_folder_guid, file_name)` pair) and keep `launch` relative names out of the port (the port refuses relative paths by design).
- `AppAction` gains one closed field for this verb: `keys: list[CalcKey]` where `CalcKey` is a Literal of the AutomationIds above (one table in `core/apps.py` or a new `core/calculator.py`: id, spoken name, the token it stands for). `_TARGETS`: `press_keys` requires `keys` (1 to 40 keys). The guard needs no new branch beyond the verb table. Low risk.
- The port gains `launch_window(program) -> handle | error` (launch and claim the NEW window, never one that existed before, like `show_folder` claims its Explorer window), `press(handle, keys) -> PortResult` (Invoke by AutomationId only, inside the claimed window only), `read_display(handle) -> str | None`, `buttons(handle) -> list[(id, name)] | None`. UIA through comtypes (generate the UIAutomationCore wrappers with `comtypes.client.GetModule`) on the existing COM worker thread with the same timeouts; add the `uiautomation` package only if comtypes cannot do it, and say why. Only `win32.py` touches Windows APIs (the structure test enforces it).
- Parsing speech to keys is pure code (`agents/desktop/calculator.py` or similar): tokens → key ids, then `equalButton`; display text "표시는 3" → "3" (strip the label; handle Korean and English labels, commas, negative numbers, "0으로 나눌 수 없습니다" style errors spoken as-is).
- Surface: the calculator is desktop surface (APP_OPEN) with a calculator kind in the tagged state, so "지워줘" and a bare expression go to the calculator only while it is the current surface. A bare expression said anywhere else keeps its current meaning; check with the parity harness.
- If the owner closes the Calculator window, the next request says so and offers to open it again (no silent relaunch).
- History: expressions and results are not personal; `historySpeech` may keep them.

## Tests
Unit with FakeDesktopPort (fake gains a calculator: records pressed keys, returns a scripted display): parsing table (digits, decimals, operators, Korean number words if built, refusals), key sequence for each sentence, display parsing table, window closed by the owner, guard table (unknown key → DENIED_SCHEMA, 41 keys → DENIED_SCHEMA, press before launch).
Parity: run `.audit\desktop-vision\codemods\s4_parity.py` (add your sentences to a copy) and report every changed old reading.
E2E: `tests/e2e/test_desktop_session.py` gains the calculator path through `handle_turn` with the fake.
Opt-in real test `tests/desktop/test_win32_calculator.py` (marker `desktop`, `DESKTOP_TESTS=1`): launch, press 12 × 3 =, read "36", close only the window it opened. Run it once (it opens and closes one Calculator window; touch no other window) and paste the output.
E2E runs: `PYTHONPATH=C:\Users\user\Desktop\voice-welfare\.audit\desktop-vision\codemods MOCK_SITE_WAIT_S=5 uv run pytest -p reuse_mock tests/e2e/test_desktop_session.py`.

## Files you may touch
`core/apps.py`, `core/desktop.py`, a new `core/calculator.py` if you want it, `core/intents.py`, `understanding/rules.py`, `understanding/llm_planner.py`, `agents/desktop/*`, `speech/system.py` or a new `speech/calculator.py`, `orchestrator/session.py` (routes only), `tests/**`, `pyproject.toml`/`uv.lock` only if a dependency is truly needed.

## Done when
Unit suite green; parity diff reported; e2e desktop session green; the opt-in calculator test passed once with output in the report.
