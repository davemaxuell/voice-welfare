# Desktop apps, in order

Every app is a row in `APPS` (`agents/desktop/apps.py`). Tier `read` means listing and reading only. Tier `act` also allows launching and opening items. Launch argv is fixed in the table. The model never supplies a command.

Global rules for all apps: no delete, rename, move, or write. No executable opens. Every launch asks first.

## 1. 파일 탐색기 (File Explorer)

- Need: a blind user wants to get to a folder and a file without the mouse.
- Utterances: "다운로드 폴더 열어줘", "문서 폴더에 뭐 있어?", "그거 열어줘", "상위 폴더로 가줘", "탐색기 열어줘", "지금 창 설명해줘".
- Named actions: `list`, `open_folder`, `open_item`, `go_up`, `read_window` (read_window needs U0c).
- Folder scope: Desktop, Documents, Downloads, Pictures only. Anything else is denied with the reason spoken.
- Risk: low for listing and folder moves. `open_item` asks first because it starts an external program. Documents only (.hwp, .hwpx, .pdf, .txt, .docx, images). Executables are always denied.
- Launch argv: `explorer.exe` with no argument, then `open_folder` by name.

## 2. 메모장 (Notepad)

- Need: read or start a plain note, for example a form the user typed on the screen.
- Utterances: "메모장 열어줘", "메모장 지금 뭐라고 써 있어?".
- Named actions: `open_app`, `read_window`.
- Risk: medium. Opening is a launch, so it asks. Reading a window is read-only. Writing is not offered in this design.
- Launch argv: `notepad.exe`. Confirm on U0d that Windows 11 opens it by that name.

## 3. 계산기 (Calculator)

- Need: a blind user needs a sum or a result read aloud.
- Utterances: "계산기 켜줘", "계산 결과 읽어줘".
- Named actions: `open_app`, `read_window`.
- Risk: low to medium. On Windows 11 Calculator is a packaged app. Its window class and process may differ from the classic calc. U0d decides whether `read_window` works. If not, the app is `launch-only`.
- Launch argv: `calc.exe` (checked in U0d).

## 4. 그림판 (Paint)

- Need: read a picture or a screenshot file the user saved.
- Utterances: "그림판 열어줘".
- Named actions: `open_app`, `open_item` for a picture file (images are documents), `read_window`.
- Risk: medium. Paint's canvas has no text. The picture path (screen explanation) is the better tool. This app adds little until it is needed, so it comes after 2 and 3.
- Launch argv: `mspaint.exe`.

## 5. 한글 (Hancom Office Hangul)

- Need: a welfare document or a form in HWP or HWPX, read aloud. This is the most common document format for Korean public forms.
- Utterances: "보고서 열어줘" (an .hwp file in Downloads), "한글 열어줘", "지금 문서 읽어줘".
- Named actions: `open_item` (opens the file in the default program), `open_app`, `read_window`.
- Reading: the existing `docs.py` reads HWPX from a file without a window. HWP binary cannot be read that way. For the window, UIA text is needed (U0c applies to it too).
- Risk: medium. The install path is not known. U0d finds it through App Paths. If it is not installed, the app is not listed. Documents are read from file, not from the window, when possible.
- Launch argv: the App Paths result, recorded in the table at build time, never from user input.

## Not proposed for now

- Mail, messenger, and office apps with accounts. They hold personal data and invite sending. They need a separate decision by the owner.
- Anything that writes or submits. Real submission stays with the user.
- Browser-based sites that already work through Agent A.
