# 리브랜딩 전수 조사: 발견 목록 전체

발견 412건. 분류별, 중요도(must > should > consider)별, 파일별로 정리했다. 요약과 묶음은 `README.md`.

## ID: text that still names blind users as the audience (36)

### must (2)

#### `docs/bokjiro-data-usage-ko.docx`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| - | 청음은 시각장애인이 음성으로 복지 제도를 찾고 신청 방법과 방문할 기관을 확인하도록 돕습니다. | The opening sentence names 시각장애인 as the audience of 청음. | '청음은 고령층·장애인·결혼이민자 등 정보취약계층이 음성으로 복지 제도를 찾고 신청 방법과 방문할 기관을 확인하도록 돕습니다.' |

#### `docs/bokjiro-data-usage.docx`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| - | Cheongeum (청음) is a voice assistant that helps blind and low-vision users find welfare programs | The opening sentence names blind and low-vision users as the audience. | "...helps people who find public services hard to use online (older adults, people with disabilities, marriage migrants and others) find welfare programs..." |

### should (3)

#### `docs/install.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 35 | 앱 본문은 청음 음성 안내와 화면 낭독기를 함께 씁니다. | Says the app is used together with a screen reader, implying every user runs one. Most of the new audience does not. This file ships in the installer (extraResources). | '청음은 음성 안내만으로 쓸 수 있고, 화면 낭독기와 함께 써도 됩니다.' 접근성 절에 큰 글자·마우스 사용도 적는다. |

#### `docs/기획요약.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 12 | 기존 도움은 화면을 그대로 둔 채 보조하는 수준에 머문다. 스크린리더는 "화면을 위에서부터 읽어 주어" 메뉴·버튼 글자까지 다 읽고 | The 'existing help' problem is about screen readers only. For 고령층 and 결혼이민자 existing help is family proxies, 주민센터 visits, digital training and translation apps. | 가족 대리 입력·주민센터 방문·디지털 교육·번역 앱의 한계를 함께 적고, 스크린리더는 그중 하나로 둔다. |

#### `src/cheongeum/orchestrator/session.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 341 | """멈추면서 접은 일을 소리로 알린다(화면을 볼 수 없으니 무엇이 취소됐는지 말해야 안다).""" | 사용자를 '화면을 볼 수 없는 사람'으로 전제한 설명. 새 대상(정보취약계층)에서는 화면을 보는 사용자도 많다. 동작 자체는 모두에게 유효. | '(화면을 보지 않거나 화면이 낯선 사용자도 무엇이 취소됐는지 알도록 말로 알린다)' |

### consider (31)

#### `CLAUDE.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 58 | 응답은 화면을 보지 않고 듣는 음성(정보취약계층 누구나, 시각장애인 포함): 쉬운 말로 핵심만 짧게 | Already rebranded, but it reads as if every user listens without looking. Sighted older adults and migrants also watch the screen. | "응답은 화면을 보지 않아도 알아들을 수 있는 음성(정보취약계층 누구나, 시각장애인 포함)" |

#### `docs/superpowers/plans/2026-11-18-sound-cues.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 | **Goal:** Twelve short sound cues that tell a blind user what 청음 is doing — SND01 for seven moments | Dated implementation plan (the cues have landed). The matching spec line 5 was already rebranded, so the two now disagree. | 기록이라 그대로 두거나, spec과 맞춰 'a user who listens instead of watching the screen'으로 바꾼다. |

#### `docs/user-test/plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 55 | 목표: "보이지 않아서 공공 사이트에서 혼자 끝내지 못한 일"의 실제 사례를 모은다. | Right for the 1차 blind cohort. If the interview is reused for other groups, this framing leaves them out. | 다른 집단에 쓸 때는 '혼자 하기 어려워서 공공 사이트에서 끝내지 못한 일'로. |

#### `drafts/future implementations/file understanding - send files to a stronger model.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 37 | This is better for a blind listener than 1,200 characters of raw text. | Dated record of an implemented decision. The reason holds for any listener, not only blind ones. | 기록이라 두어도 된다. 고친다면 'better for anyone listening'. |

