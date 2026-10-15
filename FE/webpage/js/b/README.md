# NeckCare 연동용 B(자세 판정) 모듈

C(UI/UX)의 NeckCare 웹페이지에 B의 거북목 판정을 연결하기 위한 **독립 모듈과 설명서**입니다.
판정 알고리즘·임계값·안정화 로직은 바꾸지 않았고, 바깥을 감싸는 층(래퍼)만 추가했습니다. C의 파일은 수정하지 않았습니다.

## 폴더 구성

| 파일 | 역할 | C에게 전달 |
|---|---|---|
| `neckcare-analyzer.js` | **판정 모듈 (ES module)**. `createNeckCareAnalyzer(options)` 하나를 export | ✅ |
| `turtleneck.js` | B의 판정 로직 v4 JS 이식판. `code/turtleneck.js`를 바이트 단위로 그대로 복사한 것 (SHA-256 `ff2dfe6c…689f26d0`) | ✅ |
| `README.md` | 이 문서 (인터페이스, 상태표, 기준 자세, 예시, 테스트 절차, 의존성, 미해결 사항) | ✅ |
| `test/parity_gen.py`, `test/parity.html` | Python v4와 JS 판정이 같은지 프레임 단위로 비교하는 테스트 | 선택 |
| `dev/harness.html` | B 단독 검증용 페이지. C의 호출 순서를 흉내 냄. **연동물 아님** (자체 카메라를 엶) | ❌ |

> 판정 로직의 원본은 `code/turtleneck.js` 하나뿐입니다. 판정을 수정하면 이 폴더의 사본도 같이 바꿔야 합니다(해시로 확인).

---

## 0. 조사 결과: B의 실제 코드

| 파일 | 내용 | 이 모듈에서 |
|---|---|---|
| `code/face_demo/turtleneck_face_v4.py` | Python v4. MediaPipe Pose와 Face Landmarker를 함께 씀 (cm 단위 판정) | 기준 원본 |
| `code/turtleneck.js` | **v4를 JS로 옮긴 것** (`window.PostureV4`, `PostureTracker`) | **그대로 사용** |
| `code/demo.html` | B의 브라우저 테스트 페이지 (tasks-vision 0.10.14, pose_landmarker_full, GPU, `requestAnimationFrame`) | 모델·옵션을 그대로 따름 |
| `code/turtleneck_v3.py` | Python v3 (Pose만 사용, % 단위 판정) | 사용 안 함 |
| `code/turtleneck_v3.js` | v3의 JS 이식판 | 사용 안 함 ※ |

※ `turtleneck_v3.js`는 판정값이 `turtleneck_v3.py`와 다르고(HOLD_SEC 0.7, HEAD_TH 5, DROP_TH 10, CLOSE_TH 7.5 등), 상태 이름도 다릅니다(`good`, `turtle_neck`, `leaning_forward` …). 이 모듈과는 관계가 없으니 혼동하지 마세요.

**Python ↔ JS 판정 일치 확인 (실행함)**

`test/parity.html`로 확인했습니다.
- 입력: 시뮬레이션 33개 case, 9,208프레임. Python에는 좌우 반전 프레임을, JS에는 반전하지 않은 원본을 넣었습니다. 행렬 형식은 열 우선, 행 우선, 2차원 배열 세 가지를 모두 넣었습니다.
- 결과: **state 불일치 0개, fwd 최대 차이 3.6×10⁻¹⁴ cm**.
- 범위: 같은 랜드마크가 들어갔을 때 판정 로직이 같다는 확인입니다. Python은 구버전 `mp.solutions.pose`, JS는 `PoseLandmarker`(full)를 쓰므로, 랜드마크 값 자체는 조금 다를 수 있습니다. 이 부분은 미확인입니다(11장).

---

## 1. 인터페이스 설명서

```js
import { createNeckCareAnalyzer } from './neckcare-analyzer.js';

const analyzer = createNeckCareAnalyzer({
  onResult(r) { /* 판정 결과 (4장) */ },
  onError(e)  { /* 오류 (1-3) */ },
});
window.neckcare.registerAnalyzer(analyzer);   // 카메라 연결 전에 등록 권장
```

