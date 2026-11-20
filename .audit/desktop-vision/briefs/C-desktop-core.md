# Brief C: desktop core (plan units U3 and U5), no wiring

Worktree: `C:\Users\user\Desktop\voice-welfare-apps` (branch feat/dv-apps, at 072710a, clean). Unit suite at start: 692 passed, 10 skipped.
Two other delegates work in other worktrees: one refactors `agents/web/agent.py`, `orchestrator/` and the skills; one adds picture code (`core/llm.py`, `core/picture.py`, browser capture).
Your diff will be merged with theirs, so stay inside the files listed here. Intents, rules, the desktop agent, the OS port and session wiring are later units, not yours.

## Files you may touch
New: `src/cheongeum/core/apps.py`, `src/cheongeum/core/desktop.py`, `src/cheongeum/agents/desktop/__init__.py`, `src/cheongeum/agents/desktop/explorer.py`, `src/cheongeum/speech/apps.py`, tests below.
Edit: `src/cheongeum/safety/guard.py` (one app branch), `src/cheongeum/core/turn.py` (contracts below), `src/cheongeum/web/static/*.js` only if it hard-codes the list of session states, `tests/unit/test_layers.py`.
Do NOT touch `agents/web/`, `orchestrator/`, `core/llm.py`, `core/actions.py` web models, `understanding/`, `core/intents.py`, `server/`.

## Owner decisions that apply
- Desktop control is a closed set of named actions. Code builds every OS call from a table. The model never writes a command, a path or a key chord.
- "다운로드 폴더" means the Windows Downloads folder.
- Reading a file's text never asks. Opening a file in its program asks when the file came from the internet or its kind is unknown. Programs, scripts and shortcuts are never opened by voice.
- Banking, certificate and identity-verification apps are never handled.

## U3. App table, app action, guard branch, contracts
`core/apps.py` (the allowlist, the name resolver's source and the source of every launch):
```python
AppTier = Literal["control", "not-yet", "never"]     # control: verbs below are allowed; not-yet: "아직 열 수 없어요"; never: 청음 does not handle it
AppVerb = Literal["launch_app", "show_folder", "open_file", "read_file"]
@dataclass(frozen=True)
class AppSpec:
    id: str; label: str; names: tuple[str, ...]; tier: AppTier; verbs: frozenset[str]
    launch: tuple[str, ...]          # fixed argv, e.g. ("explorer.exe",); empty when tier != control
    picture: Literal["never", "ask", "ok"]
PlaceId = Literal["downloads", "documents", "desktop", "pictures", "music", "videos"]
@dataclass(frozen=True)
class PlaceSpec:
    id: PlaceId; label: str; names: tuple[str, ...]; known_folder: str   # Windows KNOWNFOLDERID GUID string
APPS: tuple[AppSpec, ...]; PLACES: tuple[PlaceSpec, ...]
def find_app(text: str) -> AppSpec | None; def find_place(text: str) -> PlaceSpec | None   # longest alias wins, spaces ignored, NFC
```
Rows: 파일 탐색기 (`explorer`, control, all four verbs, aliases like 탐색기, 파일 탐색기, 내 파일, 윈도 탐색기). not-yet rows so these names answer instead of becoming a web search: 메모장, 계산기, 설정, 그림판, 카카오톡, 한글, 워드, 엑셀, 음악 재생, 동영상 재생 (pick sensible ids and aliases). never rows: 인터넷 뱅킹 or 은행 앱, 공동인증서, 금융인증서, 본인인증 앱 (generic names only).
Places with Korean labels and aliases (다운로드 폴더/다운로드/내려받은 파일 폴더; 문서/내 문서; 바탕 화면/바탕화면; 사진/그림; 음악; 동영상/비디오). GUIDs: Downloads {374DE290-123F-4565-9164-39C4925E467B}, Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}, Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}, Pictures {33E28130-4E1E-4676-835A-98395C3BC3BB}, Music {4BD8D571-6D19-48D3-BE97-422220080E43}, Videos {18989B1D-99B5-455B-841C-AB7C74E4DDFC}.
Careful: "받은 파일" alone already means 청음's browser downloads (`READ_DOWNLOAD`); do not make it a place alias.

`core/desktop.py` (strict contract; no path string, command line, key chord, window handle or coordinate can be expressed):
```python
class AppAction(BaseModel):     # model_config extra="forbid", like core/actions.py Action
    id: str; type: AppVerb; app: str; place: PlaceId | None = None
    names: list[str] = []        # path components below the place, each copied from a listing (one component each)
    risk: Literal["low","sensitive","consequential"] = "low"; requiresConfirmation: bool = False; reason: str | None = None
def parse_app_action(candidate: Any) -> AppAction | None
APP_ACTION_TYPES: frozenset[str]
def safe_path(root: Path, names: Sequence[str]) -> Path | None   # realpath must stay inside realpath(root); rejects bad components, symlink or junction escapes
```
Validation: `app` must be an id in APPS; each name non-empty, not "." or "..", no `/ \ : * ? " < > |` or control chars, at most 255 chars, NFC; `place` required for show_folder, open_file and read_file; `names` non-empty for open_file and read_file.

