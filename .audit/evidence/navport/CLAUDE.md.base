# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

청음(Voice Welfare Agent, 가칭): 시각장애인이 한국어 음성으로 웹을 읽고 탐색하고, 지원 사이트에서는 신청서를 대신 입력하는 PC 브라우저 에이전트. TypeScript 모노레포(`../voice-welfare-agent`)를 Python으로 옮긴 저장소다. 기획 요약은 `docs/기획요약.md`, 아키텍처 그림은 `docs/architecture.png`, 데모 시나리오는 `src/cheongeum/evaluation/data/demo_scenarios.json`(수정하지 않는다). 사용자·코드 주석·UI 문구는 한국어.

## Commands

```bash
uv sync                                    # 의존성 + 프로젝트 편집 가능 설치(src/cheongeum이 비어 있을 때 설치했다면 uv sync --reinstall-package cheongeum-voice-welfare-agent)
uv run playwright install chromium
uv run cheongeum-server                         # API + 웹 UI(정적, 빌드 없음) :8787, 모의 사이트 :5174 자동(--no-mock으로 끔)
uv run cheongeum-mock                           # 모의 사이트만
uv run pytest                              # unit + e2e(실제 Chromium, 기본 headless, HEADED=1이면 창 표시)
uv run pytest tests/unit/test_parser.py    # 파일 하나
uv run pytest tests/e2e/test_browsing.py -k search   # 이름으로 하나
uv run python scripts/run_scenarios.py     # 시나리오 35개 + PRD 지표 + RAG Recall/MRR + axe → reports/evaluation-report.md
uv run python scripts/eval_agent.py        # 목표 수행 QA: Qwen(로컬 Ollama)·OpenAI 비교, 실제 사이트 접속 → reports/agent-qa.md
uv run python scripts/check_llm.py | check_voice.py | check_welfare.py   # .env의 실제 API 연결 확인
npm --prefix apps/desktop install && npm --prefix apps/desktop start     # 데스크톱 앱(Electron 셸 → python -m cheongeum.server --desktop)
```

- E2E는 `tests/conftest.py`가 모의 사이트(5174)를 띄운다(이미 떠 있으면 재사용). 테스트는 인터넷 없이 돈다: `create_test_runtime()`이 `LLM_PROVIDER=mock`, `REQUIRE_CONSENT=false`, `WEB_SEARCH_URL`을 로컬 포털로 고정. pytest-asyncio는 세션 하나의 이벤트 루프(`asyncio_default_*_loop_scope = session`) — Playwright 객체가 루프에 묶이기 때문.
- 외부 HTTP를 쓰는 단위 테스트는 `http_mock` 픽스처(httpx.MockTransport)로 가짜 응답을 준다. 가짜 LLM은 `FakeLlm`(schemaName별 응답)과 `with_llm(session, llm)`.
- `.env`는 루트에만 있다(커밋 금지). 서버는 `.env` 변경 시 재시작해야 반영된다.

## Architecture

`src/cheongeum` 패키지 하나. 하위 패키지는 파이프라인 단계별로 나눈다(①~⑥은 `docs/architecture.png`의 상자 번호). 핵심은 "발화 → 의도/계획 → 두 에이전트 → PolicyGuard → 실행 어댑터 → 재관찰 검증 → 짧은 한국어 응답" 루프다.

