# 아키텍처 그림 ↔ 실제 구현 대조

`docs/architecture.png`의 상자마다 지금 코드에 있는지 확인한 결과입니다. ✅ 구현 · ◐ 일부 · ❌ 아직 없음

| 영역 | 그림의 항목 | 상태 | 실제 구현(위치) |
|---|---|---|---|
| ① 입력 | 음성 입력(주) | ✅ | 핸즈프리 VAD 루프·끼어들기·전역 단축키 (`web/static/mic.js`, `apps/desktop`) |
| | 텍스트 입력(선택) | ✅ | 웹 UI 입력란 |
| | STT | ✅ | OpenAI `gpt-4o-mini-transcribe`, 또는 `STT_PROVIDER=local`: 한국어는 이 컴퓨터 안(faster-whisper + `whisper-small-komixv2`, `voice/stt_local.py`)·다른 언어는 OpenAI. 평가 `scripts/eval_stt.py` |
| | 현재 웹페이지 맥락(DOM·접근성 트리·URL) | ✅ | 관찰 스크립트 `observe.js` (`agents/web/browser/`) |
| ② 의도 이해 | LLM 의도 분석(의도·과업 추출·대화 맥락) | ✅ | 규칙 파서 먼저 → LLM(`gpt-5-mini`) 보조, 직전 안내·최근 8발화 맥락 (`understanding/rules.py`, `llm_planner.py`) |
| ③ AI 오케스트레이터 | 복합 요청 분해 | ✅ | 여러 명령 계획(`_run_plan`), 여러 질문 나누기(`_answer_many`) (`orchestrator/session.py`) |
| | 에이전트 선택·조율 | ✅ | `_route()` → Agent A 기술(`agents/web/skills/`) / Agent B, B→A 인계 |
| | 작업 상태·기억 | ✅ | 대화 상태(승인·값 대기·되묻기 등, `core/dialogue.py`) + 읽기 위치 + 금고·신청 기록 파일(`personal/store.py`) |
| | 에이전트 결과 통합 | ✅ | 여러 단계 결과를 한 번에 요약해 말함 |
| ④ Agent A 웹 탐색·실행 | 페이지 분석(DOM/AX 트리) | ✅ | 화면 이해 담당 `agents/web/digest.py` |
| | 브라우저 자동화(Playwright) | ✅ | `agents/web/browser/` (설치된 크롬 영구 프로필 / 크로미움) |
| | 동작 실행(클릭·입력·이동) | ✅ | `agents/web/agent.py` → PolicyGuard → 실행 → 재관찰 |
| | 오류 감시·복구 | ◐ | 시간 초과 1회 재시도, 팝업 처리, 링크를 글자·주소로 대체, 목표 수행 중 다른 방법 시도. 일반 복구 전략은 제한적 |
| 정보·작업 상태 공유 | | ✅ | 오케스트레이터 공통 작업 상태, B→A 인계 계약 |
| ④ Agent B 복지 정보·대화 | RAG | ✅ | `agents/welfare/rag.py` (Recall@3·MRR 평가) |
| | **벡터 데이터베이스** | ❌ **그림과 다름** | 벡터 DB·임베딩 없음. 공식 자료를 항목 조각으로 나눠 **한국어 2-gram + 항목 힌트로 검색**(제도 하나의 문서 안에서 찾기라 충분히 정확). 제도 수가 늘면 벡터 검색 도입 검토 |
| | 공식 공공 데이터(복지) | ✅ | 한국사회보장정보원 중앙부처 API + 지자체 목록 (`agents/welfare/data/`) |
| | 자격 분석 | ✅ | 맞춤 찾기·자격 미리 점검(판정 안 함) (`agents/welfare/discovery.py`) |
| | 근거 기반 설명·대화 | ✅ | 근거 안에서만 답하고 출처(복지로 링크·기준연도·확인일) 표시 |
| ⑤ 실행 검증·안전 | 정보 검증(공식 출처 근거) | ✅ | 검증 담당 `safety/verify.py`(근거 인용·숫자 대조) + RAG 근거 id 검사 |
| | 실행 검증(성공 확인) | ✅ | 실행 후 재관찰·입력값 다시 읽기 |
| | 안전·오류 처리(재시도·대체) | ◐ | PolicyGuard 차단, 멈춤 즉시 처리, 제한적 재시도(위 오류 복구와 같음) |
| | 사용자 확인(민감 동작 전) | ✅ | 승인된 액션 ID 없이는 실행 불가, 실제 제출·로그인·인증은 사람에게 |
| ⑥ 접근성 출력 | TTS(단계별·맥락 맞춤 음성 안내) | ✅ | OpenAI `gpt-4o-mini-tts` 또는 OS 내장 음성, 핵심부터 짧게 |
| | 접근성 텍스트(선택, 화면낭독기 친화) | ✅ | `aria-live` 대화 기록·상태 알림 (`web/static/`) |
| 지속 개선 피드백 | | ◐ | 비식별 이벤트(동작·성공·오류 종류) 기록. 자동 반영은 없음 |
| 평가 파이프라인 | 작업 성공률 | ✅ | `scripts/run_scenarios.py`, `scripts/eval_agent.py` |
| | RAG 정확도(Recall/MRR) | ✅ | `scripts/run_scenarios.py` |
| | 응답 지연 | ✅ | 서버 처리 p50·p95(음성 제외) |
| | 접근성 준수(WCAG) | ✅ | axe 자동 검사 |
| | 사용자 테스트 | ❌ | 계획·과제·동의서·기록지만 준비(`docs/user-test/`), 실시행 0명 |
| | 기준선 비교 | ❌ | 사용자 테스트 계획에 포함(평소 화면낭독기 조건과 비교) |

## 구현됐지만 그림에 없는 것

- **화면 이해 담당**(Agent A)·**검증 담당**(A·B 공통)이라는 이름의 역할 — 그림에는 "페이지 분석", "정보 검증"으로 들어가 있음
- **목표 수행(자율)** — 관찰 → 다음 행동 결정 → 실행을 최대 10단계·75초 반복 (`agents/web/autopilot.py`)
- **PolicyGuard 접근 등급** — 지원 사이트(전체) / 그 밖(읽기 전용) / 차단
- **개인 정보 금고·신청 기록·기한 알림**, **다국어 번역 계층**, **데스크톱 백그라운드 앱**

## 그림 수정 제안

- Agent B의 "Vector Database" → "Keyword Index(2-gram)" 또는 "Official Data Index"로 바꾸면 실제와 맞음
