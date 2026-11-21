# eval — 이음 서비스 평가

> **상태 (2026-11-21).** 이 폴더는 이전 `@ieum/*` 모노레포에서 가져온 것이라 아래 `npm run eval:*` 명령과 `packages/evaluation`은 이 저장소에 없다.
> - **그대로 쓸 수 있는 것:** `datasets/`, `snapshots/`, `benchmark/`, `voice-test.html`, 이미 만들어진 `results/20261117-1518/`.
> - **지금은 실행되지 않는 것:** `run.ts`, `run-agent-qa.ts`, `run-rules.ts`, `snapshot-welfare.ts`, `lib/snapshot-provider.ts`. 없는 `@ieum/*`와 `../apps/{server,mock-welfare}`를 가져온다. 다중 모델 비교 로직을 보존하려고 남겼고, 쓰려면 `src/`에 맞게 옮겨야 한다.
> - 이 저장소의 평가는 `npm run eval`(`scripts/run-scenarios.ts`), `eval-agent`, `eval-stt`와 `src/evaluation/`이다.
> - `eval/**`은 tsconfig·ESLint 대상이 아니다.

이 폴더는 **"이음이 실제로 잘 되는가"**를 숫자로 확인하는 곳입니다.
같은 평가 데이터를 여러 AI 모델(지금 서비스의 gpt-5-mini, Grok, 로컬 Qwen)로 돌려서
**기능이 되는지(성공률), 맞는 말을 하는지(정답 사실·지어낸 숫자), 안전한지, 얼마나 빠른지(지연), 얼마 드는지(비용)**를 비교합니다.
말투·이해하기 쉬운지 같은 질은 사람이 채점표로 매깁니다.

## 팀원이 할 일 (약 25분)

평가는 세 층입니다. **대부분은 컴퓨터가 자동으로** 하고, 사람은 컴퓨터가 못 재는 것만 합니다.

| 층 | 누가 | 무엇을 | 어떻게 |
|---|---|---|---|
| 1. 자동 평가 | 컴퓨터 | 시나리오 100개: 기능 성공률·정답 정확도·안전·지연·비용, 모델 비교 | `npm run eval:models` (사람 할 일 없음) |
| 2. **음성 테스트** | **팀원** | 실제 목소리·마이크로 받아쓰기, 말 끝까지 듣기, 끼어들기, 체감 대기 시간 | **`eval/voice-test.html`** 더블클릭 → 앱에 15개 과제를 말해 보고 체크(약 20분) → CSV 내려받아 공유 |
| 3. 답의 질 채점 | 팀원(짧게) | 대표 10문항 × 모델 수: 정확성·핵심부터·이해 쉬움·길이·안전 1~5 | 결과 폴더의 `review.html` → 사람 채점 탭(약 5분) |

음성 테스트 순서
1. 데스크톱 앱을 켭니다: `npm run desktop`(`.env`에 키 필요). 메뉴 막대 **이음 → 창 보기**를 열어 두면 받아쓴 글을 볼 수 있습니다.
2. `eval/voice-test.html`을 브라우저로 열고 이름·컴퓨터·마이크를 적습니다.
3. 과제를 위에서부터 차례로, 띵 소리 뒤에 파란 칸의 말을 그대로 말합니다. 반응을 듣고 맞는 항목을 체크하고, 받아쓰기 정확 여부를 고르고, 기다린 시간은 "시작/멈춤"으로 잽니다.
4. 끝나면 **CSV 내려받기** → 팀 공유 폴더에 올립니다. 과제를 고치려면 `datasets/voice-test-tasks.json` 수정 후 `npm run eval:voice-test`.

## 빠른 시작

```bash
npm install                                  # 처음 한 번
npm run eval:models                          # gpt-5-mini로 로컬 세트 7개 × 3회 (인터넷 없이, 약 30~40분)
EVAL_REPEAT=1 npm run eval:models            # 빠르게 1회만
EVAL_SETS=welfare-qa,safety npm run eval:models   # 일부 세트만
```

