# First desktop apps after File Explorer

Each app is one `AppId` row in `core/desktop.py`, one name row in `understanding/apps.py` and one `AppSpec` in `agents/desktop/registry.py`. The import-time asserts fail when the three disagree. A new verb joins `DesktopVerb`, the guard and `WindowsDesktop.execute` in the same unit. The order puts the most value per unit of risk first and reuses the machinery that Explorer already builds.

## 1. Window switcher (열린 창)

- Need: a blind user loses track of open windows, and Alt+Tab gives no overview.
- Utterances: "지금 열린 창 뭐 있어?", "탐색기로 가줘", "2번 창으로 가줘", "아까 그 창으로 돌아가줘".
- Named actions: `focus_window` (exists). The switcher registers as its own `AppId` ("switcher") whose only verb is `focus_window`, so a target window need not be a registered app. The port still re-reads the window right before activating it. Listing open windows is an observation through `DesktopPort.windows()`, numbered like folder items.
- Risk: low. Titles are untrusted and may hold file names, so history gets a code sentence. Credential windows are listed as "보안 창" with no title. Windows are never closed. Foreground lock may block activation (S3), so the fallback is spoken.

## 2. Notes (메모)

- Need: jot down and hear back short notes ("내일 10시 주민센터") without a sighted helper.
- Utterances: "메모해줘 내일 10시 주민센터", "메모 읽어줘", "메모 목록 알려줘", "메모장으로 보여줘".
- Named actions: `write_note` (new, sensitive; creates a new text file in `Documents/청음 메모/` named by date; never overwrites), `read_file` (exists), `launch_app` for Notepad only to show a note.
- Risk: medium. Notes are written through the filesystem, not by typing into Notepad, so no keystroke can land in the wrong window. `detect_sensitive` refuses passwords and card or resident numbers in a note. The read-back confirms the text before saving.

## 3. Computer status and sound (컴퓨터 상태)

- Need: check battery, network, time and volume by voice when the screen cannot be seen.
- Utterances: "배터리 얼마나 남았어?", "인터넷 연결돼 있어?", "소리 좀 키워줘", "소리 줄여줘".
- Named actions: `read_status` (observation: `GetSystemPowerStatus`, network connectivity, clock), `volume_step` (new, up or down by 10%).
- Risk: low, with one rule. Volume never goes below 20% and never mutes, because a silent 청음 strands the user. Every change says the new level aloud.

## 4. Photo descriptions (사진 설명)

- Need: know what is in a photo or a scanned notice saved in Pictures or Downloads.
- Utterances: "사진 폴더 1번 설명해줘", "이 사진 뭐야?" (with a photo selected in Explorer).
- Named actions: `describe_image` (new). It sends the file itself, downscaled, through `ScreenPicture` with a file `ShotSource`.
- Risk: high for privacy. A photo has no anchors to mask, and it may be an ID card or a medical document. So every request is confirmed aloud with that warning ("신분증이나 서류 사진이면 보내지 마세요"), and the answer carries the picture label.

## 5. Music and video (음악·동영상)

- Need: play a song or a recorded broadcast from the Music or Videos folder.
- Utterances: "음악 폴더 1번 틀어줘", "일시 정지해줘", "다음 곡".
- Named actions: `open_file` (exists, low risk for local media), `media_key` (new: play or pause, next, previous through `SendInput` media keys).
- Risk: low to medium. "멈춰" is 청음's stop word and must keep stopping 청음. Media pause uses "일시 정지" only. Media keys reach whichever app owns the media session, so the reply names what is playing when Windows reports it.

## 6. KakaoTalk PC, read only (카카오톡 읽기)

- Need: hear new messages without navigating the chat list.
- Utterances: "카카오톡 새 메시지 읽어줘", "엄마 메시지 읽어줘".
- Named actions: `read_chats` (new, describe tier, UIA only).
- Risk: high. Other people's messages must stay out of LLM history and the action log. The UIA tree quality is unknown, so a spike comes first. Sending stays out of scope until a confirm-aloud design with exact read-back exists.

## 7. Hangul documents (한글 문서)

- Need: read government notices that arrive as old binary HWP, which `read_document` cannot read.
- Utterances: "공고 파일 읽어줘" on a `.hwp` file.
- Named actions: `read_file` (extended to `.hwp` through a converter, or through UIA on the Hancom viewer).
- Risk: unknown. A converter library needs a license check. The viewer's accessibility tree needs a spike. Until then 청음 says why it cannot read the file and suggests the HWPX or PDF version.
