---
name: py-to-ts-port
description: 청음의 Python 모듈 하나와 해당 테스트를 TypeScript로 옮길 때 사용한다.
---

1. 이번 PR의 기준 커밋에서 Python 구현, 호출부, 단위 테스트를 읽는다. 테스트하려는 입력과 출력을 해당 oracle 또는 transcript에서 찾는다.
2. `src/cheongeum` 아래 파일과 같은 경로에 `src/<단계>/<이름>.ts`를 만든다. 경계에서 스키마로 검증하고 선택 항목은 undefined로 둔다. 한글 정규식의 숫자·단어·공백·문자 위치는 Python 결과와 대조한다.
3. Python 테스트 함수 이름을 Vitest 제목으로 쓴다. 실제 구현의 함수를 oracle 및 정규식 레지스트리에 연결하고 해당 모듈과 기준 SHA를 `port-manifest.json`에 등록한다.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run test-parity`, `npm run port-drift`로 확인한다. Python의 동작이 바뀌었을 때 `npm run regen-fixtures`로 다시 기록한다.
5. 원본 `src/cheongeum`과 데모 시나리오는 수정하지 않는다. 픽스처는 기록기로만 갱신한다. 의도적으로 JS 동작을 채택할 때는 `adopt-js.json`에 해당 사례와 이유를 남긴다.
