# 청음 — 정보취약계층 공공서비스 신청 완주 음성 에이전트

고령층·장애인·저소득층·농어민·결혼이민자 등 정보취약계층이 **말로** 웹을 읽고 찾고, 복지로 같은 공공 사이트에서 **신청을 끝까지 하도록** 돕는 PC 음성 에이전트입니다.
화면을 보지 않고 소리만으로도 끝까지 쓸 수 있어 시각장애인도 쓸 수 있습니다.
신청을 몰래 대신 해 주는 것이 아니라, 화면과 사람 사이를 통역하고 **중요한 동작은 확인받고, 제출·로그인·본인인증은 사람에게 넘깁니다.**

**Windows에서 쓰려면** GitHub Releases에서 `Cheongeum-Setup-버전.exe`를 받아 실행하세요. 설치할 때 관리자 권한 사용 여부를 선택하고, 시작 메뉴에서 **청음**을 여세요. 첫 실행에서 대화 언어와 개인·공용 기기 여부를 고르고, OpenAI API 키를 확인한 뒤 소리와 말 빠르기를 맞춥니다. 브라우저는 설치본에 포함됩니다. 새 버전이 나오면 앱에서 다운로드와 설치 시점을 고를 수 있습니다. [릴리스](https://github.com/davemaxuell/voice-welfare/releases) · [설치와 첫 사용](docs/install.md)

청음은 Node.js 24 이상의 TypeScript 서비스입니다. Hono 서버가 대화와 브라우저 조작을 처리하고 React 화면을 제공합니다. 데스크톱 앱은 같은 서비스를 Electron의 Node 프로세스에서 실행합니다.

- 아키텍처 그림과 구현 대조: [`docs/architecture-check.md`](docs/architecture-check.md)
- [정보취약계층을 위한 OpenBot 활용 조사와 구현 계획](docs/openbot/README.md)
- [데스크톱 UI 인수인계](docs/desktop-ui-handoff.md) · [파일럿 검증 결과](docs/pilot-engineering-results.md)

![아키텍처](docs/architecture.png)

---

## 1. 지금 되는 것 (말 예시)

| 기능 | 이렇게 말하면 | 하는 일 |
| --- | --- | --- |
| **아무 사이트 열기·읽기** | "네이버 열어줘", "화면 설명해줘", "본문 읽어줘", "계속 읽어줘", "링크 목록 알려줘" → "3번", "뒤로 가줘", "이 사이트 뭐야?" | 브라우저로 열고, 메뉴 글자 대신 **본문 요점부터** 짧게 말함. 받아쓰기 오타("네이보", "Naver")도 알아들음 |
| **목표 수행(여러 단계 자동)** | "네이버에서 오늘 주요 뉴스 알려줘", "국민연금공단 사이트에서 고객센터 번호 찾아줘" | 관찰 → 다음 행동 결정 → 실행을 최대 10단계 반복(읽기·이동·검색만). 답은 화면 근거가 확인될 때만 말함 |
| **복지 질문(공식 데이터)** | "기초연금은 몇 살부터 받아?", "그럼 얼마야?", "몇 살부터고 얼마 받아?" | 한국사회보장정보원 공식 API 원문을 근거로만 답함. 없으면 "찾지 못했어요" |
| **맞춤 복지 찾기** | "나한테 맞는 복지 찾아줘" → 나이·장애·소득·지역 → "1번 자세히", "1번 자격 확인해줘" | 중앙·지자체 목록과 공공데이터포털의 민간 사업 자료에서 후보를 찾습니다. 민간 사업은 따로 표시하고 원자료의 기관·기준일·신청 방법을 안내합니다. |
| **기관 위치와 전화번호** | "강남구 개포동 주민센터 어디야?", "서대문구 국민연금 지사 전화번호 알려줘" | 내려받은 공식 주소록으로 답합니다. 후보가 여럿이면 지역을 다시 묻습니다. 교통약자 이동지원센터는 해당 자료를 추가한 뒤 이용할 수 있습니다. |
| **신청 시작** | "기초연금 신청 도와줘" | 공식 안내 페이지를 열고 요점 한 줄. 본문은 지원 대상 → 서비스 내용 → 신청 방법 순서로 읽음 |
| **실제 사이트 칸 채우기** | "입력 칸 하나씩 채워줘" → "홍길동" / "응" / "건너뛰기" / "그만" | 칸을 하나씩 묻고 넣은 뒤 화면 값을 다시 읽어 확인. 비밀번호·인증·동의 칸 제외, **제출 버튼은 누르지 않음** |
| **개인 정보 금고** | "내 이름은 김하늘이고 주소는 …라고 저장해줘", "내 정보 알려줘/지워줘" | 확인 후 이 컴퓨터에만 저장(이름·주소·연락처·이메일·생년월일만) |
| **보호자 문자** | "보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘", "보호자한테 연락해줘", "보호자 연락처 지워줘" | 보호자의 수신 동의를 확인하고 등록합니다. 도움 요청 때마다 받을 분과 문구를 읽고 '네'를 기다립니다. 기본은 모의 발송이며 긴급 신고 기능은 없습니다. |
| **신청 후 추적** | "기초연금 신청했어, 접수번호는 …", "보완 서류는 12월 3일까지래", "신청한 거 어떻게 됐어?" | 신청·기한을 기억, 기한 3일 전부터 알림 |
| **로그인 인계** | "로그인 눌러줘, 그 뒤는 내가 할게" | 로그인 페이지 링크까지만 열고 사람에게 넘김 |
| **연습용 신청서** | "장애인연금 연습 신청 도와줘" | 모의 신청서에서 입력·검증·요약·승인 후 모의 접수(실제 전송 없음) |
| **다국어** | "영어로 말해줘", "Speak English", "说中文", "日本語で話して", "Korean please" | 그 언어로 듣고 답함(LLM 필요). 한국 고유 용어는 원어와 짧은 풀이 |
| **멈춤·대화 습관** | "멈춰"(stop/停止/止めて), "알았어", "아니", "쉽게 말해줘" | 멈춤은 무엇보다 먼저 즉시. 맞장구·부정은 입력값으로 넣지 않음 |

## 2. 소스에서 실행하기

Node.js 24 이상에서 저장소 루트로 이동해 다음 명령을 실행하세요.

```bash
npm ci
npx playwright install chromium
npm start
```

`npm start`는 Vite로 웹 화면을 빌드한 뒤 http://localhost:8787 에서 웹 UI와 API를 함께 엽니다. 모의 신청 사이트도 http://localhost:5174 에서 시작합니다. 외부 사이트의 읽기 전용 동작은 http://127.0.0.1:5174/external.html 에서 연습할 수 있습니다.

- 화면을 편집할 때는 서버를 켜 둔 채 다른 터미널에서 `npm run dev:web`을 실행하고 Vite가 표시한 주소를 여세요.
- 모의 사이트만 필요하면 `npm run mock`을 사용하세요. 서버가 이미 모의 사이트를 실행 중이면 그 주소를 사용하세요.

첫 실행 설정을 마치려면 OpenAI API 키가 필요합니다. 한국어를 포함한 모든 언어의 대화·받아쓰기·음성 안내에는 음성 API를 사용합니다. 기본 안내 속도는 1.35배입니다. 개발 중에는 API 키 없이 규칙 기반 처리와 저장된 복지 자료를 테스트할 수 있습니다.

**데스크톱 앱(Electron)** — 기본 백그라운드(창 없이 트레이 '청음', Cmd/Ctrl+Shift+Space = 말하기·동의)

```bash
npm run start:desktop
```

개발 모드에서는 `CHEONGEUM_SHOW_WINDOW=1`로 대화 창을 처음부터 열 수 있고, `PRACTICE_MODE=true`로 연습 사이트를 기본으로 쓸 수 있습니다. 설치본에는 실행에 필요한 Node 런타임과 Chromium이 포함됩니다. 앱을 종료하면 서비스가 세션과 브라우저를 정리합니다. [설치 파일 빌드](docs/install.md#설치-파일-만들기)

“이 부분이 무슨 뜻이야?”라고 하면 청음은 먼저 선택한 글이나 가리킨 항목, 페이지 본문에서 답을 찾습니다. 글만으로 답할 수 있으면 사진을 찍지 않습니다. 차트의 색이나 그림 속 안내처럼 눈으로 확인해야 할 때는 현재 탭의 전체 페이지 사진을 가려서 본문, 질문, 개인정보를 걸러 낸 최근 요청 최대 세 개와 함께 OpenAI 시각 모델에 보냅니다. “사진 없이 화면 설명해줘”라고 하면 글로 확인할 수 있는 내용만 설명합니다.

“스크린샷으로 차트의 추세를 알려줘”처럼 사진에 대해 직접 물을 수도 있습니다. 청음은 지연 로딩되는 내용을 불러오고 전체 페이지를 한 장으로 촬영한 뒤 스크롤 위치를 복원합니다. 입력란과 내장 문서, 감지된 민감정보를 가립니다. 그림에 포함된 개인정보는 남을 수 있습니다. 사진만 보고 읽은 숫자는 따로 알려 줍니다. 끝없이 늘어나거나 이미지 크기 한도를 넘는 페이지에서는 촬영을 중단합니다.

<details>
<summary>그 밖의 설정(.env)</summary>

사이트에서 파일을 받은 뒤 “받은 파일 요약해줘” 또는 “받은 PDF에서 신청 기한이 언제야?”라고 물을 수 있습니다. 청음은 파일 이름과 전송할 곳을 읽고 매번 확인을 받습니다. PDF·PNG·JPEG·WebP는 파일 전체를, HWPX는 추출한 본문을 보냅니다. 파일당 20MB, PDF 100쪽, HWPX 본문 12만 자까지 지원합니다. “받은 파일 읽어줘”는 PDF·HWPX의 글을 이 컴퓨터에서 읽습니다.

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_REASONING_EFFORT` | 키가 있으면 `openai`, 없으면 규칙 | 기본 업무 모델은 `gpt-6.2-sol`. 호환 서버는 `openai-compatible` 또는 `qwen`과 서버 주소·모델을 지정합니다. 루프백 호환 서버는 키 없이 연결할 수 있습니다. |
| `LLM_UNDERSTAND_MODEL`, `LLM_GOAL_MODEL`, `PUBLIC_SERVICE_ROUTER` | 새 OpenAI 설정에서는 `gpt-6.2-sol`, 라우터 켜짐 | 요청 이해와 탐색 계획에 사용합니다. 직접 지정한 모델이 우선합니다. `PUBLIC_SERVICE_ROUTER=false`로 이전 경로를 선택할 수 있습니다. |
| `LLM_VISION_MODEL`, `LLM_VISION_DETAIL` | `gpt-6.1-terra`, `high` | 화면 사진 설명과 사용자가 허용한 시각 탐색에 사용합니다. |
| `LLM_WEB_MODEL`, `LLM_RECOVERY_MODEL` | `gpt-6-luna`, `gpt-6.2-astra` | 짧은 요약·재표현과, 근거 확인에 반복해서 실패한 업무의 재계획을 맡습니다. |
| `LLM_FILE_PROVIDER`, `LLM_FILE_MODEL`, `LLM_FILE_BASE_URL`, `LLM_FILE_API_KEY`, `LLM_FILE_REASONING_EFFORT` | 각각 기본 LLM 설정 | 파일 분석은 `openai`에서 사용합니다. PDF와 이미지를 지원하는 상위 모델 ID를 `LLM_FILE_MODEL`에 지정하세요. 시간 제한은 120초입니다. |
| `OPENAI_API_KEY`, `VOICE_API_KEY`, `VOICE_LIVE_MODEL` | 키 없음, `gpt-live-1` | 대화 모드의 WebRTC 음성 모델. 한 번씩 말하는 받아쓰기에는 `gpt-live-transcribe`를 사용합니다. |
| `STT_MODEL` | `gpt-transcribe` | 사용자가 직접 선택한 녹음 파일을 받아씁니다. |
| `CHEONGEUM_DATABASE_URL` | 로컬 SQLite | PostgreSQL 연결 문자열을 지정하면 개인 기기의 백그라운드 조사와 명시적으로 저장한 메모를 PostgreSQL과 pgvector에 보관합니다. |
| `PII_MODEL`, `PII_THRESHOLD` | 경로 없음, `0.5` | 개인정보는 먼저 규칙으로 찾습니다. `npm run setup-models`로 받은 `models/koelectra-ko-pii-ner`를 지정하면 이 PC에서 ONNX 모델의 탐지 결과도 함께 가립니다. |
| `TTS_MODEL`, `TTS_VOICE`, `TTS_SPEED`, `TTS_INSTRUCTIONS` | `gpt-4o-mini-tts`, `coral`, `1.35` | API 음성 안내와 기본 빠르기 |
| `WELFARE_DATA_MODE`, `WELFARE_API_KEY`, `WELFARE_API_BASE_URL` | fixture | `official-api`면 공식 API(실패 시 fixture) |
| `DATASETS_DIR` | 패키지에 포함된 주소록·민간 사업 자료 | 별도 스냅샷 폴더를 지정할 수 있습니다. 서버가 시작할 때 한 번 읽습니다. |
| `PRACTICE_MODE` | 서버 `true` / 데스크톱 `false` | `false` = 실제 사이트 모드 |
| `CHEONGEUM_DATA_DIR` | 데스크톱 `~/.cheongeum` | 개인 PC에서 금고·신청 기록(`personal.json`)을 암호화해 보관합니다. |
| `GUARDIAN_SMS_PROVIDER` | `mock` | `mock`은 문자 미리보기입니다. `solapi`는 승인 후 실제 유료 SMS 한 건을 요청합니다. |
| `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SOLAPI_SENDER_NUMBER` | — | 실제 SMS 사용 시 API 자격 증명과 SOLAPI에 등록한 발신번호를 설정합니다. 보호자는 이 서비스 번호로 문자를 받습니다. [SOLAPI 발송 API](https://solapi.com/developers/api/messages) |
| `REQUIRE_CONSENT` | `true` | 동의 전에는 화면·음성을 쓰지 않음 |
| `BROWSER_MODE`, `CHROME_PROFILE_DIR` | `chromium`, `~/.cheongeum/chrome-profile` | `chrome` = 설치된 크롬 + 영구 프로필 |
| `HEADLESS`, `VISUAL_CURSOR`, `BROWSER_SLOWMO_MS` | 창 보임, 창이 보이면 켬, `0` | 시연용 |
| `READ_ONLY_WEB`, `WEB_SEARCH_URL` | `true`, 네이버 | 지원 사이트 밖은 읽기 전용, 검색 주소 틀(`{q}`) |
| `TAVILY_API_KEY` | 선택 | 공휴일 등 공개 정보는 창을 열지 않고 검색해 대화에서 바로 답합니다. 공개 검색어만 Tavily에 전송합니다. 사이트를 열거나 화면에 보여 달라는 요청은 브라우저에서 실행합니다. |
| `READ_ONLY_CLICKS` | `safe` | 읽기 전용 사이트에서는 링크, 동작 이름이 아닌 탭, 위험한 이름이 없는 버튼만 허용합니다. `any`는 합성 환경에서 정책을 비교할 때 선택할 수 있습니다. |
| `PILOT_PROFILE` | `unidentified` | 확인된 개인 OS 프로필은 `personal`로 실행하고 시작 화면에서 같은 탭 복구를 선택할 수 있습니다. `shared`와 미확인 프로필은 세션별 임시 금고와 격리된 브라우저를 사용합니다. |
| `PORT`, `DESKTOP_PORT` | 개발 서버 `8787`, 개발 앱 `8790` | 설치본은 이전 로컬 포트를 다시 쓰고, 사용 중이면 빈 포트를 선택합니다. |
| `EVAL_STT_RECORDINGS` | `recordings/` | `npm run eval-stt`에 사용할 녹음 폴더입니다. |

</details>

공공데이터포털 자료는 `node scripts/sync-datasets.ts --check`로 기준일과 행 수를 확인하고, `node scripts/sync-datasets.ts`로 갱신합니다. 교통약자 이동지원센터 CSV는 `--csv 15028207=centers.csv --reference-date 15028207=YYYY-MM-DD`로 추가합니다. 갱신 후 서버를 다시 시작하세요. [민간복지서비스](https://www.data.go.kr/data/15116392/fileData.do) · [읍면동 기관](https://www.data.go.kr/data/15059715/fileData.do) · [국민연금 지사](https://www.data.go.kr/data/15010814/fileData.do) · [교통약자 이동지원센터](https://www.data.go.kr/data/15028207/standard.do)

## 3. 폴더 구조 (파이프라인 단계별)

①~⑥은 `docs/architecture.png`의 상자 번호입니다.

```text
src/
  voice/             ①⑥ 실시간·파일 받아쓰기와 음성 합성 API
  understanding/     ②  의도 이해, 빠른 규칙, LLM 계획, 대화·사이트 이름 해석
  language/          ②⑥ 다국어 번역과 숫자 보존
  orchestrator/      ③  턴 순서, 동의·멈춤, 공공업무 판단과 인계
  agents/web/        ④  화면 요약, 사이트 프로필, 목표 수행
    skills/               읽기·탐색·단계별 입력·승인 후 모의 접수
    browser/              Playwright 실행과 페이지에 주입하는 관찰·가림·커서 함수
  agents/welfare/    ④  복지 자료 검색·맞춤 찾기, data/ 공식 API·샘플, open_data/ 공공자료
  safety/            ⑤  정책, 동의·멈춤, 민감정보 가리기, 근거 확인
  speech/            ⑥  조사·날짜·항목 이름 읽기와 화면 설명
  personal/              개인 금고, 신청 기록과 기한, 보호자 연락
  core/                  액션·관찰·의도·응답 스키마, 대화 상태, 모델 연결, 비식별 이벤트
  server/                Hono API, WebSocket, 런타임과 저장소
  practice_site/         모의 신청 사이트와 정적 서버
  evaluation/            평가 지표와 고정 시나리오(data/demo_scenarios.json)
web/                 ①⑥ React 대화 화면, 마이크와 음성 출력, 아바타 화면과 자산
apps/desktop/src/    Electron 창, 트레이, IPC와 로컬 서비스
scripts/             시나리오·음성·목표 수행 평가, 데이터 갱신, 모델 준비
tests/unit, tests/e2e   Vitest 단위 테스트와 실제 Chromium E2E
tests/fixtures/      고정 API 응답, 브라우저 관찰 결과, 대화·정규식 비교 자료
docs/                기획 요약, 사용자 테스트 자료, stt-eval/ 받아쓰기 평가 문장
models/, recordings/ 개발용 개인정보 모델과 평가 녹음(git 제외)
```

## 4. 동작 구조

```text
대화 모드 ↔ GPT-Live (음성 대화)
               └─ 작업 위임 ID + 해당 발화 ─┐
한 번 말하기 · 직접 입력 ──────────────────┴→ 세션 · 민감정보 확인 · 즉시 멈춤
  ├─ 동의·승인·인증·명확한 조작 → 해당 기능
  └─ 공공서비스 질문 → 원래 언어로 업무·기관·필요한 사실·제외 조건 해석
       ├─ 불분명한 선택 → 한 가지 질문 → 답변·정정과 앞선 맥락으로 다시 판단
       └─ 확인된 업무 → 복지 자료·공공기관 목록 또는 공식 웹 탐색
            → 관찰된 근거 대조 → 확인한 항목과 남은 항목 → 사용자 언어로 안내
```

- **공공업무 대화**는 한국어·영어·중국어·일본어의 원문을 처리합니다. 같은 업무로 이어지는 질문은 기관, 문서, 로그인 제외 같은 조건을 유지합니다. 멈춤과 승인은 세션이 직접 처리합니다. [구현과 검증 기준](docs/public-service-agent-architecture.md)
- **화면 이해 담당**(규칙): 페이지를 종류·본문·내용 링크·메뉴·할 수 있는 일로 정리해 AI 입력을 줄임.
- **검증 담당**(규칙): 말하기 전에 근거 문장이 실제 화면·자료에 있는지, 숫자가 맞는지 대조.
- 액션·관찰·의도·응답은 camelCase JSON으로 주고받습니다. 서버는 경계에서 Zod 스키마로 검증하고, 웹과 데스크톱 화면이 같은 API를 사용합니다.

## 5. 안전 원칙

- **제출·로그인·본인인증은 사람이**: 실제 사이트에서 제출 버튼을 누르지 않고, 입력은 사용자가 말한 값·확인한 값만.
- **PolicyGuard**: 지원 사이트 밖은 읽기 전용(링크·이동·검색). 신청·결제·동의 같은 동작 버튼과 비밀번호 칸은 항상 차단.
- **민감정보**: 비밀번호·주민번호·계좌·카드 번호는 처리 전에 `[비공개]`로 가려 기록·모델 입력·응답에 남지 않음.
  규칙은 한글로 읽은 숫자("일이삼사"), 낱말 비밀번호("비밀번호는 사과나무야"), 외국어 키워드(password·密码·パスワード)도 잡고, `PII_MODEL`이 있으면 로컬 개인정보 인식 모델과 함께 봄(둘 중 하나라도 걸리면 막음).
  로그인 화면·본인인증 중·직전에 비밀번호를 언급한 뒤의 짧은 낯선 말은 비밀값일 수 있어 LLM·기록에 넘기지 않음. 외국어 비밀값은 번역 전에 막음.
- **음성**은 등록한 키로 API에 전송합니다. 청음은 녹음을 저장하지 않습니다.
- **화면 글은 신뢰하지 않음**: 페이지 속 지시를 따르지 않음(E2E로 확인). 보안문자·접속 차단은 우회하지 않고 알림.
- **동의 먼저**: 동의 전에는 화면을 읽거나 음성을 외부로 보내지 않음. 녹음은 저장하지 않음.

## 6. 테스트·평가

| 명령 | 내용 |
| --- | --- |
| `npm run typecheck` / `npm run lint` | TypeScript 타입과 코드 규칙을 검사합니다. |
| `npm run test:unit` / `npm run test:e2e` | 단위 테스트와 실제 Chromium 테스트입니다. 로컬 모델 테스트에는 `models/` 자료가 필요합니다. |
| `npx vitest run --project unit tests/unit/parser.test.ts` | 파일 하나를 실행합니다. `-t "이름"`을 덧붙이면 테스트 이름으로 고릅니다. |
| `node scripts/eval-pictures.ts` | 합성 화면 10개를 로컬 브라우저와 모의 응답으로 확인합니다. `--live`를 붙이면 허용된 7개 화면을 실제 OpenAI에 보내며 요금이 발생할 수 있습니다. 결과는 `reports/picture-qa-*.json`에 저장합니다. |
| `npm run eval` | 시나리오 35개, 입력·승인·안전 지표, RAG Recall/MRR와 접근성(axe) 결과를 `reports/evaluation-report.md`에 씁니다. |
| `npm run eval-agent` | 설정한 탐색 모델로 모의·실제 사이트의 목표 수행 과제를 평가해 `reports/agent-qa.md`에 씁니다. |
| `npm run check-llm` / `npm run check-voice` / `npm run check-welfare` | `.env`에 설정한 실제 모델·음성·복지 API 연결을 각각 확인합니다. |
| `npm run eval-stt` | 문장 목록(`docs/stt-eval/sentences.csv`)과 짝이 맞는 녹음(`recordings/<id>.webm` 등)을 음성 API에 보내 오류율, 명령·숫자·멈춤·무음 처리와 지연을 평가합니다. 결과는 `reports/stt-eval.md`에 저장합니다. |

**실사용자 테스트는 아직 0명**입니다(`docs/user-test/`에 1차 시각장애인 대상 계획·과제·동의서·기록지 준비, 다른 집단은 아직 계획 없음).

## 7. OpenAI 이용 비용

대화 모드는 GPT-Live 세션 시간에 따라 과금됩니다. 공공서비스 탐색을 위임하면 실제 호출된 업무 모델 비용이 추가됩니다. 녹음 파일 받아쓰기와 별도 음성 안내도 각 API 사용량에 따라 과금됩니다. [GPT-Live 모델](https://developers.openai.com/api/docs/models/gpt-live-1)

## 8. 알려진 한계

- 실제 접수 상태 자동 조회 없음(로그인 필요).
- 정부24 등 일부 사이트는 자동화 브라우저 접속을 차단(우회하지 않음).
- 끼어들기·말 끝 판단은 마이크·스피커 환경에 따라 다름(단축키가 확실한 대안).
- 외국어 모드는 번역 때문에 턴마다 3~8초 느림. 고정 UI 문구는 한국어.
- 대화와 이벤트는 세션 메모리에 보관합니다. 이용 설정과 금고·신청 기록은 이 PC에 보관하고, 사용자가 선택하면 마지막 공공기관과 업무 이름도 기억합니다.
- 한국어 이름 정렬은 유니코드 순서(ICU 콜레이션 대신) — 한글 음절은 가나다 순서와 같다.
