# Brief F: OS capabilities for the next apps (Milestone 4, apps 2, 3, 4 and 7), no wiring

Worktree: `C:\Users\user\Desktop\voice-welfare-sys` (branch feat/dv-sys, from 072710a plus a copy of the desktop files built so far, uncommitted).
It already contains `agents/desktop/port.py` (DesktopPort Protocol, NullPort, `create_port`, `port_result`), `agents/desktop/win32.py` (`Win32Port`, the only file allowed to call Windows APIs, COM work on one worker thread with timeouts), `tests/fakes/desktop_port.py` (FakeDesktopPort), `core/apps.py` (app table), `core/desktop.py`, `core/hangul.py` (`josa`), `speech/apps.py`. Read them first; follow their patterns exactly.
Another delegate is wiring folders into sessions in a different worktree. Intents, rules, session routes and the skill are NOT yours; a later unit wires your capabilities. Your diff will be applied on top of theirs, so stay inside the files below.

Plan rows you serve (`drafts/research results/screen pictures and desktop apps - plan.md`, section "Apps, in proposed order"):
2. 소리와 컴퓨터 상태: volume, battery, Wi-Fi, time, without finding the tray. "소리 키워줘", "배터리 얼마나 남았어?". Volume never goes to silent, since a silent 청음 strands the user.
3. 열린 창 목록: "지금 열린 창 뭐 있어?" and getting back to one. Titles of other apps are never sent to any model.
4. 메모: "메모해줘 내일 10시 주민센터", hear notes later. Notes are saved as files by code, not typed into a window. Secrets are refused.
7. 설정: reach sound, text size, contrast, Wi-Fi pages. A fixed list of pages. (Only opening a page; changing a switch is a later unit.)

## Files you may touch
Edit: `agents/desktop/port.py`, `agents/desktop/win32.py`, `tests/fakes/desktop_port.py`, `tests/unit/test_desktop_port.py`, `tests/unit/test_layers.py` (only if a new edge appears).
New: `core/settings_pages.py`, `agents/desktop/status.py` (pure parsing helpers if you need them), `personal/notes.py`, `speech/system.py`, tests listed below, `tests/desktop/test_win32_system.py` (opt-in).
Do NOT touch `core/apps.py`, `core/desktop.py`, `core/turn.py`, `core/intents.py`, `understanding/`, `orchestrator/`, `server/`, `agents/web/`, `safety/`.

## Port additions (`DesktopPort`, `NullPort`, `Win32Port`, `FakeDesktopPort` all gain them)
```python
@dataclass(frozen=True) class Volume: percent: int; muted: bool
@dataclass(frozen=True) class Power: percent: int | None; charging: bool; plugged: bool; has_battery: bool
@dataclass(frozen=True) class Network: connected: bool; wifi: bool; name: str | None     # name = Wi-Fi network name if known
@dataclass(frozen=True) class WindowInfo: handle: int; title: str; app: str              # app = executable file stem, lower-case
async def volume(self) -> Volume | None
async def set_volume(self, percent: int) -> PortResult          # clamps to [VOLUME_FLOOR, 100] and unmutes; never mutes; VOLUME_FLOOR = 10
async def power(self) -> Power | None
async def network(self) -> Network | None
async def windows(self) -> list[WindowInfo]                       # visible top-level app windows with titles, in z-order, excluding tool windows, cloaked (other virtual desktop/UWP hidden) windows and 청음's own windows (the Electron shell and its browser; decide how to recognise them and say how)
async def focus_window(self, handle: int) -> PortResult          # restore if minimized, bring to front; only a handle returned by windows() in this process
async def open_settings(self, page_id: str) -> PortResult        # only ids in core/settings_pages.py; the port maps the id to its fixed ms-settings: URI, never a free URI
```
Implementation hints, measured nowhere yet (measure them in your opt-in test):
- Volume: Core Audio `IMMDeviceEnumerator` → default render endpoint → `IAudioEndpointVolume` (`GetMasterVolumeLevelScalar`, `SetMasterVolumeLevelScalar`, `GetMute`, `SetMute(False)`) via comtypes on the port's COM thread. Define the needed interfaces inline (no pycaw dependency) or explain why a dependency is better.
- Power: `GetSystemPowerStatus` via ctypes.
- Network: prefer an API over parsing localized command output. If you parse `netsh wlan show interfaces`, handle Korean and English labels and treat unknown output as "unknown", never as disconnected. Decide and explain.
- Windows: `EnumWindows`, `IsWindowVisible`, `GetWindowTextW`, `GetWindowLongW` (`WS_EX_TOOLWINDOW`), `DwmGetWindowAttribute(DWMWA_CLOAKED)`, process image name via `QueryFullProcessImageNameW`. Focus: `ShowWindow(SW_RESTORE)` if iconic, then `SetForegroundWindow`; measure whether Windows' foreground lock refuses it when 청음 is not in front, and if so use a documented technique (for example `AllowSetForegroundWindow` from the foreground process is not available to us; `AttachThreadInput` with the foreground thread is the usual workaround) and report what worked.
- Settings: `os.startfile("ms-settings:<page>")` on the COM thread.

