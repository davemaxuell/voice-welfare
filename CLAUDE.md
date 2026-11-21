# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

청음(Voice Welfare Agent, 부를 때는 '청음아'·'청음이', 코드 이름 `cheongeum`): 정보취약계층(고령층·장애인·저소득층·농어민·결혼이민자처럼 디지털 기기로 공공서비스를 혼자 쓰기 어려운 사람)이 한국어 음성으로 웹을 읽고 탐색하고, 지원 사이트에서는 신청서를 대신 입력하는 PC 브라우저 에이전트. 시각장애인도 대상이므로 화면을 보지 않고 소리만으로 끝까지 쓸 수 있어야 한다는 설계 조건은 그대로다. 서버·에이전트와 데스크톱 서비스는 TypeScript이고, 웹 화면은 React와 Vite를 사용한다. 기획 요약은 `docs/기획요약.md`, 아키텍처 그림은 `docs/architecture.png`, 데모 시나리오는 `src/evaluation/data/demo_scenarios.json`(수정하지 않는다). 사용자·코드 주석·UI 문구는 한국어.

## Commands

```bash
npm ci                                         # 저장소 루트, Node.js 24 이상
npx playwright install chromium                 # 처음 한 번
npm start                                      # 웹 빌드 후 UI·API :8787, 모의 사이트 :5174
npm run dev:web                                # 실행 중인 :8787 서버에 연결하는 Vite 개발 화면
npm run mock                                   # 모의 사이트만 실행
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e                               # 실제 Chromium, HEADED=1이면 창 표시
npx vitest run --project unit tests/unit/parser.test.ts
npx vitest run --project e2e tests/e2e/browsing.test.ts -t search
npm run eval                                   # 고정 시나리오, RAG, axe → reports/evaluation-report.md
npm run eval-agent                             # 설정된 모델로 모의·실제 사이트 목표 수행
npm run eval-stt                               # 녹음 파일의 API 받아쓰기 평가
npm run check-llm                              # 실제 연결 점검. 음성은 check-voice, 복지는 check-welfare
npm run setup-models                           # 로컬 개인정보 인식용 ONNX 모델 내려받기
npm run start:desktop
npm run test:desktop-avatar                    # Electron 아바타, 합성 마이크와 모의 음성 API
npm run test:desktop-native                    # Windows UIA, 실제 마우스·키보드와 전역 단축키
```

- Vitest의 E2E 프로젝트는 `tests/e2e/global-setup.ts`에서 모의 사이트를 준비한다. `ensureMockSite`는 `X-Ieum-Checkout`으로 같은 체크아웃을 확인하고, 다른 작업 트리가 5174를 사용하면 기본 120초 기다린다(`MOCK_SITE_WAIT_S`). 여러 작업 트리에서 동시에 시험할 때는 `node scripts/with-port-lock.ts -- node node_modules/vitest/vitest.mjs run --project e2e`로 실행한다. 단위 테스트는 이 포트를 쓰지 않는다.
- `tests/helpers.ts`의 `testRuntimeEnv`는 모의 모델, 연습용 주소록, 로컬 검색 포털, `READ_ONLY_CLICKS=safe`를 설정한다. `fakeFetch`, `FakeLlm`, `withLlm`으로 HTTP·모델 응답을 주입한다. `tests/e2e/web-ui-fixtures.ts`는 같은 출처에서 Vite 화면, 실제 Hono API와 WebSocket을 제공하고 음성 시험에는 모의 전사·합성을 주입한다.
- `.env`는 루트에만 있다(커밋 금지). 서버는 `.env` 변경 시 재시작해야 반영된다.

## Architecture

서버·에이전트 코드는 `src/`, 웹 화면은 `web/`, Electron 셸은 `apps/desktop/`에 있다. 서비스 모듈은 파이프라인 단계별로 나눈다(①~⑥은 `docs/architecture.png`의 상자 번호). 핵심은 "발화 → 의도/계획 → 두 에이전트 → PolicyGuard → 실행 어댑터 → 재관찰 검증 → 짧은 한국어 응답" 루프다.

