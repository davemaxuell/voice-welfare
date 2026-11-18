# 청음 개발 안내

청음은 시각장애인이 한국어 음성으로 웹을 읽고, 지원 사이트에서 신청서를 작성하도록 돕는 PC 브라우저 에이전트다. 사용자는 “청음아”, “청음이”로 부를 수 있다. 사용자 안내, UI 문구와 코드 주석은 한국어로 쓴다. [기획 요약](docs/기획요약.md) · [아키텍처 그림](docs/architecture.png)

## 실행과 개발

Node.js 24 이상에서 저장소 루트를 작업 디렉터리로 사용한다.

```bash
npm ci
npx playwright install chromium
npm start
```

`npm start`는 React 화면을 빌드하고 8787번 포트에서 UI와 API를 함께 제공한다. 서버가 기본으로 여는 연습 사이트는 5174번 포트를 쓴다. 화면 개발 시 같은 서버를 켜 둔 채 다른 터미널에서 `npm run dev:web`을 실행한다. 서버 설정은 루트 `.env`에 두고 변경하면 재시작한다. API 키와 사용자 녹음은 커밋하지 않는다.

| 명령 | 용도 |
| --- | --- |
| `npm run typecheck`, `npm run lint` | 전체 타입과 ESLint 검사 |
| `npm test` | 단위·E2E 테스트 |
| `npm run test:unit`, `npm run test:e2e` | 프로젝트 하나만 실행 |
| `npx vitest run tests/unit/parser.test.ts` | 파일 하나만 실행. `-t`로 이름 선택 |
| `npm run mock` | 연습 사이트만 실행 |
| `npm run eval` | 시나리오, 근거 검색, axe 실행. `reports/evaluation-report.md` 작성 |
| `npm run eval-agent` | 실제 사이트 목표 수행 평가. `reports/agent-qa.md` 작성 |
| `npm run eval-stt` | `docs/stt-eval/sentences.csv`와 `recordings/`로 받아쓰기 평가 |
| `npm run check-llm`, `npm run check-voice`, `npm run check-welfare` | `.env`의 실제 공급자 연결 확인 |

로컬 모델을 쓰려면 `uv sync --project python`으로 Python 환경을 만든 뒤 `npm run setup-models`를 실행한다. 받아쓰기 프로세스는 `python/cheongeum_stt/`, CT2 변환기는 `python/convert_whisper_ct2.py`에 있다. 데스크톱은 루트에서 `npm --prefix apps/desktop ci`와 `npm --prefix apps/desktop start`로 시작한다. [설치 및 모델 설정](README.md)

### 회귀 기준과 테스트

마지막 Python 구현과 당시의 기록 도구는 Git 커밋 `14400191400610a80a7d6fa1d2318635208d4a1f`에 보관했다. 당시 테스트를 직접 실행하려면 별도 작업 트리를 만든다.

```bash
git worktree add --detach ../cheongeum-python-reference 14400191400610a80a7d6fa1d2318635208d4a1f
cd ../cheongeum-python-reference
uv sync
uv run playwright install chromium
uv run pytest
```

TypeScript 작업 트리에서 `npm --silent run test-parity`를 실행하면 아래 pytest 수집 기록의 테스트 이름을 Vitest 제목과 비교한다. 출력되는 이름은 대응하는 TS 테스트가 빠졌다는 뜻이다. 실제 동작은 `npm test`에서 기준 함수 출력, 한국어 정규식의 캡처·위치, 대화 턴, 브라우저 관찰 결과를 다시 검사한다. [동결한 pytest 수집 목록](.audit/ts-port/baseline/ccd78bbe5dc33171f605783cc8c26da35e734959/collect.txt) · [검증 데이터](tests/fixtures/)

E2E 전역 설정은 `X-Ieum-Checkout` 응답 헤더로 이 작업 트리의 연습 사이트를 식별한다. 다른 작업 트리가 같은 포트를 사용하면 포트를 놓을 때까지 기다린다. 테스트에는 로컬 사이트, 고정 API 응답, 주입한 모델을 쓴다. E2E 브라우저 창을 보려면 환경 변수 `HEADED=1`을 설정한다. 평가 입력 `src/evaluation/data/demo_scenarios.json`은 원본 바이트를 유지한다.

## 한 턴의 실행 순서

