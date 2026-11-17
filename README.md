# 이음 — 시각장애인 공공서비스 신청 완주 음성 에이전트 (Python)

시각장애인이 **말로** 웹을 읽고 찾고, 복지로 같은 공공 사이트에서 **신청을 끝까지 하도록** 돕는 PC 음성 에이전트입니다.
신청을 몰래 대신 해 주는 것이 아니라, 화면과 사람 사이를 통역하고 **중요한 동작은 확인받고, 제출·로그인·본인인증은 사람에게 넘깁니다.**

이 저장소는 TypeScript 모노레포(`voice-welfare-agent`)를 **Python으로 옮긴 것**입니다. 서버·에이전트·정책·브라우저 조작·평가·테스트는 모두 Python이고,
브라우저 안에서 도는 코드(웹 UI, 모의 사이트 스크립트)는 **빌드 없는 바닐라 JS**, 데스크톱 셸은 Electron(파이썬 서버를 자식 프로세스로 띄움)입니다.

- 아키텍처 그림과 구현 대조: [`docs/architecture-check.md`](docs/architecture-check.md)

![아키텍처](docs/architecture.png)

---

## 1. 지금 되는 것 (말 예시)

| 기능 | 이렇게 말하면 | 하는 일 |
| --- | --- | --- |
| **아무 사이트 열기·읽기** | "네이버 열어줘", "화면 설명해줘", "본문 읽어줘", "계속 읽어줘", "링크 목록 알려줘" → "3번", "뒤로 가줘", "이 사이트 뭐야?" | 브라우저로 열고, 메뉴 글자 대신 **본문 요점부터** 짧게 말함. 받아쓰기 오타("네이보", "Naver")도 알아들음 |
| **목표 수행(여러 단계 자동)** | "네이버에서 오늘 주요 뉴스 알려줘", "국민연금공단 사이트에서 고객센터 번호 찾아줘" | 관찰 → 다음 행동 결정 → 실행을 최대 10단계 반복(읽기·이동·검색만). 답은 화면 근거가 확인될 때만 말함 |
| **복지 질문(공식 데이터)** | "기초연금은 몇 살부터 받아?", "그럼 얼마야?", "몇 살부터고 얼마 받아?" | 한국사회보장정보원 공식 API 원문을 근거로만 답함. 없으면 "찾지 못했어요" |
| **맞춤 복지 찾기** | "나한테 맞는 복지 찾아줘" → 나이·장애·소득·지역 → "1번 자세히", "1번 자격 확인해줘" | 중앙(461개)+지자체 목록에서 후보를 찾고 선정기준과 조건별 비교(최종 판정은 안 함) |
| **신청 시작** | "기초연금 신청 도와줘" | 공식 안내 페이지를 열고 요점 한 줄. 본문은 지원 대상 → 서비스 내용 → 신청 방법 순서로 읽음 |
| **실제 사이트 칸 채우기** | "입력 칸 하나씩 채워줘" → "홍길동" / "응" / "건너뛰기" / "그만" | 칸을 하나씩 묻고 넣은 뒤 화면 값을 다시 읽어 확인. 비밀번호·인증·동의 칸 제외, **제출 버튼은 누르지 않음** |
| **개인 정보 금고** | "내 이름은 김하늘이고 주소는 …라고 저장해줘", "내 정보 알려줘/지워줘" | 확인 후 이 컴퓨터에만 저장(이름·주소·연락처·이메일·생년월일만) |
| **신청 후 추적** | "기초연금 신청했어, 접수번호는 …", "보완 서류는 12월 3일까지래", "신청한 거 어떻게 됐어?" | 신청·기한을 기억, 기한 3일 전부터 알림 |
| **로그인 인계** | "로그인 눌러줘, 그 뒤는 내가 할게" | 로그인 페이지 링크까지만 열고 사람에게 넘김 |
| **연습용 신청서** | "장애인연금 연습 신청 도와줘" | 모의 신청서에서 입력·검증·요약·승인 후 모의 접수(실제 전송 없음) |
| **다국어** | "영어로 말해줘", "Speak English", "说中文", "日本語で話して", "Korean please" | 그 언어로 듣고 답함(LLM 필요). 한국 고유 용어는 원어와 짧은 풀이 |
| **멈춤·대화 습관** | "멈춰"(stop/停止/止めて), "알았어", "아니", "쉽게 말해줘" | 멈춤은 무엇보다 먼저 즉시. 맞장구·부정은 입력값으로 넣지 않음 |

