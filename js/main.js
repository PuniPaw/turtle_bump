
import { initialState, createStore, buildEmptyTrend } from './state.js';
import { showToast } from './ui/toast.js';
import { startCamera, hasCamera, startPoseOverlay } from './pose.js';
import { startViewer } from './webrtc.js';
import { beginMonitoring, receivePostureEvent, finishMonitoring, getSaveStatus } from './dbbridge.js';
import { loadNotifyLevel, saveNotifyLevel, runNotification } from './notify.js';
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

const store = createStore(initialState);
const $ = (id) => document.getElementById(id);

mountSidebar($('sidebar'), {
  onNavigate(item) {
    if (item.id !== 'home') showToast(`'${item.label}' 메뉴는 준비 중입니다.`);
  },
});

const header = mountHeader($('header'));

// [범위 제한] 카메라 연결 + MediaPipe Pose 뼈대 표시까지만 한다.
// 각도 계산·거북목 판정·통계·실제 감지 알림은 별도 요청 전까지 연결하지 않는다.
let cameraSession = null;
let poseSession = null;
let poseToken = 0;

async function attachPoseOverlay() {
  const token = ++poseToken;
  const { video, overlay } = camera.getElements();
  camera.setPoseStatus('불러오는 중');
  try {
    const session = await startPoseOverlay(video, overlay);
    if (token !== poseToken) {
      session.stop();
      return;
    }
    poseSession = session;
    camera.setPoseStatus('연결됨');
  } catch (err) {
    console.error(err);
    if (token === poseToken) camera.setPoseStatus('연결 실패');
  }
}

function detachPoseOverlay() {
  poseToken++;
  poseSession?.stop();
  poseSession = null;
  camera.setPoseStatus('미연결');
}

async function onCameraConnected() {
  store.setState({ camera: { connected: true, error: null } });
  attachPoseOverlay();
  try {
    await beginMonitoring();
  } catch (err) {
    console.error('[D] 세션 생성 실패:', err);
    showToast(`DB 세션 생성 실패: ${err.message}`);
  }
}

const camera = mountCameraPreview($('camera'), {
  async onConnectClick() {
    if (cameraSession) return;
    const { video } = camera.getElements();

    // 노트북 내장 카메라처럼 이 기기에 카메라가 있으면 그대로 쓴다.
    if (await hasCamera()) {
      try {
        cameraSession = await startCamera(video);
        await onCameraConnected();
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
        void onCameraConnected();
      },
      onError(err) {
        console.error(err);
        camera.hideViewerWait();
        detachPoseOverlay();
        store.setState({ camera: { connected: false, error: err.message } });
        showToast(`폰 카메라 연결 실패: ${err.message}`);
        cameraSession = null;
      },
    });
  },
  async onDisconnectClick() {
    // 마지막 자세 구간이 있다면 먼저 receivePostureEvent로 전달해야 한다.
    try {
      await finishMonitoring('camera_off');
    } catch (err) {
      console.error('[D] 세션 종료 실패:', err);
      showToast(`DB 저장/종료 실패: ${err.message}`);
    }
    detachPoseOverlay();
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

// 알림 미리보기: posture/stats/history는 건드리지 않고, 배너도 잠시 뒤 스스로 닫는다.
const PREVIEW_BANNER_MS = 5000;
let previewBannerTimer = null;

function showPreviewBanner({ title, message }) {
  const alert = { level: 'bad', title, message };
  // setState는 객체를 병합하므로, 비운 뒤 넣어야 같은 참조가 유지돼 자동 닫기가 동작한다.
  store.setState({ alert: null });
  store.setState({ alert });
  $('alert').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  clearTimeout(previewBannerTimer);
  previewBannerTimer = setTimeout(() => {
    if (store.getState().alert === alert) store.setState({ alert: null });
  }, PREVIEW_BANNER_MS);
}

mountNotifySettings($('notify'), {
  initialLevel: loadNotifyLevel(),
  onChange: saveNotifyLevel,
  async onPreview(level) {
    const result = await runNotification(level, {
      title: '[미리보기] 거북목 자세 알림',
      message: '자세 알림은 이렇게 표시돼요. 미리보기는 감지 기록과 통계에 남지 않아요.',
      showBanner: showPreviewBanner,
    });
    if (result.system === 'denied') {
      showToast('Windows 알림이 차단되어 있어요. 주소창 왼쪽 사이트 설정에서 알림을 허용해 주세요.', { duration: 5000 });
    } else if (result.system === 'unsupported') {
      showToast('이 브라우저는 Windows 알림을 지원하지 않아요.');
    } else if (result.system === 'shown' && result.banner === 'off') {
      showToast('Windows 알림을 보냈어요. 화면 오른쪽 아래를 확인해 보세요.');
    }
  },
});

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

// 다른 파트(A·B·D)가 통합 시 접근할 수 있도록 노출한다.
// 예: window.neckcare.store.setState({ posture: { ts: Date.now(), angle: 12, status: 'good' } })
// B 담당 자세 판정기가 완료된 구간을 만들면 이 함수로 전달한다.
// 예: window.neckcare.receivePostureEvent({state:'TURTLE', started_at_ms:start, ended_at_ms:end, alert_triggered:true})
window.neckcare = { store, camera, receivePostureEvent, getSaveStatus };
