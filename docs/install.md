# 청음 데스크톱 실행과 설치 파일 만들기

## 소스에서 실행하기

Windows와 macOS에서 Node.js 24 이상과 npm을 설치하세요. 저장소 루트에서 아래 명령을 순서대로 실행하세요.

```bash
npm ci
npx playwright install chromium
npm --prefix apps/desktop ci
npm --prefix apps/desktop start
```

음성 대화를 사용하려면 아래의 로컬 받아쓰기 또는 원격 음성 공급자를 먼저 설정하세요. 청음이 트레이에서 동의 안내를 읽으면 Windows는 **Ctrl+Shift+Space**, macOS는 **Cmd+Shift+Space**를 누르세요. 창을 열려면 트레이의 **창 보기**를, 서버까지 끄려면 **청음 종료**를 선택하세요.

Electron은 `CHEONGEUM_NODE` 또는 `PATH`에서 찾은 `node`로 같은 저장소의 `src/server/main.ts`를 실행합니다. 받아쓰기 모델을 이 컴퓨터에서 사용하려면 Python 3.12 이상과 uv를 설치한 뒤 루트에서 `uv sync --project python`과 `npm run setup-models`를 실행하세요. [모델 설정과 웹 실행 방법](../README.md)

## 설치 파일 만들기

현재 패키징 설정은 Electron 셸과 이 안내서를 묶습니다. 새 컴퓨터에서 서버와 React 화면까지 실행하려면 위의 소스 실행 절차를 사용하세요. 빌드할 운영체제에서 데스크톱 의존성을 설치한 뒤 해당 명령을 실행하세요.

| 운영체제 | 명령 | 결과 파일 |
| --- | --- | --- |
| Windows | `npm --prefix apps/desktop run dist:win` | `apps/desktop/dist/청음-Setup-<버전>.exe` |
| macOS | `npm --prefix apps/desktop run dist:mac` | `apps/desktop/dist/청음-<버전>-<아키텍처>.dmg` |

이 설치 파일은 코드 서명과 자동 업데이트를 제공하지 않습니다. 새 버전은 설치 파일을 다시 실행해 설치하세요.

## Windows SmartScreen(서명 없음)

1. 설치 파일을 실행하면 “Windows의 PC 보호”가 뜰 수 있습니다.
2. **Tab**으로 “추가 정보”에 간 뒤 **Enter**.
3. **Tab**으로 “실행”에 간 뒤 **Enter**.
4. 설치 마법사: **다음**을 Tab·Enter로 진행. NVDA·센스리더는 표준 단추 이름을 읽습니다.

## macOS Gatekeeper(서명 없음)

1. DMG를 열고 청음을 응용 프로그램으로 옮깁니다.
2. 처음 열 때 “확인되지 않은 개발자” 경고가 납니다.
3. **시스템 설정 → 개인 정보 보호 및 보안**에서 “확인 없이 열기”를 고르거나, Finder에서 청음 아이콘에 **VoiceOver+Shift+M**(컨텍스트 메뉴) → **열기**.
4. 확인 대화에서 다시 **열기**.

## 접근성

설치·첫 실행은 NVDA, 센스리더, VoiceOver로 단추·경고 창을 읽을 수 있어야 합니다. 앱 본문은 청음 음성 안내와 화면 낭독기를 함께 씁니다.
