# 정보취약계층 리브랜딩: 바꿔야 할 곳 전수 조사 (2026-11-18)

청음의 대상이 시각장애인에서 정보취약계층(고령층·장애인·저소득층·농어민·결혼이민자 등)으로 넓어졌다. 이 문서는 그 때문에 바꿔야 하거나 검토해야 할 곳을 모두 모은 것이다. 기능은 아직 바꾸지 않았다.

- 전체 발견 412건(행 단위 목록): `findings.md`, `findings.tsv`
- 조사 방법: 저장소의 파일 677개를 목록으로 만들고(`tools/manifest.py`), 449개는 아래 7절의 이유로 제외했다. 나머지 228개는 10명이 나눠 처음부터 끝까지 읽었다(`tools/BRIEF.md`). `tools/coverage.py`는 228개 모두에 읽음 기록이 있는지 확인한다(현재 통과). 이 검사기는 일부러 넣은 오류 3개를 모두 잡았다.
- "(확인함)"은 조사원 보고를 코디네이터가 코드에서 직접 확인한 항목이다. 표시가 없으면 조사원 보고만 있는 것이다.
- 중요도: must(새 목적과 어긋남) 2건, should(새 대상 일부를 해치거나 빠뜨림) 163건, consider(판단·제품 결정) 247건.

## 1. 아직 시각장애인을 대상으로 적은 글 (ID 36, META 2)

1.1 **must** `docs/bokjiro-data-usage-ko.docx`, `docs/bokjiro-data-usage.docx`의 첫 문장은 "청음은 시각장애인이…", "helps blind and low-vision users"다. (확인함)
1.2 `docs/architecture.png`의 사용자 상자에 "User (Visually Impaired)"라고 적혀 있다. 그림 파일이라 원본에서 다시 그려야 한다. (확인함)
1.3 `docs/install.md`의 22~30행은 설치 단계를 Tab·Enter·NVDA·센스리더·VoiceOver 기준으로만 설명한다. 35행 "앱 본문은 청음 음성 안내와 화면 낭독기를 함께 씁니다"는 모든 사용자가 화면낭독기를 쓰는 것처럼 읽힌다.
1.4 `docs/기획요약.md`에 남은 곳은 다음과 같다.
    - 12행 "기존 도움" 문장이 화면낭독기 이야기뿐이다. 고령층·결혼이민자에게 기존 도움은 가족 대리 입력과 주민센터 방문이다.
    - 15행은 창 없이 단축키로 시작하는 방식을 설계로 소개한다(2.4 참고).
    - 35행은 결혼이민자를 포괄한다고 하지만 베트남어를 지원하지 않는다(3.1 참고).
    - 43행은 직접 재현을 VoiceOver로만 계획한다.
1.5 다음 코드 주석과 docstring은 "화면을 볼 수 없는 사용자"를 전제로 한다. 동작은 맞고 설명만 바꾸면 된다.
    - `orchestrator/session.py:341`, `speech/screen.py:1`, `agents/web/skills/browse.py:238`
    - 가상 커서와 보이는 브라우저를 "시연용"으로만 설명하는 곳: `README.md:90`, `server/runtime.py:45`, `agents/web/browser/__init__.py:49`, `tests/e2e/test_cursor.py:2`. 화면을 보는 고령층에게는 청음이 어디를 누르는지 보여 주는 주된 표시다.
1.6 META 2건:
    - `agents/web/browser/waiting.html:6`은 화면을 "웹 도우미 화면"이라고 부른다. `index.html`의 제목과 맞지 않는다.
    - `docs/architecture-check.md:31`은 화면 글을 "선택, 화면낭독기 친화"로 적었다. 38행의 비교 기준도 화면낭독기 조건 하나뿐이다.
1.7 `src/cheongeum/evaluation/data/demo_scenarios.json:9`의 페르소나는 "시각장애인 이용자(가상)" 하나뿐이다. CLAUDE.md가 수정을 금지하므로 주인이 결정할 일이다. 새 집단은 별도 파일로 추가하는 방법이 있다.
1.8 이번 조사에서 바로 고친 곳은 3개다. 지난번에 바꾼 문구가 "모두 화면을 보지 않는다"로 읽혀서 다시 고쳤다: `CLAUDE.md:58`, `agents/web/autopilot.py:44`, `core/picture.py:91`. 단위 시험 858개는 모두 통과했다.