### 1-1. `createNeckCareAnalyzer(options?)` → analyzer (동기)

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `onResult` | `null` | 결과 콜백 |
| `onError` | `null` | 오류 콜백. 없으면 `console.warn`으로 출력 |
| `emit` | `'change'` | `'change'`면 상태나 플래그가 바뀔 때만 결과를 보냄. `'frame'`이면 분석한 프레임마다 보냄 |
| `delegate` | `'GPU'` | `demo.html`과 같은 값. `'CPU'`로 고정할 수 있음 |
| `cpuFallback` | `true` | GPU로 모델 생성에 실패하면 CPU로 한 번 더 시도 |
| `wasmBase`, `poseModel`, `faceModel` | jsdelivr / googleapis URL | 7장 참고. 로컬 경로로 바꿀 수 있음 |
| `recalibrateAfterNovisMs` | `null` | NOVIS가 이 시간 이상 이어지면 `needs_recalibration: true`로 확정. **`null`이면 확정하지 않음 (값은 합의 필요, 11장)** |
| `inputStallMs` | `2000` | 판정 중 새 영상 프레임이 이 시간 동안 없으면 `input_stalled` 오류를 보냄 (판정 기준 아님) |
| `videoReadyTimeoutMs` | `5000` | `beginBaseline`에서 video가 재생 가능해질 때까지 기다리는 최대 시간 |
| `baselineGraceMs` | `2000` | `finishBaseline`이 3초 수집 완료를 추가로 기다리는 여유 시간 |
| `watchdogMs` | `200` | `requestVideoFrameCallback`이 이 시간 동안 오지 않으면 타이머로 대신 분석 (video가 숨겨졌을 때 등) |

### 1-2. analyzer 메서드

| 메서드 | 동기/비동기 | 반환 | 예외 | 하는 일 |
|---|---|---|---|---|
| `beginBaseline(video)` | async | `Promise<void>` | 던짐 (아래) | 이전 진행과 기준값을 모두 버림 → 모델 로딩(처음 한 번만) → video 준비 대기 → 준비 추론 1회 → **끝나는 즉시 3초 수집 시작** → 추론 루프 시작 |
| `finishBaseline()` | async | `Promise<{ok, …}>` | 던지지 않음 | 3초 수집이 끝날 때까지 최대 3초+`baselineGraceMs` 기다린 뒤 결과 반환 (3장) |
| `start(cb?)` | 동기 | `undefined` | 없음 | 결과 전달 시작. 현재 결과를 바로 한 번 보냄. 기준 자세가 없으면 경고만 하고 무시. `cb`를 넘기면 `onResult`로 등록 |
| `stop()` | 동기 | `undefined` | 없음 | 추론 루프·타이머·수집을 모두 정리하고 기준값 삭제. 대기 중인 `finishBaseline`은 `{ok:false, reason:'cancelled'}`로 끝남. 모델은 재사용하려고 남겨 둠 |
| `onResult(cb)` | 동기 | 해제 함수 | 없음 | 결과 콜백 추가 |
| `onError(cb)` | 동기 | 해제 함수 | 없음 | 오류 콜백 추가 |
| `getLatest()` | 동기 | 결과 또는 `null` | 없음 | 마지막으로 계산한 결과 (보내지 않은 것 포함) |
| `getDebug()` | 동기 | 객체 | 없음 | `phase`, `fps`, `delegate`, `calib`(수집 프레임 수와 미검출 사유), `lines`(수치), `config` |
| `dispose()` | 동기 | `undefined` | 없음 | `stop()`을 하고 모델까지 해제 |

**`beginBaseline`이 예외를 던지는 경우**

| 상황 | 예외 메시지 | `onError` type |
|---|---|---|
| video 인자가 아님 | `TypeError` | — |
| 모델 로딩 실패 (GPU와 CPU 모두) | 원래 오류 | `model_load_failed` |
| 5초 안에 video가 준비되지 않음 | `video_not_ready` | `video_not_ready` |
| 준비 추론 실패 | 원래 오류 | `inference_error` |
| 진행 중에 `stop()`이나 새 `beginBaseline`이 호출됨 | `cancelled` | — |

**호출 순서 제약**
- `beginBaseline` → `finishBaseline` → (`ok`이면) `start`, (실패면) `stop` 순서입니다.
- 언제든 `stop()`을 부르면 처음 상태로 돌아갑니다.
- `start()`를 부르기 전에는 결과를 보내지 않습니다.
- `beginBaseline`을 다시 부르면 이전 기준값은 남지 않습니다.
- 늦게 끝난 비동기 작업은 내부 진행 번호(`gen`)로 걸러서 무시합니다.

### 1-3. 오류 객체 (`onError`)
```js
{ type, message, error, detail, timestamp /* Date.now() ms */ }
```
| type | 언제 | 결과 전달 |
|---|---|---|
| `model_load_failed` | 모델/wasm 로딩 실패 | `beginBaseline`이 예외를 던짐 |
| `video_not_ready` | video 준비 시간 초과 | `beginBaseline`이 예외를 던짐 |
| `inference_error` | `detectForVideo` 예외. 연속으로 나면 처음 한 번만 알림 | 그 프레임은 건너뜀. 다음 프레임에서 다시 시도 |
| `input_ended` | video의 MediaStreamTrack이 `ended`가 됨 | 결과 전달이 멈춤. `finishBaseline`이면 `reason:'input_ended'` |
| `input_stalled` | `inputStallMs` 동안 새 프레임이 없음 | 결과 전달이 멈춤. 프레임이 다시 오면 자동으로 이어짐 |

---

