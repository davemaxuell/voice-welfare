# First desktop apps after File Explorer

Each app is one `AppSpec` row in `core/apps.py`. The row carries the names, the launch recipe, the tier, the picture policy and the named acts. The order below is by need for a blind user divided by risk. An app enters the table only when every act it needs fits an existing recipe kind (`Keys`, `Press`, `TypeInto`, `ReadText`, `Uri`).

Shared rules for every app: 청음 never types into a password control, never reads one, and never photographs a window that has one. A `consequential` act is asked aloud first and runs once after a go word.

## 0. File Explorer (first, for reference)

- **Need.** Find a file someone sent, open it, and hear it, without a screen reader.
- **Utterances.** "문서 폴더 열어줘", "바탕화면에 뭐 있어?", "목록 더 알려줘", "진단서 열어줘", "2번 열어줘", "읽어줘", "뒤로 가줘", "이 창 사진으로 설명해줘".
- **Named actions.** `show_folder` (low), `open_file` (low for documents, images and media; asked for unknown kinds and archives; refused for programs, scripts and shortcuts), `capture_window` (free).
- **Risk.** Low. No delete, move or rename in the first slice. Places are the six user folders. Anything that resolves outside a place root is refused.

## 1. 소리 (system volume and media keys)

- **Need.** Make 청음 or a video louder or quieter without finding the tray icon.
- **Utterances.** "소리 키워줘", "소리 좀 줄여줘", "음악 멈춰줘", "다음 곡 틀어줘", "소리 꺼줘".
- **Named actions.**

| Act | How | Risk |
|---|---|---|
| `volume_up`, `volume_down` | `Keys("volume_up")`, `Keys("volume_down")`, three steps per request | low |
| `play_pause`, `next_track`, `previous_track` | media keys | low |
| `mute` | `Keys("volume_mute")` | consequential |

- **Risk.** Low, with one trap. Muting silences 청음 itself, and a blind user is then stranded. `mute` is asked first, and the question says how to get sound back ("다시 켜려면 Ctrl+Shift+Space를 누르고 '소리 켜줘'라고 하세요"). It has no window, so `window_class` is empty and `picture` is `never`.
- **Note.** "멈춰" stays 청음's stop word. Pausing media needs "음악" or "영상" in the sentence.

## 2. 메모장 (Notepad)

- **Need.** Write down a phone number or a to-do by voice and hear it back later.
- **Utterances.** "메모장 열어줘", "받아써: 내일 두 시 주민센터", "방금 쓴 거 읽어줘", "저장해줘", "메모장 닫아줘".
- **Named actions.**

| Act | How | Risk |
|---|---|---|
| `dictate` | `TypeInto("Document")` with the user's words | sensitive (the text is read back, then typed) |
| `read` | `ReadText("Document")` | low |
| `save` | `Keys("ctrl+s")`, then the save dialog's name field and its "저장" button by name | consequential (creates a file; the question names the folder and the file name) |
| `close` | `Keys("alt+f4")` | sensitive (asked when there is unsaved text) |

- **Risk.** Medium. Dictated text passes the secret check, so a spoken password or resident number is not typed. The file name is built by code from the date ("메모 2026-11-18"), in the Documents place. The text area is always masked in a picture. `picture` is `ask`.
- **Unknown.** The save dialog is a second window with its own controls. It needs the outline measurements from spike S4 (e).

## 3. 설정 (Windows Settings, named pages)

- **Need.** Reach the accessibility, sound and network pages that a sighted helper would otherwise open.
- **Utterances.** "소리 설정 열어줘", "글자 크게 하는 설정 열어줘", "고대비 켜줘", "와이파이 설정 열어줘", "블루투스 설정 열어줘".
- **Named actions.**

| Act | How | Risk |
|---|---|---|
| `open_page` for a fixed list of pages (소리, 디스플레이, 텍스트 크기, 고대비, 내레이터, 와이파이, 블루투스) | `Uri("ms-settings:...")`, one URI per page, written in the table | low |
| `toggle` a named switch on the open page | `Press("Button", name)` by observed name | sensitive (asked first, state read back after) |

- **Risk.** Medium. A toggle changes the system. Every toggle is asked first, and 청음 reads the new state back from the control. Pages outside the list are refused. Account, sign-in, recovery and update pages are never in the list. `picture` is `ask`, because the window can show the account name.

## 4. 문서 보기 창 (the viewer that opens a PDF or 한글 file)

- **Need.** Hear what a scanned or layout-heavy document looks like when its text cannot be extracted.
- **Utterances.** "이 문서 사진으로 설명해줘", "다음 쪽", "이전 쪽", "이 창 닫아줘".
- **Named actions.**

| Act | How | Risk |
|---|---|---|
| `page_down`, `page_up` | `Keys("pagedown")`, `Keys("pageup")` | low |
| `capture_window` | the window picture | asked (`picture="ask"`) |
| `close` | `Keys("alt+f4")` | low |

- **Risk.** Medium, and it is a privacy risk, not an action risk. A personal document goes to OpenAI as pixels and nothing in it can be masked by name. The question says so each time. Tier is `read-only`: no typing, no menus. Viewers differ by PC, so the row matches by process name and the list of processes is short and explicit (Edge PDF, 한글 뷰어, Acrobat Reader).

## 5. 사진 (Photos)

- **Need.** Know what is in a photo a family member sent.
- **Utterances.** "사진 폴더 열어줘", "1번 열어줘", "이 사진 설명해줘", "다음 사진".
- **Named actions.** `next`, `previous` (arrow keys, low), `capture_window` (asked), `close` (low).
- **Risk.** Same shape as the viewer. Faces and other people appear. The picture prompt already forbids reading identity numbers. It should also be told not to guess who a person is.

## Proposed and deferred, with the reason

- **카카오톡, 메일.** The need is real. Sending is consequential, the content belongs to other people, and nothing can be masked by name. Wait until the viewer row has run in real use.
- **은행, 공동인증서, 간편인증 앱.** Never. Identity verification stays with the user.
- **계산기.** No need. 청음 should answer arithmetic directly, and driving a calculator by voice is slower than asking.
- **인쇄.** One consequential act on top of the viewer row. Add it after the viewer.
- **USB 드라이브.** Not an app. It is a seventh place for File Explorer, added when removable drives can be told apart from system drives.