## 2. 화면낭독기 사용자 기준으로 만든 동작 (ASSUME 31)

바꾸면 동작이 달라지는 곳이다. 화면을 보는, 디지털이 낯선 사용자에게 불리하다.

2.1 **본인인증 인계 뒤 침묵.** `web/static/app.js:361-362`는 안내를 한 번 말한 뒤 `stopSpeaking()`으로 멈춘다. 화면낭독기가 입력 칸을 읽게 하려는 것이다. 화면낭독기가 없는 사용자는 그 뒤 어디에 무엇을 쓰는지 듣지 못한다. 같은 설계가 `CLAUDE.md:41`, `agents/web/skills/browse.py:322`, `agents/web/agent.py:288`에 적혀 있다. (확인함)
2.2 **말 속도.** (확인함)
    - 기본값이 1.25배다: `core/turn.py:282`, `personal/store.py:25`, `web/static/speaker.js:5`.
    - "보통 속도"로 되돌리면 1.25배다(`personal/commands.py:103`). 가장 느린 설정은 0.9배다(`:98`). `personal/dialogue.py:18`은 1.25배를 "보통"이라고 읽어 준다.
    - 서버 TTS는 사용자 속도를 받지 않는다. `speaker.js:110`의 서버 재생과 `api.js:35`는 속도를 보내지 않고, `voice/tts.py:50`은 프로세스 하나의 `TTS_SPEED`(로컬 `.env`는 1.1)만 쓴다. 그래서 서버 TTS에서는 "천천히 말해줘"가 들리게 바뀌지 않는다.
    - `orchestrator/session.py:908`은 "천천히" 말한다고 하지만 속도는 그대로다.
    - 시험 `tests/unit/test_discovery_personal.py:161`이 1.25를 고정한다.
2.3 **사이트의 글자 크게·언어 버튼을 숨김.** `agents/web/digest.py:61`의 `UTILITY_BUTTON`은 "글자 크게/작게", english, 中文, 언어 선택을 잡음으로 보고 빼낸다. 그래서 목표 수행과 화면 설명에서 이 버튼을 쓸 수 없다. 시험 `tests/unit/test_grounding.py:103`, `tests/e2e/test_navigation.py:34`가 이 동작을 고정한다. 조사원 보고에 따르면 글자 크기만 바뀌면 `effect.py`가 "화면이 바뀌지 않았어요"로 판정한다(`test_navigation.py:157`). (확인함: 정규식)
2.4 **데스크톱 앱이 창 없이 시작.** `apps/desktop/main.cjs:21`은 `CHEONGEUM_SHOW_WINDOW=1`이 아니면 창을 띄우지 않는다. 동의는 소리와 Enter뿐이고(`:5`), 보이는 것은 트레이의 작은 점 하나다(`:27`). 오류 창은 "터미널 로그", ".env"를 확인하라고 한다(`:80`, `:149`). `README.md:57`과 `docs/기획요약.md:15`가 이것을 설계로 설명한다. (확인함: 21행)
2.5 **막힌 사이트 안내가 "직접 브라우저로 열어 보세요"다.** `agents/web/playbook.py:26`, `:56`, `:71`. 혼자 브라우저를 쓰지 못하는 사람에게는 막다른 길이고, 전화 안내가 없다. 시험 `tests/unit/test_playbook.py:43`이 이 문구를 고정한다.
2.6 **화면 설명이 화면낭독기 말투다.** "머리말, 탐색 메뉴, 보조 영역, 꼬리말"(`agents/web/browser/observe.js:208`, `speech/screen.py:138`)과 "입력란, 필수, 비어 있음"(시험 `tests/e2e/test_safety.py:66`이 고정)이 그렇다.
2.7 **위치 정보와 대응 표시가 없다.**
    - 사진 설명에 위치 정보("오른쪽 위 파란 버튼")가 없다(`core/picture.py:94`).
    - 번역은 버튼 이름만 옮겨서 한국어 화면과 맞춰 볼 수 없다(`language/i18n.py:238`).
    - 키보드 초점 안내가 있다(`web/static/app.js:1018`).