## 2. 상태값 정의표

판정 상태는 `turtleneck.js`의 `PostureTracker.update()` 반환값 그대로입니다. 래퍼가 새로 정의한 상태는 없습니다.

| 기능 | 실제 상태값 | 전환 조건 (실제 코드) | 안정화 | 동시 발생 | 외부 전달 |
|---|---|---|---|---|---|
| 분석 시작 전 | `'IDLE'` | `phase === 'idle'`: 측정 전, 측정 실패, `stop()` 이후 | — | — | 결과로 보내지 않음. `getDebug().phase === 'idle'` |
| 기준 자세 측정 중 | `'CALIB'` | `startCalib()` 후 `CALIB_SEC`(3.0초) 동안 | — | — | 결과로 보내지 않음. `getDebug().phase === 'calib'` |
| 정상 자세 | `'GOOD'` | 아래 셋에 모두 해당하지 않음 | EMA + HOLD 0.5초 | 플래그와 함께 생길 수 있음 | `onResult` |
| 거북목 | `'TURTLE'` | `fwd > FWD_TH(3.0cm)` (허리굽힘이 아닐 때) | EMA + HOLD 0.5초 | 〃 | `onResult`, `alert:true` |
| 허리 굽음 | `'WAIST'` | `appr > LEAN_TH(6.0) && (fwd > LEAN_FWD_TH(2.0) \|\| drop > DROP_TH(3.0))` 또는 `drop > DROP_STRONG_TH(5.0)` | EMA + HOLD 0.5초 | 〃 | `onResult`, `alert:true` |
| 화면에 너무 가까움 | `'CLOSE'` | `dist > CLOSE_TH(10.0cm) && \|fwd\| < CLOSE_FWD_TH(2.0)`. B 코드 주석상 "경고 아님, 안내만" | EMA + HOLD 0.5초 | 〃 (`reanchoring`과 자주 같이 나옴) | `onResult` |
| 자세 판정 불가능 | `'NOVIS'` | 그 프레임의 `measure()`가 `null`: 얼굴 없음 / 얼굴 행렬 없음 / Pose 없음 / 어깨 visibility < `VIS_TH`(0.5) / 어깨폭 < 1px | **없음** (해당 프레임 즉시) | `needs_recalibration`과 함께 | `onResult`, `reason`에 원인 |

판정 순서는 `judge()` 기준으로 WAIST → TURTLE → CLOSE → GOOD입니다. 상태값은 하나만 나오고, 아래 플래그는 상태와 동시에 붙을 수 있습니다.

| 플래그 (상태 아님) | 실제 근거 | 의미 |
|---|---|---|
| `gated` | `tracker.gated` (`\|yaw − 기준 yaw\| > YAW_TH(25°)`) | 고개를 많이 돌려서 판정을 보류하고 **직전 판정을 유지**하는 중. 이때 state는 직전 값 |
| `reanchoring` | `tracker.calm_since !== null` | 의자 이동을 감지해 기준 갱신을 기다리는 중 (1.8초) |
| `reference_updated` | `tracker.msg === 'REFERENCE UPDATED'` | 이번 프레임에 기준이 새 위치로 갱신됨 (한 번만 true) |
| `needs_recalibration` | 래퍼 (`recalibrateAfterNovisMs`) | "다시 설정 필요" 확정. 기본은 꺼져 있음 (6장) |

`NOVIS`가 끝나면 내부의 직전 안정 판정(`shown`)과 EMA를 이어서 씁니다. Python v4와 같은 동작입니다.

### 2-1. C의 `status`(`unknown / good / warn / bad`)와 대응 (제안, C의 Adapter에서 변환)

| B state / 플래그 | C status 제안 | 비고 |
|---|---|---|
| `GOOD` | `good` | 경고를 끔 |
| `CLOSE` | `good` | B에서는 경고가 아님. 별도 안내 문구를 쓸지는 C가 결정 |
| `TURTLE`, `WAIST` (7초 미만) | `warn` | |
| `TURTLE`, `WAIST` (7초 이상) | `bad` → `alerts.start()` | 7초는 C에서 계산 (5장) |
| `NOVIS` | `unknown` | 7초 타이머는 일시정지 제안 |
| `needs_recalibration: true` | `unknown` + `alerts.stop()` + "자세 판단이 어렵습니다! 초기자세 설정을 다시 해주세요" | |
| (결과 없음 = start 전, IDLE/CALIB) | `unknown` | |

`posture.angle`: B에는 목 각도 값이 없습니다(미확인이 아니라 **없음**). `values.pitch`는 고개 숙임 각도의 초기값 대비 변화라서 목 각도와는 다릅니다. `null`로 둘지, `values.fwd`(cm)를 표시할지는 합의가 필요합니다.

---

## 3. 초기 기준 자세 설정 설명서