Guard (`safety/guard.py`): `PolicyGuard.check` dispatches on the action type. App types go to one new private branch; the web path is unchanged byte for byte.
`PolicyConfig` gains the app tiers (built from APPS by default). Branch order, mirroring the web branch: schema (parse_app_action None gives DENIED_SCHEMA), stopped (DENIED_STOPPED), per-turn limit (DENIED_RATE_LIMIT, same counter and limit), app tier (not-yet and never give DENIED_APP with a Korean reason that names the app label with josa), verb not in the app's verbs (DENIED_ACTION_TYPE), then for open_file the file kind from the last name's extension: programs, installers, scripts and shortcuts (exe, msi, bat, cmd, com, scr, ps1, vbs, vbe, js, jse, wsf, wsh, hta, lnk, url, reg, jar, appx, msix and similar) give DENIED_EXECUTABLE with the sentence "'<name>'는 프로그램 파일이라 말로 실행하지 않아요." (josa for the particle); known document, picture, sound and video kinds are allowed; unknown kinds need confirmation. Any action with requiresConfirmation or non-low risk needs confirmation. Confirmation follows the web branch exactly: approved when the action id is in `ctx.approvals` (same code as the web branch uses), else NEEDS_CONFIRMATION. Risk only goes up: a caller may raise risk (for example a file with an internet zone mark), never lower what the guard requires.
The guard stays pure (no filesystem calls). `safe_path` is called by the later desktop agent right before each effect.

`core/turn.py` contracts:
- `ExecutedAction.action` accepts `Action | AppAction` (a union discriminated by `type`; the two verb sets are disjoint).
- New session state `APP_OPEN` (where SessionState and its Korean labels are defined; derive literals from one tuple if they are written twice). Check the web UI (`web/static/*.js`) for a hard-coded state list and add the label there too if one exists.
- `AGENT_IDS` gains a desktop agent id (read the existing ids for the naming pattern).
- An app turn must round-trip `parse_turn_result`: decide how `ObservationSummary` (page, url, title are required) is filled for an app view, for example page "app:explorer", url "" and title the place label. Write that choice in your report.
Do not change any existing field's meaning; the JSON the web UI reads only gains optional values.

Tests: `tests/unit/test_apps_table.py` (every row's aliases resolve to it, longest alias wins, no alias collides across rows, every control app has a launch argv and verbs, "받은 파일" is not a place alias, find_app on 메모장 gives a not-yet row);
`tests/unit/test_guard_apps.py` (table: unknown field such as `coords` or `path` or `command` gives DENIED_SCHEMA; a name with `..`, `\`, `/` or `:` gives DENIED_SCHEMA; tier not-yet and never give DENIED_APP; `.exe` and `.lnk` give DENIED_EXECUTABLE; `.pdf` open allowed; unknown extension asks, and is allowed once approved; stopped and the per-turn limit behave as on the web; read_file of any kind is allowed);
`tests/unit/test_desktop_contract.py` (safe_path on `tmp_path`: normal path ok, `..` rejected, a symlink or junction pointing outside rejected (skip the case if the OS refuses to create it), an app turn round-trips `parse_turn_result` with an AppAction in `actions`). The existing `tests/unit/test_policy.py` (coordinates denied) must still pass unedited.

## U5. Pure folder listing and narration
`agents/desktop/explorer.py` (layer `agents.desktop`: may import `core`, `safety`, `speech.phrasing`; add the row to `test_layers.py`):
```python
@dataclass(frozen=True)
class Entry: name: str; is_dir: bool; size: int; mtime: float; ext: str      # ext lower-case without dot, "" for folders
@dataclass(frozen=True)
class Listing: entries: tuple[Entry, ...]; total: int; truncated: bool; error: Literal["missing", "denied"] | None
def list_folder(path: Path, *, limit: int = 1000) -> Listing     # os.scandir; skip hidden and system files (st_file_attributes on Windows, dot-names elsewhere), desktop.ini, thumbs.db, Office lock files "~$*", partial downloads (.crdownload, .part, .tmp); newest first by mtime, ties by name
@dataclass(frozen=True)
class Located: kind: Literal["one", "many", "none"]; entries: tuple[Entry, ...]
def locate(listing: Listing, spoken: str) -> Located      # NFC both; exact full name, then exact stem, then stem containing the spoken words (at least 2 characters); several matches give "many"
```
`speech/apps.py` (layer `speech.phrasing`):
```python
def kind_word(entry: Entry) -> str        # 폴더, PDF 파일, 한글 문서 (hwp, hwpx), 워드 문서, 엑셀 파일, 파워포인트 파일, 텍스트 파일, 사진, 음악 파일, 동영상, 압축 파일, 프로그램 파일, 바로 가기, 그 밖에는 "<EXT> 파일"
def speak_name(entry: Entry) -> str       # the stem with _ and - read as spaces; the extension is not read (kind_word says it)
def speak_entry(n: int, entry: Entry, today: date) -> str          # "1번 기초연금 안내, PDF 파일, 오늘"
def speak_listing(place_label: str, listing: Listing, *, start: int = 0, page: int = 8, today: date) -> str
```
`speak_listing` first page: "다운로드 폴더에 파일 23개, 폴더 2개가 있어요. 최근 것부터 읽을게요. 1번 …, 2번 …. 더 들으시려면 '목록 더'라고 하세요." Later pages continue the numbering. Empty folder, missing folder, denied folder and a truncated listing each get one fixed sentence. Dates: 오늘, 어제, else the month and day (reuse `speech/phrasing.py` `speak_date` if it fits). Use `josa()` for particles.
Tests `tests/unit/test_explorer.py` on `tmp_path`: hidden (set the attribute on Windows) and desktop.ini skipped, newest first, NFD and NFC names both located, 1500 files truncate at 1000 with total 1500, a missing folder gives error "missing", locate handles exact, stem, ambiguous ("신청서.pdf" and "신청서.hwp" for "신청서" give many) and a one-character query gives none.
`tests/unit/test_speak_apps.py` golden text for a first page, a second page, an empty folder, a folder with only folders, and each kind word.

## Done when
Unit suite green with the new tests and no existing test edited except `test_layers.py`; `git diff --stat` limited to the files above.
