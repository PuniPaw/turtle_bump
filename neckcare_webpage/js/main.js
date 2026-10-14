import { TEST_MODE } from './test-mode.js';   // 반드시 첫 import(?mock=1일 때만 Mock 서버 주소로 전환)
import { initialState, createStore } from './state.js';
import { showToast } from './ui/toast.js';
import { startCamera, hasCamera } from './pose.js';
import { startViewer } from './webrtc.js';
import {
  loadNotifyLevel, saveNotifyLevel, syncExtensionLevel,
  previewNotification, startPostureAlert, stopPostureAlert, isPostureAlertActive,
} from './notify.js';
import { mountSidebar } from './components/Sidebar.js';
import { mountHeader } from './components/Header.js';
import { mountCameraPreview } from './components/CameraPreview.js';
import { renderAlertBanner } from './components/AlertBanner.js';
import { renderPostureStatus, renderMeasureTime } from './components/PostureStatus.js';
import { renderPostureTips } from './components/PostureTips.js';
import { mountNotifySettings } from './components/NotifySettings.js';
import { createCalibration } from './calibration.js';
import { mountStatsPage } from './components/StatsPage.js';
import { registerStatsProvider, loadStats, hasStatsProvider } from './stats-source.js';
import { createPostureAdapter } from './posture-adapter.js';
import { createSessionRecorder } from './session-recorder.js';
import { getStats, getHomeSummary } from './backend-api.js';

const store = createStore(initialState);
const $ = (id) => document.getElementById(id);

// 화면 전환(홈 ↔ 통계): 주소 #stats와 맞추고 새로고침 없이 영역만 숨긴다.
// 카메라·초기 설정·알림·세션 코드는 호출하지 않는다(카메라 스트림 유지).
const viewFromHash = () => (location.hash === '#stats' ? 'stats' : 'home');
const sidebar = mountSidebar($('sidebar'), {
  onNavigate(item) {
    const hash = item.id === 'stats' ? '#stats' : '#home';
    if (location.hash !== hash) location.hash = hash;
  },
});
window.addEventListener('hashchange', () => store.setState({ view: viewFromHash() }));

const header = mountHeader($('header'));

// 카메라 연결(영상 표시). 자세 판정은 B 모듈(js/b/)이 이 <video>를 그대로 읽는다(아래 "B 판정 모듈 연결").
// pose.js의 startPoseOverlay(뼈대 표시)는 사용하지 않는다.
let cameraSession = null;

function onCameraConnected() {
  store.setState({ camera: { connected: true, error: null } });
}

const camera = mountCameraPreview($('camera'), {
  async onConnectClick() {
    if (cameraSession) return;
    const { video } = camera.getElements();

    // 노트북 내장 카메라처럼 이 기기에 카메라가 있으면 그대로 쓴다.
    if (await hasCamera()) {
      try {
        cameraSession = await startCamera(video);
        onCameraConnected();
      } catch (err) {
        console.error(err);
        store.setState({ camera: { connected: false, error: err.message } });
        if (err.name === 'NotAllowedError') {
          showToast('카메라 권한이 거부됐어요. 브라우저 설정에서 카메라 권한을 허용해 주세요.');
        } else if (err.name === 'NotReadableError') {
          showToast('다른 프로그램이 카메라를 사용 중이에요. 화상회의 앱 등을 닫고 다시 시도해 주세요.');
        } else {
          showToast(`카메라 연결 실패: ${err.message}`);
        }
      }
      return;
    }

    // 카메라가 없는 기기에서는 폰 카메라를 받아온다(WebRTC).
    camera.showViewerWait(null);
    cameraSession = startViewer(video, {
      onRoom(code) {
        camera.showViewerWait({ url: `${location.origin}/phone.html?room=${code}`, code });
      },
      onConnected() {
        camera.hideViewerWait();
        onCameraConnected();
      },
      onError(err) {
        console.error(err);
        camera.hideViewerWait();
        store.setState({ camera: { connected: false, error: err.message } });
        showToast(`폰 카메라 연결 실패: ${err.message}`);
        cameraSession = null;
      },
    });
  },
  onDisconnectClick() {
    cameraSession?.stop();
    cameraSession = null;
    camera.hideViewerWait();
    store.setState({ camera: { connected: false, error: null } });
  },
});

renderPostureTips($('tips'));