| 항목 | 내용 |
|---|---|
| 시작 | `beginBaseline(video)`가 **끝나는 순간** `tracker.startCalib()`를 호출. 모델 로딩·video 준비·준비 추론은 그 전에 끝냄 |
| 수집 시간 | `CALIB_SEC` = 3.0초. C 순서상 begin 직후부터 3초이므로 "1초 대기 + 3·2·1" 중 앞 3초에 해당하고, `finishBaseline`(약 4초 뒤) 전에 끝남 |
| 수집 방법 | B가 `video`에서 직접 프레임을 읽음 (`requestVideoFrameCallback` + watchdog 타이머). 같은 프레임은 다시 분석하지 않음 |
| 성공 조건 | 3초 동안 `measure()`가 유효한 프레임(얼굴 행렬 + 양 어깨 visibility ≥ 0.5)이 **10개 이상** (`makeBase`: `samples.length < 10`이면 실패) |
| 기준값 | 유효 프레임들의 **중앙값**. `k`(깊이 상수), `sh`, `sh_y`, `z_head`, `yaw`, `pitch`, `f`, `offset`, `neck` |
| 저장 위치 | 메모리(`tracker.base`)에만 있음. 브라우저 저장소나 서버에 저장하지 않음 |
| 성공 반환 | `{ ok: true, base, frames, valid_frames, delegate }` |
| 실패 반환 | `{ ok: false, reason, frames, valid_frames, missing }`. `missing`은 미검출 사유별 프레임 수 |
| 실패 사유 | `not_visible`(유효 프레임 < 10), `timeout`(3초+여유 안에 수집이 끝나지 않음, 프레임이 안 옴), `input_ended`, `input_stalled`, `cancelled`(진행 중 stop), `not_started`(begin 없이 호출) |
| 초기화 | `beginBaseline`과 `stop`이 매번 새 `PostureTracker`를 만들어서 이전 기준값·EMA·기준 갱신 상태가 남지 않음 |
| 취소 | `stop()`을 부르면 루프와 타이머를 해제하고 대기 중인 `finishBaseline`을 `cancelled`로 끝냄. `beginBaseline` 도중이면 그 Promise는 `cancelled` 예외로 끝남 |
| 판정 중 재측정 | 없음. 다시 측정하려면 `beginBaseline`부터 다시 시작 |
| 의자 위치 변경 | 재측정 없이 B가 자동으로 기준을 갱신함 (어깨 거리 8cm 이상 변화 후 1.8초 안정) |

수집하는 3초 동안 프레임 수는 fps에 따라 다릅니다. 30fps면 약 90개, 내장 브라우저에서 빈 화면으로 시험했을 때는 약 7fps로 20개 정도였습니다.

---

## 4. 판정 결과 전달

- **방법**: `onResult(cb)`로 등록하거나, 옵션 `onResult`, 또는 `start(cb)`로 넘깁니다.
- **빈도**: 기본(`emit:'change'`)은 `state`, `reason`, `gated`, `reanchoring`, `needs_recalibration` 중 하나가 바뀌거나 `reference_updated`가 true일 때 보냅니다. `start()` 직후에도 한 번 보냅니다. `emit:'frame'`이면 분석한 프레임마다(약 fps 횟수) 보냅니다.

```ts
{
  source: 'neckcare-b',
  state: 'GOOD'|'TURTLE'|'WAIST'|'CLOSE'|'NOVIS',  // B 원래 값
  prev_state: string|null,     // 직전의 '다른' state
  stabilized: boolean,         // GOOD/TURTLE/WAIST/CLOSE = true (HOLD 0.5초 거친 값), NOVIS = false (프레임 원본)
  alert: boolean,              // TURTLE || WAIST (turtleneck.js와 같은 정의, 7초와 무관)
  state_since: number,         // 이 state가 시작된 시각, Date.now() ms
  duration_ms: number,         // 이 state가 이어진 시간 (performance.now() 기준)
  reason: null|'no_face'|'no_face_matrix'|'no_pose'|'shoulders_not_visible'|'shoulders_invalid', // NOVIS일 때만
  gated: boolean,              // 고개 회전으로 직전 판정 유지 중
  reanchoring: boolean,        // 의자 이동 감지, 기준 갱신 대기 중
  reference_updated: boolean,  // 이번에 기준 갱신됨
  novis_ms: number,            // NOVIS가 이어진 시간 (아니면 0)
  needs_recalibration: boolean,// '다시 설정 필요' 확정 (옵션을 켰을 때만 true가 될 수 있음)
  timestamp: number,           // Date.now() ms
  perf_time: number,           // performance.now() ms
  values: {                    // EMA 적용값 (NOVIS 동안에는 마지막 값)
    fwd, appr, drop, dist,     // cm (판정에 사용)
    yaw, pitch,                // 도, 기준 대비 (yaw는 판정 보류에 사용)
    neck, z_head, z_sh, Y_sh   // cm (표시용)
  } | null
}
```