- **데이터 모양**: 액션·관찰·의도·Draft·TurnResult는 JSON과 같은 **camelCase 키의 dict**. 경계에서 Pydantic으로 검증(`core.actions.parse_action`, `core.turn.parse_intent`, `core.turn.parse_turn_result`, `core.actions.parse_observation`) — 원본 Zod와 같은 자리. 모델 안의 선택 항목은 `exclude_none`으로 빠진다(JS의 undefined). 사이트 프로필·결과 객체(`FieldProfile`, `WebOutcome`, `GroundedAnswer`, `PageDigest`)는 dataclass.
- **JS 동작 맞춤** `core/jsutil.py`: 정규식은 `regex` 모듈(`rx`, 가변 길이 lookbehind·`\p{..}` 지원). **JS의 `\b`·`\w`는 ASCII라 한글 옆에서 경계가 생기지만 Python은 아니다** → 원본 `\b` 자리에 `B`(ASCII 경계)를 쓴다. `jdumps`=JSON.stringify(한글 그대로), `parse_url`=new URL(잘못되면 ValueError), `AbortController`/`race_abort`(멈춤 신호), `js_round`(0.5 올림), `uniq`(순서 있는 Set).
- **① ⑥ `voice/`**: 서버 쪽 STT(`stt.py`)·TTS(`tts.py`) 공급자, 고르기는 `config.py`. 마이크·VAD·끼어들기·재생은 브라우저(`web/static/`).
- **② `understanding/`**: 규칙 파서 `rules.py`가 먼저, LLM 의도 계획 `llm_planner.py`는 보조(`plan_with_llm`, 평탄화 스키마 → `flat_to_intent`, APPROVE/STOP은 LLM이 만들 수 없다). `understand.py`의 `Understanding.understand()`가 규칙 분할 → 규칙 파싱 → LLM 계획 순서로 묻고 `Understood(intents, by)`를 돌려준다. 이해 전 거르기 `filters.py`(짧은 맞장구·부정 `short_reply_kind`, 군말 떼기, 두루뭉술한 요청 되묻기, 여러 질문 나누기 `split_questions`), 화면 밖 자유 대화 분류 `chat.py`(`chat_route`). 사이트 이름 → 주소 `sites.py`. 이 패키지는 `core`만 가져오고 대화 상태를 바꾸지 않는다.
- **다국어** `language/i18n.py`: 외국어면 `translate_in` → 한국어 흐름 → `translate_out`(숫자 바뀌면 재시도 후 한국어 원문). 멈춤·승인은 규칙만.
- **③ `orchestrator/session.py` (SessionOrchestrator)** — 세션당 하나. 순서·문·라우팅만 맡고 일은 단계별 협력 객체에 맡긴다(생성자에서 한 번 만들고, 턴마다 `ctx: ExecContext`와 발화만 넘긴다. `Turn`이나 오케스트레이터는 넘기지 않는다). 대화 상태(승인 대기·값 대기·되묻기·맞춤 질문·금고 확인·칸 채우기)는 `core/dialogue.py`의 `DialogueState` 하나에 있고 이름 붙은 동작으로만 바뀐다. 오케스트레이터가 가진 것은 동의, 기록, epoch, 언어, 직전 근거 `_grounded`(B→A 인계), 맞춤 찾기 답. 턴 순서: 원문은 `redact_text`로 비식별화 후에만 사용 → 멈춤은 큐를 거치지 않고 즉시(`_stop`, epoch 증가로 대기 턴 무효화) → 비밀값 감지 → 맞춤 질문의 답 → 금고 확인 → 칸 채우기 대답·시작 → 금고·신청 기록 명령 → 짧은 대답 → 군말 떼기 → 여러 질문 → 두루뭉술한 요청 되묻기 → `Understanding` → 동의·멈춤 문 → `_route()`/`_run_plan()` → `_finish()`가 TurnResult로 검증. 맞춤 질문의 답·금고 확인·칸 채우기·금고와 신청 기록 명령의 `turn.intentType`은 await 전에 적는다(그 안에서 예외가 나면 RECOVERING 결과가 그 라벨을 보고). 큐는 `asyncio.Lock`(FIFO) + epoch. 패키지 간 가져오기 방향은 `tests/unit/test_layers.py`가 고정한다.
- **④ Agent A** `agents/web/agent.py`: 모든 조작은 `_run()`에서 `PolicyGuard.check` → `adapter.execute` → 재관찰. 사이트 지식은 `profile.py`의 `SiteProfile`에만. **화면 이해 담당** `digest.py`(규칙): 관찰을 종류·정리한 본문·내용 링크·주요 메뉴·할 수 있는 일로 요약. **목표 수행** `autopilot.py`: 관찰→LLM 한 행동(`browse_step`)→Agent A 실행, 최대 10단계·75초, 읽기·이동·검색만, 같은 행동 3번째면 중단, 근거 검증 실패 3번이면 정직하게 실패.
- **④ `agents/web/skills/`** Agent A의 대화 기술: `form.py` `FormSkill`(모의 신청서 입력·읽기·고치기·이동·검토·모의접수 준비, 실제 사이트 입력 칸 한 번에 채우기(승인 후), 다음 질문은 `ask_next`만 만든다, 승인 뒤 실행 `assist_approved`/`submit_approved`), `browse.py` `BrowseSkill`(사이트 열기·링크·뒤로·본문 읽기·검색·목표 수행·로그인 인계, 읽기 위치), `guided.py` `GuidedFill`(실제 사이트 입력 칸 하나씩 채우기), `common.py`(화면 종류별 상태·실패 안내). 승인 문은 오케스트레이터 `_approve`에 남고 `with ctx.granted(ids):` 안에서 기술을 부른다. Agent B·금고는 주입된 함수로만 쓴다(`agents.welfare`·`personal`을 가져오지 않는다).
- **④ `agents/web/browser/`**: Playwright **async** API. 관찰 스크립트는 `observe.js`(원본 TS 템플릿 문자열을 평가해 뽑은 것 — 이스케이프는 이미 풀려 있음), 가상 커서 `cursor.js`(`__X__`·`__Y__`·`__RIPPLE__` 자리), 대기 화면 `waiting.html`. Playwright 드라이버는 프로세스에 하나(`_pw()`), 끝낼 때 `stop_playwright()`.
- **④ Agent B** `agents/welfare/`: 공식 데이터(`data/`, 복지 API + fixture)만 근거. `rag.py` 2-gram 검색, LLM은 근거 안에서만, `usedChunkIds` 검증. 맞춤 찾기 `discovery.py`.
- **⑤ `safety/`**: `guard.py` PolicyGuard — `full`(지원 사이트) / `read-only`(그 외 http(s)) / `none`, secret 필드는 항상 거부, `RISKY_BUTTON` 이름 휴리스틱. `gates.py` 동의·멈춤 문 — 동의는 턴 전체, 여러 질문의 질문마다, `_route`가 의도를 바꾼 뒤 실행 직전에 묻는다. 멈춤은 턴을 시작할 때 한 번만 묻는다(상태는 `_finish`에서 바뀌므로 실행 직전에 다시 물으면 '다시 시작하고 …'의 뒤 단계가 막힌다). `privacy.py` 민감정보 탐지·가리기. **검증 담당** `verify.py`: LLM이 낸 근거 인용이 원문에 있는지(2-gram 근사), 답의 숫자가 근거·질문에 있는지(30만=300,000 환산).
- **⑥ `speech/`**: 말로 내보낼 문장. `phrasing.py`(조사 `josa`, 항목 이름 읽기 `speak_label`, 날짜 읽기 `speak_date`, 긴 글 나누기 `chunk_text`, 입력값 되읽기 `readback`), `screen.py`의 `Narrator`(화면·입력 칸·버튼·팝업 설명, 페이지 소개, 본문 요약, 한 번만 하는 안내 `once`). `speech/__init__`은 `phrasing`만 다시 내보낸다.
- **`personal/`**: 개인 정보 금고·신청 기록(`store.py`, 파일 권한 600)과 명령 이해·기한 알림(`commands.py`), 금고 저장·삭제 확인과 명령 실행 `dialogue.py`(`PersonalDialogue`).
- **`core/`**: 단계 공통. `actions.py`(Action/Observation 계약), `turn.py`(의도·TurnResult 스키마, 응답 초안 `draft()`), `dialogue.py`(`DialogueState`: 읽기 전용 속성 + 이름 붙은 동작, docstring에 호출하는 곳), `llm.py`(OpenAI 호환 strict `json_schema` 호출, 모델 ID는 `.env`로만, HTTP는 httpx, `SIMPLE_TEXT_SCHEMA`), `events.py`(비식별 이벤트), `jsutil.py`. `core/__init__`은 다시 내보내지 않는다 — 모듈에서 바로 가져온다.
- **server/**: `runtime.py`(조립, 브라우저 1개 공유·세션마다 격리 컨텍스트), `app.py`(FastAPI, REST 경로·오류 코드는 원본과 같음), `__main__.py`(uvicorn, `--desktop`이면 CSP·실제 사이트 모드·`CHEONGEUM_PARENT_PIPE=1`일 때 stdin이 닫히면 종료).
- **web/static/**: 바닐라 JS 웹 UI. `index.html`에 골격, `app.js`가 상태를 바꾸고 해당 부분만 다시 그린다(입력란·버튼을 다시 만들지 않아 포커스 유지). 음성은 `mic.js`(① 듣기: 브라우저 인식·녹음·VAD 루프·끼어들기·박수)와 `speaker.js`(⑥ 말하기: 브라우저·서버 TTS 이어 재생·신호음)로 나누고, 둘이 함께 쓰는 대화 언어와 AudioContext 하나는 `audio.js`. 이 셋과 `api.js`는 원본 TS(voice.ts·api.ts)에서 타입만 뺀 것.
- **practice_site/**: 모의 신청 사이트(`site/`) + 합성 외부 포털 `external.html`. `127.0.0.1:5174`로 열면 출처가 달라 외부(read-only) 사이트로 취급 — 그래서 IPv4·IPv6 모두에서 듣는다. 윈도에서 `.js` MIME을 직접 정한다. 서버가 기본으로 띄우므로 런타임 패키지에 둔다.
- **apps/desktop**: Electron 셸(빌드 없음). 파이썬은 `CHEONGEUM_PYTHON` → `.venv` → `uv run`.

## Conventions that matter here

- 응답은 시각장애인이 듣는 음성: 핵심만 짧게, 부가 정보는 "화면 설명해줘"에서. 조사는 `josa()`(받침·숫자 읽기 반영).
- 추측 금지: 불완전한 값·모호한 필드/링크·대상 없는 요청·모르는 사이트 이름(검색으로 대체)은 실행하지 않고 되묻는다. 화면 텍스트는 비신뢰 데이터 — 의도 분석에 넣지 않는다. 봇 차단·CAPTCHA는 우회하지 않는다.
- 실제 사이트 제출·로그인·본인인증은 하지 않는다(사용자 인계). 모의접수는 사전 승인 후에만.
- 원본 TS 동작과 맞출 것: `??`는 `nz()`/`is None`, `||`는 `or`; JS `replace(문자열)`은 첫 번째만(`count=1`), `/g`는 전부; JS 정규식 `$`는 문자열 끝만.
- Python 3.12 f-string 안에서 `\"`를 식(expression) 부분에 쓰지 말 것 — 미리 변수로 빼거나 같은 따옴표 중첩(PEP 701)을 쓴다.