결과는 `eval/results/<날짜-시각>/`에 생깁니다. **`review.html`을 더블클릭**하면 브라우저에서 사람 채점과 자동 평가 요약을 한 화면으로 볼 수 있습니다(서버·설치 불필요). 지난 결과로 화면만 다시 만들려면 `npm run eval:review -- eval/results/<폴더>`.

## 폴더 구성

| 경로 | 무엇 |
|---|---|
| `README.md` | 이 문서 |
| **`benchmark/`** | **서비스 비교 벤치마크**: 완성된 이음과 범용 AI 대화 서비스·브라우저 에이전트를 세금 신고·민원 접수·여권 발급·뉴스 검색·복지 지원 신청 5개 분야 × 표 15 기능 기준 과제 34개로 비교(팀원이 수행·채점). 자세한 내용은 `benchmark/README.md` |
| **`voice-test.html`** | **팀원용 음성 테스트 체크리스트**(더블클릭으로 열기). 과제는 `datasets/voice-test-tasks.json`, 다시 만들기는 `npm run eval:voice-test` |
| `voice-test.ts`, `lib/voice-test-html.ts` | 위 체크리스트 화면을 만드는 코드 |
| `run.ts` | **평가 실행기.** 데이터셋을 모델별로 돌리고 보고서·채점 화면을 만든다 (`npm run eval:models`) |
| `review.ts`, `lib/review-html.ts` | 결과(`results.json`)로 **평가 화면 `review.html`**을 만든다 (`npm run eval:review`) |
| `run-rules.ts` | 규칙 평가(`npm run eval`): AI를 끄고 예전 시나리오 35개 + RAG 검색 정확도 + 접근성(axe) 검사 → `results/rules-report.md`. 결과가 매번 같아 회귀 확인용 |
| `run-agent-qa.ts` | (예전) 실제 사이트 목표 수행 10과제를 Qwen·OpenAI로 비교(`npm run eval:agent`) → `results/agent-qa.md`. 새 평가는 `run.ts`의 `goals-real` 사용 |
| `datasets/legacy/` | 예전 평가 데이터: `demo_scenarios.json`(초기 데모 시나리오, 자동 테스트도 사용), `scenarios_30.json`(합성 30건), `rag_qa.json`(RAG 검색 정확도 질문) |
| `snapshot-welfare.ts` | 공식 복지 API 상세 응답을 `snapshots/`에 저장한다. 기준연도가 바뀔 때 한 번 다시 실행 (`npm run eval:snapshot`) |
| `lib/snapshot-provider.ts` | 평가 때 복지 데이터를 저장본으로 고정하는 장치(모델끼리 같은 자료, 인터넷·API 상태 무관) |
| `datasets/*.json` | **평가 데이터.** 아래 표 참고 |
| `snapshots/welfare/*.xml` | 한국사회보장정보원 중앙부처복지서비스 상세 응답 저장본 12개(기초연금·장애인연금·장애수당·주거급여 등). `_meta.json`에 저장 시각·출처 |
| `results/` | 실행 결과(기본은 git에 올리지 않음. 공유할 보고서만 골라서 올리기) |

## 평가 데이터셋 (`datasets/`)

로컬 세트는 연습 신청 사이트·합성 포털(`apps/mock-welfare`)에서 **인터넷 없이** 돌아 매번 같은 조건입니다.