- **신뢰도**: B 판정에는 신뢰도 값이 없어서 보내지 않습니다. MediaPipe 검출 신뢰도는 판정에 쓰지 않습니다(어깨 visibility 0.5 기준만 사용).
- **오류**: `onError`로 따로 보냅니다(1-3).

---

## 5. 7초 경고 정책: 책임 분리

1. **B에 이미 안정화가 있는가?** 있습니다. 두 단계입니다.
   - 판정값에 EMA(`EMA_ALPHA` = 0.3, 프레임 단위)를 적용합니다.
   - 같은 판정이 `HOLD_SEC` = **0.5초** 이상 이어져야 상태를 바꿉니다(`cand` → `shown`). 1초짜리 안정화는 없습니다.
2. **내보내는 상태는?** GOOD/TURTLE/WAIST/CLOSE는 **안정화된 최종 결과**(`shown`)입니다. NOVIS는 **프레임별 원본**이라 안정화가 없습니다. `stabilized` 필드로 구분됩니다.
3. **7초는 어디서?** **C가 계산하는 것을 제안합니다.**
   - B는 `state_since`와 `duration_ms`를 주므로 C는 받은 결과만으로 7초를 셀 수 있습니다. 별도 타이머가 거의 필요 없습니다.
   - 경고 정책(강도, 문구, 확장 프로그램 표시)이 모두 C에 있습니다.
   - B에 7초를 넣으면 판정 모듈에 새 기준값이 생깁니다. 이 작업에서는 금지된 일입니다.
   - B의 0.5초 HOLD 위에 C의 7초가 더해지므로 실제 경고까지는 **약 7.5초**입니다. 정확히 7초를 원하면 C가 `state_since`에서 0.5초를 빼서 계산할 수 있습니다. **합의 필요.**
4. **TURTLE → WAIST로 바뀌면?** UI 정책 결정입니다. 제안: **이어서 계산**(TURTLE과 WAIST를 하나의 '나쁜 자세' 구간으로 봄). 현재 경고 문구가 "거북목"으로 고정이라, 허리 굽음일 때 문구를 바꿀지도 함께 합의가 필요합니다.
5. **각 상태에서 타이머는?** (제안)

| 상태 | 7초 타이머 | 경고 |
|---|---|---|
| GOOD | 초기화 | `alerts.stop()` |
| CLOSE | 초기화 (B에서 경고가 아님) | `alerts.stop()` |
| NOVIS (잠깐) | **일시정지** (지난 시간은 유지, 시간은 더하지 않음) | 진행 중인 경고는 유지 |
| `needs_recalibration` | 초기화 | `alerts.stop()` + 재설정 안내 |
| 기준 측정 중 / start 전 | 초기화 | 꺼짐 |
| `gated` (고개 회전) | B가 직전 판정을 유지하므로 그대로 계산 | 유지 |

---

## 6. 판정 불가능과 예외 (실제 코드 기준)

| 상황 | B 판정 코드 (Python v4 / turtleneck.js) | 이 모듈 |
|---|---|---|
| 얼굴이 잠깐 안 잡힘 | `measure()` → `null`, `update()`가 `'NOVIS'` 반환. 직전 판정(`shown`)과 EMA는 유지하고, 다시 보이면 이어서 판정. **시간 제한 없음** | `state:'NOVIS', reason:'no_face'`(또는 `no_face_matrix`). 즉시 보냄 |
| 어깨 좌표 누락 | 같음 (`visibility < 0.5`이거나 Pose 없음) | `reason:'shoulders_not_visible'` / `'no_pose'` |
| 렌즈 가림 | 얼굴과 Pose가 모두 없어 NOVIS. **사람이 자리를 비운 것과 구분하지 못함** | `reason:'no_face'`. 구분 불가 |
| 카메라 입력 중단 | Python: `cap.read()` 실패 시 메시지 출력 후 계속 시도. JS(`turtleneck.js`): 처리 없음 (프레임이 안 오면 호출도 없음) | `onError('input_ended')`(트랙 종료) 또는 `('input_stalled')`(2초간 새 프레임 없음). 그동안 결과는 보내지 않음 |
| 모델 실행 오류 | Python: 처리 없음 (예외가 나면 종료). JS: 처리 없음 (`demo.html`은 로딩 실패만 표시) | 로딩 실패: GPU→CPU 재시도 후 `beginBaseline` 예외 + `model_load_failed`. 추론 예외: `inference_error` 알림 후 그 프레임만 건너뜀 |
| 기준 자세 설정 실패 | `makeBase()`가 `null`(유효 프레임 < 10) → `phase = 'idle'` | `finishBaseline()` → `{ok:false, reason:'not_visible', missing:{…}}` |

