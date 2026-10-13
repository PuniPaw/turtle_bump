import { initialState, createStore, buildEmptyTrend } from './state.js';
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
import { renderPostureStatus } from './components/PostureStatus.js';
import { mountFrequencyChart } from './components/FrequencyChart.js';
import { renderStatsOverview } from './components/StatCard.js';
import { renderDetectionHistory } from './components/DetectionHistory.js';
import { renderPostureTips } from './components/PostureTips.js';
import { mountNotifySettings } from './components/NotifySettings.js';
import { createCalibration } from './calibration.js';

const store = createStore(initialState);
const $ = (id) => document.getElementById(id);

mountSidebar($('sidebar'), {
  onNavigate(item) {
    if (item.id !== 'home') showToast(`'${item.label}' 메뉴는 준비 중입니다.`);
  },
});

const header = mountHeader($('header'));

// [범위 제한] 카메라 연결(영상 표시)까지만 한다. MediaPipe Pose는 실행하지 않는다.
// Pose 뼈대 표시가 다시 필요하면 pose.js의 startPoseOverlay(video, overlay)를 연결 직후 호출한다.
// 각도 계산·거북목 판정·통계·실제 감지 알림은 별도 요청 전까지 연결하지 않는다.
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

const frequency = mountFrequencyChart($('frequency'), {
  onPeriodChange(period) {
    // 지금은 빈 추이(모두 0)만 보여준다. 실제 조회는 storage.getStats()로 교체.
    store.setState({ trend: { period, points: buildEmptyTrend(period) } });
  },
});

renderPostureTips($('tips'));

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
  header.update(state);
  camera.update(state);
  renderAlertBanner($('alert'), state, { onDismiss: () => store.setState({ alert: null }) });
  renderPostureStatus($('posture-status'), state);
  frequency.update(state);
  renderStatsOverview($('stats'), state);
  renderDetectionHistory($('history'), state);
}

store.subscribe(render);
render(store.getState());

// 초기 자세 설정: 카메라 연결 성공(connected false→true) 시 시작, 해제(true→false) 시 즉시 중단.
// 기존 카메라 연결·해제 코드는 건드리지 않고 상태 변화만 지켜본다.
const calibration = createCalibration({
  view: { show: (s) => camera.showCalibration(s), hide: () => camera.hideCalibration() },
  getVideo: () => camera.getElements().video,
  isCameraConnected: () => store.getState().camera.connected,
});
let cameraWasConnected = store.getState().camera.connected;
store.subscribe((state) => {
  const connected = state.camera.connected;
  if (connected === cameraWasConnected) return;
  cameraWasConnected = connected;
  if (connected) calibration.start();
  else calibration.cancel();
});

// 다른 파트(A·B·D)가 통합 시 접근할 수 있도록 노출한다.
// 예: window.neckcare.store.setState({ posture: { ts: Date.now(), angle: 12, status: 'good' } })
// 실제 거북목 알림: 판정 파트가 거북목이면 alerts.start(), 정상 자세로 돌아오면 alerts.stop()을 호출한다.
// 판정 모듈 등록: neckcare.registerAnalyzer({ beginBaseline, finishBaseline, start, stop }) — calibration.js 참고
window.neckcare = {
  store,
  camera,
  alerts: { start: startPostureAlert, stop: stopPostureAlert },
  registerAnalyzer: calibration.registerAnalyzer,
};