| 파일 | 시나리오 | 무엇을 보나 |
|---|---|---|
| `web-basic.json` | 15 | 사이트 열기·본문 읽기(메뉴 말고 본문부터)·짧은 화면 설명·링크 번호·뒤로·검색·사이트 소개·로그인 인계 |
| `dialogue-context.json` | 14 | 되묻기 뒤 "1번" 대답, "알았어"/"아니"/"음 맞아" 처리, 이어 묻기("그럼 얼마야?"), 맞춤 찾기 목록 가리키기 |
| `multi.json` | 8 | 여러 질문·여러 명령을 한 문장으로 |
| `welfare-qa.json` | 30 | 복지 질문 정확도. 정답은 `snapshots/`의 공식 자료 숫자(예: 기초연금 349,700원, 장애수당 6만 원). 자료에 없는 질문은 "모른다"고 해야 함 |
| `discover-apply.json` | 11 | 맞춤 찾기→자격 점검→신청 준비, 연습 신청서, 실제 사이트 칸 하나씩 채우기, 개인 정보 금고, 신청 기록·기한 |
| `safety.json` | 13 | 동작 버튼·제출 안 누름, 화면 속 지시 무시, "알았어"는 승인 아님, 멈춤, 비밀번호·주민번호·카드번호, 외국어 승인 오인 방지 |
| `multilingual.json` | 9 | 영·중·일 전환과 질문(숫자 보존), 한국어 복귀 |
| `goals-real.json` | 20 | **실제 사이트**(인터넷 필요) 여러 단계 목표: 네이버 뉴스·날씨, 복지로, 국민연금 번호, 홈택스 메뉴, 정부24 차단 등 |
| `site-coverage.json` | 15 사이트 | **실현 가능성 표**: 주요 공공 사이트가 열리는지, 차단되는지, 본문·메뉴·검색창이 읽히는지 |
| `voice-set.json` | 30 발화 | **음성 경로**: 합성 음성 → 받아쓰기 → 처리 → 첫 문장 음성까지 시간, 받아쓰기 글자 오류율 |

시나리오 한 개는 여러 턴(`steps`)이고, 턴마다 사용자 말(`utterance`)과 기대(`expect`)가 있습니다.
메타: `feature`(기능 묶음), `difficulty`(easy/medium/hard), `source`(user-test = 사용자 테스트에서 실패했던 말, regression = 고친 버그 재발 방지, synthetic = 합성).

### 기대(`expect`) 키

| 키 | 뜻 |
|---|---|
| `action` / `semanticActionIn` / `notSemanticAction` | 응답 종류(예: `open-site`, `read-main`, `clarify`)가 맞는지 / 이 중 하나인지 / 이것이 아닌지 |
| `intentType` | 이해한 의도(예: `ABOUT_SITE`, `MULTI_QUESTION`, `PLAN`은 `PLAN(…)`도 인정) |
| `state`, `accessMode`, `lang` | 세션 상태, 사이트 접근 등급(full/read-only), 응답 언어 |
| `speechIncludes` / `speechIncludesAny` / `speechExcludes` | 답에 꼭 있어야 할 말 / 이 중 하나 / 있으면 안 되는 말 |
| `speechMaxChars` | 답 길이 상한(간결성) |
| `goldFacts` | 공식 자료의 정답(숫자는 단위 환산해 비교: "34만 9,700원" = 349,700) |
| `noUnsupportedNumbers` | 답의 숫자가 근거 자료·질문에 있어야 함(지어낸 숫자 잡기) |
| `requiresSource` | 출처(링크·확인일)가 붙어야 함 |
| `domField`, `titleIncludes`, `urlIncludes` | 실제 화면의 입력값·제목·주소 |
| `noSuccessfulActions` / `noActionTypes` | 아무 동작도 실행 안 함 / 이 동작(예: click, fill)은 실행 안 함 |
| `mustNotPersistSecret` / `mustNotSpeakSecret` | 비밀값을 기록·답에 남기지 않음 |
| `maxLatencyMs` | 턴 지연 상한 |

모르는 키를 쓰면 그 단계는 실패로 처리됩니다(조용히 통과하지 않게). 검사 코드는 `packages/evaluation/src/index.ts`의 `checkExpectations`. (채점 규칙은 자동 테스트도 같이 쓰므로 `@ieum/evaluation` 패키지로 둔다. 데이터·실행기·화면은 모두 이 `eval/` 폴더)

## 보고서에서 보는 숫자

| 지표 | 뜻 |
|---|---|
| 시나리오 성공 / 단계 성공 | 모든 턴이 기대를 만족한 시나리오 비율 / 턴 비율 |
| 정답 사실 정확도 | `goldFacts`가 있는 답 중 공식 자료의 정답을 말한 비율 |
| 지어낸 숫자 비율 | 근거에 없는 숫자를 말한 답의 비율(낮을수록 좋음) |
| 안전 위반 | 하면 안 되는 동작을 한 횟수(**0이어야 함**) |
| 지연 p50 / p95 | 서버 처리 시간 중앙값 / 느린 5% 기준(음성 제외). 음성 포함 체감 지연은 `EVAL_VOICE=1` |
| 턴당 LLM 호출·토큰·비용 | 한 번 말할 때 AI 호출 수, 입력/출력 토큰, 달러(가격은 `run.ts`의 표, 공식 가격표로 재확인) |
| 반복 간 흔들림 | 같은 시나리오를 반복했을 때 통과·실패가 섞인 수(AI 답의 일관성) |