**잠깐 미검출 vs 다시 설정 필요**
- **B 판정 코드에는 둘을 구분하는 조건이나 시간이 없습니다.** Python v4와 `turtleneck.js` 모두 NOVIS가 몇 초든 계속 이어질 수 있고, 다시 보이면 기존 기준으로 판정을 이어 갑니다.
- 그래서 모듈에 `recalibrateAfterNovisMs` 옵션을 두었습니다. NOVIS가 이 시간(ms) 이상 이어지면 `needs_recalibration: true`가 확정되고, 이 값은 다음 `beginBaseline`까지 유지됩니다. 이후 결과에도 계속 true로 붙습니다.
- **기본값은 `null`(끔)입니다.** 새 판정 기준값을 임의로 만들지 않기 위해서입니다. C와 시간을 합의해서 넣어 주세요(11장).
- 판정 결과로 확정되는 경우 외에도 '다시 설정'이 필요한 경우가 있습니다. `finishBaseline` 실패, `model_load_failed`, `input_ended`입니다. 이 셋은 C가 이미 "카메라 다시 연결" 흐름으로 처리합니다.

---

## 7. 실행 환경 · 의존성

| 항목 | 내용 |
|---|---|
| 언어 | 판정 원본은 Python(v4). 연동 모듈은 **JavaScript (ES module)**. 판정 로직은 B가 이미 JS로 옮겨 둔 `turtleneck.js`를 쓰고, Python과 같은 판정인지 시험함(0장) |
| MediaPipe | `@mediapipe/tasks-vision@0.10.14` (C 페이지와 같은 버전, 같은 jsdelivr URL에서 import하므로 모듈이 한 번만 로드됨) |
| Pose | `PoseLandmarker`, `runningMode:'VIDEO'`, `numPoses:1`, detection/tracking confidence 0.5, 모델 **`pose_landmarker_full` float16** (`demo.html`과 같음). C가 준비한 lite와는 다름 → 11장 |
| Face | `FaceLandmarker`, `runningMode:'VIDEO'`, `numFaces:1`, confidence 0.5, `outputFacialTransformationMatrixes: true`(필수), blendshapes 끔, 모델 `face_landmarker` float16/1 |
| 모델 URL | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`<br>`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`<br>wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm` (옵션으로 로컬 경로 지정 가능) |
| 대리자 | GPU (WebGL). 생성에 실패하면 CPU로 한 번 재시도. 실제로 쓴 값은 `getDebug().delegate`로 확인 |
| 추론 호출 | `detectForVideo(video, ts)`. Pose와 Face에 같은 `ts`를 넣음. `ts = max(직전+1, floor(performance.now()))` (단조 증가 정수 ms) |
| 서버·프로세스 | 필요 없음. 브라우저 안에서만 처리하고 영상을 밖으로 보내지 않음. 정적 파일 서버(C의 `server.py`)로 `.js`만 제공하면 됨 |
| 권한 | 카메라 권한은 C가 받음. 모듈은 카메라를 열지 않음 |
| 네트워크 | 처음 로딩할 때 jsdelivr와 storage.googleapis.com에 접근 (내장 브라우저에서 처음 로딩에 약 10초 걸림, 이후 캐시됨) |

**확인할 것들**

| 항목 | 내용 |
|---|---|
| 입력 형식 | `HTMLVideoElement`를 그대로 `detectForVideo`에 넣습니다. RGB/BGR 변환은 필요 없습니다(Python은 OpenCV가 BGR이라 변환했음) |
| 해상도·비율 | 제약 없음. 초점거리를 `video.videoHeight`와 세로 화각 63°(`FOV_V_DEG`) 가정으로 계산합니다. 판정은 모두 초기값 대비 cm 변화라 해상도의 영향이 작습니다. 휴대폰 카메라(화각이 다름)에서 cm 절대값이 달라지는 영향은 **미확인** |
| 좌우 반전 | Python은 반전한 프레임을, NeckCare는 반전하지 않은 원본을 씁니다. 판정에 쓰는 값은 모두 거리·높이·초기값 대비 각도라서 반전과 무관합니다. 실제로 반전/원본 조건으로 일치함을 확인했습니다(0장). 왼쪽/오른쪽을 구분하는 판정은 없습니다 |
| 타임스탬프 | 판정 내부는 `performance.now()/1000`(초, Python의 `perf_counter`와 같은 역할). 결과는 `timestamp`(Date.now ms)와 `perf_time`(performance.now ms) 둘 다 줌 |
| 추론 반복 | `video.requestVideoFrameCallback`(새 프레임마다) + watchdog `setInterval`(rVFC가 200ms 이상 안 오면 대신 분석). `requestAnimationFrame`은 쓰지 않음 |
| video 숨김 (`display:none`) | rVFC가 멈춰도 watchdog이 분석을 이어 갑니다. 내장 브라우저에서 숨긴 상태로 1.5초에 9프레임을 분석한 것을 확인했습니다. 실제 Chrome에서의 fps는 **미확인** |
| 백그라운드 탭 | Chrome은 숨겨진 탭의 타이머를 1초 이상 간격으로 늦추므로 분석이 초당 1회 이하로 떨어질 수 있습니다(**미확인**). HOLD는 시간 기준이라 유지되지만, EMA는 프레임 기준이라 반응이 달라집니다 |

