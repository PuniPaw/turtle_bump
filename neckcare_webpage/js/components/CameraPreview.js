import { icon } from '../icons.js';

// 카메라 미리보기 컴포넌트.
// 구조를 한 번만 만들고 update()로 상태 부분만 갱신한다(나중에 <video>가 다시 그려지지 않도록).
//
// [연결 위치] A(좌표 추출) 파트:
//   const { video, overlay } = camera.getElements();
//   video.srcObject = await navigator.mediaDevices.getUserMedia({ video: true });
//   → store.setState({ camera: { connected: true } })
//   overlay(canvas)에는 onLandmarks 결과로 귀·어깨 점과 선을 그린다.

const SILHOUETTE = `
<svg class="camera__art" viewBox="0 0 160 160" aria-hidden="true">
  <circle cx="80" cy="80" r="78" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.10)"/>
  <path d="M92 40c-14-6-32 2-34 18-1 9 2 15 6 19l-2 13c-12 3-24 10-30 22-3 6-4 14-4 22h96c0-14-4-26-14-34-6-5-12-7-18-8l1-9c8 0 14-4 16-12 2-7 1-13-1-17 6-4 4-11-16-14z"
        fill="rgba(169,156,255,0.10)" stroke="rgba(169,156,255,0.45)" stroke-width="1.5" stroke-dasharray="4 4"/>
  <line x1="78" y1="64" x2="74" y2="102" stroke="#a99cff" stroke-width="2" stroke-dasharray="3 4" stroke-linecap="round"/>
  <circle cx="78" cy="64" r="4.5" fill="#a99cff"/>
  <circle cx="74" cy="102" r="4.5" fill="#a99cff"/>
  <text x="88" y="62" fill="rgba(255,255,255,0.55)" font-size="9">귀</text>
  <text x="84" y="108" fill="rgba(255,255,255,0.55)" font-size="9">어깨</text>
</svg>`;

export function mountCameraPreview(el, { onConnectClick, onDisconnectClick } = {}) {
  el.innerHTML = `
    <section class="card camera-card" aria-label="카메라 미리보기">
      <div class="camera" data-connected="false">
        <video class="camera__video" playsinline muted hidden></video>
        <canvas class="camera__overlay" hidden></canvas>

        <div class="camera__grid" aria-hidden="true"></div>
        <span class="camera__corner camera__corner--tl"></span>
        <span class="camera__corner camera__corner--tr"></span>
        <span class="camera__corner camera__corner--bl"></span>
        <span class="camera__corner camera__corner--br"></span>

        <div class="camera__top">
          <button type="button" class="camera__badge" data-role="cam-badge">
            <span class="camera__badge-dot"></span><span data-role="cam-badge-text">카메라 OFF</span>
          </button>
          <span class="camera__badge camera__badge--ghost">
            ${icon('cpu', { size: 14 })}<span data-role="pose-badge">MediaPipe Pose · 미연결</span>
          </span>
        </div>

        <div class="camera__empty" data-role="empty">
          <div class="camera__art-wrap">
            ${SILHOUETTE}
            <span class="camera__art-badge">${icon('cameraOff', { size: 18 })}</span>
          </div>
          <h2 class="camera__title">카메라 연결 전</h2>
          <p class="camera__desc">카메라를 연결하면 자세 분석을 시작할 수 있습니다.</p>
          <button type="button" class="btn btn--light" data-role="connect">
            ${icon('camera', { size: 18 })}<span>카메라 연결</span>
          </button>
        </div>

        <div class="camera__viewer-wait" data-role="viewer-wait" hidden>
          <h2 class="camera__title">폰 카메라 연결 대기 중</h2>
          <p class="camera__desc">폰 브라우저로 아래 주소를 열면 자동으로 연결됩니다.</p>
          <p class="camera__code" data-role="viewer-url">연결 준비 중...</p>
          <p class="camera__code camera__code--big" data-role="viewer-code"></p>
        </div>

        <div class="camera__metric" aria-label="목 기울기 각도">
          <span class="camera__metric-label">목 기울기 각도</span>
          <strong class="camera__metric-value" data-role="angle">—</strong>
          <span class="camera__metric-sub" data-role="angle-sub">측정 전</span>
        </div>

        <div class="camera__bar">
          ${icon('camera', { size: 16 })}
          <span data-role="bar-text">카메라가 연결되지 않았습니다.</span>
        </div>
      </div>
    </section>
  `;

  const root = el.querySelector('.camera');
  const video = el.querySelector('.camera__video');
  const overlay = el.querySelector('.camera__overlay');
  const q = (role) => el.querySelector(`[data-role="${role}"]`);
  q('connect').addEventListener('click', () => onConnectClick?.());
  q('cam-badge').addEventListener('click', () => {
    if (root.dataset.connected === 'true') onDisconnectClick?.();
  });

  let lastState = null;
  let waiting = null; // null | { url, code }

  function paint() {
    if (!lastState) return;
    const { connected } = lastState.camera;
    root.dataset.connected = String(connected);
    q('empty').hidden = connected || Boolean(waiting);
    q('viewer-wait').hidden = connected || !waiting;
    if (waiting) {
      q('viewer-url').textContent = waiting.url || '연결 준비 중...';
      q('viewer-code').textContent = waiting.code || '';
    }
    video.hidden = !connected;
    overlay.hidden = !connected;
    q('cam-badge-text').textContent = connected ? '카메라 ON (클릭하여 끄기)' : '카메라 OFF';
    q('bar-text').textContent = connected ? '카메라가 연결되었습니다.' : '카메라가 연결되지 않았습니다.';

    const { angle } = lastState.posture;
    const hasAngle = typeof angle === 'number';
    q('angle').textContent = hasAngle ? `${angle.toFixed(0)}°` : '—';
    q('angle-sub').textContent = hasAngle ? '실시간 측정값' : '측정 전';
  }

  return {
    getElements: () => ({ video, overlay }),
    // 폰 카메라를 기다리는 동안 방 코드/접속 주소를 보여준다. info가 없으면 숨긴다.
    showViewerWait(info) {
      waiting = info ?? {};
      paint();
    },
    hideViewerWait() {
      waiting = null;
      paint();
    },
    setPoseStatus(text) {
      q('pose-badge').textContent = `MediaPipe Pose · ${text}`;
    },
    update(state) {
      lastState = state;
      paint();
    },
  };
}