## Settings page table (`core/settings_pages.py`)
`SettingsPage(id, label, names, uri)` rows for at least: 소리 (`ms-settings:sound`), 디스플레이·글자 크기 (`ms-settings:easeofaccess-display`), 고대비 (`ms-settings:easeofaccess-highcontrast` or the Windows 11 contrast themes page; check which exists on this build), 내레이터 (`ms-settings:easeofaccess-narrator`), 돋보기 (`ms-settings:easeofaccess-magnifier`), Wi-Fi (`ms-settings:network-wifi`), 블루투스 (`ms-settings:bluetooth`), 날짜와 시간 (`ms-settings:dateandtime`). `find_settings_page(text)` like `core/apps.py` `find_place` (alias at word start, spaces ignored, longest wins).

## Notes (`personal/notes.py`, layer `personal`)
```python
@dataclass(frozen=True) class Note: path: Path; created: datetime; text: str
def save_note(folder: Path, text: str, now: datetime) -> Note       # one UTF-8 .txt per note, name "YYYY-MM-DD HHMM 첫 낱말들.txt" made safe with core/desktop.py is_component; never overwrites (add a counter)
def list_notes(folder: Path, limit: int = 50) -> list[Note]         # newest first
def delete_note(...)  # NOT now: no deletion by voice in this unit
```
The folder is `<Documents known folder>\청음 메모` (the wiring unit resolves it through the port). A note whose text `safety/privacy.py` `detect_sensitive` flags (rules only) is refused by the caller; give `save_note` no knowledge of that, but add `note_refusal(text) -> str | None` in `speech/system.py` or wherever the layer table allows, returning the Korean sentence.

## Speech (`speech/system.py`, layer `speech.phrasing`)
Golden-text functions: `speak_volume(v)`, `speak_volume_changed(before, after, floor_hit)`, `speak_power(p)`, `speak_network(n)`, `speak_time(now)` ("지금은 오후 3시 5분이에요." style; check `speech/phrasing.py` for date helpers), `speak_windows(list, start=0, page=8)` numbered like the folder listing ("열린 창이 5개 있어요. 1번 메모장, 제목 …"), `speak_notes(list)`, `speak_note_saved(note)`. Use `josa()`.

## Tests
`tests/unit/test_desktop_port.py` gains NullPort and FakeDesktopPort cases for each new method; a structure test stays green (only win32.py calls Windows APIs).
`tests/unit/test_settings_pages.py`, `tests/unit/test_notes.py` (tmp_path: save, no overwrite, newest first, unsafe characters in the first words), `tests/unit/test_speak_system.py` (golden texts).
`tests/desktop/test_win32_system.py` (marker `desktop`, skipped unless `DESKTOP_TESTS=1`): read volume and set it back to the same value (do NOT leave it changed; do not set it below the current value by more than 1 percent), read power and network, list windows (print only counts and app names, never titles, in your report), do NOT focus or open any window or settings page in the automated run.
Run the opt-in test once and report timings. Opening a settings page and focusing a window are effects on the owner's screen; do not run them; leave them for a manual check.

## Done when
Unit suite green; opt-in test passed once with timings; `git diff --stat` limited to the files above.
