# 청음의 말 이해와 조작 권한

## 말뜻과 권한

화면을 보지 않고 쓰는 사용자는 청음이 어떤 버튼을 누르려는지 음성으로 확인해야 한다. 웹페이지의 제목과 본문에는 누구나 지시처럼 보이는 글을 넣을 수 있다. Anthropic의 브라우저 실험에서도 보호 장치를 적용한 뒤 공격 성공률이 Opus 4.5에서 1.4%, Sonnet 4.5에서 1.9%였다. 청음에서는 화면 글이나 모델 응답으로 사용자 승인을 만들 수 없다. [Anthropic의 브라우저 실험](https://www.anthropic.com/research/prompt-injection-defenses)

## 처리 순서와 담당 코드

| 구분 | 맡은 일 | 담당 코드 |
|---|---|---|
| A. 항상 지키는 제한 | 입력 비식별화, 비밀값 보호, 동의·멈춤, 출처와 입력 칸 확인, 턴당 12회 제한, 근거와 숫자 검증. 승인 뒤에도 대상·화면·유효 시간을 다시 확인한다. 자율 탐색은 최대 10단계·75초이며 같은 동작이 세 번 반복되면 멈춘다. | `session.py:handle_turn`, `gates.py:gate_refusal`, `guard.py:PolicyGuard.check`, `approval.py:recheck`, `verify.py:check_grounding`, `autopilot.py` |
| B. 빠른 길 | 멈춤·진행 상황·명시적인 화면 사진 요청, 대기 중인 승인·거절, 인증 인계 완료, 등록된 명령·사이트 이름을 바로 이해한다. 칸에 맞는 값과 되묻기 답도 로컬에서 처리한다. | `fastpath.py:fast_intent`, `lexicon.py:approval`, `understand.py:Understanding.understand` |
| C. 말뜻 풀이 | 모델이 발화의 조건을 보존해 의도를 정하고 여러 질문을 단계로 나눈다. 모델이 뜻을 알 수 없다고 하면 그 판단을 받아들인다. | `llm_planner.py:plan_with_llm` |
| D. 오프라인 | 모델이 없거나 호출이 실패하면 기존 파서가 명령을 나누고 해석한다. | `rules.py:RuleBasedIntentProvider`, `understand.py:Understanding.understand` |

## 규칙을 추가할 때

새 규칙은 막는 규칙(A)이나 빠른 길(B)일 때만 코드로 만든다. 말뜻 풀이는 planner 프롬프트(understanding/llm_planner.py)에 쓴다.

## 실제 사이트 버튼의 한계

버튼 위험도는 화면에서 관찰한 역할과 이름으로 판정한다. 이름이 실제 동작을 정확히 설명한다는 보장은 없다. 기본 설정인 `safe`에서는 실제 신청·제출·결제처럼 결과를 남기는 버튼은 사용자가 직접 누른다. ‘검색 조건 변경’이나 ‘확인’처럼 뜻이 모호하면 대상을 읽고, 그 조작에 대한 승인을 받은 뒤 한 번 누른다. 정보 조회 전용 작업은 확인이 필요한 버튼에서 진행할 수 없다.
