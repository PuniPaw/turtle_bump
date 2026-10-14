// 알림 강도 설정과 알림 실행.
//   - 미리보기: previewNotification(level) — 버튼을 누를 때만 실행, 약 3초 뒤 자동 종료
//   - 실제 감지 알림: startPostureAlert(level) / stopPostureAlert() — 지금은 어디서도 호출하지 않는다.
//     [연결 위치] B(판정) 파트: 거북목으로 판정되면 startPostureAlert(), 정상 자세로 돌아오면 stopPostureAlert().
//     (window.neckcare.alerts.start / stop 으로도 접근 가능)
// 실제 감지 알림은 Chrome 확장 프로그램(turtle-extension)에도 전달되어 다른 웹사이트에 표시된다.
import './alert-overlay.js';

export const NOTIFY_LEVELS = {
  weak: {
    label: '약함',
    summary: 'Windows 알림만 표시',
    channels: { system: true, overlay: false },
    turtles: 0,
  },
  medium: {
    label: '중간',
    summary: 'Windows 알림 + 화면 경고창 + 거북이 1마리',
    channels: { system: true, overlay: true },
    turtles: 1,
  },
  strong: {
    label: '강함',
    summary: 'Windows 알림 + 화면 경고창 + 거북이 10마리',
    channels: { system: true, overlay: true },
    turtles: 10,
  },
};

export const DEFAULT_NOTIFY_LEVEL = 'medium';
const STORAGE_KEY = 'neckcare.notifyLevel';
const PREVIEW_MS = 3000;

// 실제 감지 알림 문구(자세 종류별). kind: 'turtle'(거북목) | 'waist'(허리 굽음)
const LIVE_TEXT = {
  turtle: {
    title: '거북목 자세가 감지되었어요',
    message: '고개를 들고 어깨를 펴 주세요. 바른 자세로 돌아오면 알림이 사라져요.',
  },
  waist: {
    title: '허리 굽음 자세가 감지되었어요',
    message: '허리를 펴고 등을 의자에 기대 주세요. 바른 자세로 돌아오면 알림이 사라져요.',
  },
};
const ALERT_KINDS = Object.keys(LIVE_TEXT);

// 자세 판정이 오래 불가능할 때의 안내(거북이 없이 중앙 상단 경고창만)
const NOTICE_TEXT = {
  title: '자세 판단이 어렵습니다!',
  message: '초기자세 설정을 다시 해주세요.',
};

export function isNotifyLevel(value) {
  return typeof value === 'string' && Object.hasOwn(NOTIFY_LEVELS, value);
}

const normalizeLevel = (level) => (isNotifyLevel(level) ? level : DEFAULT_NOTIFY_LEVEL);

export function loadNotifyLevel() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isNotifyLevel(saved) ? saved : DEFAULT_NOTIFY_LEVEL;
  } catch {
    return DEFAULT_NOTIFY_LEVEL;
  }
}

export function saveNotifyLevel(level) {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // 저장소를 못 쓰는 환경(시크릿 창 등)에서는 이번 세션 동안만 유지된다.
  }
  syncExtensionLevel(level);
}

// Windows(시스템) 알림. 강도와 관계없이 모든 알림이 이 함수 하나를 쓴다.
// 결과: 'shown'(표시됨) | 'denied'(권한 없음) | 'unsupported'(미지원) | 'error'(생성·표시 실패) | 'unknown'(시간 안에 응답 없음)
// 'shown'은 Chrome이 Windows에 알림을 넘겼다는 뜻이다. Windows 방해 금지 모드로 숨겨진 경우까지는 알 수 없다.
const SHOW_WAIT_MS = 3000;

async function showSystemNotification(title, body) {
  if (!('Notification' in window)) return 'unsupported';
  let permission = Notification.permission;
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission();
    } catch (err) {
      console.error('알림 권한 요청 실패', err);
      return 'error';
    }
  }
  if (permission !== 'granted') return 'denied';

  let notification;
  try {
    // 같은 tag를 써서 알림이 쌓이지 않게 하되, renotify로 매번 다시 알린다.
    // (renotify가 없으면 같은 tag의 알림이 남아 있을 때 팝업 없이 조용히 교체된다)
    notification = new Notification(title, { body, icon: 'favicon.svg', tag: 'neckcare-posture', renotify: true });
  } catch (err) {
    console.error('Windows 알림 생성 실패', err);
    return 'error';
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => finish('unknown'), SHOW_WAIT_MS);
    function finish(result) {
      clearTimeout(timer);
      notification.onshow = null;
      notification.onerror = null;
      resolve(result);
    }
    notification.onshow = () => finish('shown');
    notification.onerror = (event) => {
      console.error('Windows 알림 표시 실패', event);
      finish('error');
    };
  });
}