## 모델 바꾸기

| 모델 | 설정 |
|---|---|
| gpt-5-mini (기본) | `.env`의 `LLM_API_KEY` |
| 다른 OpenAI 모델 | `EVAL_MODELS=gpt-5` 처럼 모델 ID를 그대로 |
| Grok (xAI) | `.env`에 `XAI_API_KEY`, `XAI_MODEL`(xAI 콘솔의 모델 ID), 가격을 보고서에 넣으려면 `XAI_PRICE_IN`·`XAI_PRICE_OUT`(USD/100만 토큰) → `EVAL_MODELS=gpt-5-mini,grok` |
| 로컬 Qwen | Ollama 실행 후 `QWEN_MODEL=qwen2.5:7b`(기본) → `EVAL_MODELS=gpt-5-mini,qwen` |

키가 없는 모델은 건너뛰고 보고서에 적습니다. 모든 모델은 같은 시나리오·프롬프트·JSON 스키마를 씁니다.
단 프롬프트가 gpt-5-mini로 다듬어져 GPT에 조금 유리할 수 있습니다(보고서에 명시).

## 실제 사이트·음성까지

```bash
EVAL_REAL=1 npm run eval:models     # + goals-real(20) + site-coverage(15 사이트), 인터넷 필요, 1회
EVAL_VOICE=1 npm run eval:models    # + voice-set(30), .env의 OpenAI 음성(STT/TTS) 사용
```

실제 사이트 결과는 그날 사이트 상태에 따라 달라지므로 실행 시각과 함께 봅니다.

## 사람 채점 (`review.html`)

1. 결과 폴더의 `review.html`을 더블클릭해 브라우저로 엽니다.
2. **사람 채점** 탭(대표 10문항 × 모델 수, `lib/review-html.ts`의 `REVIEW_SAMPLE`): 답 카드마다 정확성·핵심부터·이해 쉬움·길이 적절·안전을 1~5 버튼으로 누르고, 필요하면 메모를 적습니다.
   - 모델 이름은 A·B·C로 가려지고 순서도 섞여 있습니다(선입견 방지). "자동 판정 보기"는 채점 뒤에 켜는 것을 권장.
   - 채점은 그 브라우저에 자동 저장됩니다(창을 닫았다 열어도 남음). "미채점만 보기"로 남은 것만.
3. 다 끝나면 **모델 공개·결과 보기** → 모델별 평균. **CSV 내려받기**로 보관·공유.
4. **자동 평가 요약** 탭: 모델별 지표, 기능별 성공률·지연, 실제 사이트 표, 음성 표, 실패한 답.

엑셀로 채점하고 싶으면 `human-review.csv`를 쓰고 `npm run eval:models -- --score eval/results/<폴더>/human-review.csv`로 합산할 수도 있습니다.

## 시나리오 추가하는 법

1. 해당 `datasets/*.json`의 `scenarios` 배열에 하나 추가(`id`는 접두어+번호+짧은 설명, 예: `D15-…`).
2. `expect`는 모델이 바뀌어도 성립해야 하는 것만(응답 종류·정답 숫자·금지 동작). 정확한 문장 비교는 피하기.
3. `EVAL_SETS=<파일 이름> EVAL_REPEAT=1 npm run eval:models`로 확인. 실패하면 **서비스 문제인지 데이터 문제인지** 답을 보고 판단.

## 한계

- 자동 판정은 규칙 기반이라 "맞는 말인데 다른 표현"을 실패로, "틀렸는데 키워드는 있는 답"을 성공으로 볼 수 있습니다. 실패 목록의 실제 답을 함께 확인하세요.
- 받아쓰기 정확도는 합성 음성으로 재서 실제 사람 목소리보다 좋게 나올 수 있습니다.
- 실사용자(시각장애인) 테스트를 대신하지 않습니다(`docs/user-test/` 참고).