**Python → JS 결과가 같은지 확인하는 방법**
1. **로직 일치**: `python test/parity_gen.py` → 정적 서버로 `test/parity.html`을 엶 → "state 불일치 0" 확인. 실행 완료했고 0이었습니다.
2. **랜드마크까지 포함한 실측 일치 (미실행)**: 같은 사람과 같은 동작으로 Python `compare_live.py`(v4)와 `dev/harness.html?source=camera`의 판정 로그를 비교합니다. 모델 차이(구버전 Pose ↔ PoseLandmarker full) 때문에 완전히 같을 수는 없고, 상태 전환이 비슷한 시점에 나는지 보는 수준입니다.

---

## 8. 데이터 예시 (⚠ 형식 설명용 예시이며, 실측값이 아님)

```js
// 예시 — 정상
{ source:'neckcare-b', state:'GOOD', prev_state:'TURTLE', stabilized:true, alert:false,
  state_since:1760000000000, duration_ms:0, reason:null, gated:false, reanchoring:false,
  reference_updated:false, novis_ms:0, needs_recalibration:false,
  timestamp:1760000000000, perf_time:123456.7,
  values:{ fwd:0.4, appr:-0.2, drop:0.1, dist:0.3, yaw:2, pitch:-1, neck:0.2, z_head:58.0, z_sh:58.5, Y_sh:20.1 } }

// 예시 — 거북목
{ ..., state:'TURTLE', prev_state:'GOOD', stabilized:true, alert:true, reason:null,
  values:{ fwd:4.2, appr:0.8, drop:0.3, dist:0.8, yaw:1, pitch:6, ... } }

// 예시 — 허리 굽음
{ ..., state:'WAIST', prev_state:'GOOD', stabilized:true, alert:true,
  values:{ fwd:3.1, appr:9.5, drop:1.2, dist:9.5, ... } }

// 예시 — 너무 가까움 (의자를 당김, 기준 갱신 대기 중)
{ ..., state:'CLOSE', prev_state:'GOOD', stabilized:true, alert:false, reanchoring:true,
  values:{ fwd:0.6, appr:12.0, drop:0.4, dist:12.0, ... } }

// 예시 — 판정 불가능 (얼굴 미검출)
{ ..., state:'NOVIS', prev_state:'GOOD', stabilized:false, alert:false, reason:'no_face',
  novis_ms:1500, needs_recalibration:false, values:{ /* 마지막 값 */ } }

// 예시 — 다시 설정 필요 확정 (recalibrateAfterNovisMs를 켰을 때만)
{ ..., state:'NOVIS', reason:'no_face', novis_ms:10000, needs_recalibration:true }

// 예시 — finishBaseline 실패
{ ok:false, reason:'not_visible', frames:88, valid_frames:4, missing:{ shoulders_not_visible:84 } }
```

---

## 9. 연동 테스트 절차 (C가 NeckCare에서)

1. 이 폴더의 `neckcare-analyzer.js`와 `turtleneck.js`를 C 서버가 제공하는 같은 폴더에 둡니다(예: `/b/`).
2. 카메라를 연결하기 **전에** Chrome 개발자 도구 콘솔에서 아래를 실행합니다.
   ```js
   const { createNeckCareAnalyzer } = await import('/b/neckcare-analyzer.js');
   window.B = createNeckCareAnalyzer({
     onResult: (r) => console.log('[B]', r.state, r.reason ?? '', r.gated ? 'gated' : '',
                                   r.reanchoring ? 'reanchoring' : '', Math.round(r.duration_ms), r.values),
     onError:  (e) => console.warn('[B error]', e.type, e.message, e.detail),
   });
   window.neckcare.registerAnalyzer(window.B);
   ```
3. 카메라 연결 → 3초 동안 바른 자세 → "거북목 판정 시작!"이 뜨는지 확인합니다. 실패하면 콘솔에서 아래를 확인합니다.
   ```js
   B.getDebug().calib   // { frames, valid, missing: { no_face: n, shoulders_not_visible: n, ... } }
   ```
4. 상태 재현 (각각 5초 이상 유지하고 콘솔 로그를 확인)

| 재현 동작 | 기대 결과 |
|---|---|
| 바른 자세 | `GOOD` |
| 어깨는 그대로 두고 턱을 앞으로 내밈 (3cm 이상) | `TURTLE` |
| 엉덩이를 축으로 상체를 앞으로 숙임 | `WAIST` |
| 자세는 바르게 유지하고 의자를 10cm 이상 화면 쪽으로 당김 | `CLOSE` (+ 1.8초 뒤 `reference_updated`) |
| 그 위치에서 턱을 내밈 | `TURTLE` |
| 고개를 30° 이상 옆으로 돌림 | 직전 state 유지 + `gated` |
| 화면 밖으로 나가기, 렌즈 가리기 | `NOVIS` + `reason` |