#### `drafts/future implementations/official datasets - private programs and where to go.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 33 | A similarity search over offices returns "a similar dong", which is a guess a blind user | Dated design record (implemented). The risk applies to any user who cannot check the address. | 기록이라 두어도 된다. 고친다면 'a guess the user cannot catch'. |
| 238 | judge against six criteria (constraints honoured, safe for a blind user, interface depth, testability, root | Dated record of a past judging rubric. Leave it, but future rubrics should name the wider audience. | 기록이므로 그대로 두고, 이후 평가 기준은 '정보취약계층 사용자에게 안전'으로. |

#### `drafts/research results/agent skills tools - fit for cheongeum.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 56 | 청음 is a local program for one blind person who is present and listening | Dated record (2026-11-17) that still steers work: it says most Part 2 verdicts follow from this blind-only persona. The user is now any 정보취약계층 person, blind users included. | 기록으로 두되 주석 추가: '2026-11-18 리브랜드: 대상은 정보취약계층(고령층·장애인·결혼이민자 등). 시각장애인 전제에 기댄 Part 2 판단은 다시 볼 것.' |
| 496 | The stated goal is that blind users depend less on other people. | Recorded owner direction (2026-11-18), a dated record. The confirm-aloud rule now serves all 정보취약계층 users; a reader may take this line as the current product goal. | 기록은 두되 '(리브랜드 후: 정보취약계층이 남의 도움을 덜 받도록)' 주석을 붙인다. |

#### `drafts/research results/navigating agent - fit for cheongeum.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 9 | That is the better base for a voice product for blind users, because the safety gate judges every click | Dated research note (2026-11-17); its stages were built. It calls 청음 a product for blind users. The argument (the guard judges role and name) holds for the wider audience. | 기록으로 둔다. 다시 쓸 때는 'for blind users' 대신 'for 정보취약계층 users'. |

#### `drafts/research results/navigating agent - follow-up plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 111 | Hidden text is where a page can plant instructions that no sighted helper would ever notice | Dated plan, already built. It implies the user cannot see and relies on a sighted helper. The security point holds for all users. | 기록으로 둔다. 다시 쓸 때는 'that no one looking at the screen would notice'. |
| 114 | Text written for screen readers (visually clipped, not `display: none`) stays, because it is written for our users. | Dated plan. It equates 'our users' with screen-reader users. Keeping sr-only text is still fine, but the users are now 정보취약계층 broadly. | 기록으로 둔다. 다시 쓸 때는 'written for screen-reader users, one of our groups'. |

#### `drafts/research results/navigating agent - implementation plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 20 | A blind user asks 청음 for something on a website, and the agent reaches it more often. | Dated plan (built 2026-11-17). It states the goal for a blind user only; the same navigation work serves every 정보취약계층 user. | 기록으로 둔다. 다시 쓸 때는 'A user asks 청음 …'. |

#### `drafts/research results/navigating agent - merged.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 10 | for a blind user who speaks Korean to it? | Dated research note. It frames the target as a blind Korean speaker; the audience now includes sighted 고령층 and 결혼이민자 who may speak another language. | 기록으로 둔다. 다시 쓸 때는 'for a 정보취약계층 user who speaks to it'. |
| 75 | Keep structured text as the main sense. It is cheaper, it is what a screen reader user's world is made of | Dated note. It justifies text-only perception by the screen-reader user's world, and the user is no longer only a screen-reader user. | 기록으로 둔다. 근거에서 'screen reader user's world'를 빼거나 '시각장애 사용자에게는'으로 한정. |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/cheongeum_current_build.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 21 | a login *button* is refused by the read-only rule and the user is told to press it with their screen reader | Dated inventory (2026-11-18) that treats the user as a screen-reader user; behavior has since changed (login pressed after '눌러'). Reused in the Pickle-fit report it misstates audience. | Leave as dated record with a note: superseded; the user may have no screen reader, and 청음 now moves to the button and presses it on '눌러'. |
| 55 | Silence during long tasks plus a closed mic during processing are the main voice-UX weaknesses for a blind user | Judges voice UX against the blind user only; the same weaknesses hit older and first-time users. Dated record that feeds the Pickle comparison. | "...for users who rely on voice (blind users, older adults, first-time users)" or keep as dated record with a note. |
| 211 | the virtual cursor is a sighted-observer (demo/companion) feature rather than something the blind user perceives. | Assumes the user cannot see (also L197 'for demos'). For sighted 고령층·결혼이민자 the cursor is a user-facing aid showing where 청음 acts; a report built on this would undervalue it. | 가상 커서를 '눈으로 보는 사용자에게 청음이 어디를 누르는지 보여 주는 장치'로 다시 평가해 적기. |
| 216 | but real blind-user testing count is 0 | Frames the missing user tests as blind-only; the gap now covers every 정보취약계층 group. Dated record. | "real-user testing count is 0 (no group tested yet)" |
| 229 | there is no end-user installer path for a blind user to install unaided. | Developer-style install (repo + uv + Node) blocks older and non-technical users as much as blind ones; naming only blind users narrows the gap. Dated record. | "...for a 정보취약계층 user (or a helper) to install unaided." |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/pickle_features_ux.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 221 | A remote-screen viewer with pinch and two-finger gestures is the opposite of what a blind user can operate | Forward recommendation ('청음 should lean on the latter') weighed for blind users only; sighted older users may also want a visible approval card beside the spoken hand-off. | 말로 하는 인계는 유지하고, 눈으로 보는 사용자를 위한 화면 표시(승인 카드)도 함께 평가해 적기. |
| 249 | whitespace for 청음: an agent where approvals, progress, and hand-offs are designed voice-first and screen-reader-native | Positions 청음 as screen-reader-native, the old blind-only identity; under the rebrand the whitespace is voice-first help for anyone who struggles with the web. | "...voice-first and usable without reading the screen, for 정보취약계층 (blind users included)." |
| 298 | Both are high-value for blind users too. | Uses blind users as 청음's reference audience; the same value applies to 고령층 and 결혼이민자 who do not know where to apply. Minor; dated record. | "Both are high-value for 정보취약계층 (고령층, 시각장애인 등) too." |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/pickle_safety_privacy.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 329 | 청음's blind-first design addresses a gap Pickle leaves open. | Calls 청음 'blind-first', contradicting the rebrand; this inference is a recommendation likely to be copied into the Pickle-fit report. Dated record, but do not reuse the wording. | "청음's voice-first design for 정보취약계층 (screen-free use kept) addresses a gap Pickle leaves open." |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/pickle_technical_build.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 298 | It is also accessible to the user's own screen reader at hand-off time. | Dated research note (2026-11-18), but section 9 is a forward recommendation list; it frames the local-browser handoff benefit only through the user's screen reader. | Add that a sighted user can also take over directly in the visible local window; keep the screen reader as one case. |
| 315 | Because 청음's Chromium is local and headed, the blind user can use NVDA or 센스리더 directly on the real window | Forward recommendation in a dated note names 'the blind user' as the handoff user; work that follows it would design the handoff for screen-reader users only. | Rephrase to 'the user can take over the real window directly (with NVDA/센스리더 if they use one, or by looking at it)'. |
| 322 | is the visual analogue of what blind users need audibly. | Forward recommendation frames spoken step progress as a blind-user need; it serves every voice user, and sighted users could also see the step list. | '...what voice-first users need audibly (sighted users may also see it as a list).' |

#### `src/cheongeum/agents/web/autopilot.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 44 | 너는 화면 대신 소리로 듣는 정보취약계층 사용자를 대신해 웹을 탐색하는 브라우저 에이전트다. | Already-rebranded prompt reads as if every 정보취약계층 user listens instead of looking; fine for voice use, but many target users also look at the screen. | '너는 음성으로 웹을 쓰는 정보취약계층 사용자(화면을 보지 않을 수도 있다)를 대신해…' |

#### `src/cheongeum/agents/web/skills/browse.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 238 | 누르기 전에 무엇을 왜 누르는지 소리로 설명하고 묻는다(화면을 볼 수 없는 사용자에게는 이 설명이 화면이다). | Code comment justifies the spoken explanation only for users who cannot see; it also serves users who see the button but do not know what it does. | '(화면을 볼 수 없거나 무엇을 누르는지 모르는 사용자에게는 이 설명이 화면이다)' |

#### `src/cheongeum/core/picture.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 91 | 화면을 볼 수 없거나 보기 어려운 사용자에게 웹페이지 전체를 위에서 아래까지 담은 사진 한 장을 말로 설명한다. | Already edited, but still defines the user by sight only, unlike the other prompts (정보취약계층). Sighted 고령층 ask for this because the page is confusing, not because they cannot see. | '화면을 보기 어렵거나 화면 내용을 이해하기 어려운 사용자에게' |

#### `src/cheongeum/evaluation/data/demo_scenarios.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 9 | "persona": "시각장애인 이용자(가상)", | The only persona in the demo set is a blind user, so a reader sees a blind-only product. Still a valid group, and CLAUDE.md says 수정하지 않는다: owner decision. | 주인 결정: 동결을 풀면 '정보취약계층 이용자(가상, 예: 시각장애인)'; 유지하면 다른 페르소나는 다른 파일에 |

#### `src/cheongeum/speech/screen.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 1 | ⑥ 접근 가능한 출력: 화면을 눈 대신 귀로 듣게 풀어 말하는 담당(화면 이해 담당의 요약을 말로 바꾼다). | Module docstring frames the narrator as a substitute for eyes, i.e. for users who cannot see. The new audience also includes sighted users who need plain spoken explanation. Code comment only. | ⑥ 접근 가능한 출력: 화면을 귀로도 알아듣게 쉬운 말로 풀어 말하는 담당 |

## META: names, titles, diagrams (2)

### consider (2)

#### `docs/architecture-check.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 31 | \| \| 접근성 텍스트(선택, 화면낭독기 친화) \| ✅ \| `aria-live` 대화 기록·상태 알림 (`web/static/`) \| | Diagram item treats on-screen text as optional and for screen readers. For sighted users with hearing loss or migrants reading, visible text is a main channel. architecture.png likely says it too. | '화면 글(큰 글자 대화 기록·상태 표시, 화면낭독기 친화)'로 바꾸고 47행 그림 수정 제안에도 넣는다. |

#### `src/cheongeum/agents/web/browser/waiting.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 6 | <p>웹 도우미 화면에서 <strong>안내를 듣고 동의</strong>하면 이 창에서 시작합니다.</p> | Calls the main UI '웹 도우미 화면', matching neither index.html's title '청음 — 음성 복지 신청 도우미 (데모)' nor the new tagline. '듣고' also assumes listening. | 새 이름과 맞춰 '청음 화면에서 안내를 듣거나 읽고 동의하면…' |

## ASSUME: behavior built for blind screen-reader users (31)

### should (16)

#### `README.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 57 | 기본 백그라운드(창 없이 트레이 '청음', Cmd/Ctrl+Shift+Space = 말하기·동의) | Desktop default shows no window. A sighted novice sees nothing after launch and must know a 3-key chord. Line 184 also calls the shortcut the reliable fallback. | 기본은 큰 '말하기' 버튼이 있는 창, 백그라운드는 선택으로. 184행 '단축키가 확실한 대안'도 화면 버튼과 함께 적는다. |

#### `apps/desktop/main.cjs`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 21 | const BACKGROUND = process.env.CHEONGEUM_SHOW_WINDOW !== '1'; | Background mode (no window, tray only, voice only; comment line 7) is the default. A sighted older adult who opens the app sees no window and must know Ctrl+Shift+Space. | 기본을 창 보이기(큰 말하기 버튼)로 바꾸고 백그라운드는 선택 설정으로. 7행 주석도 함께 고친다. |

#### `docs/install.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 22 | 2. **Tab**으로 “추가 정보”에 간 뒤 **Enter**. | SmartScreen steps (lines 22-24) are keyboard and screen-reader only (Tab, Enter, NVDA·센스리더). A sighted novice or a helping family member clicks, and gets no mouse steps. Shipped in the installer. | '“추가 정보”를 누릅니다(키보드: Tab 후 Enter)'처럼 마우스 방법을 먼저, 키보드는 괄호로. |
| 30 | Finder에서 청음 아이콘에 **VoiceOver+Shift+M**(컨텍스트 메뉴) → **열기**. | Assumes VoiceOver is running. A sighted user would Control-click or right-click the icon. | '청음 아이콘을 Control 키를 누른 채 클릭(VoiceOver 사용자는 VO+Shift+M) → 열기'. |

#### `docs/기획요약.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 15 | 창 없이 백그라운드에서 돌고, 단축키 하나로 말한다. | Presents the windowless, shortcut-only start as the design. Sighted novices need a visible window and button (see apps/desktop/main.cjs:21). | '큰 말하기 버튼이 있는 창이나 단축키로 말한다(화면을 보지 않는 사용자는 창 없이도)'. |

#### `src/cheongeum/agents/web/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 288 | 입력 칸으로 키보드 초점을 옮긴다(값은 넣지 않는다). 본인인증 인계 때 화면 낭독기가 첫 칸을 읽게 한다. | Handoff relies on a screen reader reading the focused field after one TTS sentence (AUTH_HANDOFF); a sighted older or novice user without one hears nothing about where to type. | Keep the focus, but also speak the field name, show a large visible highlight on it, and repeat guidance on request or after a silence. |

#### `src/cheongeum/agents/web/browser/observe.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 208 | const landmarkNames = { HEADER: '머리말', NAV: '탐색 메뉴', MAIN: '본문', ASIDE: '보조 영역', FOOTER: '꼬리말', FORM: '입력 양식' }; | Screen-reader landmark names (also line 213), spoken by screen.py:138 as '화면 구성: 머리말, 탐색 메뉴, 보조 영역, 꼬리말'. Useful for landmark navigation, meaningless to a sighted older user. | 화면 설명에서 랜드마크 목록을 빼거나 '위쪽 메뉴, 가운데 내용, 맨 아래 안내'처럼 위치 말로 바꾸기(screen.py:138과 함께) |

#### `src/cheongeum/agents/web/digest.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 61 | r"^(글자\s*(크게\|작게\|확대\|축소)\|화면\s*(크게\|작게\|확대\|축소\|인쇄)\|인쇄(하기)?\|프린트\|english\|eng\|中文\|日本語\|chinese\|japanese\|한국어\|language\|언어\s*선택" | UTILITY_BUTTON drops text-size and site-language buttons from controls (LLM items, screen summary) as noise for a voice user. Low-vision older users need 글자 크게; 결혼이민자 need the site's language switch. | 글자 크기·언어 선택 버튼은 조작 요소에 남기고, 대화 언어가 외국어면 사이트의 언어 버튼을 먼저 알려 주기 |

#### `src/cheongeum/agents/web/playbook.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 26 | "blocked": "평소 쓰시는 브라우저로 직접 여시거나, 비슷한 정보를 다른 사이트에서 찾아 드릴까요?", | Fallback assumes the user already browses alone (a blind screen-reader user). The new audience often cannot, and no phone or in-person route is offered. '브라우저' is also jargon. | '직접 여시기 어려우면 129나 가까운 주민센터에 물어보실 수 있어요'처럼 사람 도움 길을 함께 말하기 |
| 56 | "blocked": "평소 쓰시는 브라우저로 복지로를 직접 여시거나, '복지 제도 찾아줘'라고 말씀해 주세요.", | Same premise as line 26: assumes the user can open 복지로 alone in their own browser. | 129(보건복지상담센터)·주민센터 방문 안내를 함께 말하기 |
| 71 | "blocked": "평소 쓰시는 브라우저로 정부24를 직접 여시거나, 발급 절차를 물어 주세요. 예: '주민등록등본 발급 방법 알려줘'.", | Same premise as line 26: assumes the user can open 정부24 alone in their own browser. | 정부민원안내콜센터 1588-2188·주민센터 방문 안내를 함께 말하기 |

#### `src/cheongeum/agents/web/skills/browse.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 322 | TTS는 UI가 AUTH_HANDOFF에서 안내 한 번만 말한 뒤 멈춰 화면 낭독기와 겹치지 않게 한다. | At login/auth handoff 청음 speaks once then goes silent (app.js:361-362) so a screen reader can read the field. A user with no screen reader hears nothing and gets no help finding where to type. | 화면낭독기 사용 여부를 설정이나 첫 대화로 받고, 없으면 칸 이름과 '다 했어'를 짧게 다시 안내 |

#### `src/cheongeum/core/turn.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 282 | rate: float = 1.25 | Default TTS speed 1.25x suits practiced screen-reader users; 고령층, hard-of-hearing and Korean learners need about 1.0 or slower and must know to say '천천히' (not in help). Same in personal/store.py:25. | 기본 1.0(또는 0.9)로 낮추고 첫 안내에서 속도 바꾸는 말 알려 주기. store.py DEFAULT_SPEECH도 같이 |

#### `src/cheongeum/personal/store.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 25 | DEFAULT_SPEECH = {"rate": 1.25, "length": "normal", ...} | 기본 말하기 속도가 1.25배(speaker.js도 1.25, 브라우저 1.0이 보통). 빠른 음성에 익숙한 화면낭독기 사용자 기준이라 고령층·이민자에게는 처음부터 빠르다. | 기본값을 1.0으로(store·speaker.js·dialogue 구간 함께). 첫 사용 때 '천천히 말해줘'를 안내하는 것도 검토. |

#### `src/cheongeum/web/static/app.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 361 | // 본인인증 인계: 안내 한 번만 말하고 TTS를 멈춰 화면 낭독기가 입력 칸을 읽게 한다 | After the login/auth handoff, TTS speaks once then cancels so a screen reader can read the field. A user with no screen reader (older adult, or blind user without one) hears nothing more. | 화면낭독기 사용 여부를 설정으로 두고, 없으면 칸 이름과 다음 할 일을 이어 말하기 |

#### `src/cheongeum/web/static/speaker.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 | export const speechPrefs = { rate: 1.25, voice: null }; | Default speech rate 1.25x suits experienced screen-reader listeners. Older adults and Korean learners need slower speech and must first know to say '천천히 말해줘'. | 기본 1.0으로, 처음 안내에서 속도 고르기 제안(core/turn.py SpeechPrefs, personal/commands '보통 속도'=1.25도 함께) |

### consider (15)

#### `CLAUDE.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 41 | 인계 때 첫 입력 칸 `focus_field`·UI는 `AUTH_HANDOFF`에서 TTS 한 번만 말하고 멈춤 | Documents the auth handoff: TTS speaks once, then stays silent so a screen reader can read the focused field. A sighted user with no screen reader who misses it hears nothing more. | 인계 동작(browse.py·app.js)을 바꾸면 이 줄도 고친다. 예: 할 일을 화면에 큰 글자로 띄우고, 잠시 뒤 한 번 더 말로 알린다. |

#### `README.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 90 | `HEADLESS`, `VISUAL_CURSOR`, `BROWSER_SLOWMO_MS` \| 창 보임, 창이 보이면 켬, `0` \| 시연용 | The visible browser and visual cursor are labeled demo-only (시연용). For sighted users they are the real feedback that shows where 청음 is acting. | 설명을 '시연·눈으로 따라가기용'으로 고치고, 실제 사이트 모드에서도 켜 두는 것이 기본임을 적는다. |

#### `docs/superpowers/specs/2026-11-18-sound-cues-design.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 32 | \| Kind \| Source \| Clip / voicing \| Plays when \| Mic open? \| | Twelve abstract earcons carry state by sound alone. Screen-reader users are used to learning earcons; novices may not learn twelve meanings, and the spec pairs none with a visible status. | 주요 신호(듣기·승인·인계·문제)는 화면 상태 표시와 짝짓고, 처음 몇 번은 말로도 뜻을 알려 준다. |

#### `drafts/research results/navigating agent - follow-up plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 124 | Clicks are then reported correctly, but the agent keeps reading text a sighted person cannot see. | This option was built (line 27): mainText keeps CSS-hidden menus and tab panels for reading. A sighted older adult who follows on screen hears text they cannot find there. | 읽을 때 화면에 안 보이는 글이면 '화면에는 접혀 있는 내용이에요'라고 알리거나 보이는 글을 먼저 읽는 방안 검토(observe.js, effect.py). |

#### `drafts/research results/navigating agent - implementation plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 98 | Drop utility buttons by name (font size, skip links, language switch, social, carousel controls). | Built as digest.py UTILITY_BUTTON, pinned by tests/unit/test_grounding.py (also nav-fit 92, merged 188). Goal mode and screen descriptions lose 글자 크게 and language buttons 고령층·결혼이민자 may need. | 글자 크기·언어 버튼은 빼지 말고 '화면 도구'로 따로 알려 주거나 목표 수행이 찾을 수 있게 하는 방안 검토(digest.py, test_grounding.py). |

#### `drafts/research results/navigating agent - merged.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 75 | Add a screenshot only as a fallback reader (stage 3). | The built design keeps text-only perception, so it cannot resolve what sighted users point at: '빨간 버튼', '오른쪽 위에 있는 거', a picture. 고령층 who look at the screen often describe things by looks. | 색·위치·그림으로 가리키는 말을 받을지 결정하고, 사진 설명 계획(core/picture.py)과 함께 검토. |

#### `drafts/research results/screen pictures and desktop apps - plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 9 | When the user asks, 청음 takes a picture of the screen it is explaining, sends it to OpenAI, and says what it shows. | Forward plan. The answer describes what the screen shows (layout, popup position), which a sighted user already sees. A sighted novice needs what it means and what to do next. | 사진 설명 답에서 '무엇을 하라는 화면인지, 다음에 할 일'을 먼저 말하도록 계획에 추가 검토. |
| 47 | The Explorer window is told to show the same folder, best effort. | Forward plan. Speech follows the file system and the window follows only on a best-effort basis. A sighted user watching Explorer may see a different folder from the one 청음 reads out. | 창이 따라오지 못하면 그 사실을 말하게 하거나, 창 맞추기를 성공 조건으로 둘지 결정(spike S3). |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/pickle_technical_build.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 321 | Speak these statuses instead of showing cards. | Forward recommendation assumes nobody looks at the screen; sighted older adults or migrants would follow a task better with a visible status card next to the speech. | 'Speak these statuses and also show them as large-text cards in the UI.' |

#### `src/cheongeum/agents/web/browser/__init__.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 49 | 시연용 가상 커서: 마우스 화살표가 대상 위치로 미끄러져 가고, 누를 때 눌리며 물결이 퍼지고, 기다릴 때 갸웃거리며 말풍선 점이 뛴다. | Docstring (and comment at 366) frames the cursor as demo-only. For sighted users (older adults, migrants) it is the main visual cue of what 청음 points at. runtime.py turns it on when headed. | 주석을 '사용자에게 지금 가리키는 곳을 보여 주는 가상 커서'로 바꾸고, 보이는 창에서는 늘 켠다는 점을 문서에 적기 |

#### `src/cheongeum/core/picture.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 94 | description에는 무엇에 대한 화면인지와 눈에 띄는 그림·도표·팝업·안내문을 쉬운 한국어 존댓말 짧은 문장 2~4개로 쓴다. | No location cues. A sighted novice who will press the button themselves needs 'where' (오른쪽 위 파란 버튼); the prompt assumes the user never looks. | '사용자가 직접 찾을 수 있게 중요한 버튼은 대략 위치(위·아래·오른쪽)도 짧게' 추가 검토 |

#### `src/cheongeum/language/i18n.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 238 | Text quoted from web pages (titles, excerpts): translate it into {name} too … only proper names may keep the Korean | Built for a user who never looks at the screen (line 232). A sighted 결혼이민자 hears only translated button/link names and cannot match them to the Korean text on screen. | 누를 이름·버튼 글자는 번역 뒤 괄호에 한국어 원문을 함께 두기 검토 |

#### `src/cheongeum/personal/dialogue.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 18 | rate = prefs.get("rate", 1.25); <=1.0 "천천히", >=1.4 "빨리", else "보통" | 1.25배를 '보통'이라고 읽어 준다. 화면낭독기 사용자의 빠른 청취를 기준으로 한 구간이라, 기본값을 1.0으로 바꾸면 1.0이 '천천히'로 들린다. | 기본값 변경과 함께 구간을 다시 정한다(예: <0.95 천천히, 0.95~1.15 보통, >1.15 빨리). |

#### `src/cheongeum/web/static/app.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 1018 | "시작 전에 안내를 듣고 동의해 주세요. '안내 듣고 시작하기' 버튼이 선택되어 있습니다. Enter를 누르세요." | Keyboard-focus instruction written for screen-reader users. A sighted older user with a mouse or touch screen is better told to press the big button. | '아래 '안내 듣고 시작하기' 버튼을 누르세요. 키보드라면 Enter를 누르세요.' |

#### `tests/e2e/test_cursor.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 2 | 시연용 가상 커서: 초점만 옮길 때(승인·입력을 기다리는 때)와 누를 때 모양이 다르고, | Frames the cursor as a demo aid. For sighted users (older adults, migrants) it is the main visual cue of what 청음 points at; tests check position and aria-hidden but not size or contrast. | 커서를 시연용이 아니라 보는 사용자를 위한 기능으로 정의하고(크기·대비 기준 포함) 설명과 시험 이름을 맞춘다. |

## GAP: groups of 정보취약계층 left out (119)

### should (48)

#### `README.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 23 | "나한테 맞는 복지 찾아줘" → 나이·장애·소득·지역 | 맞춤 찾기 asks only age, disability, income and region. 농어민, 결혼이민자·다문화 가족, 한부모 or older people living alone cannot state their situation, so their programs never surface. | discovery.py 질문에 직업(농어업)·가구 형태·다문화 가족 여부를 넣을지 검토하고, 바뀌면 이 표도 고친다. |
| 32 | "영어로 말해줘", "Speak English", "说中文", "日本語で話して", "Korean please" | Conversation languages are en/zh/ja only (also line 50). Vietnamese, a top 결혼이민자 origin language, and Filipino, Khmer and Thai are missing. | 베트남어부터 추가를 검토한다(i18n·STT 라우팅·멈춤 규칙·평가 문장). 그 전까지 결혼이민자 포괄을 과장하지 않는다. |
| 185 | 외국어 모드는 번역 때문에 턴마다 3~8초 느림. 고정 UI 문구는 한국어. | In foreign-language mode the fixed UI text stays Korean, so a 결혼이민자 who reads the screen sees Korean-only buttons, consent and status text. | 동의 안내·주요 버튼·상태 문구 번역을 계획에 넣거나, 한계로 분명히 적는다. |

#### `docs/architecture-check.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 38 | \| \| 기준선 비교 \| ❌ \| 사용자 테스트 계획에 포함(평소 화면낭독기 조건과 비교) \| | The baseline is defined only as the screen-reader condition. For 고령층 or 결혼이민자 the baseline is doing it alone, with family help, or at the 주민센터. | 기준선을 집단별 '평소 방식'으로 적는다(화면낭독기 / 혼자 / 가족 도움). |

#### `docs/stt-eval/sentences.csv`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 1 | id,lang,kind,text,read_as,expect | No speaker fields. The local STT switch is gated on this eval, yet nothing asks for older speakers, regional dialects or Korean with a foreign accent, where small Whisper models fail most. | 녹음 화자 기준(연령대·사투리·외국인 억양)을 정하고 eval_stt 결과를 집단별로 보고한다. |
| 2 | k01,ko,command,장애인연금 신청 도와줘,, | Welfare topics lean on disability (k01, k16, k57, e04, z04, j04). None for 농어민, 결혼이민자·다문화 or older-adult programs beyond 기초연금, so those words' STT accuracy is untested. | 예: '농업인 수당 신청하고 싶어', '다문화가족 지원 알려줘', '노인 일자리 찾아줘' 같은 문장을 더한다. |
| 53 | k52,ko,switch,영어로 말해줘,,en | Language-switch and foreign rows (53-56, 62-79) cover en/zh/ja only. Vietnamese and other main 결혼이민자 languages are never evaluated. | 언어를 더하면 vi 등의 전환·외국어·멈춤 문장 행을 함께 더한다. |

#### `docs/user-test/consent-template.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 3 | 참여자에게는 소리 내어 읽어 드리고, 점자·큰 글자·음성 파일 등 원하는 형태로 제공합니다. | Formats fit visual impairment only. No translated version or interpreter for 결혼이민자 and no plain-language version for low-literacy older adults. | '참여자가 이해하는 언어의 번역본·통역, 쉬운 말 버전'을 더한다. |

#### `docs/user-test/plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 3 | 이 1차 계획은 그중 시각장애인만 다루고, 고령층·결혼이민자 등 다른 집단은 넣지 않았습니다. | Participants (13), recruitment via 시각장애인 단체 (14), the screen-reader baseline (9, 21) and SUS cover only blind users. No plan tests 고령층, 결혼이민자, 저소득층 or 농어민. | 2차 계획: 고령층·결혼이민자 모집(노인복지관·가족센터), 기준선 '평소 방식', 쉬운 설문 검토. |

#### `docs/기획요약.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 16 | 나이·장애·소득·지역을 하나씩 물어 받을 수 있을 법한 제도를 찾고 | Discovery questions cannot express 농어민 or 결혼이민자·다문화 가족, both named in 대상 (line 7). | 직업(농어업)·가구 형태·다문화 가족 여부 질문 추가를 검토하고 문장을 맞춘다. |
| 35 | 영어·중국어·일본어 대화도 지원해(한국 고유 용어는 원어와 풀이) 한국어가 서툰 결혼이민자·다문화 가정까지 포괄한다. | Claims to cover 결혼이민자, but Vietnamese (a main origin language) and Filipino, Khmer and Thai are unsupported. The claim overstates coverage. | 베트남어를 더하기 전에는 '영어·중국어·일본어를 쓰는 결혼이민자'로 범위를 좁혀 적는다. |
| 43 | VoiceOver를 켠 상태로 복지로 신청 전 과정을 직접 재현하고, 구간별 소요 시간과 실패 지점을 기록 | The walkthrough is planned only with VoiceOver. No run as a sighted novice or in a foreign-language session; line 44 admits other groups are unplanned. | 같은 재현을 화면낭독기 없이(눈으로 보며 처음 쓰는 사람)와 외국어 모드로도 기록한다. |

#### `drafts/future implementations/official datasets - private programs and where to go.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 207 | 15155700 장애인복지관 프로그램, 15139219 장애인단체 (대표자명 is dropped at sync). The live mobility API | Forward plan: the later place datasets are all disability ones. No 노인복지관·경로당, 가족센터 (다문화) or 농어민 services are listed. | 후속 데이터 목록에 고령층·결혼이민자·농어민 기관 자료를 찾아 더할지 검토한다. |

#### `scripts/eval_agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 70 | Task("R1-네이버뉴스", "real", "네이버에서 오늘 주요 뉴스 알려줘", ... | All 15 goal utterances are fluent standard Korean. No en/zh/ja goal (the path claimed for 결혼이민자) and no hesitant, dialect or short phrasing typical of older or non-native users. | Add goals in en/zh/ja (through translate_in) and Korean variants with 군말·사투리·짧은 말, and report pass rate per variant. |

#### `scripts/eval_stt.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 39 | class Row: id: str / lang: str / kind: str / text: str / read_as: str / expect: str | No speaker attributes, so CER and the local-STT switch gates (GATES, line 36) are pooled; older, dialect (농어민), non-native Korean (결혼이민자) and dysarthric speech are never measured apart. | Add speaker columns (age band, region/dialect, native language, speech condition) to sentences.csv or a recordings index and report CER and gates per group. |
| 154 | for lang in ("en", "zh", "ja"): | STT eval measures only en/zh/ja besides Korean (sentences.csv: 64 ko, 6 each en/zh/ja). Vietnamese, Filipino, Khmer, Thai, common among 결혼이민자, are absent. | If conversation languages expand, add vi (then tl/km/th) rows and a per-language CER; until then state the gap in the report. |

#### `scripts/run_scenarios.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 190 | - 시나리오: demo_scenarios.json(활성 4 + 구현된 S5) + 합성 30건(정상 10·오류복구 10·안전중단 10) | All 35 scenarios are Korean (only non-Korean utterance is a phone number) and demo_scenarios.json's only persona is '시각장애인 이용자(가상)'; multilingual and other-persona flows are absent. | Add a new scenario file (demo_scenarios.json stays unedited) with en/zh/ja turns and older/novice phrasing, and report completion per persona. |
| 213 | - 데이터: 장애인연금 공식 API 상세 응답(2026-11-16 저장), 질문 {rag['questions']}개(src/cheongeum/evaluation/data/rag_qa.json) | RAG accuracy is measured on one program (장애인연금) only; retrieval for programs used by 고령층 (기초연금), 저소득층, 농어민 and 결혼이민자 is not evaluated. | Add saved details and QA for e.g. 기초연금, 기초생활보장, 다문화가족 지원, 농어민 지원 and report Recall/MRR per program. |

#### `src/cheongeum/agents/web/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 129 | _ASSIST_SECRET = rx(r"(비밀\s*번호\|password\|인증\s*번호\|otp\|주민\|계좌\|카드)", I) | Real-site fill helper drops secret fields by label, but 외국인등록번호, 여권번호, 거소신고번호 (결혼이민자 ID numbers) don't match; observe.js marks only password/OTP sensitive. Same list in guided.py:179. | Add 외국인\s*등록\|여권\|거소 to both regexes (better one shared constant) with a unit test. |

#### `src/cheongeum/agents/web/file_answer.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 22 | SCAN_NOTICE = { "ko": …, "en": …, "zh": …, "ja": … } | Hard-codes ko/en/zh/ja. Vietnamese (largest 결혼이민자 group), Tagalog, Thai, Khmer are absent, and SCAN_NOTICE[lang] at line 88 raises KeyError if i18n adds one. | 언어 목록을 i18n 한곳에서 받아 vi 등을 더하고, 없는 언어는 ko 문구로 대체 |

#### `src/cheongeum/agents/web/profile.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 114 | korean = bool(rx(r"^[가-힣]{2,5}$").search(v)) | Name check takes 2-5 Hangul syllables with no space, or ASCII letters only. Many 결혼이민자 names (e.g. 응우옌티투짱, spaced names, diacritics) fail with '이름만 또박또박 말씀해 주세요'. | 길이·띄어쓰기 제한을 넓히고(예: 2~20자, 공백 허용), 실패 말도 '이름을 다시 말씀해 주세요'로 |

#### `src/cheongeum/agents/welfare/discovery.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 18 | PROFILE_ORDER = ["age", "disability", "income", "ctpv"] | 맞춤 찾기 asks only age, disability, income, region. 가구상황(다문화·한부모·보훈) and 농어업 are never asked, so 결혼이민자·농어민 match only if they volunteer it in the exact words. | 선택 질문 추가(가구상황·직업) 또는 마지막에 '해당하는 상황(다문화 가정, 농사·어업 등)이 있으면 말씀해 주세요' 한 번 묻기 |
| 87 | if rx(r"(다문화\|탈북\|북한이탈)").search(t): | 결혼이민자 often say '결혼해서 한국에 왔어요', '결혼이민', '외국인 아내', '베트남 사람'; none set multicultural, so 다문화 programs (e.g. 결혼이민자 통번역 서비스 in the catalog) are not boosted. | 결혼\s*이민\|이주\s*여성\|국제\s*결혼\|외국인\s*(배우자\|아내\|남편)\|귀화 등 추가(국적 이름은 오탐 검토) |
| 135 | def targets_of(p: dict) -> list[str]:  (장애인·저소득·한부모·다자녀·보훈·다문화만) | No 농어민 signal. Catalog fixture has 농업인 연금보험료 지원, 농업인 건강보험료 지원, 어업인 안전보험 with no target tag; they get the -1 '누구나 대상' penalty and '농사지어요' cannot raise them. | 농업\|농사\|어업\|어민\|농어민 인식 → 이름·요약에 농·어업인이 든 제도에 가점(대상 태그가 없으므로) |

#### `src/cheongeum/core/intents.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 216 | def help_pages(lead: Sequence[HelpGroup], consented: bool) -> ...  (INTENTS 줄만 읽음) | Help reads only INTENTS rows. Language switch ('영어로 말해줘', i18n) and speed ('천천히 말해줘', personal/commands.py:98) are not rows, so the commands 결혼이민자·고령층 most need are never announced. | '언제든' 묶음에 '천천히 말해줘'·'영어로 말해줘' 예문 추가(외국어 안내 한 줄 포함) |

#### `src/cheongeum/core/turn.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 246 | LANGS = ("ko", "en", "zh", "ja") | Conversation-language schema lacks Vietnamese, the largest 결혼이민자 origin in Korea (also Filipino, Khmer, Thai, Mongolian). Adding one starts here and in i18n.py:18. | vi 우선 추가(이후 th·km·tl·mn 검토). Lang Literal·i18n·UI 언어 선택 함께 |

#### `src/cheongeum/evaluation/data/rag_qa.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 3 | "service": "장애인연금", | RAG Recall/MRR is measured on one disability program with standard-Korean questions; nothing for 기초연금(고령층), 농업인 제도, 결혼이민자 통번역 서비스, or colloquial/non-native phrasing. | 기초연금 등 2~3개 제도와 고령층 말투·서툰 한국어 질문 추가 |

#### `src/cheongeum/evaluation/data/scenarios_30.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 | "scenarios": [  (N01–N10, E01–E10, X01–X10) | All 30 use fluent standard Korean, mostly the 장애인연금 mock form, no persona. No hesitation/dialect/repeats (고령층), non-native Korean or foreign-language turns (결혼이민자), or '천천히/쉽게 말해줘'. | persona별 시나리오 추가: 고령층 말투, 서툰 한국어, 영어·중국어 전환, 속도·쉬운 말 요청 |

#### `src/cheongeum/language/i18n.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 18 | LANG_NAME = {"ko": "한국어", "en": "English", "zh": "简体中文", "ja": "日本語"} | Vietnamese, the largest 결혼이민자 origin, is missing (also Tagalog, Khmer, Thai, Mongolian) while Japanese is in. _SWITCH, detect_script_lang ([a-z] only), APPROVE/REJECT and FIXED are per-language too. | vi 추가: LANG_NAME·LANG_BCP47(vi-VN)·_SWITCH·APPROVE/REJECT·FIXED·detect_script_lang(성조 문자)·turn.LANGS |

#### `src/cheongeum/orchestrator/session.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 935 | if route == "language" and out.get("language") in ("ko", "en", "zh", "ja"): | 대화 언어가 한·영·중·일 4개뿐. 결혼이민자 출신국 1위 베트남과 필리핀·캄보디아·태국·몽골 언어가 없다(기획요약 '결혼이민자 포괄'과 어긋남). | core/turn.py LANGS·i18n FIXED와 함께 베트남어(vi)부터 추가 검토. 범위를 4개로 둔다면 기획 문구를 '일부 언어'로 낮춘다. |

#### `src/cheongeum/personal/commands.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 98 | rx(r"(천천히\|느리게)\s*(말해\|...)") → {"rate": 0.9}; "보통 속도" → {"rate": 1.25} | 가장 느린 속도가 0.9배, '보통 속도'로 되돌리면 1.25배. 고령층·한국어가 서툰 이민자에게 1.25는 빠르고 0.9로도 부족할 수 있다. | '보통'=1.0, '천천히'=0.8 안팎, '더 천천히' 단계 추가 검토(store.DEFAULT_SPEECH·speaker.js 기본값과 함께). |

#### `src/cheongeum/understanding/chat.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 17 | - language: 대화 언어를 바꿔 달라는 말(예: "Please English", "영어로", "일본어로 해줘", "한국말로"). language에 ko/en/zh/ja. | 결혼이민자 in Korea are mostly from Vietnam, China, the Philippines, Cambodia, Thailand. Only ko/en/zh/ja can be chosen (also the enum on line 34); Vietnamese, Tagalog, Khmer, Thai speakers cannot switch. | 언어 목록(core.turn.LANGS)을 넓힐 때 이 설명·예시와 34행 enum도 함께(vi 등) |

#### `src/cheongeum/understanding/rules.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 37 | STOP_RE = rx( r"(멈춰\|멈추\|멈춤\|중지\|중단\|그만\|정지\|스톱\|잠깐\|취소\|" + B + r"(stop\|halt)" + B + r"\|停止\|停下\|... | Stop is language-independent but only for Korean, English, Chinese, Japanese. A Vietnamese or Filipino 결혼이민자 saying stop in their own language is not stopped. Safety-critical. | 지원 언어를 넓힐 때 멈춤 낱말도 추가(예: dừng lại, tigil, ឈប់, หยุด) |

#### `src/cheongeum/understanding/sites.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 22 | KNOWN_SITES: list[KnownSite] = [ | Lists 한국장애인고용공단 but no site for 결혼이민자 (다누리, 하이코리아), 농어민 (농업e지원, 농림축산식품부), elderly jobs (노인일자리 여기) or housing (마이홈). Those names fall back to search and get no near-match fix. | 다누리, 하이코리아, 농업e지원, 농림축산식품부, 노인일자리 여기, 마이홈포털 등을 한 줄 소개와 함께 추가 |

#### `src/cheongeum/voice/tts.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 50 | if self.speed and self.speed != 1: | Server TTS speed is one process-wide setting (TTS_SPEED). The per-user '천천히 말해줘' rate never reaches it, so an older or non-native user on server TTS cannot slow speech down. | synthesize에 speed 인자를 받아 세션 speechPrefs.rate를 쓰기(api.js speak, app.py /api/audio/speak와 함께) |

#### `src/cheongeum/web/static/api.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 35 | async speak(text, lang) { | Sends only text and lang, so the session speech rate cannot reach server TTS. Same gap as speaker.js:110 and voice/tts.py:50. | speak(text, lang, rate)로 넓혀 서버에 속도를 넘기기 |

#### `src/cheongeum/web/static/app.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 34 | const EXAMPLES = [ '장애인연금 신청 도와줘', ... '화면 설명해줘', '본문 읽어줘', '링크 목록 알려줘', '장애인연금 얼마 받아?' | The visible example commands are a disability-pension form plus screen-reader-style commands. Nothing shows older, low-income, farmer or migrant users a task of their own. | '기초연금 신청 도와줘', '나한테 맞는 복지 찾아줘', '가까운 주민센터 알려줘', 'Please English' 등을 섞기 |
| 52 | const ALL_LANGS = ['ko', 'en', 'zh', 'ja']; | Four-language list is hard-coded here and in voiceRouteText (line 59: '영어, 중국어, 일본어'). No Vietnamese or other main 결혼이민자 languages. | 언어를 늘릴 때 이 목록과 59행 안내 문장도 함께 |
| 82 | function consentText() { | Consent is spoken and shown only in Korean, before any language can be chosen. A migrant with little Korean agrees to data transfer without understanding it. | 동의 전에 언어를 고르게 하거나 동의 안내를 지원 언어로 준비 |

#### `src/cheongeum/web/static/audio.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 4 | export const BCP47 = { ko: 'ko-KR', en: 'en-US', zh: 'zh-CN', ja: 'ja-JP' }; | Browser speech recognition and synthesis languages are limited to these four. Vietnamese, Filipino, Khmer and Thai speakers among 결혼이민자 have no voice support. | 언어를 늘릴 때 vi-VN 등 추가(index.html, app.js ALL_LANGS, core.turn.LANGS와 함께) |

#### `src/cheongeum/web/static/index.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 2 | <html lang="ko"> | All UI labels (buttons, consent, panels, hints) are Korean only and do not follow the chosen conversation language. A migrant who picks 中文 still sees Korean buttons. | 대화 언어에 맞춰 화면 글도 바꾸기(최소한 멈춤·동의·대화 시작 버튼) |
| 48 | 대화 언어 Language <option value="ko">한국어</option> … <option value="ja">日本語</option> | Only 한국어, English, 中文, 日本語. The largest 결혼이민자 groups (Vietnamese, Filipino, Cambodian, Thai) cannot pick their language. | 베트남어 등 추가(core.turn.LANGS, i18n, audio.js BCP47, rules.py 멈춤 낱말과 함께) |

#### `src/cheongeum/web/static/speaker.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 110 | async speak(text, fetchAudio, fromChunk = 0) { | serverTts ignores speechPrefs.rate (only browser TTS uses it). With server TTS the '천천히 말해줘' command has no audible effect. | 서버 TTS 요청에 속도를 넘기기(api.js speak, voice/tts.py와 함께) |

#### `tests/e2e/test_scenarios.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 | FILE = load_scenario_file(DEMO_SCENARIO_PATH) | The only scenario suite is demo_scenarios.json (frozen); its sole persona is '시각장애인 이용자(가상)' on 장애인연금. No scenario covers 고령층, 결혼이민자, 저소득층 or 농어민. | 원본 파일은 두고 정보취약계층 시나리오 파일(예: 고령층 기초연금, 결혼이민자 외국어 대화)을 새로 만들어 여기서 함께 돌린다. |

#### `tests/unit/test_discovery_personal.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 32 | r = parse_profile_answer("마흔다섯 살이고 심한 장애가 있고 부산 살아요") | Profile tests cover 나이·장애·소득·시도 only, like PROFILE_ORDER. 결혼이민 is not parsed (only '다문화'), 농어민 not at all; 20 fixture services aimed only at 다문화·탈북민 are filtered out (L56). | 다문화·결혼이민·농어민 질문이나 파싱을 더하면 '베트남에서 결혼해서 왔어요', '농사지어요' 같은 답의 시험을 더한다. |

#### `tests/unit/test_i18n_voice_llm.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 42 | def test_lang_switch(text, lang): | Language switch and script detection are tested for ko/en/zh/ja only. Vietnamese (Latin with diacritics), Tagalog, Khmer, Thai, Mongolian (main 결혼이민자 languages) have no switch phrase or script rule. | 지원 언어를 넓히면 detect_lang_switch·detect_script_lang 시험을 언어별로 더한다. |

#### `tests/unit/test_policy.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 138 | ("my password is 1234", True), ("密码是1234", True), ("パスワードは1234です", True) | Secret rules (privacy.py:31) and these cases cover only en/zh/ja keywords; the Korean PII model skips non-Hangul text (line 206). A 결혼이민자 giving a password in Vietnamese or Tagalog is not caught. | 대화 언어를 늘릴 때 베트남어(mật khẩu)·타갈로그어·크메르어 등 비밀번호·인증번호 키워드를 privacy.py와 이 시험 사례에 함께 더한다. |

#### `tests/unit/test_welfare.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 323 | @pytest.mark.parametrize("v,ok", [("김하늘", True), ("남궁민수", True), ("John Smith", True), ... | Only Korean 2-5 syllables and ASCII English are tested; profile.py:114-115 rejects 결혼이민자 names with Vietnamese diacritics, Chinese characters or Korean spellings over 5 syllables, and re-asks. | 'Nguyễn Thị Hoa', '응우옌티투하'(6자), '王芳' 같은 사례를 넣고 validate_name이 받을 범위를 정한다. |

### consider (71)

#### `README.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 20 | "본문 읽어줘", "계속 읽어줘", "링크 목록 알려줘" → "3번" | Example phrases teach web terms (본문, 링크 목록) that many 고령층 do not know. These examples are how new users learn what to say. | 규칙이 받는 쉬운 말 예시도 함께 싣는다(예: '내용 읽어줘', '누를 수 있는 것 알려줘'). 규칙이 실제로 받는지 먼저 확인한다. |

#### `apps/desktop/main.cjs`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 |  * - 마이크 권한과 소리 자동재생을 미리 허용해, 앱을 켜면 클릭 없이 바로 안내를 듣고 Enter로 동의할 수 있다. | In background mode consent is audio plus Enter, with no visible text. Older adults with hearing loss cannot read what they agree to, and a stray Enter counts as consent. | 창을 띄워 동의 내용을 큰 글자로 함께 보여 주고, 화면의 '동의' 버튼으로도 동의할 수 있게 한다. |
| 27 | /** 트레이 아이콘: 이미지 파일 없이 16×16 동그라미를 직접 그린다(macOS는 글자 '청음'도 함께). */ | In background mode the tray icon is the only visible sign 청음 is running. On Windows it is an unlabeled black 16px dot, nearly invisible on a dark taskbar. | 알아볼 수 있는 아이콘(색·글자)을 쓰고, 윈도에서도 청음이 켜져 있음을 알 수 있게 한다. |

#### `docs/bokjiro-data-usage-ko.docx`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| - | 장애인복지관 운영 프로그램 15155700 후속 후보 … 장애인단체 현황 15139219 후속 후보 | Both follow-up dataset candidates serve 장애인 only. Nothing is planned for 고령층 (노인복지관 등), 결혼이민자 (가족센터·다문화 지원) or 농어민. | 후속 후보에 고령층·결혼이민자·농어민 기관의 공공데이터를 찾아 추가할지 검토한다. |

#### `docs/bokjiro-data-usage.docx`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| - | Cheongeum uses age, disability, income category, and region to suggest programs. | Same 맞춤 찾기 limit as README: farmers/fishers and marriage migrants cannot state their situation. Update this sentence if the discovery questions change. | discovery 질문이 바뀌면 이 문장도 함께 고친다. |

#### `docs/stt-eval/sentences.csv`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 15 | k14,ko,command,링크 목록 알려줘,, | Command rows use web terms (링크 k14/k15/k42, 본문 k13). Everyday phrasing of inexperienced users is absent, so intent agreement is measured only on expert wording. | '누를 수 있는 거 알려줘', '파란 글씨 눌러줘', '내용 읽어줘' 같은 일상 표현을 더한다. |

#### `docs/superpowers/specs/2026-11-18-sound-cues-design.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 10 | - Non-goals: a sound settings screen or volume control; server changes. | No volume control or off switch for cues. Older adults with hearing loss may miss short laptop-speaker cues; others may find them loud or confusing. | 신호음 크기·끄기 설정을 후속 목표로 적는다. |

#### `docs/user-test/record-sheet.csv`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 12 | P1,화면낭독기,T1,,,,,, | The only comparison condition is 화면낭독기. Sessions with 고령층 or 결혼이민자 need a baseline such as their usual way (alone or with family help). | condition 값을 집단별 기준선으로 일반화한다(예: 평소 방식). |

#### `docs/user-test/tasks.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 | \| # \| 과제(읽어 줄 문장) \| 성공 기준 \| 보는 것 \| | No task tests language switching, '쉽게 말해줘' or asking what to say, which 결혼이민자 and 고령층 rely on. The baseline (line 20) is screen-reader only. | 다른 집단용 과제를 더한다: 언어 바꾸기(지원 언어), '쉬운 말로 다시', '뭐라고 말하면 돼?'. |
| 12 | "연습용 장애인연금 신청서를 열고 이름과 주소를 넣어 보세요. 이름은 김하늘, 주소는 부산광역시 예시구 예시로 10입니다." | The only form-filling task uses a 장애인연금 practice form. Applications typical of other groups (e.g. 기초연금) are not exercised. | 다른 집단 테스트 때는 그 집단의 신청서 과제를 쓴다(연습 사이트에 있는 양식 확인). |

#### `drafts/future implementations/speech providers - stay on OpenAI during checking.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 18 | \| TTS \| `TTS_PROVIDER=openai`, `TTS_MODEL=gpt-4o-mini-tts`, `TTS_VOICE=coral`, `TTS_SPEED=1.1` | Speech runs 10% faster than normal with no user control (voice picker undecided, line 57). Many older adults need slower speech; screen-reader users prefer fast. | '천천히 말해줘/빨리 말해줘'로 속도를 바꾸는 기능과 기본 1.0을 검토한다(이미 있는지 먼저 확인). |

#### `drafts/research results/agent skills tools - fit for cheongeum.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 68 | \| 3 \| Language \| `language/i18n.py` \| Translate in and out for English, Chinese, Japanese \| | 결혼이민자 in Korea are largely Vietnamese, Chinese, Filipino, Cambodian, Thai, Mongolian. Vietnamese and the others are missing. The gap is in language/i18n.py; this doc only records it. | i18n.py에서 베트남어부터 추가 검토(필리핀어·크메르어 등 다음). 문서는 날짜 있는 기록으로 둔다. |
| 274 | \| `discover` \| Asks age, disability, income level, and region, then ranks the catalog by rule \| | 맞춤 찾기 asks only age, disability, income, region. 다문화·결혼이민 가구, 농어민 occupation, 한부모, household size cannot be stated, so those groups' programs rank poorly. Gap is in agents/welfare/discovery.py. | discovery.py에 가구 형태(다문화·한부모)·직업(농어업) 질문 추가 검토. 결정 6(프로필 저장)도 같은 항목으로 다시 본다. |
| 282 | Without a key it uses the fixture: one detailed service (장애인연금), 6 glossary entries | The offline fixture's only detailed service is 장애인연금, and START_APPLICATION is tied to it (C5, line 448). Demos and tests without an API key cannot show 고령층 or 저소득층 flows. | fixture에 기초연금 등 다른 집단의 대표 제도를 더하고 C5(장애인연금 고정) 해소를 함께 검토. |
| 415 | The browser's speech rate is fixed at 1.25 today and screen-reader users differ widely in the rate they want. | The rationale names only screen-reader users, who often like fast speech. 고령층 and 결혼이민자 likely need speech slower than 1.25, which makes A3 more urgent than this plan says. | 근거를 '사람마다 원하는 속도가 다르고 고령층·결혼이민자는 더 느린 말이 필요'로 고치고, 기본 속도 1.25 재검토를 A3에 넣는다. |

#### `drafts/research results/probes/phrasings.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 7 | The phrasings are examples written for this check, not utterances from real users. | These seeded the help-command examples (fit doc line 411). All are team-written standard Korean with no 고령층 or 결혼이민자 phrasings (simpler, dialect, non-native). Two use 링크 and 본문. | 규칙 시험·도움말 예문에 고령층·결혼이민자 실제 발화(사용자 시험 녹취)를 더하고 '링크·본문' 대신 쉬운 예문을 고른다. |

#### `drafts/sound-cues/bake_start_done.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 29 | y = soft(x[start : start + int(0.022 * SR)]) | Shipped start/done cues (web/static/cues/start.ogg, done.ogg) are cut to 22 ms, tuned only to dodge the clap detector; older users with hearing loss or first-time users may miss or not learn them. | 고령층 청취자로 들리는지 확인하고, 박수 감지를 피하면서 조금 더 긴(약 0.1초) 부드러운 소리나 기본 음량을 검토. |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/cheongeum_current_build.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 50 | **Languages.** `lang` ∈ ko, en, zh, ja | Records 청음's 4 languages; vs main 결혼이민자 origins (중국·베트남·필리핀·일본·캄보디아·태국) Vietnamese, Tagalog, Khmer, Thai are missing and fixed UI text stays Korean. Fix is in code. | 비교 보고서에 결혼이민자 언어 공백을 적고, 코드(server/app.py, language/i18n.py)에서 베트남어부터 추가 검토. |
| 226 | plan for 3–5 participants, 12 task cards, SUS + trust ratings, crossover vs own screen reader | Records a user-test plan whose baseline is the participant's own screen reader, so it fits blind users only; 고령층·결혼이민자 have no baseline. The fix belongs in docs/user-test/plan.md. | 기록에 한계를 적고, plan.md에 다른 집단과 그들의 비교 조건(혼자 웹으로 하기, 주민센터 도움 등)을 추가. |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/pickle_features_ux.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 234 | ## 3. Accessibility — blind/low-vision and elderly users | Accessibility comparison covers blind and elderly users only; 결혼이민자 (Pickle is ko/en/ja, L331), low-literacy and other disabled users are not assessed, so the comparison misses part of the audience. | 결혼이민자 언어·쉬운 말·청각 관점을 추가하거나, 조사 범위가 좁다고 명시. |

#### `research_notes/피클 AI 에이전트 청음 적용 검토/pickle_safety_privacy.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 332 | No evidence on how Pickle performs for blind/low-vision users (no reviews or press on accessibility found). | The only audience gap searched is blind/low-vision; fit for 고령층, 결혼이민자 or low-literacy users was not looked for, so the §9 relevance lens skips most of the new audience. | 고령층·결혼이민자 사용 후기와 쉬운 말 여부를 조사 범위에 추가하거나, 조사하지 않았다고 명시. |

#### `scripts/eval_agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 55 | Task("L1-링크따라가서답", "local", f"{PORTAL}에서 장애인연금 안내 기사 내용 알려줘", ... | Goal-mode QA covers 장애인연금, 보조기기, 기초연금 and generic portals; no task targets services for 결혼이민자 (e.g. 다누리), 농어민 or 저소득층, so success there is unmeasured. | Add a few local/real tasks per group, e.g. 다누리 상담 전화번호, 농업인 지원 사업 찾기, 기초생활수급 신청 방법. |

#### `scripts/eval_claps.mjs`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 19 | const crops = { '2-76408-A-22.wav': [[0, 0.86], [0.90, 1.65], ... | Double-clap trigger is tuned and evaluated only on ESC-50 clips; claps from older adults or people with weak or one-handed claps (upper-limb disability) are not tested. | Record soft/slow claps from older and motor-impaired users and report the trigger rate, or document the clap as optional with another hands-free cue. |

#### `scripts/run_scenarios.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 219 | - 자동 검사는 일부 기준만 확인합니다. 화면낭독기(NVDA/VoiceOver) 실사용 검사를 대신하지 않습니다. | Names only screen-reader testing as the manual check axe cannot replace; for 고령층 and low-literacy users, text size/zoom, plain wording and visual feedback also need manual checks. | '화면낭독기 실사용 검사와 고령층 등 실사용자 검사(글자 크기·확대·쉬운 말)를 대신하지 않습니다.' |

#### `scripts/setup_local_models.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 105 | 프로젝트 팀이 함께 만든 모델(사용 확인됨). 학습 데이터: AI Hub 한국어 음성 | The local STT model (default for Korean) is documented only as 'AI Hub 한국어 음성'; whether it covers elderly, dialect or non-native Korean speech is unstated and unmeasured. | Record which AI Hub sets were used (e.g. 노인 음성, 방언, 외국인 한국어 발화) in MODELS.md and verify with per-group eval_stt rows. |
| 132 | print("STT_MODEL=gpt-4o-mini-transcribe   # 한국어 외 언어(영어·중국어·일본어)만 OpenAI로") | Setup hint hardcodes the en/zh/ja set, mirroring a conversation-language list that omits Vietnamese and other main 결혼이민자 languages; must change if languages expand. | Say '한국어 외 지원 언어만 OpenAI로' or print the list from the same source as i18n. |

#### `src/cheongeum/agents/web/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 123 | "이름": ["성명", "이름", "신청인"], | Field synonyms for the real-site helper miss labels used on forms for foreign residents: 영문 성명 for name, 체류지 for address, so 결혼이민자 forms match less. | Consider adding 체류지 to 주소 and 영문 성명 to 이름 (only where the saved value actually fits, e.g. romanized name kept separately). |
| 681 | target={"role": "link", "name": self.profile.links.application}, reason="장애인연금 모의 신청 링크 클릭" | The only end-to-end practice application is a 장애인연금 form; older adults' most common program (기초연금) and other groups' services have no practice flow. | Product call: add a 기초연금 (or neutral) practice form, or keep 장애인연금 as one example among several. |

#### `src/cheongeum/agents/web/browser/waiting.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 5 | <p>이 창은 청음이 웹사이트를 열어 읽고 조작하는 창입니다.</p> | The only page a sighted user sees before consent is Korean-only (lang=ko) though en/zh/ja conversation is supported; a 결혼이민자 cannot tell what this window is. | 대화 언어(영어·중국어·일본어 등) 한 줄 안내를 함께 싣거나 언어 설정에 맞춰 바꾸기 |
| 7 | <p>동의 후 "장애인연금 신청 도와줘"라고 말하면 모의 신청서가, "복지로 열어줘"라고 말하면 복지로가 열립니다.</p> | The only example request is 장애인연금 (the practice form). Older adults, the largest new group, get no example of their own (e.g. 기초연금). '모의 신청서' is also hard wording. | '연습용 신청서'로 바꾸고 기초연금 같은 고령층 예시를 함께 들기(모의 사이트·profile.py 링크 이름도 함께 검토) |

#### `src/cheongeum/agents/web/playbook.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 156 | script = f"'{topic} 문의인데요, {where}에서 도움이 필요해요.'" | Human-help speech gives 129 or the site number and a Korean phone script only. For a 결혼이민자 with little Korean, a multilingual line is the usable route. | 대화 언어가 외국어면 다국어 상담(다누리콜센터 1577-1366, 번호 확인 필요)을 먼저 안내 |

#### `src/cheongeum/agents/web/profile.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 128 | return fail("주소가 불완전합니다. 시·도, 시·군·구, 도로명과 건물번호까지 말씀해 주세요. 추측해서 입력하지 않았습니다.") | Asks only for a 도로명 address; many 농어민 and older users know the 읍·면·리 + 번지 address, which the validator already accepts. | '도로명과 건물번호, 또는 읍·면·리와 번지까지 말씀해 주세요.' |
| 133 | if rx(r"^01[016789]\d{7,8}$").search(d): | 연락처 accepts mobile numbers only (message line 135 says 010). Older and rural users with only a home landline cannot enter it. Practice form only, but it is the demo flow. | 지역번호 유선전화(02-, 0xx-)도 받기 |
| 191 | links=SiteLinks(application="장애인연금 모의 신청하기", login="모의 본인인증"), | The single practice form is a 장애인연금 (disability) application; 고령층·저소득층 have no matching practice flow. Pins practice_site link text. | 기초연금 같은 고령층 제도의 연습 신청서 추가를 검토(모의 사이트·데모 시나리오와 함께) |

#### `src/cheongeum/agents/web/skills/browse.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 428 | "아이디와 비밀번호는 키보드로 직접 입력해 주세요. 비밀번호는 소리 내어 말하지 마세요. " | Users who cannot type (some older adults, motor disabilities) have no path past login. Owner decision (2026-11-18) keeps 청음 from hearing passwords: privacy vs completion. | 가족·복지관 등 사람 도움 인계 안내를 함께 말하는 것을 검토 |
| 515 | tail = self.narrator.once("more", "더 들으려면 '계속 읽어줘'라고 말씀하세요.", "더 있어요.") if rest else "본문 끝입니다." | How to continue is said once per session, then only '더 있어요.'. Users who forget commands (older adults) lose the phrase. '본문 끝' also uses 본문. | '더 있어요. 계속 들으시려면 '계속'이라고 하세요'처럼 짧게 매번 |

#### `src/cheongeum/agents/web/skills/form.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 365 | "purpose": "장애인연금 모의 신청서 모의접수 (실제 제출 아님)", | Hard-codes the 장애인연금 practice form in the UI approval card; practice forms for other groups would need this from the profile. | SiteProfile에 신청서 이름을 두고 거기서 읽기 |

#### `src/cheongeum/agents/web/skills/guided.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 215 | first = self.narrator.once("guided", " 건너뛰려면 '건너뛰기', 그만하려면 '그만'.") | How to skip or stop is said once per session (same at line 220). Older users who forget the words get no reminder. | 같은 칸에서 머뭇거리거나 '뭐라고 해?'라고 하면 다시 알려 주기 |

#### `src/cheongeum/agents/welfare/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 112 | DEFAULT_SERVICE = "장애인연금"  (MVP 첫 적용 대상; application_context가 신청서를 열 때 씀) | The only application flow (mock form, application_context, help example) is a disability pension; 고령층(기초연금)·저소득층·농어민 have no demo program. 기획요약 now leads with 기초연금. | MVP 대상 제도를 넓힐지(기초연금 등, 제도별 모의 신청서) 주인 결정. 바꾸면 practice_site·시나리오·테스트도 함께 |

#### `src/cheongeum/agents/welfare/discovery.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 89 | if rx(r"(혼자\|1인\|독거)").search(t): out["living"] = "alone" | Living alone is parsed but never used by targets_of or match_services, so 독거 고령층 get no lift for 돌봄·안전 programs. | living=alone이면 보호·돌봄, 안전·위기 주제 제도에 가점 검토 |

#### `src/cheongeum/core/intents.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 85 | _row("START_APPLICATION", "장애인연금 신청 시작", "시작", ["장애인연금 신청 도와줘", "신청 페이지를 열어줘"]), | The first example help reads under 시작 is a disability-pension request; 기획요약 now opens with '기초연금 신청 도와줘'. Tied to the 장애인연금 mock form. | 도움말 예문을 대상 넓은 제도로(모의 신청서 범위와 함께 결정). demo_scenarios.json 동결이라 이 발화는 계속 받아야 함 |

#### `src/cheongeum/core/places.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 15 | KINDS = {DONG_OFFICE: 행정복지센터, PENSION: 국민연금 지사, MOBILITY: 교통약자 이동지원센터} | Only three place kinds. No 가족센터(다문화가족지원센터) for 결혼이민자, 노인복지관 for 고령층, 장애인복지관, 고용센터, 농업기술센터 for 농어민. | 공공데이터 가족센터·노인복지관 현황 등 추가 여부 결정(datasets.py DATASETS와 함께) |

#### `src/cheongeum/evaluation/__init__.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 38 | persona: Optional[str] = None | persona exists but only demo S1 sets it (시각장애인), and compute_metrics has no per-persona breakdown, so reports cannot show how other 정보취약계층 groups fare. | 시나리오에 persona(고령층·결혼이민자 등)를 붙이고 지표를 persona별로 나누기 |

#### `src/cheongeum/evaluation/data/demo_scenarios.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 4 | "targetService": "장애인연금 모의 신청", | Every demo flow is a disability-pension application; no flow for a program 고령층·저소득층·결혼이민자 would apply for. File is frozen by CLAUDE.md. | 동결 유지 시 다른 제도·집단 흐름은 scenarios_30.json 등 별도 파일에 추가 |

#### `src/cheongeum/orchestrator/session.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 311 | dropped = self._dropped_on_stop() if self._lang == "ko" else "" | 결혼이민자 등 영어·중국어·일본어 사용자는 '멈춰' 뒤 무엇이 취소됐는지(파일 전송·저장·칸 채우기) 듣지 못한다. 한국어 사용자만 안내받음. | 취소 안내도 FIXED 문구로 만들거나 _localize를 거쳐 사용자 언어로 알린다. |
| 908 | f"천천히 다시 말씀드릴게요. {last_speech}" | LLM이 없거나 숫자가 바뀌면 '천천히'라고 말하지만 말하기 속도는 그대로(기본 1.25배)라 고령층에게 약속과 다르게 들린다. | '다시 말씀드릴게요'로 바꾸거나, 이 답에만 느린 속도(예 0.85)를 실어 보내는 방법 검토. |
| 1103 | f"{current} 연습 신청서는 아직 없어요. 지금은 장애인연금 연습 신청서만 있어요." | 연습 신청서가 장애인연금 하나뿐(1060·1075행도 이름 고정). 새 대상의 가장 큰 집단인 고령층의 대표 제도(기초연금, 기획요약 예시)는 연습할 수 없다. | 기초연금 연습 신청서 추가 검토. demo_scenarios.json은 바꾸지 않으므로 장애인연금 양식은 유지하고 하나를 더한다. |

#### `src/cheongeum/personal/commands.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 87 | def parse_speech_pref(text) — 속도·길이·목소리·진행 알림만 | 말하기 설정에 소리 크기('크게 말해줘')가 없다(DEFAULT_SPEECH에도 없음). 난청이 흔한 고령층에게 필요한 설정이 빠져 있다. | volume 설정과 '크게/작게 말해줘' 명령 추가 검토(브라우저 TTS volume·서버 TTS 재생 음량). |

#### `src/cheongeum/personal/guardian.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 34 | def guardian_command(text): if "보호자" not in text: return None | 보호자 명령은 한국어 낱말 '보호자'로만 알아듣고, 답은 _localize에서 번역하지 않는다(session.py 507행). 외국어로 대화하는 결혼이민자는 보호자 기능을 못 쓴다. | 보호자 명령·확인을 언어별 규칙 또는 번역 후 판정으로 넓히고 답도 사용자 언어로(비밀값·번호 확인은 규칙 유지). |

#### `src/cheongeum/practice_site/site/apply.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 23 | <h1>장애인연금 신청서 (모의)</h1> | 연습 사이트의 신청서가 장애인연금 하나뿐(index.html 목록도 같음). 고령층 대표 제도인 기초연금 등은 연습할 수 없다. 시험·시나리오가 이 양식을 쓴다. | 양식은 유지하고(데모 시나리오 고정) 기초연금 연습 양식을 하나 더 두는 방안 검토. 사이트 프로필·규칙 이름 고정과 함께. |

#### `src/cheongeum/safety/privacy.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 31 | rx(rf"(password\|passcode\|密码\|密碼\|パスワード\|暗証番号\|{B}PIN{B})", I) | 외국어 비밀번호·인증번호 낱말이 영·중·일뿐이고 모델은 한글 글만 본다. 베트남어 등을 추가하면 그 언어로 말한 비밀값이 번역 LLM으로 넘어간다. | 대화 언어를 늘릴 때 같은 변경에서 그 언어의 키워드(예: mật khẩu, mã xác nhận)를 KEYWORDS에 더한다. |

#### `src/cheongeum/server/app.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 230 | "lang은 ko, en, zh, ja 중 하나입니다." | 언어 API 설명·오류 문구가 4개 언어를 고정한다. 결혼이민자 언어(베트남어 등)를 늘리면 함께 바꿔야 한다(LANGS에서 만들면 한 곳). | 문구를 LANGS에서 만들고(', '.join(LANGS)) 226행 docstring도 맞춘다. |

#### `src/cheongeum/server/runtime.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 45 | # 시연용 가상 커서 / visualCursor: bool | 가상 커서를 '시연용'으로만 설명한다. 화면을 보는 고령층에게는 청음이 어디를 누르는지 보여 주는 주된 시각 피드백이다. 지금 기본값(창이 보이면 켬)은 맞다. | 주석을 '사용자가 청음의 조작 위치를 눈으로 따라가는 표시(시연에도 씀)'로 바꿔 운영에서 끄지 않게 한다. |

#### `src/cheongeum/understanding/filters.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 61 | 무엇을 할까요? 예를 들어 '화면 설명해줘', '네이버 열어줘'처럼 말씀해 주세요. | The only examples are screen narration and Naver. A first-time older or low-income user hears nothing about public-service help, which is the product's purpose. | 예: '기초연금 신청 도와줘', '나한테 맞는 복지 찾아줘' |

#### `src/cheongeum/understanding/rules.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 294 | r"(쉽게\s*(다시\s*)?(말해\|설명\|얘기)\|무슨\s*말(이야\|인지\|이에요)\|...\|다시\s*(한\s*번\s*)?말해\s*줘\|천천히\s*(다시\s*)?말해)" | '다시 말해줘' and '천천히 다시 말해줘' go to REPHRASE (new easier wording at the same speed), not a word-for-word repeat or slower speech. An older user who missed the words gets different words. | '다시 말해줘'는 그대로 다시, '천천히 다시'는 속도를 낮춰 다시 말하기로 나누는 것을 검토 |
| 307 | if (has(r"장애인\s*연금") and has(r"(신청\|도와)") and not has(r"검색")) or has(r"신청\s*(페이지\|화면\|서)?\s*(를\|을)?\s*(열어\|시작\|도와)"): | The only practice application flow is 장애인연금. Older, low-income and farmer users have no practice form for their programs (기초연금, 주거급여). Product decision with the mock site. | 연습 신청서를 기초연금 등으로 늘릴지 결정(모의 사이트·시나리오와 함께) |

#### `src/cheongeum/voice/config.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 105 | return LanguageRoutedStt(local, other, local_languages=("ko",), all_languages=LANGS) | Korean speech stays on the computer, but en/zh/ja speech goes to OpenAI when a key is set. Migrants using their own language get weaker privacy than Korean speakers (disclosed in app.js). | 다국어 로컬 받아쓰기를 검토하거나, 이 차이를 동의 안내에서 쉬운 말로 계속 알리기 |

#### `src/cheongeum/voice/stt.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 36 | STT_PROMPT = "장애인연금 신청 대화. 성명, 주민등록 주소, 실거주지, 연락처, 소득·재산 신고, 가구원 수, 모의접수, 다음으로, 이전으로, 멈춰, 청음아." | The recognition hint primes only disability-pension mock-form words. Terms older or low-income users say (기초연금, 주거급여, 생계급여) get no hint. The local model skips it by default. | 힌트를 '복지 신청 대화'로 넓히고 주요 제도 이름을 넣을지 eval_stt로 확인 |

#### `src/cheongeum/web/static/index.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 15 | <div class="toolbar" role="group" aria-label="도구"> | The toolbar has 고대비 but no larger-text control. Older users with weak eyesight must know browser zoom. | '글자 크게' 버튼 추가 |

#### `src/cheongeum/web/static/mic.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 45 | export async function startRecording(maxMs = 15000) { | Push-to-talk recording stops at 15 s. Older users or Korean learners who speak slowly or pause may be cut off mid-request. | 더 길게(예: 30초) 두고 끊길 때 소리로 알리기 |
| 365 | VoiceLoop.SILENCE_SHORT_MS = 1500; | Hands-free turn ends after 1.5 s of silence (2 s after long speech). Older adults and non-native speakers pause longer to find words, so requests may be sent half-finished. | 사용자별로 늘릴 수 있게 하거나 기본값을 고령층·이민자 사용자 시험으로 정하기 |

#### `src/cheongeum/web/static/styles.css`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 47 | .hint { font-size: .9rem; opacity: .85; } | Hints (how to talk, privacy notes) are smaller and faded, which lowers contrast for older users with weak eyesight. .muted on line 57 is the same. | 힌트도 본문 글자 크기, 불투명으로 |

#### `tests/e2e/test_conversation.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 205 | assert "기초연금 연습 신청서는 아직 없어요" in r["speech"] | 고령층: the only practice form is 장애인연금; 기초연금, the main program for older adults, has none, and this test asserts the refusal. Practice flow and demo serve disabled applicants only. | 고령층용 기초연금 연습 신청서를 둘지 결정한다. 만들면 이 단언을 바꾼다. |
| 445 | # drafts/research results/probes/phrasings.py의 19개. 규칙이 놓치면 LLM 계획이 이 평탄화 답을 낸다. | Everyday phrasings come from one probe set in standard Korean. No older-adult phrasing (dialect, vague 이거·그거) or non-native Korean (dropped particles) is tested here or in test_parser.py. | 고령층·결혼이민자 말투 예시(예: '이름 김하늘 써', '그거 눌러 주이소')를 PLANNED와 test_parser.py에 더한다. |

#### `tests/e2e/test_multilingual.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 24 | async def test_switch_to_english_then_translate(new_session): | E2E language tests cover en, zh, ja only, as does i18n.py LANG_NAME. Many 결혼이민자 speak Vietnamese, Tagalog, Khmer, Thai or Mongolian; none is supported or tested. | 베트남어 등을 지원하기로 하면 전환·번역·멈춤·승인 E2E를 같은 모양으로 더한다. |

#### `tests/e2e/test_web_ui.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 77 | async def test_decline_and_high_contrast(ui_url, page): | UI tests cover only the high-contrast and voice toggles. index.html has no text-size control, so nothing serves or checks large text for older or low-vision sighted users. | 글자 크기 조절을 두기로 하면 여기서 함께 시험한다. |

#### `tests/fixtures/picture_cases.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 6 | "question": "스크린샷으로 도표에서 방문이 가장 많은 계절을 알려줘", | Every picture request uses 스크린샷/캡처/화면 사진, matching the explicit trigger (rules.py _PICTURE_REQUEST). Plain asks like '이 그림에 뭐라고 써 있어?' are neither handled nor evaluated. | 쉬운 말 요청도 받을지 정하고(명시 요청만 받는 개인정보 이유와 견줘), 받으면 이 파일에 그런 질문을 더한다. |

#### `tests/unit/test_discovery_personal.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 141 | def test_speech_pref_commands(): | Voice settings cover speed, length, voice and progress only. There is no volume command ('크게 말해줘') and no step slower than 0.9, which older adults with hearing loss may need. | 소리 크기·더 느린 속도 명령을 둘지 정하고 여기 시험을 더한다. |

#### `tests/unit/test_i18n_voice_llm.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 72 | def test_stop_words_multilingual(): | Stop, approve and reject are rule words for en/zh/ja only. A Vietnamese or Tagalog speaker saying stop in their own language is not stopped; safety tracks the language list. | 언어를 더할 때 멈춤·승인·거절 규칙 단어와 그 시험을 반드시 함께 더한다. |

#### `tests/unit/test_open_data.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 93 | ("장애인 콜택시 어디에 예약해?", True), ("행정복지센터 전화번호 좀 알려줘", True), | Place lookup covers 주민센터, 국민연금 지사 and 교통약자 이동지원센터 only (core/places.py KINDS). No 가족센터(다문화가족지원센터) or multilingual helpline for 결혼이민자. | 결혼이민자용 기관 자료(가족센터 등)를 더할지 정하고, 더하면 장소 문장 시험을 더한다. |

#### `tests/unit/test_welfare.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 14 | LIST = (FIXTURES / "welfare-list-disability-pension.xml").read_text(encoding="utf-8") | API mapping, topic answers, RAG and the Recall/MRR gate (line 164) all run on one disability program (장애인연금). Programs for 고령층(기초연금), 저소득층, 농어민, 다문화가족 are never exercised. | 기초연금·기초생활보장·농어업인·다문화가족 제도 fixture를 하나씩 더해 같은 매핑·RAG 검사를 돌린다. |

## PLAIN: words a 정보취약계층 user may not know (188)

### should (78)

#### `apps/desktop/main.cjs`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 80 | dialog.showErrorBox('청음', `서버가 종료되었습니다(코드 ${code}). 터미널 로그를 확인하세요.`); | Error box shown to the user uses 서버, 코드 and 터미널 로그. The user cannot act on it. | '청음이 멈췄어요. 앱을 다시 켜 주세요. 계속되면 도와주는 분께 알려 주세요.' (코드는 로그에만) |
| 149 | dialog.showErrorBox('청음', '서버를 시작하지 못했습니다. .env와 터미널 로그를 확인하세요.'); | Error box shown to the user names .env, 터미널 로그 and 서버, which are developer terms. | '청음을 시작하지 못했어요. 컴퓨터를 다시 켠 뒤 다시 해 보세요. 계속되면 도와주는 분께 알려 주세요.' |

#### `drafts/research results/screen pictures and desktop apps - plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 31 | "사진으로 보면 위쪽에 '긴급 안내' 팝업이 있어요. … 숫자는 사진에서 읽은 것이라 확인하지 못했어요. | This planned spoken sentence uses 팝업, which many 고령층 do not know. Forward plan; the implementation will likely copy it. | '팝업' → '안내 창' (예: '위쪽에 '긴급 안내' 창이 떠 있어요'). |

#### `src/cheongeum/agents/web/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 138 | "LOG_FAILED": "조작 기록을 남기지 못해 승인된 조작을 실행하지 않았습니다.", | Spoken; '조작 기록', '승인된 조작' are internal terms a user cannot act on. | '기록을 남기지 못해서 허락하신 일을 하지 않았어요. 다시 말씀해 주세요.' |
| 229 | reason=f"'{item['name']}' 누르기({item['role']})" | Action reason is shown in the web UI '실행 내역' list (app.js:337); role is an English code (link, button, tab, scriptlink, generic) a sighted novice reads. | Drop the role or map it to Korean words: f"'{item['name']}' 누르기". |
| 269 | message=f"'{name}' 링크를 이 화면에서 찾지 못했습니다." | Spoken (browse.py:208-210). '링크' is jargon and wrong when the target was a button or tab, since _locate searches every pressable item. | f"'{name}'(이)라는 것을 이 화면에서 찾지 못했어요." |
| 270 | message=f"'{name}'에 맞는 링크가 {len(hits)}개입니다." | Spoken before the numbered candidate list; '링크' is jargon and may be inaccurate (buttons, tabs). | f"'{name}'(이)라는 것이 {len(hits)}개 있어요." |
| 849 | message=f"예상하지 못한 팝업('{dialogs['blocked']}')이 있어 진행을 멈췄습니다." | Spoken; '팝업' is jargon. The fallback title '알 수 없는 팝업' (line 804) is spoken inside it too. | f"예상하지 못한 안내 창('{...}')이 떠서 멈췄어요." and '알 수 없는 안내 창' |

#### `src/cheongeum/agents/web/approval.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 77 | kind = josa("링크" if a["role"] == "link" else "버튼", "이", "가") | Spoken when an approval is cancelled ('누르려던 X 링크가 화면에서 없어졌어요'); '링크' is jargon and tabs/menu items are called 버튼. 버튼 text pinned by test_approval.py:30-31, test_navigation.py:187. | Drop the role word: "누르려던 'X'(이)가 화면에서 없어졌어요"; update those two tests. |

#### `src/cheongeum/agents/web/browser/__init__.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 700 | errors = [*raw.get("errors", []), *(f"브라우저 경고창: {m}" for m in self._native_dialogs)] | Joins observation errors, which screen.py:140 speaks as '오류 안내: 브라우저 경고창: …'. '브라우저' is unfamiliar to many older users. | '사이트 알림 창: {m}' |

#### `src/cheongeum/agents/web/browser/waiting.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 1 | <title>청음 브라우저 창 (대기 중)</title> | Window and taskbar title a sighted user sees before consent; many older users do not know the word '브라우저'. | '청음 인터넷 창 (기다리는 중)' |
| 4 | <h1>청음 브라우저 창</h1> | Large heading of the waiting page a sighted user reads; '브라우저' is jargon for the new audience. | '청음이 쓰는 인터넷 창' |

#### `src/cheongeum/agents/web/digest.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 191 | can_do.append("검색 결과 열기" if kind == "search-results" else "내용 링크 열기") | '내용 링크 열기' is spoken in about_site; '링크' is unfamiliar to many 정보취약계층 users. | '글 안의 항목 열기' |

#### `src/cheongeum/agents/web/docs.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 30 | "speech": f"'{name}'은 예전 한글 파일(HWP)이라 글자를 뽑지 못해요. HWPX나 PDF로 받아 주세요.", | Asks the user to fetch another file format by acronym; an older user cannot tell HWP from HWPX/PDF or act on it. | '이 한글 문서는 읽을 수 없어요. 같은 자료가 PDF로도 있으면 그것을 받아 주세요'처럼 무엇을 누를지 말하기 |
| 33 | "speech": f"'{name}'의 원문은 읽어 드리기 어려워요. 원문 읽기는 PDF나 HWPX만 돼요." | Format acronyms the user cannot act on. | '이 종류의 파일은 읽어 드릴 수 없어요.' |

#### `src/cheongeum/agents/web/file_answer.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 33 | raise DocumentLimit("이 파일 형식은 요약할 수 없어요. PDF, HWPX, PNG, JPEG, WebP 파일을 받아 주세요.") | Spoken list of five format acronyms the user cannot act on. | '이 파일은 요약할 수 없어요. 문서나 사진 파일만 돼요.' |
| 79 | return "파일 분석에 실패했어요. 파일을 읽을 수 있는 모델인지 설정을 확인해 주세요.", "ko" | Asks the end user to check model settings, which they cannot do; '모델', '설정' are jargon. | '지금은 파일 내용을 알려 드릴 수 없어요. 글을 그대로 읽어 드릴까요?'(설정 안내는 기록으로) |

#### `src/cheongeum/agents/web/playbook.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 52 | "복지로는 자동으로 여는 브라우저의 접속을 막을 수 있어요. " | '자동으로 여는 브라우저' is technical; spoken once per session. | '복지로는 프로그램이 대신 여는 것을 막을 수 있어요.' |
| 72 | "policy-denied": "읽기·검색·링크 이동은 도와드릴 수 있어요. 예: '본문 읽어줘', '신청 방법 찾아줘'.", | '링크 이동' and '본문' in spoken help. | '읽기·검색·다른 화면으로 가기는 도와드릴 수 있어요. 예: 내용 읽어줘' |
| 133 | "이 사이트는 자동으로 여는 브라우저의 접속을 막고 있어서 내용을 읽을 수 없어요. 보안 장치를 우회하지는 않아요.", | Spoken on every blocked page; '자동으로 여는 브라우저' is technical. | '이 사이트는 프로그램이 대신 여는 것을 막고 있어서 내용을 읽을 수 없어요.' |

#### `src/cheongeum/agents/web/skills/browse.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 146 | f"…대신 검색했어요. '링크 목록 알려줘'라고 하시면 검색 결과를 읽어 드릴게요. 원하는 결과를 '○○ 링크 눌러줘'로 열 수 있어요." | Teaches two commands built on '링크'. | '검색 결과 읽어줘', '○○ 열어줘'처럼 파서가 받는 쉬운 말로 안내 |
| 210 | else f"{out.message} '링크 목록 알려줘'라고 하시면 이 화면의 링크를 읽어드립니다.", | '링크' twice in a recovery hint. | '누를 수 있는 것 알려줘'라고 하시면 읽어 드려요 |
| 228 | moved=f"'{out.readValue}' 링크를 열었습니다. {intro}", | '링크' after every followed link. | ''…'을 열었어요.' |
| 243 | kind = "링크" if target.get("role") == "link" else "버튼" | Approval question becomes ''X' 링크를 누르려고 해요 … 처리하는 링크일 수 있어서'; '링크' in the key consent sentence. | 링크도 '버튼'이나 '항목'으로 말하기 |
| 367 | return draft(state, "read", "이 세션에서는 받은 파일을 저장하지 않아요.") | '세션' is developer jargon. | '지금은 받은 파일을 저장하지 않아요.' |
| 374 | fallback = "OpenAI 파일 분석 설정이 없어 원문 읽기로 안내할게요. " | Company name and '설정' in speech; the user cannot change settings. | '파일 내용을 알려 드리는 기능을 지금 쓸 수 없어 글을 그대로 읽어 드릴게요.' |
| 386 | prompt = f"'{name}'의 {contents}를 {recipient}에 보내면 개인 정보가 포함될 수 있어요. 보내도 될까요? …" | Consent names the recipient as 'OpenAI' or '설정된 서버 host' (llm.py:115), also in the UI card (line 389). Users must understand where data goes to consent. | '외국 인공지능 회사(OpenAI)'처럼 무엇인지 풀어 말하기 |
| 531 | "더 읽을 링크가 없습니다." if start else "이 화면에는 링크가 없습니다." | '링크' in spoken replies. | '더 읽을 항목이 없어요.' / '누를 수 있는 항목이 없어요.' |
| 537 | more_hint = f" 나머지 {rest}개는 '링크 더 알려줘'라고 말씀하세요." if rest > 0 else "" | Teaches a command built on '링크'. | '더 알려줘' |
| 595 | return refused("화면 사진을 설명할 OpenAI 모델이 설정되지 않았어요. '화면 설명해줘'라고 하시면 글로 읽어 드릴게요.") | Setup jargon ('OpenAI 모델', '설정') the user cannot act on. | '지금은 화면 사진 설명을 쓸 수 없어요. …' |
| 818 | "이 화면에서 로그인 버튼이나 링크를 찾지 못했어요. '링크 목록 알려줘'라고 하시면 누를 수 있는 것을 읽어 드려요.", | '링크' twice in the login fallback. | '로그인 버튼을 찾지 못했어요. '누를 수 있는 것 알려줘'라고 하시면…' |
| 824 | moved = f"'{target['name']}' {josa(kind, '으로', '로')} 이동했어요. " if out.focused else "" | Says ''로그인' 링크로 이동했어요' for a focus move: '링크' plus screen-reader focus wording that sounds like page navigation. | '화면에서 '로그인' 버튼을 찾았어요.' |

#### `src/cheongeum/agents/web/skills/form.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 306 | popup = f"안내 팝업 '{"', '".join(out.dismissedDialogs)}'이 떠서 닫았어요. " | '팝업' is a loanword many older users do not know. | '안내 창 '…'이 떠서 닫았어요.' |

#### `src/cheongeum/agents/welfare/data/__init__.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 234 | "version": f"{year}년 기준" if year else "API 실시간", | version is spoken by source_sentence (agent.py:213) after answers, so TTS says '(출처: 복지로, API 실시간)'. | '오늘 조회한 공식 자료'처럼 말로 바꾸기 |

#### `src/cheongeum/core/intents.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 135 | [("본문 읽어줘", _WEB), ("계속 읽어줘", _WEB)], | Help reads '본문 읽어줘' (first example), teaching the jargon word 본문. | '내용 읽어줘'(규칙이 받는지 확인 후) |
| 142 | [("링크 목록 알려줘", _WEB), ("링크 더 알려줘", _WEB)], | Help reads '링크 목록 알려줘'; 링크 is listed jargon. | '누를 수 있는 것 알려줘'(규칙 지원 확인 후) |

#### `src/cheongeum/core/llm.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 115 | self.file_recipient = "OpenAI" if base_url.rstrip("/") == OPENAI_BASE_URL else f"설정된 서버 {urlsplit(base_url).hostname}" | Spoken in the file-send consent question (browse.py:386 '…를 OpenAI에 보내면…'). A foreign company name or a hostname tells most users nothing, so consent is not informed. | '미국 회사 OpenAI의 인공지능 서버' / '설정해 둔 다른 컴퓨터(서버)'처럼 풀어 말하기 |

#### `src/cheongeum/language/i18n.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 138 | "ko": "모든 동작을 멈췄습니다. 대기 중인 브라우저 작업은 없습니다. 이어서 하려면 '다시 시작'이라고 말씀하세요.", | Spoken on every stop; '대기 중인 브라우저 작업' is jargon. | '모두 멈췄어요. 기다리던 일도 없어요. 이어서 하려면 '다시 시작'이라고 말씀하세요.' |

#### `src/cheongeum/orchestrator/session.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 689 | f"처리 중 문제가 생겨 실행을 멈췄습니다({name}). 다시 말씀해 주세요." | 예외 클래스 이름(TimeoutError 등 영어)이 그대로 TTS로 읽힌다. 사용자에게 뜻이 없고 영어를 모르는 사용자에게 혼란. | 이름은 trace에만 남기고 말은 '처리 중 문제가 생겨 멈췄어요. 다시 말씀해 주세요.' |
| 1086 | " 자세히는 '본문 읽어줘', 입력 칸은 '하나씩 채워줘'라고 하세요." | 사용자에게 '본문'이라는 말을 따라 하라고 가르친다. '본문'은 웹 용어라 고령층·이민자가 뜻을 모를 수 있다. | '자세히는 "내용 읽어줘"…'(규칙 파서가 '내용 읽어줘'를 READ_MAIN으로 받는지 함께 확인) |
| 1185 | "인계받은 신청 주소가 허용된 사이트가 아니라서 열지 않았습니다." | '인계받은'은 내부 구조(Agent B→A 인계) 용어가 사용자 말에 새어 나온 것. 정보취약계층에게 뜻이 불분명. | '찾은 신청 주소가 허용된 사이트가 아니라서 열지 않았어요.' |

#### `src/cheongeum/personal/dialogue.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 153 | "조작 기록을 이 세션에서는 쓰지 않아요." | '세션'은 개발 용어. 사용자에게 뜻이 없다. | '지금은 조작 기록을 남기지 않고 있어요.' |
| 159 | f"허용한 사이트는 {', '.join(sites)}이에요."  # sites = origin(https://…) | allowed_sites()가 출처(https://www.…)를 돌려주므로 TTS가 'https 콜론 슬래시…'처럼 주소를 읽는다. | 출처를 한국어 사이트 이름(sites.site_label)으로 바꿔 읽는다. |

#### `src/cheongeum/safety/gates.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 40 | "먼저 시작 화면의 안내를 듣고 동의해 주세요. 동의 전에는 화면을 읽거나 브라우저를 조작하지 않습니다." | 동의 거절 응답으로 말해진다. '브라우저'는 디지털 경험이 적은 사용자가 모르는 말. | '…동의 전에는 화면을 읽거나 인터넷 창을 움직이지 않아요.' |
| 42 | "동의하지 않으셔서 화면을 읽거나 브라우저를 조작하지 않습니다. 복지 제도 질문은 할 수 있습니다." | '브라우저' 같은 말이 그대로 들린다. | '동의하지 않으셔서 화면을 읽거나 인터넷 창을 움직이지 않아요. 복지 제도 질문은 하실 수 있어요.' |

#### `src/cheongeum/safety/guard.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 113 | f"허용되지 않은 액션 유형({action['type']})입니다." | '액션 유형'과 영어 종류 이름(navigate 등)이 그대로 말해진다. | '이 조작은 할 수 없어요.'(종류 이름은 trace에만) |
| 128 | "비밀번호 등 인증 정보는 에이전트가 입력하지 않습니다." | '에이전트'는 개발 용어. 사용자에게는 청음이 스스로를 가리키는 말이 필요. | '비밀번호 같은 인증 정보는 제가 입력하지 않아요. 직접 입력해 주세요.' |
| 132 | "허용된 입력 필드가 아닙니다." | '필드'는 개발 용어. 다른 곳은 '입력 칸'을 쓴다. | '제가 채울 수 있는 입력 칸이 아니에요.' |

#### `src/cheongeum/server/app.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 110 | "서버 STT가 설정되지 않았습니다. 브라우저 음성 인식이나 텍스트 입력을 사용하세요." | UI에 보이는 오류. 'STT'·'서버'·'브라우저'·'텍스트'는 사용자가 알 수 없는 말이고 할 일도 모호하다. | '이 컴퓨터에서는 말 받아쓰기가 준비되지 않았어요. 글자로 써 주세요.' |
| 120 | "세션이 없습니다. 새 세션을 시작하세요." | UI에 보이는 오류. '세션'은 개발 용어라 무엇을 해야 할지 모른다. | '연결이 끊겼어요. 화면을 새로 고치거나 앱을 다시 켜 주세요.' |
| 126 | "서버 오류가 발생했습니다. 모의 사이트와 브라우저가 실행 중인지 확인하세요." | UI에 보이는 오류인데 개발자용 지시(모의 사이트·브라우저 실행 확인)라 정보취약계층 사용자가 할 수 없다. | '잠시 문제가 생겼어요. 다시 말씀해 주시고, 계속되면 앱을 다시 켜 주세요.' |
| 178 | _err(404, "SESSION_NOT_FOUND", "세션이 없습니다.") | /api/turn 오류로 UI에 보인다. '세션'은 개발 용어. | 120행과 같은 쉬운 문구로 통일. |
| 258 | _err(404, "SESSION_NOT_FOUND", "세션이 없습니다.")  # /api/audio/turn | 음성 턴 오류로 UI에 보인다. '세션'은 개발 용어. | 120행과 같은 쉬운 문구로 통일. |
| 279 | _err(404, "SESSION_NOT_FOUND", "세션이 없습니다.")  # /api/audio/stop | 멈춤 음성 경로 오류로 UI에 보인다. '세션'은 개발 용어. | 120행과 같은 쉬운 문구로 통일. |

#### `src/cheongeum/speech/screen.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 138 | parts.append(f"화면 구성: {', '.join(o['landmarks'])}.") | Speaks screen-reader landmark names from observe.js (머리말, 탐색 메뉴, 보조 영역, 꼬리말). This is a screen-reader concept that older or low-literacy users will not follow. | 빼거나 '위쪽 메뉴, 가운데 내용, 맨 아래 안내'처럼 위치로 말하기 |
| 160 | f"링크 {total}개 중 앞 15개: {', '.join(links[:15])}. 전체는 '링크 목록 알려줘'라고 말씀하세요." | 링크 is web jargon, and the user is told to repeat it as a command. rules.py LIST_LINKS already accepts 메뉴, so a plainer command exists. | '누를 수 있는 것 N개 중 앞 15개 … 전체는 '메뉴 알려줘'라고 하세요.' (rules.py에 '누를 수 있는 것 알려줘'도 추가 검토) |
| 162 | else f"링크: {', '.join(links)}." | Same 링크 jargon in the short form of the full-screen description. | '누를 수 있는 것: …' 또는 '메뉴: …' |
| 187 | hint = self.once("read", "이어서 들으려면 '본문 읽어줘'라고 하세요.") | Teaches the command '본문 읽어줘'. rules.py READ_MAIN already accepts '내용 읽어줘', which is plainer. | '이어서 들으려면 '내용 읽어줘'라고 하세요.' |
| 206 | tail = self.once("brief", " 더 들으려면 '본문 읽어줘', 메뉴는 '링크 목록 알려줘'라고 하세요.") | Two jargon commands in one hint (본문, 링크). rules.py accepts '내용 읽어줘' and '메뉴 알려줘'. | ' 더 들으려면 '내용 읽어줘', 메뉴는 '메뉴 알려줘'라고 하세요.' |
| 224 | hint = self.once("read", " 이어서 들으려면 '본문 읽어줘'라고 하세요.") | Same '본문 읽어줘' command hint as line 187, heard on every first page open. | ' 이어서 들으려면 '내용 읽어줘'라고 하세요.' |

#### `src/cheongeum/understanding/filters.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 63 | 어떤 걸 누를까요? '링크 목록 알려줘'라고 하시면 누를 수 있는 것을 읽어 드려요. | Uses 링크 as a command word, and only offers listing, which assumes the user cannot see. A sighted user could just say the name they see. | '화면에 보이는 이름을 말씀하시거나, '메뉴 알려줘'라고 하시면 누를 수 있는 것을 읽어 드려요.' |

#### `src/cheongeum/web/static/app.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 43 | '본문 읽어줘', | Example command shown as a button teaches the jargon 본문. rules.py READ_MAIN accepts '내용 읽어줘'. | '내용 읽어줘' |
| 44 | '링크 목록 알려줘', | Example command teaches the jargon 링크. rules.py LIST_LINKS accepts '메뉴 알려줘'. | '메뉴 알려줘' (또는 '누를 수 있는 것 알려줘'를 규칙에 추가) |
| 76 | .map(([k, v]) => `${label[k]}은 ${v}`); | The spoken consent reads raw model ids from /api/health llmRoles (provider(model) strings) aloud. They mean nothing to most users. | '말씀 이해에는 외부 인공지능 서비스(OpenAI)를 씁니다'처럼 회사 이름과 하는 일만 |
| 89 | '화면 사진을 요청하면 현재 탭의 웹페이지 전체를 한 장으로 찍어 OpenAI로 보냅니다. 입력란과 내장 문서, 감지된 개인정보는 가립니다. ' | 탭 and 내장 문서 are jargon in a sentence users must understand to give informed consent. | '지금 보고 있는 웹페이지 전체를 사진 한 장으로 찍어 OpenAI로 보냅니다. 입력 칸과 페이지 안의 문서 파일은 가립니다.' |
| 267 | ' 이 브라우저는 음성 인식을 지원하지 않아 텍스트 입력만 사용할 수 있습니다.' | Help text under the input box uses 브라우저 and 텍스트. | ' 여기서는 말로 입력할 수 없어 글자로만 입력할 수 있어요.' |
| 373 | setError('브라우저가 소리 재생을 막았습니다. 화면을 한 번 클릭하거나 "소리 확인" 버튼을 눌러 주세요.'); | 브라우저 and 클릭 in a message the user must act on. | '소리가 막혀 있어요. 화면을 한 번 누르거나 '소리 확인' 버튼을 눌러 주세요.' |
| 402 | setError('브라우저가 소리 재생을 막았습니다. 화면을 한 번 클릭해 주세요.'); | Same as line 373. | '소리가 막혀 있어요. 화면을 한 번 눌러 주세요.' |
| 444 | setError('대화 모드는 서버 음성 인식(STT_PROVIDER=local 또는 openai)이 필요합니다. 지금은 음성 입력 버튼이나 텍스트를 사용하세요.'); | Shows a config variable name and 모드/서버/텍스트 to the user. | '지금은 말로 대화할 수 없어요. 음성 입력 버튼이나 글자로 입력해 주세요.' (설정 이름은 로그로) |
| 560 | await speakAndWait('문제가 계속되어 대화 모드를 끝냅니다. 텍스트로 입력해 주세요.'); | Spoken. 대화 모드 and 텍스트 are jargon, and typing is not an option for many older users. | '문제가 계속돼서 대화를 멈출게요. 대화 시작 버튼을 다시 누르거나 글자로 입력해 주세요.' |
| 873 | setError('마이크를 사용할 수 없습니다. 브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요.'); | 브라우저 마이크 권한 and 텍스트 are jargon in an error the user must fix. | '마이크를 쓸 수 없어요. 마이크 사용을 허락했는지 확인하거나 글자로 입력해 주세요.' |
| 1002 | label: `인식: ${h.stt.supported ? h.stt.provider : '브라우저'} · 안내: ${h.tts.supported ? h.tts.provider : '브라우저'}`, | Puts provider ids (local(model)+openai(model)) into the help line under the input box. | '말 알아듣기: 이 컴퓨터 · 목소리: 외부 서비스'처럼 쉬운 말로 |
| 1019 | : `준비되었습니다. (의도 분석: ${s.llmProvider}) '대화 시작'을 누르거나 Enter를 누르면 음성으로 대화합니다.`, | Shows the intent provider id (e.g. mock-rule, openai(model)+mock-rule) in the conversation log. | '준비되었어요. '대화 시작'을 누르면 말로 대화할 수 있어요.' |
| 1025 | setError(`세션을 시작하지 못했습니다: ${e.message} — 서버(uv run cheongeum-server)가 실행 중인지 확인하세요.`); | Developer instructions (세션, 서버, a shell command) shown to end users. | '청음을 시작하지 못했어요. 프로그램을 다시 켜 주세요.' (자세한 내용은 로그로) |

#### `src/cheongeum/web/static/index.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 12 | 데모 · 모의 신청 전용 — 실제 복지로 접수가 아닙니다. 합성 데이터만 사용하세요. | 합성 데이터 is jargon, so users may type real personal data without understanding the warning. | '연습용입니다. 실제 내 정보 대신 꾸민 정보만 넣으세요.' |
| 111 | <p>브라우저 창의 가상 인증 화면에 키보드로 직접 입력하세요. 청음은 비밀번호를 듣거나 입력하지 않습니다.</p> | 브라우저 창 and 가상 인증 화면 are unclear; the user must work out which window to type in. | '옆에 열린 인터넷 창의 인증 화면에 직접 입력해 주세요. 청음은 비밀번호를 듣거나 입력하지 않아요.' |

#### `src/cheongeum/web/static/mic.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 15 | onError('이 브라우저는 음성 인식을 지원하지 않습니다. 텍스트로 입력해 주세요.'); | 브라우저 and 텍스트 in a user-facing error. | '여기서는 말로 입력할 수 없어요. 글자로 입력해 주세요.' |
| 38 | r.onerror = (e) => onError(`음성 인식 오류: ${e.error}`); | Shows raw English browser error codes (no-speech, not-allowed, network) to the user. | 코드별 쉬운 말: '말소리가 들리지 않았어요', '마이크 사용이 허락되지 않았어요' 등 |

### consider (110)

#### `apps/desktop/main.cjs`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 50 | tray.setToolTip('청음 — 음성 도우미 (Cmd/Ctrl+Shift+Space: 지금 말하기)'); | User-facing tooltip uses English key names and shows the Mac Cmd key on Windows. Older users may not read 'Shift+Space'. | 운영체제에 맞는 한 가지만 한글로: 'Ctrl+Shift+스페이스 키: 지금 말하기'. |
| 53 | { label: '지금 말하기 (Cmd/Ctrl+Shift+Space)', click: () => win?.webContents.send('cheongeum:talk') }, | Tray menu label uses English key names and both Mac and Windows keys at once. | '지금 말하기 (Ctrl+Shift+스페이스)'처럼 운영체제별로 한 가지만 한글로. |

#### `drafts/research results/screen pictures and desktop apps - plan.md`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 153 | the consent text will say pictures go to OpenAI. | Consent depends on knowing where pictures go. Many 고령층 do not know the English name 'OpenAI', so consent given on that wording may not be informed. | 동의 문구를 '화면 사진을 미국 회사 OpenAI의 인공지능에 보내 설명을 받아요'처럼 풀어 쓴다. |

#### `src/cheongeum/agents/web/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 132 | "TARGET_NOT_FOUND": "화면에서 조작할 대상을 찾지 못했습니다.", | Spoken through skills/common.py; '조작할 대상' is technical wording. | '누를 곳을 화면에서 찾지 못했어요.' |
| 133 | "AMBIGUOUS_TARGET": "같은 이름의 대상이 여러 개라서 실행하지 않았습니다.", | Spoken; '대상', '실행' are abstract where a concrete phrase exists. | '같은 이름이 화면에 여러 개 있어서 누르지 않았어요.' |
| 136 | "NAVIGATION_FAILED": "페이지를 열지 못했습니다. 인터넷 연결이나 사이트 상태를 확인해 주세요.", | Spoken; '페이지' is a loanword, and asking a novice to check 'site state' gives no step they can take. | '화면을 열지 못했어요. 인터넷이 연결돼 있는지 확인하시고 다시 말씀해 주세요.' |
| 137 | "RESUBMIT_BLOCKED": "이전 화면은 양식을 보낸 결과 화면이라, 같은 내용을 다시 보내지 않도록 돌아가지 않았습니다.", | Spoken; '양식' and '결과 화면' are web-form terms. | '앞 화면은 입력한 내용을 보낸 뒤의 화면이라, 같은 내용이 다시 보내지지 않게 돌아가지 않았어요.' |
| 373 | self._action(type="back", reason="이전 페이지로 돌아가기") | Reason is shown in the UI '실행 내역' list; '페이지' where '화면' is plainer. | '앞 화면으로 돌아가기' |
| 381 | message="더 돌아갈 이전 페이지가 없습니다." | Spoken (browse.py:456); '페이지' loanword. | '더 돌아갈 앞 화면이 없어요.' |
| 550 | self._action(type="capture", reason="요청한 브라우저 탭 사진 촬영") | Reason is shown in the UI '실행 내역' list; '브라우저 탭' is jargon. | '요청하신 화면 사진 찍기' |
| 552 | failure = "현재 웹페이지의 사진을 찍지 못했어요. 다시 요청해 주세요." | Spoken; '웹페이지' where '화면' is plainer and matches other messages. | '지금 화면의 사진을 찍지 못했어요. 다시 말씀해 주세요.' |
| 657 | _FAIL_MESSAGES.get(result.get("errorCode") or "", "조작에 실패했습니다.") | Spoken fallback; '조작' is technical. | '하려던 일을 하지 못했어요.' |
| 681 | reason="장애인연금 모의 신청 링크 클릭" | Reason is shown in the UI '실행 내역' list; '링크 클릭' is jargon. | '장애인연금 연습 신청서 열기' |
| 806 | reason=f"안내 팝업 '{d['title']}' 닫기" | Reason is shown in the UI '실행 내역' list; '팝업' is jargon. | f"안내 창 '{d['title']}' 닫기" |
| 890 | "reason": "사용자 승인 후 모의접수 버튼 클릭(실제 제출 아님)", | Reason is shown in the UI '실행 내역' list; '클릭' where '누르기' is plainer. | '허락받고 모의접수 버튼 누르기(실제 제출 아님)' |

#### `src/cheongeum/agents/web/autopilot.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 52 | answer에 사용자에게 들려줄 답을 결론부터 1~2문장, 80자 안팎(쉬운 존댓말, 화면 내용에 근거. 목록은 3개까지, 부연·출처 설명 금지) | Prompt dictates spoken answer/ask_user/fail text and asks for 쉬운 존댓말, but does not forbid web jargon (링크, 탭, 팝업, URL) or English abbreviations. | Add a rule: '링크·탭·팝업·URL 같은 웹 용어와 영어 약어 대신 쉬운 우리말로 말한다.' |
| 250 | 화면에서 확실한 답을 확인하지 못했어요. 추측해서 말씀드리지 않을게요. 지금 화면의 본문을 읽어 드릴까요? | Spoken; '본문' is a document term (also a command word, '본문 읽어줘'). | '…지금 화면의 글을 읽어 드릴까요?' |

#### `src/cheongeum/agents/web/digest.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 26 | "article": "글 본문", | Spoken as '지금 화면은 글 본문 페이지예요.' (browse.py:690, screen.py:119); '본문' is web/editor jargon for many users. | '긴 글' 또는 '안내 글' |
| 189 | can_do.append("본문 읽기") | Spoken in about_site (browse.py:694): '여기서는 본문 읽기, …를 도와드릴 수 있어요.' | '내용 읽기' |

#### `src/cheongeum/agents/web/docs.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 52 | raise DocumentLimit(f"PDF는 한 번에 {max_pages}쪽까지 요약할 수 있어요. 필요한 부분을 나누어 받아 주세요.") | Spoken limit message; 'PDF' and '나누어 받아 주세요' are not actionable for a non-expert. | '문서가 너무 길어서 한 번에 요약할 수 없어요. 궁금한 부분을 물어봐 주세요.' |
| 64 | raise DocumentLimit("HWPX의 본문이 너무 커서 읽지 못했어요. 필요한 부분을 나누어 받아 주세요.") | Acronym HWPX and a step the user cannot do. | '이 한글 문서는 너무 커서 읽지 못했어요.' |

#### `src/cheongeum/agents/web/effect.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 91 | NOT_READY = "화면이 아직 다 열리지 않았어요. 잠시 뒤 '본문 읽어줘'라고 말씀해 주세요." | Teaches the command with '본문'; rules.py:338 already accepts '내용 읽어줘'. | '잠시 뒤 '내용 읽어줘'라고 말씀해 주세요.' |

#### `src/cheongeum/agents/web/file_answer.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 23 | "ko": "AI가 이미지를 읽은 내용이라 틀릴 수 있어요.", | 'AI', '이미지' are loanwords; this warning matters most to the users least likely to know them. | '컴퓨터가 그림을 보고 읽은 내용이라 틀릴 수 있어요.' |
| 40 | raise DocumentLimit("파일은 한 번에 20MB까지 읽을 수 있어요. 필요한 부분을 나누어 받아 주세요.") | 'MB' and splitting a file mean little to most users. | '파일이 너무 커서 읽을 수 없어요.' |
| 51 | raise DocumentLimit("이 HWPX에서 글을 찾지 못했어요.") | Format acronym in speech. | '이 한글 문서에서 글을 찾지 못했어요.' |

#### `src/cheongeum/agents/web/playbook.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 27 | "policy-denied": "읽기·이동·검색은 도와드릴 수 있어요. 예: '본문 읽어줘', '뒤로 가줘'.", | Example command uses '본문'; rules.py:338 accepts '내용 읽어줘'. | '내용 읽어줘' |
| 57 | "policy-denied": "읽기·검색·메뉴 이동은 도와드릴 수 있어요. 예: '본문 읽어줘', '서비스 찾기 눌러줘'.", | Example command uses '본문'. | '내용 읽어줘' |

#### `src/cheongeum/agents/web/skills/browse.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 60 | return "본문을 이어서 보고 있어요." | Progress sentence spoken by the progress voice; '본문'. | '내용을 이어서 보고 있어요.' |
| 62 | return f"본문에서 {target} 찾았어요." if ok else f"본문에서 {target} 찾아봤어요." | Progress sentence; '본문'. | '글에서 … 찾았어요.' |
| 134 | "어느 사이트를 열지 알려 주세요. 예: '정부24 열어줘', 'gov.kr 열어줘'." | Second example is a domain name; many older users do not know web addresses. | '예: 정부24 열어줘, 복지로 열어줘' |
| 140 | "speech": f"'{name}'의 주소를 몰라서 검색해 보려 했지만 열 수 없었어요. 주소를 직접 말씀해 주세요.", | '주소' means web address here and can be heard as a home address; asking for a URL assumes web literacy. | '인터넷 주소를 아시면 말씀해 주시고, 모르시면 다른 이름으로 말씀해 주세요.' |
| 246 | site = u.host if u else url | Goes to the UI approval card '대상 사이트' as a raw host name. | site_label(url) 사용 |
| 358 | f"{listed}{more} 로그인 기록을 지웠어요. 다시 쓰려면 로그인해야 해요.", | Reads raw cookie domains (e.g. 'bokjiro.go.kr, www.bokjiro.go.kr') aloud. | site_label로 사이트 이름만 말하기 |
| 503 | "본문을 끝까지 읽었습니다." if offset else "이 화면에서 읽을 본문을 찾지 못했습니다. '화면 설명해줘'라고 하시면 구성을 알려드립니다.", | '본문' twice in spoken replies. | '내용을 끝까지 읽었어요.' / '읽을 내용을 찾지 못했어요.' |
| 514 | intro = "본문입니다. " | Spoken before every read; '본문'. | '내용입니다.' |
| 701 | return draft(self.dialogue.state, "web-answer", "이 설정에서는 다른 웹사이트를 열 수 없어 찾아볼 수 없어요.") | '설정' is setup jargon. | '지금은 다른 사이트를 열 수 없어 찾아볼 수 없어요.' |
| 713 | f"{josa(f"'{query}'", "을", "를")} 검색해 열었어요. AI 요약 설정이 없어 본문만 읽어요. …", | 'AI 요약 설정', '본문' in speech. | '요약 기능을 쓸 수 없어 앞부분만 읽어 드릴게요.' |
| 736 | f"검색 결과에서 확실한 답을 확인하지 못했어요. 본문 시작은 이렇습니다. {…}" | '본문' in speech. | '찾은 글의 앞부분은 이렇습니다.' |
| 752 | "여러 단계를 알아서 하려면 AI 모델 설정이 필요해요. 대신 '네이버 열어줘'처럼 한 단계씩 말씀해 주세요." | 'AI 모델 설정' is setup jargon the user cannot act on. | '지금은 여러 단계를 알아서 할 수 없어요. 대신 한 단계씩 말씀해 주세요.' |
| 764 | self.progress.add(step_sentence(step, site_label(before, sites), site_label(here, sites))) | For unknown sites site_label returns the bare host, so the progress voice says e.g. 'www.example.com에서 …'. | 모르는 사이트는 '이 사이트'로(화면 글은 넣지 않는 원칙 유지) |
| 802 | return {**asked, "speech": f"{lead}모의접수 단계에 왔어요. {asked['speech']}", …} | '모의' wording; '연습' is plainer. | '연습 접수 단계에 왔어요.' |

#### `src/cheongeum/agents/web/skills/common.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 67 | body = f"{out.message or '실행하지 못했습니다.'} 다시 시도하거나 다른 명령을 말씀해 주세요." | Spoken after most failures; '명령' sounds technical and curt to older users. | '다시 해 볼까요? 아니면 다른 일을 말씀해 주세요.' |

#### `src/cheongeum/agents/web/skills/form.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 98 | site = u.host if u else view["url"] | Shown in the UI approval card as '대상 사이트: www.example.go.kr'; a raw host name means little to many users. guided.py already uses site_label. | site_label(view['url']) 또는 페이지 제목 사용 |
| 300 | "마지막 검토 단계입니다. 내용을 확인했으면 '모의 접수 내용을 확인했어'라고 말씀해 주세요.", | User must say a long phrase containing '모의'; '연습' is plainer and matches 기획요약's '연습용 신청서'. | '연습 접수 내용을 확인했어', 짧은 '확인했어'도 받기 |
| 358 | "이 내용으로 모의접수할까요? 실제 복지로 접수가 아니며 어디에도 전송되지 않습니다. 승인하려면 '모의접수 승인', 그만두려면 '거절'… | The go word itself is '모의접수 승인', a hard phrase to recall and say. | '연습 접수할까요? 하시려면 '접수해', 그만두려면 '아니'라고 말씀하세요.' |
| 366 | "site": f"{profile.name} ({profile.origin}, 로컬)", | UI card shows 'http://127.0.0.1:5174, 로컬'; the address and '로컬' mean nothing to most users. | '모의 복지 신청 사이트 (이 컴퓨터 안의 연습용)' |
| 404 | f"모의접수를 마쳤습니다. 모의 접수번호는 {out.receipt}입니다. 실제 복지로 접수가 아니며 어떤 기관에도 전송되지 않았습니다.", | '모의' wording; '연습' is plainer. | '연습 접수를 마쳤어요. 연습 접수번호는 …' |
| 424 | return draft("APPLICATION_OPEN", "reject", "모의접수를 하지 않았어요. 입력 내용은 그대로 있어요.") | '모의' wording; '연습' is plainer. | '연습 접수를 하지 않았어요.' |

#### `src/cheongeum/agents/web/skills/guided.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 100 | f"{site}에 저장된 내 정보를 쓸까요? 맞으면 '응', 아니면 '아니'라고 해 주세요." | For sites not in KNOWN_SITES site_label returns the bare host, so a consent question speaks e.g. 'minwon.example.go.kr에 저장된 내 정보를…'. | 모르는 사이트면 '이 사이트'나 페이지 제목으로 말하기 |
| 126 | speech = f"{site} {label} 칸에 '{value}' 넣을까요? 맞으면 '응', 아니면 '아니'라고 해 주세요." | Same host fallback (site_label, then u.host or the full URL) spoken before every field. | 모르는 사이트면 사이트 이름을 빼고 '{label} 칸에 …'만 |
| 216 | return f"{site}에 저장된 내 정보를 쓸까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.{first}" | Same bare-host fallback as line 100, spoken in a consent question. | 모르는 사이트면 '이 사이트'나 페이지 제목으로 말하기 |

#### `src/cheongeum/agents/welfare/agent.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 102 | 질문에 대한 답(결론·숫자·대상)부터 말하고, 최대 2문장 100자 안팎의 짧고 쉬운 존댓말로 답한다. | Already rebranded and consistent, but answers repeat 근거 terms (소득인정액, 선정기준액, 차상위) verbatim; nothing asks the model to gloss 행정 용어 that 고령층·결혼이민자 may not know. | '어려운 행정 용어는 근거 표현을 쓰되 짧게 풀어 말한다(숫자는 그대로)' 한 줄 추가 검토 |
| 469 | 정확한 자격은 담당 기관에 확인해 주세요. 복지로 상세 페이지를 열어 드릴까요? | TTS question uses web jargon '상세 페이지'; users new to the web may not know what will open. | '복지로에서 이 제도 안내 화면을 열어 드릴까요?' |
| 478 | condition은 15자 이내 한국어 명사구(예: "만 18세 이상", "중위소득 50% 이하"), note는 한 문장. | condition is spoken as is; the precheck prompt's own example is '중위소득 50% 이하', a term many 고령층·결혼이민자 do not know, and it asks for no plain wording. | 예시를 쉬운 말로 바꾸고 '기준 원문의 어려운 용어는 쉬운 말로(숫자는 그대로)' 지시 추가 |
| 511 | {name}의 신청 서류는 공식 상세 페이지에서 확인해야 해요. '신청 페이지 열어줘'라고 하시면 열어 드릴게요. | Spoken '상세 페이지'/'페이지' jargon, and the suggested command teaches the word 페이지. | '공식 안내 화면에서 확인해야 해요. '신청 안내 열어줘'라고 하시면…'(규칙이 받는지 확인) |
| 537 | speech=f"{detail['servNm']} 신청은 {first_sentence(how, 80)}에서 해요.{forms_part}{contact_part} 복지로 상세 페이지를 열어 드릴까요?" | Same '상세 페이지' jargon at the end of every 신청 준비 answer. | '복지로에서 이 제도 안내 화면을 열어 드릴까요?' |

#### `src/cheongeum/agents/welfare/data/__init__.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 231 | "title": f"복지로 '{serv_nm}' (한국사회보장정보원 중앙부처복지서비스 API)", | Shown as link text in the UI 근거 자료 list (app.js:326). 'API' and '중앙부처복지서비스' mean nothing to most users. | 화면 제목은 '복지로 ○○ 안내(한국사회보장정보원 공식 자료)'처럼 |
| 235 | "note": "공식 API 실시간 조회", | note is shown next to each source in the UI (app.js:327, '확인일 …, 공식 API 실시간 조회'). | '공식 자료 바로 조회' |
| 501 | "title": f"복지로 '{s['servNm']}' (한국사회보장정보원 지자체복지서비스 API)" | Local-program source title shown in the UI sources list with 'API'. | '복지로 ○○ 안내(지자체 공식 자료)' |

#### `src/cheongeum/agents/welfare/discovery.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 23 | "income": "기초생활수급자나 차상위계층이신가요? 잘 모르시면 '모름'이라고 하셔도 돼요." | '차상위계층' is administrative jargon; many eligible people and Korean learners do not know whether they are 차상위. | '나라에서 생계비나 의료비 지원을 받고 계신가요? 아니면 형편이 어려우신가요?'처럼 풀어 묻기 |

#### `src/cheongeum/agents/welfare/open_data/datasets.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 56 | "version": f"{ref.isoformat()} 기준" | Spoken for 민간 사업 via source_sentence ('출처: …, 2026-03-31 기준'); TTS reads ISO dates awkwardly. places.py:120 already says 년·월·일. | '2026년 3월 31일 기준'처럼 말로 읽는 날짜 |
| 61 | Dataset("15059715", "행정안전부 읍면동 하부행정기관 현황", ... | This title is spoken as the source of every 주민센터 answer (places.py:120); '읍면동 하부행정기관 현황' is jargon. | 말할 때 쓸 짧은 출처 이름 따로 두기(예: '행정안전부 공개 자료') |
| 63 | Dataset("15028207", "전국교통약자이동지원센터정보표준데이터", ... | Spoken as the source of 이동지원센터 answers; one long compound ending in '표준데이터'. | 말할 때는 '국토교통부 공개 자료' 등 짧은 이름 |

#### `src/cheongeum/core/intents.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 26 | HelpGroup = Literal["시작", "복지 정보", "웹 읽기", "신청서", "언제든"] | Group names are spoken in help ('웹 읽기: …', session.py:1051); '웹' may be unfamiliar to 고령층. | '인터넷 화면 읽기' 또는 '화면 읽기' |
| 93 | _row("OPEN_BROWSER", "사이트 이름 없이 크롬·브라우저만 켜기", "시작", ["크롬 켜줘", "브라우저 열어줘"]), | Help reads '크롬 켜줘'; many 고령층 call the browser '인터넷'. Check rules.py accepts '인터넷 켜줘' before changing. | 예문을 '인터넷 켜줘'로(규칙 지원 확인 후) |

#### `src/cheongeum/core/turn.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 66 | STATE_LABELS_KO: "TRANSCRIBED": "전사 완료", "BROWSING": "웹 페이지 읽는 중(읽기 전용)", "MOCK_SUBMITTED": "모의접수 완료" | Unused in Python but mirrors app.js:8, whose labels are shown and announced ('상태: …'). '전사', '읽기 전용', '모의접수' are jargon; keep both copies in sync. | '받아쓰기 끝', '인터넷 화면 읽는 중(입력은 안 해요)', '연습 접수 끝' 등 |

#### `src/cheongeum/language/i18n.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 150 | "ko": "다른 언어로 대화하려면 AI 모델 설정이 필요해요. 지금은 한국어로만 안내할 수 있어요.", | 'AI 모델 설정' is jargon and something only the operator can do. | '다른 언어 대화 기능이 아직 켜져 있지 않아요. 지금은 한국어로만 안내할 수 있어요.' |

#### `src/cheongeum/orchestrator/session.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 80 | NOT_DONE = {..., None: "모의접수하지 않았어요."} | '모의접수'는 한자어 합성어라 고령층·결혼이민자에게 낯설 수 있다. 승인 후 화면이 바뀌었을 때 들려주는 말. | '연습 접수는 하지 않았어요.' |
| 1005 | "크롬을 열었어요. 어디로 갈까요?" | '크롬'은 제품 이름이라 컴퓨터가 익숙하지 않은 고령층은 무엇이 열렸는지 모를 수 있다. | '인터넷 창을 열었어요. 어느 사이트로 갈까요?' |
| 1019 | step = "누리집 이용" | 사람 도움 안내(help_human_draft)에 들어가 말로 나가는 단계 이름. '누리집'은 순화어지만 고령층·이민자에게 '사이트·홈페이지'보다 낯설다. | '사이트 이용' 또는 '홈페이지 이용' |
| 1038 | lead = ("웹 읽기",)  → 도움말에서 f"{group}: ..."로 읽힘 | 도움말 묶음 이름 '웹 읽기'가 그대로 들린다. '웹'은 디지털 경험이 적은 사용자에게 낯선 말. 이름은 core/intents.py HelpGroup에 있다. | '사이트 읽기' 또는 '인터넷 화면 읽기'(intents.py HelpGroup과 함께) |
| 1206 | "장애인연금 모의 신청서를 열었어요. 연습용이라 실제로 접수되지는 않아요." | '모의'는 바로 뒤 '연습용'과 같은 뜻이라 쉬운 말 하나로 충분. 이민자에게는 '연습'이 더 쉽다. | '장애인연금 연습 신청서를 열었어요. 실제로 접수되지는 않아요.' |
| 1216 | summary="모의 신청서를 열었어요." | 여러 명령을 이어 말할 때 쓰이는 요약 문장. '모의'보다 '연습'이 쉽다. | '연습 신청서를 열었어요.' |

#### `src/cheongeum/personal/action_log.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 109 | label = r.get("label") or r.get("actionType") ...; parts.append(f"{i}. {label}{where}")  # where=host | '오늘 한 일'에서 호스트 주소(www.bokjiro.go.kr 등)와, 라벨이 없을 때 영어 actionType(click 등)이 그대로 읽힌다. | 호스트는 sites.site_label 같은 한국어 사이트 이름으로, actionType은 한국어 동작 이름 표로 바꿔 읽는다. |

#### `src/cheongeum/personal/guardian.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 145 | action = "모의 문자로 미리 볼까요" if self.sender.preview else "문자로 보낼까요" | '모의 문자'는 뜻이 바로 오지 않는다(실제로는 보내지 않고 내용만 들려준다는 뜻). | '보내지 않고 문자 내용만 들어 볼까요' |
| 164 | "preview": f"모의 문자 내용은 “{pending['message']}”입니다. 실제 발송은 하지 않았어요." | '모의 문자'는 낯선 표현. 같은 문장 끝에 실제로 보내지 않았다는 말이 있어 '모의'가 없어도 된다. | '문자 내용은 “…”이에요. 실제로 보내지는 않았어요.' |

#### `src/cheongeum/safety/guard.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 106 | deny("DENIED_SCHEMA", "액션 형식이 계약과 맞지 않습니다.") | 거부 이유는 outcome_failure로 사용자에게 말해진다. '액션'·'계약'은 개발 용어(드문 경로). | '요청한 조작의 형식이 맞지 않아 하지 않았어요.' |
| 157 | f"지원하지 않는 사이트라 읽기 전용입니다. {reason}" | '읽기 전용'은 컴퓨터 용어. 뒤에 붙는 이유와 함께 말해진다. | '이 사이트에서는 읽어 드리기만 해요. …' |
| 192 | read_only("링크와 이동용 버튼만 누를 수 있습니다.") | '링크'는 웹 용어라 고령층이 모를 수 있다. | '다른 화면으로 가는 글자나 버튼만 누를 수 있어요.' |
| 197 | read_only("검색 실행(Enter)만 할 수 있습니다.") | 영어 키 이름 'Enter'가 그대로 읽힌다. | '검색 실행만 할 수 있어요.' |

#### `src/cheongeum/server/app.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 106 | "음성 서비스 호출에 실패했습니다. 잠시 후 다시 시도하거나 텍스트로 입력하세요." | UI 오류 칸(role=alert)에 보이는 문장. '텍스트로 입력'보다 쉬운 말이 있다. | '음성 인식이 잠시 안 돼요. 조금 뒤 다시 말씀하시거나 글자로 써 주세요.' |
| 175 | "sessionId와 text(1~500자)가 필요합니다." | 글을 500자 넘게 입력하면 UI에 이 개발용 문구가 보인다. | '한 번에 500자까지 말씀하거나 쓸 수 있어요. 나눠서 다시 해 주세요.' |

#### `src/cheongeum/speech/screen.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 142 | parts.append(f"팝업 창 '{d['title']}'이 떠 있습니다. 내용: {d['text']}. 버튼: {', '.join(d['buttons'])}.") | 팝업 is a loanword that some older users and migrants do not know. Widely heard, so a judgment call. | '작은 알림 창 '…'이 떠 있어요.' |
| 154 | parts.append(f"본문 시작: {excerpt}") | 본문 is a document term. 내용 is plainer for low-literacy users and Korean learners. | '내용 시작:' |
| 183 | parts.append(f"팝업 {self.popup_name(view)} 떠 있어요.") | 팝업 in the page-open announcement; see line 142. | '작은 알림 창 …이 떠 있어요.' |
| 205 | popup = f" 팝업 {self.popup_name(view)} 떠 있어요." if view["dialogs"] else "" | 팝업 in the short screen description; see line 142. | '작은 알림 창 …이 떠 있어요.' |
| 223 | popup = f"팝업 {self.popup_name(view)} 떠 있어요. " if view["dialogs"] else "" | 팝업 in the page intro; see line 142. | '작은 알림 창 …이 떠 있어요.' |

#### `src/cheongeum/understanding/filters.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 55 | 어느 사이트를 열까요? '네이버', '정부24'처럼 이름이나 주소를 말씀해 주세요. | 주소 here means web address; an older user may hear it as home address. Low risk because names are offered first. | '…처럼 이름이나 인터넷 주소를 말씀해 주세요.' |

#### `src/cheongeum/understanding/sites.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 24 | "보건복지부가 운영하는 복지 포털로, 복지 제도를 찾아보고 온라인으로 신청할 수 있는 곳" | Spoken answer to '이 사이트 뭐야'. 포털 is a loanword that older users and migrants may not know. | '복지 정보를 모아 둔 사이트로, …' |
| 29 | "정부 민원 포털로, 각종 증명서 발급과 민원 신청을 온라인으로 하는 곳" | Same 포털 loanword in a spoken site description. | '정부 민원을 한곳에서 하는 사이트로, …' |
| 32 | "세금을 담당하는 정부 기관의 누리집" | 누리집 is the official purified word but less familiar to many older users than 홈페이지. | '세금을 담당하는 정부 기관의 홈페이지' |
| 39 | "건강보험과 장기요양보험을 운영하는 공단의 누리집으로, 보험료와 건강검진 등을 확인하는 곳" | Same 누리집 wording; see line 32. | '…공단의 홈페이지로, …' |
| 46 | "국민연금을 운영하는 공단의 누리집으로, 연금 가입 내역과 수령 안내를 보는 곳" | Same 누리집 wording; see line 32. | '…공단의 홈페이지로, …' |
| 48 | "기초연금 제도를 안내하는 보건복지부 누리집" | Same 누리집 wording; see line 32. Older adults are the main users of this site. | '기초연금 제도를 안내하는 보건복지부 홈페이지' |
| 53 | "복지·보건 정책을 맡은 정부 부처의 누리집으로, 정책 소식과 보도자료가 올라오는 곳" | Same 누리집 wording; see line 32. | '…정부 부처의 홈페이지로, …' |
| 56 | "복지 제도 상담을 해 주는 보건복지상담센터 누리집" | Same 누리집 wording; see line 32. | '복지 제도 상담을 해 주는 보건복지상담센터 홈페이지' |
| 68 | "한국에서 가장 많이 쓰는 포털 사이트로, 검색·뉴스·날씨·쇼핑·지도 등을 한곳에서 쓸 수 있는 곳" | 포털 사이트 is fairly common, but a migrant or first-time user may not know it. | '한국에서 가장 많이 쓰는 검색 사이트로, …' |
| 72 | "카카오가 운영하는 포털 사이트로, 검색·뉴스·메일 등을 쓸 수 있는 곳" | Same 포털 wording; see line 68. | '카카오가 운영하는 검색 사이트로, …' |

#### `src/cheongeum/web/static/app.js`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 12 | TRANSCRIBED: '전사 완료', | Shown in 현재 상태 and announced as '상태: …'. 전사 is a technical term. | '받아쓰기 끝' |
| 13 | INTENT_DETECTED: '의도 파악', | Shown in 현재 상태; 의도 파악 is system wording. | '말씀 알아들음' |
| 21 | BROWSING: '웹 페이지 읽는 중(읽기 전용)', | 읽기 전용 is computer jargon. | '웹 페이지 읽는 중(입력은 하지 않아요)' |
| 85 | '동의하시면 청음은 별도의 브라우저 창으로 웹사이트를 열어 화면을 읽어드리고, 지원하는 연습용 신청 사이트에서는 입력을 대신합니다. ' | 브라우저 창 in the consent text. | '따로 인터넷 창을 열어 …' |
| 90 | '받은 파일에 대해 질문하거나 요약을 요청하면 파일 전체나 본문을 OpenAI 파일 분석 서버에 보낼 수 있습니다. ' | 본문 and 서버 in the consent text. | '…파일 내용을 OpenAI에 보내 분석할 수 있습니다.' |
| 276 | '읽기 전용(읽기·이동·검색만)' | 읽기 전용 in the 접근 status line; the parenthesis helps but the label is jargon. | '읽기만 해요(입력·제출 안 함)' |
| 337 | `실패(${a.result?.errorCode ?? '미실행'})` : `차단: ${a.policy.reason}` | 실행 내역 shows raw English error codes (TIMEOUT, VERIFY_FAILED) to users. | 오류 코드를 '시간 초과', '확인 실패' 같은 한국어로 바꿔 보여 주기 |
| 375 | setError('서버 음성 재생에 실패해 브라우저 음성으로 읽습니다.'); | 서버 and 브라우저 describe internals the user does not need. | '다른 목소리로 이어서 읽어 드릴게요.' |
| 448 | setError('동의하지 않으셔서 음성 대화를 시작하지 않습니다. 복지 제도 질문은 텍스트로 입력할 수 있습니다.'); | 텍스트 where 글자 is plainer. | '…복지 제도 질문은 글자로 입력할 수 있어요.' |
| 994 | push({ role: 'system', text: '모의 브라우저 창을 준비하는 중입니다…' }); | 모의 브라우저 창 is internal wording. | '연습용 인터넷 창을 준비하고 있어요…' |

#### `src/cheongeum/web/static/index.html`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 20 | <button type="button" id="contrast-toggle" aria-pressed="false">고대비 꺼짐</button> | 고대비 is an accessibility term many older users do not know (label is also set in app.js line 212). | '선명한 화면 꺼짐' 또는 '검은 바탕 꺼짐' |
| 131 | <h2 id="unsupported-title">데모/미지원</h2> | 데모 and 미지원 are jargon in a panel heading. | '연습판이라 아직 안 되는 것' |

## COUPLED: tests and fixtures that pin text or behavior above (36)

### should (18)

#### `src/cheongeum/evaluation/data/scenarios_30.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 61 | "speechIncludes": "팝업" | Pins the word '팝업' in step-2 speech (Narrator/FormSkill). A PLAIN fix such as '알림 창' breaks N06. | 문구를 바꾸면 기대값을 새 낱말로 |
| 89 | "speechIncludes": "본문입니다" | Pins '본문' in read-main speech (BrowseSkill). A PLAIN fix such as '내용입니다' breaks N09. | 문구를 바꾸면 기대값을 새 낱말로 |

#### `tests/e2e/test_browsing.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 36 | first = await s.handle_turn("본문 읽어줘") … assert "본문 끝" in last["speech"] | Pins the '본문 읽어줘' command and browse.py read-main speech ('본문 끝', '계속 읽어줘'). Replacing 본문 in spoken hints (screen.py 187/206/224) means updating these asserts. | 말을 바꾸면 '내용 읽어줘'와 새 끝 문구도 함께 시험 |
| 51 | lst = await s.handle_turn("링크 목록 알려줘") … assert "더 읽을 링크가 없습니다" in more["speech"] | Pins the 링크 command (screen.py 160/206, app.js 44) and browse.py LIST_LINKS speech '더 읽을 링크가 없습니다'. | 명령·문구를 바꾸면 '메뉴 알려줘' 등 새 말로 함께 시험 |

#### `tests/e2e/test_conversation.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 214 | r1 = await s.handle_turn("나한테 맞는 복지 찾아줘") | Pins the fixed 4-answer 맞춤 찾기 run (L217-220: 나이·장애·소득·시도 = discovery.py PROFILE_ORDER). Adding a 다문화·결혼이민 or 농어민 question means r5 is no longer the result list. | 질문을 더하면 답 목록을 PROFILE_ORDER 길이에 맞춰 만들거나 결과가 나올 때까지 '건너뛸게요'를 되풀이하게 고친다. |

#### `tests/e2e/test_file_answers.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 52 | assert all(word in ask["speech"] for word in ("안내문.pdf", "OpenAI", "개인 정보")) | Pins the file-send consent prompt (skills/browse.py:386) that names the recipient only as 'OpenAI'. Older users may not know what that is, so the consent is not informed. | '외부 인공지능 회사 OpenAI'처럼 풀어 말하고(app.js 동의 문구와 같게) 이 단언은 'OpenAI' 포함을 유지한다. |
| 138 | assert "20MB" in large["speech"] and large.get("pendingConfirmation") is None | Pins '파일은 한 번에 20MB까지 읽을 수 있어요' (agents/web/file_answer.py:40). 'MB' is an English unit abbreviation many older users do not know. | '파일이 너무 커서 한 번에 읽을 수 없어요'로 바꾸고 단언을 '너무 커서' 등으로 고친다. |

#### `tests/e2e/test_navigation.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 34 | assert "글자 크게" not in shown | Pins digest.py UTILITY_BUTTON hiding 글자 크게/작게 and site language buttons from the goal model, a screen-reader-user choice. Older or low-vision sighted users and migrants need these. | UTILITY_BUTTON에서 글자 크기·언어 선택을 빼면 이 단언을 고친다. |

#### `tests/e2e/test_safety.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 66 | "'사이트 공지' 영역", | Pins the detailed screen description in screen-reader idiom (speech/screen.py describe_screen): '영역', '성명, 입력란, 필수, 비어 있음' (L69), '체크 상자, 선택, 체크 안 됨' (L71). | '성명 칸은 꼭 써야 하고 아직 비어 있어요'처럼 문장으로 바꾸면 L65~72의 기대 문구를 함께 바꾼다. |
| 130 | assert "팝업" in nxt["speech"] | Pins skills/form.py:306 '안내 팝업 ...이 떠서 닫았어요'. '팝업' is on the plain-language list. | '안내 창'으로 바꾸고 단언을 '안내 창'으로 고친다. |
| 178 | for said in ["나한테 맞는 복지 찾아줘", "일흔 살이에요", "아니요", "잘 모르겠어요", "건너뛸게요"]: | Same fixed 4-answer 맞춤 찾기 run as test_conversation.py:214. With a 다문화·결혼이민 or 농어민 question added, the flow is unfinished and this consent check hits the wrong turn. | 질문 수가 바뀌어도 결과까지 가도록 답 목록을 PROFILE_ORDER에서 만든다. |

#### `tests/unit/test_discovery_personal.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 161 | assert PersonalStore(str(path)).speech()["rate"] == 1.25 | Pins default TTS rate 1.25 (store.py DEFAULT_SPEECH; '보통 속도'=1.25 in commands.py:103), tuned to fast screen-reader listeners; too fast for many older adults and Korean learners. | 기본 속도를 1.0 근처로 낮추면 L161과 L142~143(0.9·1.5)의 기대를 함께 고친다. |

#### `tests/unit/test_grounding.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 103 | tools = ["글자 작게", "글자 크게", "화면 인쇄", "English", "中文", "日本語", "이전 배너", "다음 배너", "공유하기", "맨 위로", "본문 바로가기"] | Asserts digest.py UTILITY_BUTTON hides text-size and site-language buttons from the model. Older or low-vision sighted users need 글자 크게; 결혼이민자 may need a site's own language version. | 글자 크기·언어 버튼을 목록에 남기기로 하면 tools에서 빼고 menu 쪽 기대로 옮긴다. |

#### `tests/unit/test_playbook.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 43 | assert "브라우저" in first and ("직접" in first or "찾아" in first) | Pins '브라우저' and the 'open it yourself' advice in blocked_speech (agents/web/playbook.py:26,52,56,71,133). A plainer word or a next step for users who cannot open sites alone breaks this. | playbook 문구를 바꿀 때 이 단언도 함께 고친다(예: '브라우저' 대신 '인터넷 창', 혼자 못 여는 분께는 전화 안내 등). |

#### `tests/unit/test_progress.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 21 | (done("read_more"), "본문을 이어서 보고 있어요."), | Pins the exact spoken progress sentence from agents/web/skills/browse.py:60; '본문' is jargon for many 정보취약계층 users, so a PLAIN fix there must update this expectation. | browse.py를 '내용을 이어서 보고 있어요.' 등으로 바꾸면 이 기대값도 같이 바꾼다. |
| 22 | (done("find", "신청 방법"), "본문에서 '신청 방법'을 찾았어요."), | Pins browse.py:62 '본문에서 …찾았어요/찾아봤어요' exactly; this progress line is spoken unasked (Progress.spoken defaults on). | '화면 내용에서 …을 찾았어요' 등으로 바꿀 때 함께 수정. |

#### `tests/unit/test_registry.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 40 | def test_help_example_is_understood_on_any_screen(type_, text, state): | Help speaks each intent's first example; lines 35-44 require rules.py to parse it on every screen. Swapping '본문 읽어줘' (intents.py:135) or '링크 목록 알려줘' (:142) needs rules.py to know the new phrase. | 쉬운 예문(예: '내용 읽어줘', '누를 수 있는 것 알려줘')으로 바꿀 때 rules.py가 그 말을 먼저 알아듣게 한다. |
| 144 | @pytest.mark.parametrize("lead", [("신청서",), ("웹 읽기",), ("시작", "복지 정보")]) | Pins help group name '웹 읽기' (core/intents.py:26-27, orchestrator/session.py:1038), which help speaks aloud as '웹 읽기: …'; '웹' may be unfamiliar to older users. | 묶음 이름을 '사이트 읽기'·'인터넷 화면 읽기' 등으로 바꾸면 이 매개변수도 바꾼다. |

### consider (18)

#### `src/cheongeum/evaluation/data/demo_scenarios.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 12 | "utterance": "장애인연금 신청 도와줘", | Pins START_APPLICATION (intents.py:85) and DEFAULT_SERVICE (agent.py:112) to 장애인연금 in a frozen file; broadening the default must keep this utterance working. | 기본 제도를 바꿔도 이 발화가 같은 모의 신청 흐름으로 가게 유지 |

#### `src/cheongeum/evaluation/data/scenarios_30.json`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 31 | "speechIncludes": "성명을 말씀해 주세요" | Pins form-label wording '성명' / '주민등록 주소' (also lines 32, 193, 195). If labels are made plainer for Korean learners (이름), these break; labels live in the practice site/profile. | 라벨을 쉬운 말로 바꾸면 이 기대값도 함께 |
| 278 | X09: "speechIncludes": ["이동했어요", "'눌러'"] … "AUTH_HANDOFF", "speechIncludes": "직접" | Pins login-pointing and auth-handoff wording; if handoff speech changes for users without a screen reader (e.g. saying where to type), update these. | 인계 안내를 바꾸면 기대값 확인 |

#### `tests/e2e/test_conversation.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 534 | assert r["speech"].startswith("이렇게 말해 보세요. 웹 읽기: ") | Pins the spoken help group label '웹 읽기' (core/intents.py HELP_GROUPS, session.py:1038); '웹' is unfamiliar to many older users. assert_each_understood also needs every help example to parse by rules. | '인터넷 화면 읽기' 등으로 바꾸면 이 단언을 고치고, 쉬운 말로 바꾼 도움말 예문은 rules.py가 알아듣게 한다. |

#### `tests/e2e/test_file_answers.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 118 | assert "본문" in ask["speech"] | Pins contents='본문' in the HWPX send prompt (skills/browse.py:384). '본문' is on the plain-language list. | '파일 글 전체' 등으로 바꾸면 이 단언을 고친다. |
| 124 | assert "원문" in answer["speech"] and "교통비 12만 원" in answer["speech"] | This path speaks 'OpenAI 파일 분석 설정이 없어 원문 읽기로 안내할게요' (skills/browse.py:374): setup jargon the user cannot act on. | '지금은 파일 내용을 그대로 읽어 드릴게요'처럼 설정 이야기를 빼고 단언을 그 문장에 맞춘다. |

#### `tests/e2e/test_multilingual.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 107 | assert "AI 모델 설정이 필요해요" in r["speech"] | Pins i18n.py:150 '다른 언어로 대화하려면 AI 모델 설정이 필요해요', said in Korean to someone asking for another language: setup jargon, and the asker may not follow Korean. | '지금은 다른 언어로 안내할 수 없어요'처럼 바꾸고 요청한 언어로도 짧게 알린다. 단언을 함께 고친다. |

#### `tests/e2e/test_navigation.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 157 | r = await s.handle_turn("글자 크게 버튼 눌러줘") | Uses 글자 크게 as the standard no-effect click (also L95, L127). effect.py diff_views sees text and state only, so on a real site bigger text is reported as '화면이 바뀌지 않았어요'. | 글자 크기·확대 버튼은 결과를 따로 말하게 하고(예: '글자 크기 버튼을 눌렀어요') L95·L127·L157의 기대를 바꾼다. |

#### `tests/e2e/test_picture_turn.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 89 | assert "모델이 설정되지" in (await s.handle_turn(QUESTION))["speech"] | Pins skills/browse.py:595 '화면 사진을 설명할 OpenAI 모델이 설정되지 않았어요': setup jargon spoken to the user. | '지금은 화면 사진을 설명할 수 없어요'로 바꾸고 단언을 고친다. |

#### `tests/e2e/test_safety.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 274 | assert re.match(r"^MOCK-\d{8}-\d{4}$", done["verification"]["receipt"]) | Pins the mock receipt format that skills/form.py:404 reads aloud ('모의 접수번호는 MOCK-...'). English letters spoken are hard for older users and Korean learners. Also L365. | 영문 접두어 없이 숫자만 읽게 바꾸면 L274·L365의 정규식을 고친다. |

#### `tests/e2e/test_web_ui.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 62 | box = page.get_by_label("명령 입력 (말하듯이 입력하세요)") | Pins the input label from index.html:63 (also L256). '명령' sounds technical; older users may not know what to type. | '하고 싶은 말을 적어 주세요' 등으로 바꾸면 L62·L256 라벨을 고친다. |
| 84 | await page.get_by_role("button", name="고대비 꺼짐").click() | Pins the toggle label '고대비' (index.html:20), accessibility jargon most older users do not know. | '선명한 화면 꺼짐' 등 쉬운 말로 바꾸면 이 이름을 고친다. |

#### `tests/unit/test_docs.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 20 | assert "HWPX" in out["speech"] | Pins docs.py:30 '예전 한글 파일(HWP)이라 ... HWPX나 PDF로 받아 주세요': format abbreviations plus a re-download task most older users cannot do alone. | '이 파일은 읽을 수 없어요'에 다음 할 일을 쉬운 말로 붙이면 단언을 고친다. |

#### `tests/unit/test_playbook.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 59 | assert "본문 읽어줘" in speech or "검색" in speech or "이동" in speech | Loosely pins the policy-denied next step (playbook.py:57 example '본문 읽어줘') spoken via common.py:65; fixture at line 53 copies guard.py:157 '읽기 전용입니다. 클릭할 수 없습니다.', also spoken. | playbook·guard 문구를 쉬운 말로 바꾸면 53행 fixture 메시지와 59행 후보 낱말도 맞춘다. |

#### `tests/unit/test_progress.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 20 | (done("back"), "이전 페이지로 돌아갔어요."), | Pins browse.py:58 exactly; '페이지' is borderline for older or low-literacy users, '화면' is the word used elsewhere in speech. | '이전 화면으로 돌아갔어요.'로 바꾸면 함께 수정. |

#### `tests/unit/test_result_speech.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 49 | assert "API 실시간" not in a.speech | Live-source label 'API 실시간' (welfare/agent.py:35, welfare/data/__init__.py:234) is spoken via source_sentence (agent.py:209-213). Renaming it in plain words makes lines 49,56,64,81 pass vacuously. | 실시간 라벨을 '공식 자료 실시간 조회' 등으로 바꾸면 부정 단언 4곳도 새 라벨로 바꾼다. |

#### `tests/unit/test_welfare.py`

| 줄 | 원문 | 이유 | 제안 |
|---|---|---|---|
| 318 | assert [s.id for s in f.scenarios if is_active_pc(s)] == ["S1-normal-flow", "S2-field-validation", ... | Pins exactly four active PC scenarios in demo_scenarios.json, whose persona is '시각장애인 이용자(가상)'; adding 고령층·결혼이민자 scenarios as active fails here (that file is marked do-not-modify). | 새 대상 시나리오는 별도 파일에 두거나, 이 단언을 '기존 4개를 포함한다'로 완화한다. |
| 338 | "source": {"title": "출처", "url": "https://example.com/x", "lastCheckedAt": "2026-11-18", "version": "API 실시간"}, | Fixture copies the spoken live-source label (welfare/agent.py:35); tests at 345-384 speak '(출처: 출처, API 실시간)'. Won't fail on a rename but would keep exercising the old jargon label. | 라벨을 바꾸면 fixture의 version 값도 같은 말로 바꾼다. |