// 통계 화면. 조회는 D 파트 모듈이 등록됐을 때만 실제로 일어난다(없으면 "연동 준비 중").
const statsPage = mountStatsPage($('stats-page'), {
  async onLoad() {
    store.setState({ report: { attempted: true } });
    const result = await loadStats(store);
    if (result === 'unavailable') showToast('통계 데이터 연동 준비 중입니다.');
    else if (result === 'error') showToast('분석 결과를 불러오지 못했어요. 이전 결과를 유지합니다.');
  },
  onChange(name, value) {
    store.setState({ report: { [name]: value } });
    // 기간·집계 단위가 바뀌면 그 조건으로 다시 조회한다(조회 모듈이 있을 때만).
    if ((name === 'period' || name === 'trendUnit') && hasStatsProvider()) loadStats(store);
  },
});

// 알림 미리보기: posture/stats/history는 건드리지 않고, 약 3초 뒤 스스로 정리된다.
mountNotifySettings($('notify'), {
  initialLevel: loadNotifyLevel(),
  onChange(level) {
    saveNotifyLevel(level);
    // 실제 감지 알림이 켜져 있는 중이면 바뀐 강도로 다시 표시한다.
    if (isPostureAlertActive()) startPostureAlert(level);
  },
  async onPreview(level) {
    const result = await previewNotification(level, {
      title: '[미리보기] 거북목 자세 알림',
      message: '자세 알림은 이렇게 표시돼요. 미리보기는 감지 기록과 통계에 남지 않아요.',
    });
    if (result.system === 'denied') {
      showToast('Windows 알림이 차단되어 있어요. 주소창 왼쪽 사이트 설정에서 알림을 허용해 주세요.', { duration: 5000 });
    } else if (result.system === 'unsupported') {
      showToast('이 브라우저는 Windows 알림을 지원하지 않아요.');
    } else if (result.system === 'error') {
      showToast('Windows 알림을 표시하지 못했어요. Chrome과 Windows의 알림 설정을 확인해 주세요.', { duration: 5000 });
    } else if (result.system === 'shown' && level === 'weak') {
      showToast('Windows 알림을 보냈어요. 화면 오른쪽 아래를 확인해 보세요.');
    } else if (result.system === 'unknown' && level === 'weak') {
      showToast('Windows 알림 표시 여부를 확인하지 못했어요. 알림 센터(Win+N)를 확인해 보세요.', { duration: 5000 });
    }
  },
});
syncExtensionLevel(loadNotifyLevel());

function render(state) {
  document.querySelectorAll('[data-view]').forEach((section) => {
    section.hidden = section.dataset.view !== state.view;
  });
  sidebar.setActive(state.view);
  statsPage.update(state);
  header.update(state);
  camera.update(state);
  renderAlertBanner($('alert'), state, { onDismiss: () => store.setState({ alert: null }) });
  renderPostureStatus($('posture-status'), state);
  renderMeasureTime($('measure-time'), state);
}

store.subscribe(render);
store.setState({ view: viewFromHash() });

// ---- D 백엔드 연동(API 명세서 v0.3.3) -----------------------------------------
// 저장: session-recorder.js가 세션·자세 이벤트를 만들어 보낸다(전송 시점: 통계 갱신 직전·카메라 OFF·pagehide).
// 조회: 통계 화면은 registerStatsProvider, 홈 누적 측정 시간은 /summary/home.
// 백엔드가 꺼져 있으면 카메라·판정·알림은 그대로 동작하고 저장·통계만 실패로 표시된다.
let endFailNotified = false;
const recorder = createSessionRecorder({
  onStatus(type, info) {
    if (type === 'session_failed') {
      showToast('DB 서버에 연결하지 못해 이번 측정은 저장되지 않아요. 카메라와 자세 알림은 계속 동작해요.', { duration: 5000 });
    } else if (type === 'end_failed' && !info.final && !endFailNotified) {
      endFailNotified = true;
      showToast('측정 종료 기록을 저장하지 못해 같은 내용으로 다시 시도하고 있어요.', { duration: 5000 });
    } else if (type === 'session_ended') {
      endFailNotified = false;
    }
  },
  onSessionEnded: () => refreshHomeMeasured(),
});

// 홈 "누적 측정 시간": 서버 값만 표시(기록 없음 null ↔ 0 구분). 실패하면 기존 표시 유지
async function refreshHomeMeasured(asOf = Date.now()) {
  try {
    const r = await getHomeSummary(asOf);
    store.setState({ stats: { measuredSec: typeof r?.measured_sec === 'number' ? r.measured_sec : null } });
  } catch (err) {
    console.warn('[neckcare] 홈 누적 측정 시간을 불러오지 못했습니다.', err.message);
  }
}