- **데이터 모양**. `core/actions.ts`, `core/intents.ts`, `core/turn.ts`가 액션·관찰·의도·응답의 camelCase JSON 계약을 정의한다. 외부 입력과 응답 경계에서 Zod로 검증한다. 선택 항목의 생략과 빈 값의 차이를 보존한다.
- **비교 자료**. `tests/fixtures/oracle/`의 함수 결과, `tests/fixtures/regex/`의 정규식·입력, `tests/fixtures/transcripts/`의 대화 기록을 기준으로 동작을 확인한다. 이전 Python 구현의 기준 커밋은 `77aad3e`이다. 실행·빌드·테스트는 저장소 루트의 Node 명령을 사용한다. `core/text.ts`, `core/url.ts`, `core/abort.ts`에서 공통 문자열·URL·중단 처리를 가져온다.
- **① ⑥ `voice/`**. `config.ts`가 인증된 음성 공급자를 조립한다. `live.ts`가 실시간 받아쓰기, `stt.ts`가 녹음 파일 전사, `tts.ts`가 음성 합성을 담당한다. 한국어를 포함한 네 언어 모두 음성 API를 쓴다. 대화 모드는 WebRTC로 GPT-Live에 연결하고, 한 번 말하기는 브라우저와 로컬 서버의 WebSocket을 거친다. 마이크·재생은 `web/src/`, 키와 첫 실행 이용 설정은 `server/settings.ts`에서 관리한다.
- **② `understanding/`**: LLM이 있으면 빠른 길(`fastpath.ts`) → LLM 계획 → 실패하면 규칙. LLM이 없으면 규칙 파서(오프라인). `Understanding.understand()`가 의도와 판정 경로를 반환한다. 여러 질문의 분리도 계획이 맡는다. 승인·거절·대답 어휘는 `core/lexicon.ts`, 화면 밖 대화는 `chat.ts`, 사이트 이름 해석은 `sites.ts`에 있다. [말 이해와 조작 권한](docs/rules.md)
- **다국어** `language/i18n.ts`: 외국어면 `translateIn` → 한국어 흐름 → `translateOut`(숫자 바뀌면 재시도 후 한국어 원문). 멈춤·승인은 규칙만.
- **③ `orchestrator/session.ts`**. 세션마다 `SessionOrchestrator` 한 개가 동의와 턴 순서, 라우팅, 언어, 직전 근거와 맞춤 찾기 답을 관리한다. 승인·값·질문 대기, 금고 확인, 칸 채우기, 인증 인계 재개는 `core/dialogue.ts`의 `DialogueState`에 둔다. 멈춤은 대기열을 건너뛰고 epoch를 바꿔 대기 중인 작업을 무효화한다. 진행 상황 질문도 바로 답한다. 민감정보를 확인한 뒤 현재 대화의 대기 상태, 개인 기록 명령, 공공업무, 일반 의도를 순서대로 다룬다. 기술에는 `ExecContext`로 해당 턴의 권한을 전달한다. 처리 결과와 보조 대화 기록에서도 금고·저장 대기 값을 가린다.
- **동의 직후 음성 연습**. `orchestrator/first_run.ts`의 `FirstRunGuide`는 마이크와 부르는 이름 확인, ‘멈춰’ 연습, 청음 소개, 연습 신청 제안을 네 언어의 고정 문장으로 진행한다. 다른 명령이 들어오면 평소 대화로 전환한다. 진행 단계는 `SettingsStore`에 보관한다.
- **④ Agent A** `agents/web/agent.ts`: 모든 조작은 `run()`에서 `PolicyGuard.check` → `adapter.execute` → 재관찰. TIMEOUT을 한 번 다시 하는 것은 저위험이고 승인이 필요 없던 조작뿐이다. 중요한 조작(모의접수·승인받은 클릭·입력)은 이미 됐을 수 있어 다시 하지 않고, 화면을 다시 봐서(접수번호·화면 변화·칸 값) 확인되지 않으면 `unconfirmed`로 돌려주고 기술이 승인 대기를 둔 채 "…확인하지 못했어요. 다시 할까요?"라고 묻는다(`askAgain`). 사이트 지식은 `profile.ts`의 `SiteProfile`에만. **화면 이해 담당** `digest.ts`(규칙): 관찰을 종류·정리한 본문·내용 링크·주요 메뉴·조작 요소(`controls`: 탭·펼치기 먼저, 화면 도구 버튼 `UTILITY_BUTTON` 제외)·할 수 있는 일로 요약. LLM에 주는 목록은 링크 30·메뉴 12·조작 요소 12가 기본 몫이고 남는 몫은 조작 요소가 쓴다. `digestForLlm`의 `mainText`와 `BrowseSkill.webAnswer`의 page 글은 `redactText`로 비식별화한 뒤 LLM에 넘기고, `checkGrounding`만 원문을 쓴다. **누르기** `followLink`: 관찰의 `outline.items`(링크·버튼·탭·메뉴 항목·역할 없는 클릭 요소 `generic`, 각자 `ref`·상태)에서 이름으로 찾아 `{ref, role, name}`으로 누른다(링크 우선, 여러 이름이 맞으면 되묻기). 어댑터는 누르기 직전 같은 관찰 규칙으로 그 ref의 role·name을 다시 읽어 다르면 `VERIFY_FAILED`. **효과 판정** `effect.ts` `diffViews`: moved(주소·제목)·changed(같은 화면의 본문·팝업·선택/펼침 상태, 새 글 `revealed`)·none. 기다림은 이동, 새 팝업, **누른 요소 자신**의 선택·펼침 변화(`itemChanged`, 복지로는 title의 '선택됨')에서만 일찍 끝난다 — 본문 변화만으로 끝내면 돌아가는 배너를 효과로 알고 이동 전 화면을 돌려준다. 최대 1.5초(탭·펼치기)·6초(그 밖). 같은 화면에서 바뀌면 새 글이 자리 잡을 때까지(최대 3초, '불러오는 중'은 내용이 아님) 기다린다. 저절로 바뀌는 자리(`effect.Churn`): 사용자를 기다린 틈(조작 없이 1초 넘게 떨어진, 기다림 반복이 아닌(`observe(ctx, false)`) 두 관찰)에 바뀐 자리를 세고, **서로 다른 두 틈**에서 바뀐 자리만 무시한다(한 번 바뀐 것은 늦게 도착한 내용일 수 있다). 무시하는 것도 그 자리에서 바뀌던 줄 수만큼이다. 그래서 배너가 있는 화면을 연 뒤 첫 클릭은 배너를 새 내용으로 읽을 수 있다(알려진 한계). 실제 사이트 로그인(`BrowseSkill.login`)은 로그인 버튼·링크로 초점을 옮기고(`pointAt`) 무엇을 왜 하는지 말한 뒤 '눌러'를 들으면 누른다(물은 뒤 화면이 바뀌었는지는 아래 승인 지문으로 본다). 아이디·비밀번호는 사용자가 직접 입력한다. **본인인증 인계** `auth_page.ts` `authPageKind`(login|verification|other; 간편인증 앱 안내 포함) → 인계 때 첫 입력 칸 `focusField`·UI는 `AUTH_HANDOFF`에서 TTS 한 번만 말하고 멈춤 → '다 했어'/'인증 끝났어'(`BrowseSkill.authDone`)는 재관찰 후 아직 login·verification이면 기다리고, 아니면 새 제목을 말한 뒤 `DialogueState.authResume`의 신청서·칸 채우기를 이어 간다. **목표 수행** `autopilot.ts`: 관찰→LLM 한 행동(`browse_step`)→Agent A 실행, 최대 10단계·75초, 읽기·이동·검색만(`find`는 본문 창을 낱말 위치로), 모르는 기관은 `find_portal`로 찾는다(`TavilySearch.portals`가 공공 도메인 안 https 후보만 주고, `isOfficialPortal`이 한 번 더 거르며, 후보 host만 `open_url`로 열린다. 내 정보는 로그인 화면에서 멈춰 인계). 메뉴가 글로 안 읽히면 `inspect_screen`(`orient.ts`: 목표·누리집마다 한 번 동의, 사진 최대 3장, 결과는 정해진 틀이고 `imageOnly`는 누르지 않으며 맡겨 둔 조사(백그라운드)에는 비전 모델을 주지 않는다), 같은 행동 3번째면 중단, 화면이 안 바뀐 클릭은 실패로 기록, 근거 검증 실패 3번이면 정직하게 실패. 단계마다 `BrowseSkill.runGoal`의 `onStep`이 행동 종류·대상 이름(20자까지)·사이트 이름(`siteLabel`)으로만 만든 한 문장(`stepSentence`, 화면 글·모델 글 없음)을 세션의 진행 기록 `core/progress.ts`(`Progress`, `spoken` = 묻지 않아도 알릴지, 기본 켬)에 넣는다.
- **④ `agents/web/skills/`** Agent A의 대화 기술: `form.ts` `FormSkill`(모의 신청서 입력·읽기·고치기·이동·검토·모의접수 준비, 실제 사이트 입력 칸 한 번에 채우기(승인 후), 다음 질문은 `askNext`만 만든다, 승인 뒤 실행 `assistApproved`/`submitApproved`), `browse.ts` `BrowseSkill`(사이트 열기·링크·뒤로·본문 읽기·검색·목표 수행·로그인 인계·`authDone` 재개, 읽기 위치), `guided.ts` `GuidedFill`(실제 사이트 입력 칸 하나씩 채우기), `common.ts`(화면 종류별 상태·실패 안내). 승인 문은 오케스트레이터에 남고 `ctx.granted(ids, work)` 안에서 기술을 부른다. 승인을 물을 때 기술이 승인 지문(`agents/web/approval.ts`: 조작 종류, 누를 대상의 role·name·ref, 주소의 출처+경로, 칸 id와 값 해시, 읽어 준 문장. 본문 글·제목은 넣지 않음)을 함께 남기고, 승인 처리는 다시 관찰해 지문이 다르면 실행하지 않고 승인을 버린 뒤 바뀐 것을 말한다. 같아도 물은 지 2분(`APPROVAL_TTL_S`, 시계는 `OrchestratorDeps.clock`)이 지났으면 실행하지 않고 요약을 다시 읽어 새로 묻는다. Agent B·금고는 주입된 함수로만 쓴다(`agents/welfare/`·`personal/`을 가져오지 않는다).
- **④ `agents/web/browser/`**. `index.ts`가 Playwright를 통해 `observe.ts`(DOM 관찰), `blocks.ts`(영역 표시), `full_page.ts`(전체 페이지 레이아웃), `cursor.ts`와 `rest_cursor.ts`(가상 커서)의 함수를 페이지에서 실행한다. 각 함수는 직렬화되어 브라우저에서 단독으로 동작해야 한다. 필요한 도우미는 함수 안에 둔다. `waiting.html`은 런타임에 읽는 정적 대기 화면이다. 승인·입력 초점을 기다리는 동안 커서는 `wait` 상태를 표시한다.
- **④ Agent B** `agents/welfare/`: 공식 데이터(`data/`, 복지 API + fixture)만 근거. `rag.ts` 2-gram 검색, LLM은 근거 안에서만, `usedChunkIds` 검증. 맞춤 찾기 `discovery.ts`. "지금 신청할 수 있어?"는 지자체 상세의 `enfcBgngYmd`·`enfcEndYmd`(중앙에는 없음)와 본문의 신청기간·연중·마감 날짜만 오늘과 비교해 예/아니오 — 없으면 확인 못 함 + `prepare`와 같은 문의처(추측 금지, LLM 우회).
- **⑤ `safety/`**. `guard.ts`의 `PolicyGuard`가 지원 사이트는 `full`, 외부 HTTP(S)는 `read-only`, 그 밖은 `none`으로 판단한다. 비밀 입력란은 항상 거부한다. `READ_ONLY_CLICKS=safe`에서는 관찰된 링크와 이동용 버튼을 누를 수 있다. 결과를 남기는 동작은 거부하고, 모호한 조작은 대상 확인 뒤 한 번만 실행한다. 로그인은 승인 후 사용자가 직접 이어 간다. 정보 조회만 요청한 턴에는 확인이 필요한 조작을 하지 않는다. `observe.ts`는 실제 주소와 ARIA 상태로 링크·스크립트 링크·탭을 구분한다.
- `gates.ts`는 전체 턴과 각 실행 단계의 동의를 확인한다. `privacy.ts`는 한글로 읽은 숫자와 여러 언어의 비밀번호·인증번호 단서를 처리한다. `pii_model.ts`는 모델을 준비한 환경에서 Node의 ONNX Runtime으로 탐지한 구간을 규칙 결과에 더한다. 로그인·인증 중의 짧고 낯선 대답도 번역·모델·기록에 넘기기 전에 확인한다. `verify.ts`는 인용문과 숫자를 원문에 대조하고 ‘30만’과 ‘300,000’ 같은 표기를 맞춰 본다.
- **⑥ `speech/`**: 말로 내보낼 문장. `phrasing.ts`(조사 `josa`, 항목 이름 읽기 `speakLabel`, 날짜 읽기 `speakDate`, 긴 글 나누기 `chunkText`, 입력값 되읽기 `readback`), `screen.ts`의 `Narrator`(화면·입력 칸·버튼·팝업 설명, 페이지 소개, 본문 요약, 한 번만 하는 안내 `once`).
- **`personal/`**: 개인 정보 금고·신청 기록(`store.ts`, Seal 있으면 AES-GCM·키는 OS keyring, 없으면 파일 권한 600 평문)·조작 기록(`action_log.ts`)·봉인(`seal.ts`)과 명령 이해·기한 알림(`commands.ts`), 금고 저장·삭제 확인과 명령 실행 `dialogue.ts`(`PersonalDialogue`). OS 프로필을 잃으면 금고·조작 기록을 열 수 없다.
- **`core/`**. `actions.ts`, `intents.ts`, `turn.ts`는 데이터 계약을 정의하고, `dialogue.ts`와 `events.ts`는 대화 상태와 비식별 이벤트를 관리한다. `llm.ts`는 OpenAI 및 `openai-compatible`(`qwen` 별칭) 서비스에 구조화 응답을 요청한다. 공식 역할별 기본 모델은 `model_stack.ts`에 있으며 환경 설정으로 바꿀 수 있다. 키 없는 호환 서버 연결은 루프백 주소에서만 허용한다.
- **제안 선택지** `core/choices.ts`: 응답 뒤 버튼으로 고를 수 있는 것을 서버가 정한다(`TurnResult.offeredChoices`, 인증 인계 중 `auth-done`·`auth-cancel`, 읽기 전용 화면을 연 뒤 `read-main`, 승인 대기 중에는 없음). `POST /api/session/{sid}/choice {turnId, key, handoffId?}` → `SessionOrchestrator.choose`가 대기열 한 차례 안에서 그 응답·인계 번호·화면 주소(다시 관찰)를 확인하고 말과 같은 길(`_process`, 고정 문장·의도)로 실행. 지난 제안이면 409 `CHOICE_EXPIRED`, 아무것도 하지 않음. 제안은 다음 응답·멈춤·종료·재접속 분리에서 바뀐다. 버튼 이름은 말로 해도 같은 뜻(로그인했어요 → AUTH_DONE).
- **`server/`**. `runtime.ts`가 모델·복지·브라우저·개인 저장소를 조립한다. 브라우저는 세션별 컨텍스트를 사용하고, 확인된 개인 프로필만 봉인 금고와 평소 크롬을 쓸 수 있다. `app.ts`는 Hono REST, `http.ts`는 Node HTTP와 WebSocket, `main.ts`는 명령행 서버를 맡는다. 데스크톱의 아바타 문서에만 필요한 `blob:` CSP를 허용한다.
- **`web/src/`**. `App.tsx`가 접근성 대화 화면을, `conversation.ts`가 세션·승인·말하기 상태를 관리한다. `mic.ts`와 `voice-edge.ts`는 마이크·실시간 음성 입력, `speaker.ts`와 `audio.ts`는 안내 재생과 공유 AudioContext를 맡는다. 긴 작업 중에는 2초마다 진행 상황을 확인하고 사용자가 말하거나 안내를 읽는 동안에는 새 단계 알림을 미룬다. 음성 진행 안내 간격은 최소 15초다.
- **practice_site/**: 모의 신청 사이트(`site/`) + 합성 외부 포털 `external.html`. `127.0.0.1:5174`로 열면 출처가 달라 외부(read-only) 사이트로 취급 — 그래서 IPv4·IPv6 모두에서 듣는다. 윈도에서 `.js` MIME을 직접 정한다. `src/practice_site/serve.ts`가 정적 파일을 제공하고 서버가 기본으로 함께 띄운다.
- **apps/desktop**: Electron 셸. `apps/desktop/src/main.ts`가 Electron 유틸리티 프로세스로 `apps/desktop/src/service.ts`를 실행한다. 설치본에는 서비스 번들, Chromium, 준비한 개인정보 탐지 모델이 포함된다. [설치 안내](docs/install.md) **아바타 창**(`CHEONGEUM_AVATAR=0`이면 끔): 화면 구석의 작은 창(`/avatar/`, `overlay-preload.ts`, 따로 묶인 Electron 세션 — `/avatar/` 파일과 그 blob만 불러오고 권한·API 없음). 세션·마이크·재생·기록은 대화 창 하나가 계속 맡고(창을 닫으면 숨김), 대화 창이 `cheongeumDesktop.publish`로 보낸 표시 상태(`companion.ts` `desktopView`: 모드·마이크·말하는 중·한 줄 상태·카드)를 메인이 마지막 것을 기억해 넘긴다. 아바타는 `{choiceSetId, key}`만 돌려보내고 메인이 보낸 창·모양을 확인한다. 카드(`currentDecision`: 동의·승인·서버 제안)는 대화 창의 `desk`가 번호를 주고 서버 쪽 참조(승인 번호·인계 번호·turnId)는 대화 창에만 둔다. 한 카드는 한 번만 실행(`choose`가 기다리기 전에 표시, 새 응답이 오면 새 번호) — 대화 창 버튼도 같은 길. 입력값·파일 이름은 카드에 넣지 않는다('내용 확인'은 대화 창 검토 화면을 연다). 음성 승인은 듣기 시작할 때 있던 승인 번호에 묶고, 대화 모드의 음성 한 턴도 보내는 동안 카드를 잡는다(`voiceTurn`). 듣는 동안 청음이 말하는 소리는 녹음하지 않는다(`VoiceLoop.ignore`). 인증 중 말하기 단축키는 마이크를 켜지 않고 '선택지 보기' 길을 알려 준다. 아바타 창은 `focusable: false`(저절로 뜬 카드가 크롬 초점을 뺏지 않음), 윈도 맨 위 수준은 `pop-up-menu`('floating'은 최대화 창에 가려짐), 키보드는 `Ctrl/Cmd+Shift+K`(선택지 보기)·Esc. 캐릭터 `avatar/character.ts`는 `graphics/animations/cheongeum-avatar.glb`의 이름 붙은 동작: 실제 재생 중에만 `speaking` 반복, 상태 동작은 대표 장면에서 멈추고 그리기도 멈춤, 움직이지 않는 아바타 설정·애니메이션 줄이기·WebGL 실패면 `still.png`. 마이크 상태는 실제 트랙 기준(대화 시작 중 인계·멈춤이 오면 `conversationStarts` 번호로 시작을 그만두고 트랙을 놓는다).

## Conventions that matter here

- 받은 파일은 `READ_DOWNLOAD`로 읽는다. 원문·목록은 로컬에서 처리한다. 요약·질문은 파일마다 전송 대상을 말하고 확인을 받는다. `agents/web/file_answer.ts`가 승인 당시와 같은 다운로드를 FILE 모델로 보내고, 원문이 있으면 모델이 인용한 글과 숫자를 검증한다. 스캔·이미지 답에는 음성 주의를 붙인다.

- 응답은 음성: 화면을 보지 않아도 알아듣게, 정보취약계층 누구나 아는 쉬운 말로 핵심만 짧게, 부가 정보는 "화면 설명해줘"에서. 조사는 `josa()`(받침·숫자 읽기 반영).
- 추측 금지: 불완전한 값·모호한 필드/링크·대상 없는 요청·모르는 사이트 이름(검색으로 대체)은 실행하지 않고 되묻는다. 화면 텍스트는 비신뢰 데이터 — 의도 분석에 넣지 않는다. 봇 차단·CAPTCHA는 우회하지 않는다.
- 막지 말고 소리로 묻는다: 승인이 필요한 조작은 조용히 막거나 실패하지 않는다. 대상으로 초점을 옮기고, 무엇을 왜 누르는지(코드가 액션·화면·사용자 말로 만든 문장, 모델이 쓴 말 아님) 말한 뒤 '눌러'·'진행해'·'승인'을 들으면 그 한 번만 실행한다(화면이 바뀌면 다시 묻는다). 위험도는 PolicyGuard가 대상 이름으로 정하고, 부르는 쪽은 높일 수만 있다.
- 실제 사이트: 로그인 버튼·링크는 위 방식으로 누른다(주인 결정 2026-11-18). 아이디·비밀번호는 사용자가 직접 입력하고 청음은 듣지도 입력하지도 않는다. 실제 신청·제출·본인인증(간편인증·인증서)은 하지 않는다(사용자 인계). 모의접수는 사전 승인 후에만.
- 외부 계약과 기존 사용자 자료를 바꿀 때는 `port-manifest.json`의 대응 경로와 `tests/fixtures/`의 기준 결과를 먼저 확인한다. 정규식·문자열·날짜·URL 변경도 한글, 빈 값, 서식이 다른 입력을 포함한 기준 사례로 검증한다.