2.8 **소리 신호.**
    - 시작·끝 신호가 22ms로 잘려 있다. 박수 감지 때문이다(`drafts/sound-cues/bake_start_done.py:29` → `web/static/cues/`). 청력이 약한 고령층은 못 들을 수 있다.
    - 음량 조절과 끄기가 없고, 12가지 추상 신호를 외워야 한다(`docs/superpowers/specs/2026-11-18-sound-cues-design.md:10`, `:32`).
2.9 **숨긴 메뉴 글도 본문으로 읽는다.** CSS로 숨긴 메뉴·탭 글을 본문에 넣어 읽는 선택이 `drafts/research results/navigating agent - follow-up plan.md:124`에 기록되어 있다. 화면을 보는 사람은 들은 글을 화면에서 찾지 못한다. 코드에서는 확인하지 않았다.

## 3. 빠진 집단 (GAP 119)

3.1 **대화 언어가 한·영·중·일 4개뿐이다.** 결혼이민자 주요 출신국 언어인 베트남어·타갈로그어·크메르어·태국어·몽골어가 없다. (확인함)
    - 언어 목록: `core/turn.py:246-247`, `language/i18n.py:18`, `orchestrator/session.py:935`, `understanding/chat.py:17`·`:34`, `web/static/app.js:52`·`:59`, `web/static/index.html:48`, `web/static/audio.js:4`, `agents/web/file_answer.py:22`, `server/app.py:230`, `scripts/setup_local_models.py:132`.
    - 언어를 추가하면 반드시 함께 바꿀 안전 목록: 멈춤 낱말 `understanding/rules.py:37`(확인함), 비밀값 낱말 `safety/privacy.py:31`. 둘 다 언어별 목록이다.
    - 지금도 한국어로만 되는 것: 멈춤 뒤 취소 안내(`session.py:311`), 보호자 명령(`personal/guardian.py:34`), 화면 글자와 동의 문구(`index.html`, `app.js:82`, `browser/waiting.html:5`, `README.md:185`).
    - 개인정보 차이: 한국어 음성은 컴퓨터 안에서 받아쓰지만 외국어 음성은 OpenAI로 간다(`voice/config.py:105`).
3.2 **맞춤 찾기가 농어민·결혼이민자를 알아보지 못한다.** (확인함)
    - 질문은 나이·장애·소득·시도 4개뿐이다(`agents/welfare/discovery.py:18`).
    - 다문화 정규식(`:87`)은 "결혼이민", "외국인 아내", "베트남 사람"을 잡지 못한다.
    - 농어민 분류가 없다(`:135`). 그래서 목록에 있는 농업인·어업인 제도가 "누구나 대상" 감점을 받는다.
    - 관련 문서: `README.md:23`, `docs/기획요약.md:16`.
    - 질문 4개를 고정한 시험: `tests/e2e/test_conversation.py:214`, `tests/e2e/test_safety.py:178`, `tests/unit/test_discovery_personal.py:32`.
3.3 **외국인 주민의 신청서 입력.**
    - 이름 검사가 한글 2~5자 또는 악센트 없는 영문만 받는다. "응우옌티투짱"(6자)이나 "Nguyễn"은 되묻는다(`agents/web/profile.py:114`, 시험 `tests/unit/test_welfare.py:323`). (확인함)
    - 실제 사이트 칸 채우기에서 건너뛰는 비밀 칸 이름 목록에 외국인등록번호·거소신고번호가 없다. 주민·계좌·카드는 있다(`agents/web/agent.py:129`, 조사원 보고로는 `skills/guided.py:179`도 같음). (확인함: 129행)
    - 칸 이름 동의어에 "영문 성명"·"체류지"가 없다(`agent.py:123`).
    - 연락처는 휴대폰만 받는다(`profile.py:133`). 주소 질문은 도로명만 안내한다(`profile.py:128`).
3.4 **연습과 예시가 모두 장애인연금이다.**
    - 연습 신청서: `practice_site/site/apply.html:23`, `orchestrator/session.py:1103`, `agents/web/skills/form.py:365`, `agents/web/profile.py:191`, `agents/web/agent.py:681`.
    - 예시 문장: `web/static/app.js:34`, `core/intents.py:85`, `agents/web/browser/waiting.html:7`, `understanding/filters.py:61`.
    - 받아쓰기 힌트: `voice/stt.py:36`.
    - 고령층 대표 제도인 기초연금은 연습할 수 없다.
