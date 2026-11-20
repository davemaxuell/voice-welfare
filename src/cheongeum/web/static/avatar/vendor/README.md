# 아바타 창이 쓰는 외부 파일

빌드 없이 불러오도록 그대로 복사했다. 바꾼 것은 가져오기 경로뿐이다(`'three'` → `./three.module.min.js`, `../utils/BufferGeometryUtils.js` → `./BufferGeometryUtils.js`). 데스크톱 CSP가 인라인 import map을 막기 때문이다.

| 파일 | 출처 | 라이선스 |
| --- | --- | --- |
| `three/three.module.min.js` | npm `three@0.170.0` `build/` | MIT (`three/LICENSE`) |
| `three/GLTFLoader.js` | npm `three@0.170.0` `examples/jsm/loaders/` | MIT |
| `three/BufferGeometryUtils.js` | npm `three@0.170.0` `examples/jsm/utils/` | MIT |

캐릭터는 청음 마스코트다. `../cheongeum-avatar.glb`는 `graphics/animations/cheongeum-avatar.glb`, `../still.png`는 `graphics/mascot-original-refined.png`를 256픽셀로 줄인 것이다. 모델을 다시 내보내면 두 파일을 함께 바꾼다. 동작 이름과 대표 장면(`character.js`의 `HOLD`)은 `graphics/animations/index.html`의 표를 따른다.
