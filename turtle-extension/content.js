// 모든 웹페이지에 주입된다(overlay.js 다음).
//   - 일반 사이트: NeckCare의 실제 거북목 알림 상태에 맞춰 경고창 + 거북이를 표시한다.
//   - NeckCare 페이지(localhost): 페이지가 보내는 알림 상태를 background로 넘긴다.
//     NeckCare 페이지는 웹페이지가 직접 오버레이를 그리므로 여기서는 그리지 않는다.
//   - 팝업의 "현재 탭에서 미리보기": 이 탭에만 약 3초 표시한 뒤 실제 알림 상태로 되돌린다.
(() => {
  if (window.__neckcareTurtleInjected) return;
  window.__neckcareTurtleInjected = true;

  const TURTLES = { weak: 0, medium: 1, strong: 10 };
  const PREVIEW_MS = 3000;
  const HEARTBEAT_MS = 10000;
  const STALE_MS = 30000;   // 이 시간 동안 NeckCare 탭 소식이 없으면 알림을 끈 것으로 본다
  const LIVE_TEXT = {
    title: '거북목 자세가 감지되었어요',
    message: '고개를 들고 어깨를 펴 주세요. 바른 자세로 돌아오면 알림이 사라져요.',
  };
  const PREVIEW_TEXT = {
    title: '[미리보기] 거북목 자세 알림',
    message: '다른 웹사이트에서는 이렇게 표시돼요. 미리보기는 감지 기록과 통계에 남지 않아요.',
  };

  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isApp = isLocal && Boolean(document.querySelector('meta[name="neckcare-app"]'));

  const overlay = NeckCareAlertOverlay.create();
  let alert = { active: false, level: null };
  let heartbeatAt = 0;
  let shownKey = '';          // 지금 그려진 상태(같은 상태면 다시 그리지 않음)
  let previewTimer = null;
  let watchTimer = null;

  const liveActive = () => alert.active && Date.now() - heartbeatAt < STALE_MS;

  function paint(level, text, key) {
    const count = TURTLES[level] || 0;
    if (count === 0) {
      clear();
      return;
    }
    if (shownKey === key) return;
    overlay.show({ count, title: text.title, message: text.message });
    shownKey = key;
    if (!watchTimer) watchTimer = setInterval(watch, 1000);
  }

  function clear() {
    overlay.hide();
    shownKey = '';
    clearInterval(watchTimer);
    watchTimer = null;
  }

  function paintLive() {
    if (previewTimer) return;
    if (!isApp && liveActive()) paint(alert.level, LIVE_TEXT, `live:${alert.level}`);
    else clear();
  }

  // 표시 중일 때만 1초마다: 오래된 알림 정리, 페이지가 오버레이를 지웠으면 다시 붙이기
  function watch() {
    if (!previewTimer && !liveActive()) {
      clear();
      return;
    }
    overlay.ensureMounted();
  }

  // ---- 실제 알림 상태 ----
  chrome.storage.local.get(['neckcareAlert', 'neckcareHeartbeat'], (s) => {
    alert = s.neckcareAlert || alert;
    heartbeatAt = s.neckcareHeartbeat || 0;
    paintLive();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.neckcareHeartbeat) heartbeatAt = changes.neckcareHeartbeat.newValue || 0;
    if (changes.neckcareAlert) {
      alert = changes.neckcareAlert.newValue || { active: false, level: null };
      paintLive();
    }
  });

  // ---- 팝업 미리보기 ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'preview') return;
    const level = TURTLES[msg.level] !== undefined ? msg.level : 'medium';
    clearTimeout(previewTimer);
    previewTimer = null;
    shownKey = '';
    paint(level, PREVIEW_TEXT, `preview:${level}:${Date.now()}`);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      shownKey = '';
      paintLive();
    }, PREVIEW_MS);
    sendResponse({ ok: true, turtles: TURTLES[level] });
  });

  // ---- NeckCare 페이지 → background 중계 ----
  if (!isApp) return;

  let port = null;
  let lastAlert = null;   // 마지막 알림 메시지(재연결 시 다시 보냄)
  let lastLevel = null;

  function send(msg) {
    if (!port) connect();
    try { port && port.postMessage(msg); } catch { port = null; }
  }

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'neckcare-app' });
    } catch {
      port = null;          // 확장 프로그램이 다시 로드된 경우: 페이지 새로고침 필요
      return;
    }
    port.onDisconnect.addListener(() => { port = null; });
    if (lastLevel) port.postMessage(lastLevel);
    if (lastAlert) port.postMessage(lastAlert);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'neckcare-app') return;
    if (d.type === 'alert') {
      lastAlert = { type: 'alert', active: Boolean(d.active), level: d.level || null };
      send(lastAlert);
    } else if (d.type === 'level') {
      lastLevel = { type: 'level', level: d.level };
      send(lastLevel);
    }
  });

  // 알림이 켜져 있는 동안 NeckCare 탭이 살아 있음을 알린다(서비스 워커도 깨어 있게 함).
  setInterval(() => {
    if (lastAlert && lastAlert.active) send({ type: 'heartbeat' });
  }, HEARTBEAT_MS);

  connect();
  // 페이지가 먼저 보낸 메시지를 놓쳤을 수 있으니 현재 상태를 다시 요청한다.
  window.postMessage({ source: 'neckcare-extension', type: 'hello' }, location.origin);
})();