// 통계: 조회 직전에 미전송 구간과 진행 중 구간 스냅샷(같은 asOf)을 저장한 뒤 조회한다(명세 5.5·8장).
registerStatsProvider({
  async query({ period, unit, asOf }) {
    await recorder.flush(asOf);
    const data = await getStats({ period, unit, asOf });
    refreshHomeMeasured(asOf);
    return data;
  },
});

refreshHomeMeasured();
window.addEventListener('pagehide', () => recorder.pageHide());

// 초기 자세 설정: 카메라 연결 성공(connected false→true) 시 시작, 해제(true→false) 시 즉시 중단.
// 기존 카메라 연결·해제 코드는 건드리지 않고 상태 변화만 지켜본다.
const calibration = createCalibration({
  view: { show: (s) => camera.showCalibration(s), hide: () => camera.hideCalibration() },
  getVideo: () => camera.getElements().video,
  isCameraConnected: () => store.getState().camera.connected,
  isViewActive: () => store.getState().view === 'home',
});
let cameraWasConnected = store.getState().camera.connected;
let lastView = store.getState().view;
store.subscribe((state) => {
  const connected = state.camera.connected;
  if (connected !== cameraWasConnected) {
    cameraWasConnected = connected;
    // 저장 세션: 실제 연결 성공 시각으로 시작, OFF 시 마지막 구간 최종화 후 종료(카메라는 이미 꺼진 뒤 비동기 저장)
    if (connected) {
      recorder.start();
      calibration.start();
    } else {
      recorder.stop('camera_off');
      calibration.cancel();
    }
  }
  // 화면 전환: 통계로 가면 초기 설정만 잠시 멈추고(카메라 유지), 홈으로 돌아오면 다시 시작한다.
  if (state.view !== lastView) {
    lastView = state.view;
    window.scrollTo(0, 0);
    if (state.view === 'home') calibration.resume();
    else calibration.suspend();
  }
});

// B 판정 모듈 연결: B 결과는 posture-adapter.js가 화면 상태·알림으로 바꾼다.
// 모듈(또는 MediaPipe CDN) 로딩에 실패하면 지금처럼 판정 없이 UI만 동작한다.
// 등록은 다음 카메라 연결부터 적용되므로 페이지를 열자마자 불러온다.
const postureAdapter = createPostureAdapter({
  store,
  onState: recorder.setState,             // 확정 상태 → 저장 구간
  onAlertStart: recorder.markAlertStarted, // 경고 시작 → alert_triggered
});
let bAnalyzer = null;
import('./b/neckcare-analyzer.js')
  .then(({ createNeckCareAnalyzer }) => {
    bAnalyzer = createNeckCareAnalyzer({
      recalibrateAfterNovisMs: 5 * 60 * 1000,   // 팀 합의: 판정 불가가 5분 이어지면 "초기자세 설정을 다시 해주세요"
      onResult: postureAdapter.handleResult,
      onError: postureAdapter.handleError,
    });
    calibration.registerAnalyzer(postureAdapter.wrap(bAnalyzer));
  })
  .catch((err) => console.error('[neckcare] 자세 판정 모듈을 불러오지 못했습니다. 판정 없이 동작합니다.', err));

// 다른 파트(A·B·D)가 통합 시 접근할 수 있도록 노출한다.
// 판정 결과는 B 모듈 → posture-adapter.js → store.posture / alerts 로 자동 연결된다.
// 판정 모듈 등록: neckcare.registerAnalyzer({ beginBaseline, finishBaseline, start, stop }) — calibration.js 참고
// 통계 조회 모듈 등록: neckcare.registerStatsProvider({ query({ period, unit, asOf }) }) — stats-source.js 참고
window.neckcare = {
  store,
  camera,
  alerts: { start: startPostureAlert, stop: stopPostureAlert },
  registerAnalyzer: calibration.registerAnalyzer,
  registerStatsProvider,
  getAnalyzer: () => bAnalyzer,   // 디버그용: neckcare.getAnalyzer().getDebug()
  getRecorder: () => recorder,    // 디버그용: neckcare.getRecorder().getStatus()
};

// 테스트 모드(?mock=1)에서만: B 결과 형식의 테스트 입력을 Adapter에 넣는 통로(카메라 없이 통합 테스트용)
if (TEST_MODE) {
  window.neckcare.test = {
    feed(state) {
      postureAdapter.handleResult({ source: 'test', state, state_since: Date.now(), duration_ms: 0, timestamp: Date.now(), needs_recalibration: false });
    },
  };
}