3.5 **도움말이 "천천히 말해줘"·"영어로 말해줘"를 알려 주지 않는다**(`core/intents.py:216`). 건너뛰기·계속 읽기 방법은 세션에 한 번만 말한다(`skills/guided.py:215`, `skills/browse.py:515`).
3.6 **사이트·기관 목록.**
    - `understanding/sites.py:22`에 다누리, 하이코리아, 농업e지원, 노인일자리 여기, 마이홈이 없다.
    - `core/places.py:15`에 가족센터, 노인복지관, 농업기술센터가 없다.
    - `drafts/future implementations/official datasets - private programs and where to go.md:207`의 다음 자료 계획도 장애 관련뿐이다.
3.7 **천천히 말하는 사람.** 녹음이 15초에서 끊기고(`web/static/mic.js:45`), 1.5초 쉬면 차례가 끝난다(`mic.js:365`).
3.8 **화면을 보는 사람.** 안내 글씨가 작고 흐리다(`web/static/styles.css:47`, `:57`). 창 없는 모드에서는 동의 문구를 글로 볼 수 없다(2.4).
3.9 **비밀번호를 직접 칠 수 없는 사람**은 로그인할 방법이 없다(`skills/browse.py:428`). 주인 결정(2026-11-18, 비밀번호를 듣지 않음)과 묶인 판단이다.
3.10 **평가와 사용자 시험이 한 집단만 잰다.**
    - 시나리오·검색 평가: `scripts/run_scenarios.py:190`·`:213`, `evaluation/data/scenarios_30.json:5`, `evaluation/data/rag_qa.json:3`(장애인연금 하나), `scripts/eval_agent.py:70`.
    - 받아쓰기 평가에 화자 정보가 없고 외국어는 en/zh/ja뿐이다: `scripts/eval_stt.py:39`·`:154`, `docs/stt-eval/sentences.csv:1`·`:2`·`:53`. 로컬 STT 모델이 노인·사투리·외국인 억양을 다루는지는 확인되지 않았다(`scripts/setup_local_models.py:105`).
    - 집단별 지표가 없다(`evaluation/__init__.py:38`). 시나리오 시험은 `tests/e2e/test_scenarios.py:5` 하나다.
    - 사용자 시험: `docs/user-test/plan.md`(1차 시각장애인만, 다른 집단 계획 없음), `tasks.md:5`·`:12`, `consent-template.md:3`(번역판·쉬운 말 판 없음), `record-sheet.csv`. 비교 기준: `docs/architecture-check.md:38`, `docs/기획요약.md:43`.

## 4. 쉬운 말 (PLAIN 188건, 37개 파일)

- 자주 나온 낱말: 링크 22, 브라우저 22, 본문 22, OpenAI 10, 팝업 9, API 8, 세션 7, URL 6, TTS 6.
- 많은 파일: `skills/browse.py` 26, `web/static/app.js` 23, `agents/web/agent.py` 17, `speech/screen.py` 11, `understanding/sites.py` 10, `orchestrator/session.py` 9, `server/app.py` 8, `safety/guard.py` 7, `skills/form.py` 7.
- 먼저 고칠 것은 다음과 같다.
  - **개발자용 말이 사용자에게 들린다.**
    - `orchestrator/session.py:689`는 영어 예외 이름을 그대로 말한다. (확인함)
    - `server/app.py:110`·`:120`·`:126`에 "서버 STT", "세션이 없습니다", 모의 사이트·브라우저를 확인하라는 말이 있다.
    - `safety/guard.py:113`·`:128`·`:132`에 "액션 유형(navigate)", "에이전트", "필드"가 있다. `safety/gates.py:40`·`:42`도 있다.
    - 동의·도움말에 모델 이름과 실행 명령이 보인다(`web/static/app.js:76`·`:444`·`:1002`·`:1019`·`:1025`).
  - **명령 안내 "본문 읽어줘"·"링크 목록 알려줘".** 이 문구가 나오는 곳은 `speech/screen.py:160`·`:187`·`:206`·`:224`, `web/static/app.js:43-44`, `core/intents.py`다. 규칙은 이미 "내용 읽어줘"(`rules.py:338`)와 "메뉴 알려줘"(`rules.py:327`)를 알아듣는다. 안내 문구와 시험만 바꾸면 된다. (확인함)
  - **파일 전송 동의.** 받는 곳을 "OpenAI"로만 말하고, 크기 제한을 "20MB"로 말한다(`skills/browse.py:386`, `agents/web/file_answer.py:40`).
