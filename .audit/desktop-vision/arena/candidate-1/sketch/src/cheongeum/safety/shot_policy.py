"""
[새 파일] 찍지 않는 화면: 그림 경로의 단일 관문(웹·데스크톱 공통, 순수 함수).
ScreenPicture.explain이 찍기 전에 한 번 부르고, 이것이 거절하면 아무것도 찍지 않는다.

찍지 않는 것:
 - 자동 입력 방지(CAPTCHA)·접속 차단 화면: 풀거나 우회하지 않는다. BLOCKED는 digest.py:17에서 여기로 옮긴다(U0).
 - 로그인·본인인증 화면, 비밀번호 칸이 보이는 화면, 본인인증 인계 중(AUTH_HANDOFF): 사용자가 비밀값을 넣는 중일 수 있다.
 - 자격 증명·인증서·보안 프로그램 창(데스크톱): 창 종류·실행 파일 이름·제목 단서로.
 - 바탕화면·작업 표시줄(셸): 목록 읽기('바탕화면에 뭐 있어?')로 대신한다.
 - 내려 둔(최소화) 창: 제목 줄만 보인다(probe-facts: 최소화 창은 7개 요소뿐).
"""
from __future__ import annotations

from cheongeum.core.jsutil import I, rx
from cheongeum.core.shot import CaptureRefusal, ShotSubject

# digest.py:17에서 옮김. digest는 여기서 가져온다(같은 정규식을 두 곳에 두지 않는다).
BLOCKED = rx(r"(접속이\s*차단|접근이\s*차단|비정상적인\s*접근|자동\s*입력\s*방지|unusual traffic|are you a robot|captcha|access denied)", I)

# 데스크톱 자격 증명 창 단서(휴리스틱: 한계로 문서화). 창 종류·실행 파일은 바꾸기 어렵고, 제목은 보조로만.
CREDENTIAL_CLASSES = frozenset({"Credential Dialog Xaml Host", "#32770:CredentialUI"})
CREDENTIAL_PROCESSES = frozenset(
    {"consent.exe", "credentialuibroker.exe", "logonui.exe", "keepass.exe", "1password.exe", "bitwarden.exe",
     "anysign4pc.exe", "magicline4nx.exe", "delfino.exe", "crossex.exe", "touchenkey.exe", "nprotect.exe"}
)
CREDENTIAL_TITLE = rx(r"(인증서\s*(선택|암호)|공동\s*인증|금융\s*인증|간편\s*인증|비밀\s*번호|암호\s*입력|PIN|password|sign\s*-?\s*in|로그인)", I)


def refuse_capture(subject: ShotSubject, *, session_state: str) -> CaptureRefusal | None:
    """
    찍으면 안 되는 화면이면 거절 이유(코드가 만든 한국어 문장), 찍어도 되면 None.
    순서: AUTH_HANDOFF 상태 → CAPTCHA·차단(subject.captcha 또는 BLOCKED가 제목·글 앞 600자에) → 로그인·인증(subject.auth)
          → 비밀번호 칸 → 자격 증명 창 → 셸 → 최소화.
    거절 문장 예: "자동 입력 방지 화면이라 그림으로 보지 않았어요. 이 단계는 직접 해 주셔야 해요."
    """
    raise NotImplementedError


def credential_window(process: str, window_class: str, title: str) -> bool:
    """데스크톱 창 분류용(agents/desktop/focus.classify_window가 부른다). 실행 파일·창 종류가 우선, 제목은 보조."""
    raise NotImplementedError
