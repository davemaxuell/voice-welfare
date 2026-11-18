# 청음 설치(서명 없음)

Windows·macOS 설치 파일은 **서명하지 않습니다**. 자동 업데이트는 없고, 새 버전은 설치 파일을 다시 실행합니다.

## 만들기

저장소 루트에서:

```bash
npm --prefix apps/desktop install
npm --prefix apps/desktop run dist
```

- Windows: `apps/desktop/dist/청음 Setup *.exe` (NSIS)
- macOS: `apps/desktop/dist/청음-*.dmg`

빌드 기계에 Python 3.12+, `uv`, Playwright Chromium이 있어야 합니다. 설치 파일은 Electron 셸과 함께 `scripts/package-desktop`이 모아 둔 런타임 안내를 넣습니다. 로컬 STT·PII 모델은 첫 실행 때 동의 후 `uv run python scripts/setup_local_models.py`로 받습니다.

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