- 전체 목록: `findings.md`의 PLAIN 절.

## 5. 함께 고쳐야 할 시험 (COUPLED 36)

위 글이나 동작을 바꾸면 깨지는 시험이다. 대표적인 것은 다음과 같다.

- 본문·링크 안내: `tests/e2e/test_browsing.py:36`·`:51`, `tests/unit/test_progress.py:21`·`:22`, `tests/unit/test_registry.py:40`·`:144`.
- 화면 설명과 팝업 문구: `tests/e2e/test_safety.py:66`·`:130`.
- 맞춤 찾기 질문 4개: `tests/e2e/test_safety.py:178`, `tests/e2e/test_conversation.py:214`.
- 막힌 사이트 안내: `tests/unit/test_playbook.py:43`.
- 파일 전송 동의: `tests/e2e/test_file_answers.py:52`·`:138`.
- 숨긴 버튼: `tests/unit/test_grounding.py:103`, `tests/e2e/test_navigation.py:34`.
- 말 속도: `tests/unit/test_discovery_personal.py:161`.
- 시나리오: `src/cheongeum/evaluation/data/scenarios_30.json:61`·`:89`, `tests/unit/test_welfare.py:318`(활성 데모 시나리오 4개 고정).

## 6. 기록으로 두면 되는 것

- `research_notes/피클 AI 에이전트 청음 적용 검토/` 4개 파일: ID 12건이 있다. 다시 쓸 때 주의할 곳은 `pickle_safety_privacy.md:329` "blind-first design"과 `cheongeum_current_build.md:211`이다. 211행은 가상 커서를 "보는 관찰자용"으로 평가한다.
- `drafts/research results/`: ID 9건. `agent skills tools - fit for cheongeum.md:56`에 따르면 Part 2 판정은 "듣고 있는 시각장애인 한 명"을 전제로 한다. 재사용하려면 다시 판단해야 한다.
- 그 밖의 기록: `drafts/future implementations/`(ID 3건), `docs/superpowers/plans/2026-11-18-sound-cues.md:5`.
- git이 무시하는 파일:
  - `reports/evaluation-report.md`는 `run_scenarios.py`를 다시 돌리면 새 문구로 바뀐다.
  - `reports/피클 AI 에이전트 청음 적용 검토.md`는 연구 보고서다. 시각장애 언급이 9곳 있다.
  - `.superpowers/`는 작업 기록이다.

## 7. 제외한 파일과 이유 (449개)

- `.audit/`(과거 작업 기록)
- 소리 파일
- 외부 라이브러리(`scripts/vendor/`)와 Kenney 소리 묶음
- 잠금 파일(`uv.lock`, `package-lock.json`)
- 정부 복지 자료 원문: `agents/welfare/data/fixtures`, `open_data/snapshots`, `tests/fixtures/*.xml`
- 빈 svg
- `docs/architecture.png`: 코디네이터가 직접 봄

git이 무시하는 것 가운데 사람이 쓴 파일은 따로 봤다.

- `.env`: `TTS_SPEED=1.1`
- `reports/`, `.superpowers/`
- `apps/desktop/dist/`: 설치 파일이다. 메타데이터를 바꾸면 다시 빌드해야 한다.

## 다시 돌리기

```
python -I .audit/rebrand-audit/tools/manifest.py <repo> <outdir> 10   # 목록과 조각
# 조각마다 조사원 1명이 tools/BRIEF.md대로 result-<k>.tsv 작성
python -I .audit/rebrand-audit/tools/coverage.py <outdir>             # 228개 모두 읽었는지 (0이면 통과)
python -I .audit/rebrand-audit/tools/report.py <outdir> <destdir>     # findings.md / findings.tsv
```
