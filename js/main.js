
import { initialState, createStore, buildEmptyTrend } from './state.js';
import { showToast } from './ui/toast.js';
import { startCamera, hasCamera, startPoseOverlay } from './pose.js';
import { startViewer } from './webrtc.js';

// D 담당: Flask + MariaDB 연동
import {
  beginMonitoring,
  receivePostureEvent,
  finishMonitoring,
  getSaveStatus
} from './bcintegration.js';

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


// --------------------------------------------------
// 1. 기본 설정
// --------------------------------------------------

const store = createStore(initialState);
const $ = (id) => document.getElementById(id);


// --------------------------------------------------
// 2. 사이드바 및 헤더
// --------------------------------------------------

mountSidebar($('sidebar'), {
  onNavigate(item) {
    if (item.id !== 'home') {
      showToast(`'${item.label}' 메뉴는 준비 중입니다.`);
    }
  },
});

const header = mountHeader($('header'));


// --------------------------------------------------
// 3. 카메라 및 MediaPipe 상태
// --------------------------------------------------

let cameraSession = null;
let poseSession = null;
let poseToken = 0;


// --------------------------------------------------
// 4. MediaPipe 실행
// --------------------------------------------------

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

    if (token === poseToken) {
      camera.setPoseStatus('연결 실패');
    }
  }
}


// --------------------------------------------------
// 5. MediaPipe 종료
// --------------------------------------------------

function detachPoseOverlay() {
  poseToken++;

  poseSession?.stop();
  poseSession = null;

  camera.setPoseStatus('미연결');
}


// --------------------------------------------------
// 6. 카메라 연결 완료
// D 담당: MariaDB 측정 세션 생성
// --------------------------------------------------

async function onCameraConnected() {

  store.setState({
    camera: {
      connected: true,
      error: null
    }
  });

  // MediaPipe 실행
  void attachPoseOverlay();

  // Flask API를 통해 세션 생성
  try {
    const sessionId = await beginMonitoring();

    console.log(
      '[D] MariaDB 세션 생성 성공:',
      sessionId
    );

  } catch (err) {
    console.error(
      '[D] 세션 생성 실패:',
      err
    );

    showToast(
      `DB 세션 생성 실패: ${err.message}`
    );
  }
}


// --------------------------------------------------
// 7. 카메라 ON / OFF
// --------------------------------------------------

const camera = mountCameraPreview($('camera'), {

  // 카메라 ON
  async onConnectClick() {

    if (cameraSession) return;

    const { video } = camera.getElements();

    // 노트북 또는 PC 카메라
    if (await hasCamera()) {

      try {
        cameraSession = await startCamera(video);

        await onCameraConnected();

      } catch (err) {
        console.error(err);

        store.setState({
          camera: {
            connected: false,
            error: err.message
          }
        });

        if (err.name === 'NotAllowedError') {

          showToast(
            '카메라 권한이 거부됐어요. 브라우저 설정에서 카메라 권한을 허용해 주세요.'
          );

        } else if (err.name === 'NotReadableError') {

          showToast(
            '다른 프로그램이 카메라를 사용 중이에요.'
          );

        } else {

          showToast(
            `카메라 연결 실패: ${err.message}`
          );

        }
      }

      return;
    }

    // 카메라가 없는 경우 WebRTC 사용
    camera.showViewerWait(null);

    cameraSession = startViewer(video, {

      onRoom(code) {

        camera.showViewerWait({
          url: `${location.origin}/phone.html?room=${code}`,
          code
        });

      },

      onConnected() {

        camera.hideViewerWait();

        void onCameraConnected();

      },

      onError(err) {

        console.error(err);

        camera.hideViewerWait();

        detachPoseOverlay();

        store.setState({
          camera: {
            connected: false,
            error: err.message
          }
        });

        showToast(
          `폰 카메라 연결 실패: ${err.message}`
        );

        cameraSession = null;
      }
    });
  },


  // 카메라 OFF
  async onDisconnectClick() {

    // D 담당: MariaDB 세션 종료
    try {

      const result = await finishMonitoring(
        'camera_off'
      );

      console.log(
        '[D] MariaDB 세션 종료 성공:',
        result
      );

    } catch (err) {

      console.error(
        '[D] 세션 종료 실패:',
        err
      );

      showToast(
        `DB 저장/종료 실패: ${err.message}`
      );
    }

    // MediaPipe 종료
    detachPoseOverlay();

    // 카메라 종료
    cameraSession?.stop();
    cameraSession = null;

    camera.hideViewerWait();

    store.setState({
      camera: {
        connected: false,
        error: null
      }
    });
  }
});