1. `src/voice/`가 음성 공급자를 고른다. `STT_PROVIDER=local`에서 `STT_BASE_URL`이 있으면 지정한 호환 서버를 사용한다. `STT_LOCAL_MODEL`을 설정하면 로컬 프로세스에서 faster-whisper가 한국어를 받아쓴다. 다른 언어는 설정에 따라 원격 모델로 보낸다.
2. `src/orchestrator/session.ts`의 `SessionOrchestrator`가 민감정보를 확인하고 멈춤·동의·언어 처리를 거친다. `src/understanding/`은 규칙을 먼저 적용한다. 모델은 허용된 의도 목록에서만 고른다. 맞장구나 부정 응답을 입력값으로 해석하지 않는다.
3. 웹 작업은 `src/agents/web/`에 맡긴다. `digest.ts`는 관찰을 본문·내용 링크·메뉴·조작 요소로 정리한다. `agent.ts`는 동작 전에 정책을 검사하고 Playwright로 실행한 뒤 다시 관찰한다. `autopilot.ts`는 읽기·이동·검색을 최대 10단계 수행한다. 사이트 이름이나 링크가 모호하면 묻는다.
4. 복지 질문은 `src/agents/welfare/`에서 공식 자료와 샘플 데이터를 검색한다. `rag.ts`의 검색 결과에 있는 근거만 사용하고 답변의 `usedChunkIds`와 숫자를 확인한다. 신청 가능일은 자료에 있는 신청기간과 오늘 날짜를 대조한다. 자료에 기간이 없으면 문의처를 안내한다.
5. `src/speech/`는 조사(`josa`), 날짜, 입력값 되읽기, `Narrator`의 화면 설명을 맡는다. 음성 답변은 핵심부터 짧게 말한다. `src/language/`가 번역한 답의 숫자도 다시 확인한다.

## 안전과 상태

- `src/core/`의 Zod 스키마로 외부 액션·관찰·의도·턴 응답을 검증한다. `src/core/llm.ts`는 모델 입력에 비식별화된 문자열을 받는다. 화면 글도 비신뢰 입력이다. 모델에 보내기 전에 가리고 인용·숫자 검증에는 원문을 쓴다.
- `src/safety/guard.ts`의 `PolicyGuard`는 지원 사이트, 읽기 전용 사이트, 접근할 수 없는 사이트를 구분한다. 비밀번호 입력은 차단한다. `READ_ONLY_CLICKS=safe`에서는 주소가 있는 링크와 위험하지 않은 조작만 허용한다. “신청방법”과 “신청하기”는 다른 동작이다. 제품 기본값인 `any`에서도 로그인 동작에는 승인이 필요하다.
- 승인 요청은 대상과 결과를 짧게 읽고 사용자의 대답을 기다린다. `src/agents/web/approval.ts`는 조작 종류, 대상, 출처와 경로, 입력값, 읽어 준 문장의 지문을 만든다. 승인 시 다시 관찰해 같은 조작인지 확인한다. 지문이 바뀌거나 2분이 지나면 다시 요약하고 확인한다. 승인은 해당 조작 한 번에만 쓴다.
- `src/agents/web/skills/`에서 `BrowseSkill`은 읽기 위치와 메뉴·검색·로그인 인계를, `FormSkill`은 연습 신청서와 승인된 입력을, `GuidedFill`은 실제 사이트 입력 칸을 하나씩 맡는다. 실제 사이트의 제출·본인인증과 로그인 정보 입력은 사용자에게 넘긴다. 모의 접수는 승인된 연습 신청서에서만 실행한다.
- `src/safety/privacy.ts`는 비밀번호·주민번호·계좌번호 등의 값과 한글로 읽은 숫자를 가린다. `PII_MODEL`을 설정하면 로컬 모델의 탐지 결과도 합친다. 로그인·본인인증 중인 짧은 비밀값 후보는 번역, LLM, 대화 기록에 들어가기 전에 처리한다.
- `src/personal/`은 사용자가 확인한 개인 정보와 신청 기록을 관리한다. 파일 저장 시 AES-GCM으로 암호화하고 OS 자격 증명 저장소에 키를 보관한다. 데스크톱의 기본 저장 폴더는 `~/.cheongeum`이며 `CHEONGEUM_DATA_DIR`로 바꿀 수 있다.
- `src/core/assets.ts`에서 브라우저 관찰 스크립트, 연습 사이트, 복지 자료, 평가 입력과 안내음의 경로를 찾는다. 실제 웹 동작에는 Playwright를 쓴다. CAPTCHA와 접속 차단은 사용자에게 알린다.

## 화면과 데스크톱

`src/server/`는 Hono REST 경로(`app.ts`), 세션별 자원과 공급자 조립(`runtime.ts`), 실행 및 종료(`main.ts`)로 나뉜다. 세션마다 브라우저 컨텍스트를 격리한다. `--desktop`에서는 CSP를 적용한다. Electron의 부모 파이프가 닫히면 서버가 세션과 브라우저를 정리한다.

`web/src/App.tsx`는 React 화면을, `conversation.ts`는 동의·대화·음성 진행 상태를 관리한다. `mic.ts`가 마이크·말 끝·끼어들기·박수를 감지하고 `speaker.ts`가 안내와 신호음을 재생한다. 턴 진행 중에는 `GET /api/session/{id}/progress`를 사용한다. 갱신 뒤에도 입력값, 입력 포커스, 스크린 리더의 읽기 순서를 유지한다. `tests/e2e/web-ui.test.ts`에서 실제 Chromium과 axe로 확인한다.

`apps/desktop/main.cjs`가 `CHEONGEUM_NODE` 또는 `PATH`의 `node`로 서버를 실행한다. 기본은 트레이 모드다. `preload.cjs`가 전역 단축키 이벤트를 React 화면에 전달한다. `Ctrl+Shift+Space`(macOS는 `Cmd+Shift+Space`)는 동의 중이면 동의하고 대화 중이면 지금 말하기를 실행한다.
