# Brief D: the OS boundary (plan unit U7)

Worktree: `C:\Users\user\Desktop\voice-welfare-win` (branch feat/dv-win, at 072710a, clean). Unit suite at start: 692 passed, 10 skipped.
Other delegates are building the app table (`core/apps.py`), the folder listing (`agents/desktop/explorer.py`) and the session refactors in other worktrees. You build only the one interface that holds every Windows call, so the rest of 청음 never imports a Windows library.

## Files you may touch
New: `src/cheongeum/agents/desktop/__init__.py` (empty; another delegate also creates it, that is fine), `src/cheongeum/agents/desktop/port.py`, `src/cheongeum/agents/desktop/win32.py`, `tests/fakes/__init__.py` and `tests/fakes/desktop_port.py`, `tests/unit/test_desktop_port.py`, `tests/desktop/test_win32_port.py` (opt-in), `scripts/probe_desktop.py`.
Edit: `pyproject.toml` and `uv.lock` (add `comtypes` for Windows only, via `uv add "comtypes; sys_platform == 'win32'"`), `tests/unit/test_layers.py` (add `agents.desktop` with `{"core"}` if not present), `pytest` config only to register a `desktop` marker if needed.
Do NOT touch anything else.

## Measured facts (spike S3, `C:\Users\user\Desktop\voice-welfare\.audit\desktop-vision\spikes\S3-result.md` and `s3_shell.py` beside it)
- `comtypes.client.CreateObject("Shell.Application").Windows()` lists Explorer windows: 13 ms warm, 46 to 480 ms cold.
- `w.Document.Folder.Self` raises AttributeError under comtypes. Read the folder from `w.LocationURL` (a percent-encoded `file:///` URL).
- `explorer.exe <folder>` opened a new window with its own HWND on this PC (Windows 11 Pro 26300).
- `Navigate2(path)` works on a normal and a minimized window and from a worker thread after `comtypes.CoInitialize()`. `Document.SelectItem(Folder.ParseName(name), 1|4|8|16)` selects one file.
- Known folders resolve with `SHGetKnownFolderPath` through ctypes (no dependency).

## The interface (`agents/desktop/port.py`, layer `agents.desktop`, imports only the standard library and `core`)
```python
PortResult = dict      # ActionResult shape used by the web adapter: {"ok": bool, "errorCode": str | None, "latencyMs": int}
class DesktopPort(Protocol):
    available: bool                                     # False means the desktop feature is off on this machine
    def known_folder(self, guid: str) -> Path | None    # KNOWNFOLDERID GUID string → existing folder path, or None
    def zone_marked(self, path: Path) -> bool           # True when the file has a Zone.Identifier stream with ZoneId >= 3 (from the internet)
    async def launch(self, argv: tuple[str, ...]) -> PortResult           # start a program from a fixed argv the app table gives (never a shell string)
    async def show_folder(self, path: Path, select: str | None = None) -> PortResult   # make the Explorer window 청음 owns show this folder (open one if none), select a name if given
    async def open_file(self, path: Path) -> PortResult                   # open in its default program
    async def close(self) -> None
class NullPort:            # available = False; known_folder → None; every effect returns {"ok": False, "errorCode": "UNSUPPORTED", "latencyMs": 0}
def create_port() -> DesktopPort   # Win32Port on Windows when comtypes imports, else NullPort. Never raises.
```
Error codes: reuse the web adapter's names where they fit (TIMEOUT, ABORTED); add `UNSUPPORTED`, `NOT_FOUND`, `OS_ERROR`. Check `core/actions.py` for the existing error code list and tell me which new ones you need.

## `agents/desktop/win32.py` `Win32Port`
- Imports `comtypes` only inside methods, so `import cheongeum.server.runtime` works with comtypes missing (add a unit test that blocks the import and still builds `create_port()` → NullPort).
- All COM work runs on one dedicated worker thread with `CoInitialize`, called through `asyncio.to_thread` or a single-thread executor, with a timeout (5 s) that returns TIMEOUT. The event loop is never blocked.
- `show_folder`: remember the HWND of the Explorer window 청음 opened. If that window still exists, `Navigate2` it; else start `explorer.exe <path>` and find the new window by its folder (poll up to 5 s), remember its HWND. Never navigate or close a window 청음 did not open. Selection is best effort; a failed select still returns ok when navigation worked.
- `launch`: `subprocess.Popen(list(argv))`, no shell, no cwd from the user.
- `open_file`: `os.startfile(path)` on a thread.
- `zone_marked`: read `<path>:Zone.Identifier`; parse `ZoneId=`; missing stream is False; any error is False.
- `close`: forget the HWND; do not close the user's windows. (Closing 청음's own window on exit is optional; say what you chose.)

## Tests
- `tests/fakes/desktop_port.py` `FakeDesktopPort`: maps GUIDs to `tmp_path` folders, records every call, lets a test mark files as internet-zoned and script failures. Later units use it for every desktop test.
- `tests/unit/test_desktop_port.py`: NullPort behavior, `create_port()` with comtypes blocked, `zone_marked` on a real NTFS stream written to a `tmp_path` file (`open(str(p) + ":Zone.Identifier", "w")`, skip if not NTFS), FakeDesktopPort records calls.
- `tests/desktop/test_win32_port.py`, marker `desktop`, skipped unless `DESKTOP_TESTS=1`: on a temp folder, `show_folder` opens a window, a second call navigates the same HWND, `select` works, `known_folder` for Downloads exists, then close the window you opened. Run it once yourself with `DESKTOP_TESTS=1` (it opens and closes one Explorer window on a temp folder; never touch other windows) and paste the result.
- `scripts/probe_desktop.py`: the same checks as a manual smoke with timings, writing `reports/desktop-probe.md` (reports/ is git-ignored).

## Done when
Unit suite green; the opt-in test passed once with its output in your report; `git diff --stat` limited to the files above.
