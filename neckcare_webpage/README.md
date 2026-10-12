# NeckCare — 거북목 모니터링 대시보드 (UI 프로토타입)

거북이 방지턱 프로젝트의 웹 프론트엔드 UI. 현재는 **화면 디자인과 구조만** 구현되어 있다.
카메라, MediaPipe Pose, 판정 로직, 저장/통계는 아직 연결되지 않았고, 모든 값은 초기값(0 / 측정할 수 없음)이다.

## 실행

빌드 도구 없이 HTML + CSS + JavaScript(ES 모듈)로 되어 있다. ES 모듈은 `file://`로 열면 동작하지 않으니 로컬 서버로 연다.

- `start.bat` 더블클릭 → 브라우저에서 http://localhost:5173 이 열린다
- 또는 이 폴더에서 `python -m http.server 5173` 실행 후 http://localhost:5173 접속

## 폴더 구조

```
index.html                  화면 뼈대 (각 영역의 mount 위치)
css/styles.css              디자인 토큰(:root 색상 변수) + 전체 스타일 + 반응형
js/main.js                  컴포넌트 연결, store 구독, window.neckcare 노출
js/state.js                 초기 상태(initialState)와 store(setState/subscribe)
js/icons.js                 인라인 SVG 아이콘
js/utils/format.js          시간/날짜 포맷
js/ui/toast.js              하단 안내 토스트
js/components/
  Sidebar.js                왼쪽 메뉴 (홈 외 메뉴는 "준비 중" 안내)
  Header.js                 인사말, 분석 상태 표시, 현재 시각
  CameraPreview.js          카메라 미리보기 (video + overlay canvas 포함)
  AlertBanner.js            나쁜 자세 알림 (state.alert 있을 때만 표시)
  PostureStatus.js          현재 자세 상태 카드
  FrequencyChart.js         거북목 발생 빈도 (비율 링 + 추이 선 그래프)
  StatCard.js               주요 수치 카드 4개
  DetectionHistory.js       최근 감지 기록 표
  PostureTips.js            바른 자세 팁 (정적)
```

## 다른 파트 연결 위치

모든 화면은 `store`의 상태만 보고 그린다. 다른 파트는 `store.setState(...)`로 값을 넣으면 된다.
(`window.neckcare.store`로도 접근 가능)

| 파트 | 연결 방법 |
| --- | --- |
| A. 좌표 추출 | `window.neckcare.camera.getElements()` → `{ video, overlay }`. `video.srcObject`에 웹캠 스트림 연결, `overlay` 캔버스에 귀·어깨 점 그리기. 연결되면 `setState({ camera: { connected: true } })`. 시작 버튼은 `main.js`의 `onConnectClick` |
| B. 판정 | 프레임마다 `setState({ posture: { ts, angle, status } })` (`status`: `good`/`warn`/`bad`). 분석 시작 시 `setState({ analysis: { status: 'running' } })`. 나쁜 자세 지속 시 `setState({ alert: { level: 'bad', title, message } })` |
| D. 저장/통계 | `getStats()` 결과로 `setState({ stats: {...}, trend: { period, points: [{ label, rate }] }, history: [{ ts, durationSec, status }] })`. 기간 탭 변경은 `main.js`의 `onPeriodChange` |

브라우저 개발자 도구 콘솔에서 화면 반응을 미리 확인해 볼 수 있다 (새로고침하면 초기화):

```js
neckcare.store.setState({ posture: { ts: Date.now(), angle: 12, status: 'good' } })
```
