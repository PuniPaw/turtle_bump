// 알림 강도 설정과 알림 실행.
// 지금은 "알림 미리보기"에서만 호출한다. 감지 결과·통계와는 연결되어 있지 않다.
// [연결 위치] 나중에 판정 로직이 붙으면 runNotification(loadNotifyLevel(), { ... })을 같은 방식으로 호출한다.

export const NOTIFY_LEVELS = {
    weak: {
    label: '약함',
    summary: 'Windows 알림만 표시',
    channels: { system: true, banner: false, sound: false },
    },
    medium: {
    label: '중간',
    summary: 'Windows 알림 + 화면 경고 배너',
    channels: { system: true, banner: true, sound: false },
    },
    strong: {
    label: '강함',
    summary: 'Windows 알림 + 화면 경고 배너 + 알림음',
    channels: { system: true, banner: true, sound: true },
    },
};

export const DEFAULT_NOTIFY_LEVEL = 'medium';
const STORAGE_KEY = 'neckcare.notifyLevel';

export function isNotifyLevel(value) {
    return typeof value === 'string' && Object.hasOwn(NOTIFY_LEVELS, value);
}

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
}

// 결과: 'shown' | 'denied' | 'unsupported'
async function showSystemNotification(title, body) {
    if (!('Notification' in window)) return 'unsupported';
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';
    new Notification(title, { body, icon: 'favicon.svg', tag: 'neckcare-posture' });
    return 'shown';
}

function playChime() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    const ctx = new AudioCtx();
    const start = ctx.currentTime;
    [880, 660].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = start + i * 0.22;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.21);
    });
    setTimeout(() => ctx.close(), 800);
    return true;
}

// 강도에 맞는 채널로 알림을 띄운다. 화면 배너는 store를 쓰는 쪽(showBanner)이 그린다.
// 사용자 클릭 직후 동기적으로 소리를 먼저 재생해야 브라우저 자동재생 제한에 걸리지 않는다.
export async function runNotification(level, { title, message, showBanner } = {}) {
    const { channels } = NOTIFY_LEVELS[isNotifyLevel(level) ? level : DEFAULT_NOTIFY_LEVEL];
    const result = { system: 'off', banner: 'off', sound: 'off' };
    if (channels.sound) result.sound = playChime() ? 'played' : 'unsupported';
    if (channels.banner) {
    showBanner?.({ title, message });
    result.banner = 'shown';
    }
    if (channels.system) result.system = await showSystemNotification(title, message);
    return result;
}