// --------------------------------------------------
// 8. 자세 빈도 그래프
// 현재는 기존 빈 데이터 표시 유지
// --------------------------------------------------

const frequency = mountFrequencyChart($('frequency'), {

  onPeriodChange(period) {

    store.setState({
      trend: {
        period,
        points: buildEmptyTrend(period)
      }
    });

  }
});


// --------------------------------------------------
// 9. 자세 개선 팁
// --------------------------------------------------

renderPostureTips($('tips'));


// --------------------------------------------------
// 10. 알림 미리보기
// --------------------------------------------------

const PREVIEW_BANNER_MS = 5000;

let previewBannerTimer = null;

function showPreviewBanner({ title, message }) {

  const alert = {
    level: 'bad',
    title,
    message
  };

  store.setState({ alert: null });
  store.setState({ alert });

  $('alert').scrollIntoView({
    behavior: 'smooth',
    block: 'nearest'
  });

  clearTimeout(previewBannerTimer);

  previewBannerTimer = setTimeout(() => {

    if (store.getState().alert === alert) {
      store.setState({ alert: null });
    }

  }, PREVIEW_BANNER_MS);
}


// --------------------------------------------------
// 11. 알림 설정
// --------------------------------------------------

mountNotifySettings($('notify'), {

  initialLevel: loadNotifyLevel(),

  onChange: saveNotifyLevel,

  async onPreview(level) {

    const result = await runNotification(level, {

      title: '[미리보기] 거북목 자세 알림',

      message:
        '자세 알림은 이렇게 표시돼요. 미리보기는 감지 기록과 통계에 남지 않아요.',

      showBanner: showPreviewBanner
    });

    if (result.system === 'denied') {

      showToast(
        'Windows 알림이 차단되어 있어요. 사이트 설정에서 알림을 허용해 주세요.',
        { duration: 5000 }
      );

    } else if (result.system === 'unsupported') {

      showToast(
        '이 브라우저는 Windows 알림을 지원하지 않아요.'
      );

    } else if (
      result.system === 'shown' &&
      result.banner === 'off'
    ) {

      showToast(
        'Windows 알림을 보냈어요.'
      );
    }
  }
});


// --------------------------------------------------
// 12. 화면 렌더링
// --------------------------------------------------

function render(state) {

  header.update(state);

  camera.update(state);

  renderAlertBanner(
    $('alert'),
    state,
    {
      onDismiss: () =>
        store.setState({ alert: null })
    }
  );

  renderPostureStatus(
    $('posture-status'),
    state
  );

  frequency.update(state);

  renderStatsOverview(
    $('stats'),
    state
  );

  renderDetectionHistory(
    $('history'),
    state
  );
}


// --------------------------------------------------
// 13. 상태 변경 감지
// --------------------------------------------------

store.subscribe(render);

render(store.getState());


// --------------------------------------------------
// 14. B/C/D 통합용 인터페이스
// --------------------------------------------------

// B 담당이 자세 판정을 완료하면
// receivePostureEvent()를 호출하여 DB에 저장한다.
//
// 예시:
//
// await window.neckcare.receivePostureEvent({
//   event_id: crypto.randomUUID(),
//   state: 'TURTLE',
//   started_at_ms: startTime,
//   ended_at_ms: endTime,
//   alert_triggered: true
// });

window.neckcare = {
  store,
  camera,
  receivePostureEvent,
  getSaveStatus
};
