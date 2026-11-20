# APPS: what comes after File Explorer

Each app is one row in `core/apps.py` (`names`, `tier`, `verbs`, `launch`, `driver`). Until its stage ships, the row exists with `tier="none"`, so "메모장 열어줘" answers "아직 열 수 없어요" instead of becoming a Naver search (`browse.py:114`). A new verb needs one line in `AppVerb` (`core/desktop.py`) and one in the row. The guard and the tests then cover it.

Order rule. Each step proves one new capability. Value to a blind user comes first, risk second.

## First, Explorer itself grows (not new apps)

- **E1. Read a file.** "이력서 읽어줘". Verb `read_item`, low risk. It reads PDF and HWPX text from the path with `docs.read_document` (`agents/web/docs.py:11`). Old HWP is not readable, and the answer says so. No viewer window is needed.
- **E2. Open a file in its default program.** "이력서 열어줘". Verb `open` on a file, `sensitive`, always asks "열까요?". Extension allow-list only. `.exe`, `.lnk` and scripts are refused aloud. Risk: opens another program on the user's screen, so the fingerprint carries the folder and file name.
- **E3. Later and careful.** New folder, rename, move to the Recycle Bin. These take a dictated name, so they need the secret check on the name, a spoken confirmation with the name read back, and never a permanent delete.

## 1. 메모장 (Notepad): voice notes

- **Need.** "I want to leave myself a note and hear it again, without a screen."
- **Say.** "메모장 열어줘", "메모장에 '내일 오전 약 먹기' 적어줘", "메모 읽어줘", "메모 저장해줘".
- **Actions.** `launch`, `type_text(value)`, `read_text`, `save_as(name)`, `focus_window`. `save_as` writes only under Documents and refuses an existing name.
- **Risk.** Typing into the wrong window. Typing a secret. Overwriting a file.
  - Verify the tracked window handle before any write. The fingerprint holds it.
  - Run the same secret check as web `fill` on the value (`guard.py:134`).
  - `save_as` asks aloud and reads the file name back.
  - Unknown: new Windows 11 Notepad may not accept UIA `ValuePattern.SetValue`. If only synthesized keys work, typing needs a foreground check and a higher risk class. Spike before committing.

## 2. 계산기 (Calculator): press by name

- **Need.** Quick arithmetic with a real app that shows its work to a helper.
- **Say.** "계산기 켜줘", "12 곱하기 3", "결과 읽어줘", "지워".
- **Actions.** `launch`, `press_button(name)`, `read_text("display")`. Button names come from a fixed table (`일`, `더하기`, `곱하기`, `등호`), pressed through UIA Invoke by name. No coordinates.
- **Risk.** Low. Button names are localized, so the table is per Windows language. The display text ("표시는 36") is untrusted data and is read, not interpreted.
- **Why second.** It proves the generic UIA driver with clicks by name, which later apps reuse.

## 3. 창 목록과 전환 (window list)

- **Need.** "What is open, and take me back to it."
- **Say.** "열려 있는 창 알려줘", "탐색기로 가줘".
- **Actions.** `list_windows`, `focus_window(app)`. "탐색기로 가줘" already works through idempotent `launch`.
- **Risk.** Window titles can hold private text such as a mail subject. Titles of unregistered apps are not spoken, only the program label. No title goes to any model. Windows may refuse to take the foreground, and the answer says so.

## 4. 음악 재생 (media)

- **Need.** Listening is a blind user's main leisure. "음악 폴더에서 틀어줘".
- **Say.** "음악 폴더 열어줘", "첫 번째 틀어줘", "다음 곡", "소리 줄여줘".
- **Actions.** `open` on an audio file (E2), `media_play_pause`, `media_next`, `media_prev`, `volume_step(delta)`. Media keys are fixed virtual-key codes built by code.
- **Risk.**
  - "멈춰" is the global STOP (`STOP_RE`, `rules.py:36`). Decision: STOP also pauses media that 청음 started, so the word always quiets the sound.
  - Music covers TTS and the microphone. Advise headphones once.
  - Volume steps are capped at 70% so a spoken mistake cannot deafen the user.

## 5. 시스템 상태 (no window)

- **Need.** Small facts a sighted user reads off the tray.
- **Say.** "배터리 몇 퍼센트야?", "지금 몇 시야?", "와이파이 연결됐어?".
- **Actions.** `read_status(kind)` with a closed `kind` set. No UIA and no model.
- **Risk.** Very low. It uses a `system` driver, which is the third driver kind after `folder` and `uia`. Ships early if the owner wants a quick win.

## 6. 카카오톡 (deferred, owner decision first)

- **Need.** Messaging is the top daily need for many Korean blind users.
- **Say.** "새 메시지 읽어줘", "엄마한테 '곧 갈게' 보내줘".
- **Actions.** `list_chats`, `read_chat(name)`, `send_message(name, text)`.
- **Risk.** Highest. Private conversations, and the window is custom drawn, so UIA may expose little.
  - `picture_ok=False` forever. Messages never reach OpenAI by picture or by prompt.
  - `send_message` is consequential: read back the recipient and the text, then ask.
  - Do not build before the owner decides on local-only processing and on a process deny-list.
