---
name: py-to-ts-port
description: 청음의 이전 Python 구현과 현재 TypeScript 구현의 동작을 대조할 때 사용한다.
---

1. `scripts/migration/port-manifest.json`의 `reference.commit`에서 마지막 Python 구현과 테스트를 확인한다. `git show <커밋>:src/cheongeum/<경로>`로 원본을 읽을 수 있다.
2. `tests/fixtures`에서 해당 함수, 정규식, 대화 기록을 찾는다. Vitest로 실제 TypeScript 구현의 출력과 대조한다. 한글과 이모지가 포함된 정규식은 문자 위치도 확인한다.
3. `npm run test-parity`로 기존 테스트 이름을 확인하고 `npm run port-drift`로 모듈별 Python 기준 커밋을 검사한다. 전체 검증에는 `npm run typecheck`, `npm run lint`, `npm test`를 사용한다.
4. 기준 기록을 재현하려면 마지막 Python 커밋의 별도 작업 트리에서 해당 커밋의 `npm run regen-fixtures`를 실행한다. 의도적으로 다른 동작은 `tests/fixtures/oracle/adopt-js.json`에서 확인한다.