## 2. 빠른 시작

요구: Python 3.12+와 [uv](https://docs.astral.sh/uv/), (데스크톱 앱만) Node.js 20+와 Google Chrome. 키(OpenAI, 공공데이터포털 복지 API)가 없으면 규칙 기반·샘플 데이터로 동작합니다.

```bash
cd voice-welfare
uv sync                                   # 의존성 + 프로젝트(편집 가능 설치)
uv run playwright install chromium        # Playwright용 Chromium
# 프로젝트 루트에 .env (키·설정, 커밋 금지)
uv run ieum-server                        # http://localhost:8787 : 웹 UI + API (+ 모의 사이트 :5174 자동)
```

- 웹 UI는 빌드 없이 같은 포트에서 바로 서빙됩니다(`src/ieum/web/static`). 편집 후 새로고침만 하면 됩니다.
- 모의 사이트만: `uv run ieum-mock` (http://localhost:5174, 외부 포털 테스트는 http://127.0.0.1:5174/external.html)

**데스크톱 앱(Electron)** — 기본 백그라운드(창 없이 트레이 '이음', Cmd/Ctrl+Shift+Space = 말하기·동의)

```bash
npm --prefix apps/desktop install         # 처음 한 번(Electron)
npm --prefix apps/desktop start           # 실제 사이트 모드. IEUM_SHOW_WINDOW=1이면 창, PRACTICE_MODE=true면 연습 사이트 기본
```

Electron은 `.venv`의 파이썬(없으면 `uv run`, 또는 `IEUM_PYTHON`)으로 `python -m ieum.server --desktop`을 띄우고, 끌 때 stdin을 닫아 서버가 브라우저·세션을 정리하게 합니다.

<details>
<summary>그 밖의 설정(.env)</summary>

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_REASONING_EFFORT` | `mock` | `openai` / `ollama`(로컬 Qwen) / `qwen`·`openai-compatible`. 모델 ID는 코드에 없음 |
| `STT_PROVIDER`, `STT_MODEL`, `STT_BASE_URL` | `mock` | `openai` 또는 `local`(OpenAI 호환 로컬 받아쓰기 서버) |
| `TTS_PROVIDER`, `TTS_MODEL`, `TTS_VOICE`, `TTS_SPEED`, `TTS_INSTRUCTIONS` | `mock` | `openai` 또는 `browser`(무료 OS 음성) |
| `WELFARE_DATA_MODE`, `WELFARE_API_KEY`, `WELFARE_API_BASE_URL` | fixture | `official-api`면 공식 API(실패 시 fixture) |
| `PRACTICE_MODE` | 서버 `true` / 데스크톱 `false` | `false` = 실제 사이트 모드 |
| `IEUM_DATA_DIR` | 데스크톱 `~/.ieum` | 금고·신청 기록(`personal.json`, 권한 600) |
| `REQUIRE_CONSENT` | `true` | 동의 전에는 화면·음성을 쓰지 않음 |
| `BROWSER_MODE`, `CHROME_PROFILE_DIR` | `chromium`, `~/.ieum/chrome-profile` | `chrome` = 설치된 크롬 + 영구 프로필 |
| `HEADLESS`, `VISUAL_CURSOR`, `BROWSER_SLOWMO_MS` | 창 보임, 창이 보이면 켬, `0` | 시연용 |
| `READ_ONLY_WEB`, `WEB_SEARCH_URL` | `true`, 네이버 | 지원 사이트 밖은 읽기 전용, 검색 주소 틀(`{q}`) |
| `PORT`, `DESKTOP_PORT` | `8787`, `8790` | 서버 포트 |
| `QWEN_MODEL`, `EVAL_MODELS` | — | `scripts/eval_agent.py` 비교용 |

</details>

## 3. 폴더 구조 (파이프라인 단계별)

①~⑥은 `docs/architecture.png`의 상자 번호입니다.

```text
src/ieum/
  voice/             ①⑥ 서버 STT(stt.py)·TTS(tts.py) 공급자, 고르기(config.py)
  understanding/     ②  의도 이해: 규칙 파서(rules.py, 먼저), LLM 의도 계획(llm_planner.py, 보조), 둘을 묻는 순서(understand.py),
                         이해 전 거르기(filters.py: 맞장구·군말·두루뭉술한 요청·여러 질문), 자유 대화 분류(chat.py), 사이트 이름(sites.py)
  language/          ②⑥ 다국어(i18n.py): 외국어 → 한국어 흐름 → 다시 번역
  orchestrator/      ③  턴 순서·동의·멈춤 문·라우팅·B→A 인계(session.py의 SessionOrchestrator)
  agents/web/        ④  Agent A 웹 탐색·실행(agent.py) + 화면 이해 담당(digest.py) + 사이트 프로필(profile.py) + 목표 수행(autopilot.py)
    skills/               대화 기술: 모의 신청서·실제 사이트 한 칸 채우기(form.py), 웹 읽기·이동·검색(browse.py), 실제 사이트 칸 하나씩 채우기(guided.py)
    browser/              Playwright(async) 실행, observe.js(관찰 스크립트), 가상 커서
  agents/welfare/    ④  Agent B 복지 정보·대화(agent.py), RAG(rag.py), 맞춤 찾기(discovery.py)
    data/                 복지 API 클라이언트 + 대체용 샘플 데이터(fixtures/)
  safety/            ⑤  PolicyGuard(guard.py), 동의·멈춤 문(gates.py), 민감정보 탐지·가리기(privacy.py), 검증 담당(verify.py)
  speech/            ⑥  말할 문장: 조사·날짜·항목 이름 읽기(phrasing.py), 화면 설명(screen.py의 Narrator)
  personal/              개인 정보 금고·신청 기록(store.py) + 명령 이해·기한 알림(commands.py) + 확인·명령 실행(dialogue.py)
  core/                  공통: Action/Observation 계약(actions.py), 의도·TurnResult 스키마(turn.py), 대화 상태(dialogue.py), LLM 호출(llm.py),
                         비식별 이벤트(events.py), JS 동작 맞춤 도우미(jsutil.py: ASCII \b 정규식, JSON.stringify, URL, AbortController)
  server/                FastAPI REST(app.py) + 런타임 조립(runtime.py), `python -m ieum.server`
  web/static/        ①⑥ 접근성 웹 UI(바닐라 JS: app.js, mic.js 듣기, speaker.js 말하기, audio.js 공용, api.js), 빌드 없음
  practice_site/         모의 신청 사이트(site/, 바닐라 JS) + 정적 서버(serve.py). 서버가 기본으로 띄운다
  evaluation/            시나리오 평가·지표·RAG 정확도, data/(demo_scenarios.json 등, 수정 금지)
apps/desktop/        Electron 셸(main.cjs, preload.cjs) — 파이썬 서버를 자식 프로세스로 실행
scripts/             run_scenarios.py(평가), eval_agent.py(목표 수행 QA), check_llm/voice/welfare.py, vendor/axe.min.js
tests/unit, tests/e2e   pytest 단위 / 실제 Chromium E2E(인터넷 없이 동작), fixtures/(실제 API 응답 저장본)
docs/                기획 요약, 아키텍처 그림, 사용자 테스트 자료
```

## 4. 동작 구조

```text
말(음성) → 받아쓰기 → 비식별화 → [멈춤은 즉시] → (외국어면 한국어로)
  → 의도 이해(규칙 먼저, 모르면 LLM) → 오케스트레이터 라우팅
     ├─ Agent B 복지 정보: 공식 API 근거 검색 → LLM이 근거 안에서만 답 → 검증 담당(숫자 대조)
     └─ Agent A 웹 실행: 관찰 → 화면 이해 담당(정리) → 계획 → PolicyGuard → Playwright 실행 → 재관찰 확인
  → 짧은 한국어 답(필요하면 사용자 언어로 번역, 숫자 바뀌면 원문) → 음성 합성
```

- **규칙 먼저, LLM은 보조**: 자주 쓰는 명령은 규칙으로 빠르고 결정적으로. 승인·멈춤은 LLM이 만들 수 없음.
- **화면 이해 담당**(규칙): 페이지를 종류·본문·내용 링크·메뉴·할 수 있는 일로 정리해 AI 입력을 줄임.
- **검증 담당**(규칙): 말하기 전에 근거 문장이 실제 화면·자료에 있는지, 숫자가 맞는지 대조.
- 데이터는 JSON과 같은 camelCase dict로 오가고, 경계(액션·의도·TurnResult·관찰)에서 Pydantic으로 검증합니다(원본의 Zod 역할). REST 응답 모양은 TS 버전과 같아서 웹 UI·데스크톱 앱이 그대로 붙습니다.

## 5. 안전 원칙

- **제출·로그인·본인인증은 사람이**: 실제 사이트에서 제출 버튼을 누르지 않고, 입력은 사용자가 말한 값·확인한 값만.
- **PolicyGuard**: 지원 사이트 밖은 읽기 전용(링크·이동·검색). 신청·결제·동의 같은 동작 버튼과 비밀번호 칸은 항상 차단.
- **민감정보**: 비밀번호·주민번호·계좌·카드 번호는 처리 전에 `[비공개]`로 가려 기록·모델 입력·응답에 남지 않음.
- **화면 글은 신뢰하지 않음**: 페이지 속 지시를 따르지 않음(E2E로 확인). 보안문자·접속 차단은 우회하지 않고 알림.
- **동의 먼저**: 동의 전에는 화면을 읽거나 음성을 외부로 보내지 않음. 녹음은 저장하지 않음.

## 6. 테스트·평가

| 명령 | 내용 |
| --- | --- |
| `uv run pytest` | 단위 192 + E2E 94 = 286개(실제 Chromium, 인터넷 불필요). 화면 보기: `HEADED=1 uv run pytest` |
| `uv run pytest tests/unit/test_parser.py` / `-k 검색` | 파일 하나 / 이름으로 고르기 |
| `uv run python scripts/run_scenarios.py` | 시나리오 35개 + PRD 지표 + RAG Recall/MRR + 접근성(axe) → `reports/evaluation-report.md` |
| `uv run python scripts/eval_agent.py` | 실제 사이트 목표 수행 10과제, Qwen(로컬)·OpenAI 비교 → `reports/agent-qa.md` |
| `uv run python scripts/check_llm.py` / `check_voice.py` / `check_welfare.py` | `.env`의 실제 OpenAI·음성·복지 API 연결 확인 |

TS 버전과 같은 결과: 시나리오 35/35, 필드 정확도 15/15, 승인 준수 100%, 무단 제출·읽기 전용 위반·비밀값 노출 0건, RAG Recall@3 100%·MRR 0.950, axe 위반 0건(7개 화면).
**실사용자(시각장애인) 테스트는 아직 0명**입니다(`docs/user-test/`에 계획·과제·동의서·기록지 준비).

## 7. 비용(OpenAI, 측정 기반 추정)

1턴 ≈ 약 $0.006(8원): 음성 합성 약 85%, LLM 약 10%(입력 1.6k·출력 0.1k 토큰), 받아쓰기 약 5%.
`TTS_PROVIDER=browser`(무료 OS 음성)로 바꾸면 비용 대부분이 사라지고, `STT_PROVIDER=local`이면 음성이 컴퓨터 밖으로 나가지 않습니다.

## 8. 알려진 한계

- 실제 접수 상태 자동 조회 없음(로그인 필요).
- 정부24 등 일부 사이트는 자동화 브라우저 접속을 차단(우회하지 않음).
- 끼어들기·말 끝 판단은 마이크·스피커 환경에 따라 다름(단축키가 확실한 대안).
- 외국어 모드는 번역 때문에 턴마다 3~8초 느림. 고정 UI 문구는 한국어.
- 세션·이벤트 로그는 메모리(서버 재시작 시 사라짐). 금고·신청 기록만 파일 저장.
- 한국어 이름 정렬은 유니코드 순서(ICU 콜레이션 대신) — 한글 음절은 가나다 순서와 같다.