// ---- 확장 프로그램 연결 ------------------------------------------------------
// 이 페이지에도 확장 프로그램 content script가 주입되어 있으면 메시지를 받아 background로 넘긴다.
// 확장 프로그램이 없으면 아무 일도 일어나지 않는다.
function postToExtension(payload) {
  window.postMessage({ source: 'neckcare-app', ...payload }, location.origin);
}

export function syncExtensionLevel(level) {
  postToExtension({ type: 'level', level: normalizeLevel(level) });
}

// 확장 프로그램이 이 페이지보다 늦게 준비되면 현재 강도·알림 상태를 다시 보내 달라고 요청한다.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'neckcare-extension' || e.data.type !== 'hello') return;
  syncExtensionLevel(loadNotifyLevel());
  if (live) postToExtension({ type: 'alert', active: true, level: live.level, kind: live.kind });
});

// ---- 화면 오버레이(경고창 + 거북이) -------------------------------------------
const overlay = globalThis.NeckCareAlertOverlay.create();
let live = null;          // 실제 감지 알림 중이면 { level, kind }
let notice = false;       // "자세 판단이 어렵습니다" 안내 중인지
let previewTimer = null;  // 미리보기 중이면 타이머 id

const liveText = () => LIVE_TEXT[live?.kind] ?? LIVE_TEXT.turtle;

function paintOverlay(level, text) {
  const conf = NOTIFY_LEVELS[level];
  if (!conf.channels.overlay) {
    overlay.hide();
    return;
  }
  overlay.show({ count: conf.turtles, title: text.title, message: text.message });
}

function paintLive() {
  if (live) paintOverlay(live.level, liveText());
  else if (notice) overlay.show({ count: 0, title: NOTICE_TEXT.title, message: NOTICE_TEXT.message });
  else overlay.hide();
}

// 미리보기: 누르는 즉시 시작하고 약 3초 뒤 정리한다.
// 실제 감지 알림이 켜져 있었다면 미리보기가 끝난 뒤 그 상태로 되돌린다.
export async function previewNotification(level, { title, message }) {
  const lv = normalizeLevel(level);
  clearTimeout(previewTimer);
  paintOverlay(lv, { title, message });
  previewTimer = setTimeout(() => {
    previewTimer = null;
    paintLive();
  }, PREVIEW_MS);
  return { system: await showSystemNotification(title, message) };
}

// 실제 감지 알림 시작. kind: 'turtle'(거북목) | 'waist'(허리 굽음). 생략하면 현재 종류 유지(처음이면 거북목).
//   - 같은 강도·같은 종류로 이미 켜져 있으면 아무것도 하지 않는다(거북이 유지, Windows 알림·확장 프로그램 메시지 없음).
//   - 종류만 바뀌면 경고창 문구만 바꾼다(거북이 유지, Windows 알림은 다시 보내지 않음).
//   - 강도가 바뀌면 그 강도로 다시 표시한다(Windows 알림은 다시 보내지 않음).
// Windows 알림 권한은 미리보기 등 사용자 클릭으로 먼저 허용받아 두어야 한다.
export async function startPostureAlert(level = loadNotifyLevel(), { kind } = {}) {
  const lv = normalizeLevel(level);
  const k = ALERT_KINDS.includes(kind) ? kind : (live?.kind ?? 'turtle');
  if (live && live.level === lv && live.kind === k) return { system: 'skipped' };
  const wasActive = Boolean(live);
  const onlyKindChanged = wasActive && live.level === lv;
  live = { level: lv, kind: k };
  notice = false;
  if (!previewTimer) {
    if (onlyKindChanged && NOTIFY_LEVELS[lv].channels.overlay) overlay.update(liveText());
    else paintLive();
  }
  postToExtension({ type: 'alert', active: true, level: lv, kind: k });
  if (wasActive) return { system: 'skipped' };
  const text = liveText();
  return { system: await showSystemNotification(text.title, text.message) };
}

// 정상 자세로 돌아왔을 때: 거북이·경고창을 모두 정리한다.
export function stopPostureAlert() {
  if (!live) return;
  live = null;
  if (!previewTimer) paintLive();
  postToExtension({ type: 'alert', active: false });
}

// "자세 판단이 어렵습니다! 초기자세 설정을 다시 해주세요" 안내(이 페이지의 중앙 상단 경고창).
// 자세 경고는 호출하는 쪽에서 먼저 stopPostureAlert()로 끈다.
export function showRecalibrationNotice() {
  if (notice) return;
  notice = true;
  if (!previewTimer && !live) paintLive();
}

export function hideRecalibrationNotice() {
  if (!notice) return;
  notice = false;
  if (!previewTimer && !live) paintLive();
}

export function isPostureAlertActive() {
  return Boolean(live);
}