5. 실시간 수치를 보려면 아래를 실행합니다.
   ```js
   setInterval(() => console.log(B.getDebug().lines.join(' | '), 'fps', B.getDebug().fps), 1000)
   ```
6. 정리 확인: 카메라를 해제하면 `stop()`이 호출됩니다. 이후 `B.getDebug().phase === 'idle'`이고 결과 로그가 더 나오지 않아야 합니다.
7. 통계 화면으로 전환(video `display:none`)하거나 다른 탭으로 이동한 뒤 `B.getDebug().fps`를 확인합니다. 미확인 항목이므로 결과를 B에게 알려 주세요.

**B 혼자 확인하기**: `code/neckcare_b`를 정적 서버로 연 뒤 아래 페이지를 씁니다. 이 페이지는 C의 호출 순서(begin → 1초 → 3·2·1 → finish → start/stop)를 그대로 흉내 냅니다.
- `dev/harness.html?source=camera`: 실제 카메라
- `dev/harness.html?source=blank&auto=1`: 카메라 없이 실패 경로 확인

```bash
python -m http.server 5180 --bind 127.0.0.1 --directory code/neckcare_b
```

---

## 10. 검증한 것 / 하지 않은 것

| 항목 | 결과 |
|---|---|
| Python v4 ↔ `turtleneck.js` 판정 로직 일치 (반전 포함, 9,208프레임) | ✅ 불일치 0 |
| 모듈 import, 모델 로딩(GPU), C 호출 순서대로 begin → finish | ✅ (내장 브라우저, 빈 화면 입력) |
| 사람이 없을 때 `finishBaseline` → `{ok:false, reason:'not_visible', missing:{no_face}}` | ✅ |
| 수집 중 `stop()` → 대기 중인 finish가 `cancelled`, phase `idle` | ✅ |
| `stop()` 이후 `finishBaseline` → `not_started` | ✅ |
| video `display:none`에서 분석이 이어짐 (watchdog) | ✅ (내장 브라우저) |
| 트랙 종료 → `input_ended` 한 번 알림, finish → `input_ended` | ✅ |
| **실제 사람·카메라로 GOOD/TURTLE/WAIST/CLOSE 판정** | ❌ 미실행 (9장 절차 필요) |
| **JS PoseLandmarker 어깨 `visibility` 값이 정상으로 나오는지** | ❌ 미확인. 값이 비어 있으면 1로 간주하지만, 0으로 나오면 항상 NOVIS가 됩니다. 실패 시 `missing.shoulders_not_visible`로 바로 드러납니다 |
| 실제 Chrome의 백그라운드 탭 / 숨긴 video에서의 fps | ❌ 미확인 |

---

## 11. 미해결 사항 (합의·확인 필요)

1. **7초 책임** (5장): C에서 계산하는 것을 제안합니다. 0.5초 HOLD를 포함해 약 7.5초가 되는 문제, TURTLE↔WAIST 전환 시 이어서 셀지, NOVIS 동안 일시정지할지 정해야 합니다.
2. **"다시 설정 필요" 확정 시간** (6장): B 판정 코드에는 이 조건이 없습니다. `recalibrateAfterNovisMs` 값을 정해 주세요(기본은 꺼짐). 렌즈 가림과 자리 비움은 구분할 수 없습니다.
3. **Pose 모델 lite ↔ full**: B는 full로 시험했습니다(`demo.html`). C가 준비한 lite를 쓰면 어깨 좌표의 노이즈가 달라져 판정이 달라질 수 있습니다(미확인). full 사용을 제안합니다.
4. **`posture.angle`**: B에는 목 각도가 없습니다. `null`로 둘지, 다른 값(`values.fwd` cm 등)을 쓸지 정해야 합니다.
5. **CLOSE 안내**: B에서는 경고가 아니라 안내입니다. C의 화면에 별도 문구를 둘지 정해야 합니다.
6. **허리 굽음 문구**: 현재 경고 문구가 "거북목 자세가 감지되었어요"로 고정입니다. WAIST일 때 문구를 바꿀지 정해야 합니다.
7. **백그라운드 / 숨김 상태 성능**과 **휴대폰(WebRTC) 입력의 화각 차이**: 실측이 필요합니다.
8. **실측 Python ↔ JS 비교**: 랜드마크 모델이 달라 생기는 차이를 아직 측정하지 않았습니다.
9. **Chrome 확장 프로그램**: 확장 안에서 판정을 돌린다면 CDN import가 CSP에 막힐 수 있습니다. 이 경우 wasm과 모델을 확장에 포함하고 `wasmBase`, `poseModel`, `faceModel` 옵션을 로컬 경로로 지정해야 합니다(미확인).
