import { icon } from '../icons.js';
import { escapeHtml } from '../utils/format.js';

// 나쁜 자세 알림 배너. state.alert가 null이면 숨겨진다.
// [연결 위치] B(판정)가 bad 상태가 badDurationSec 이상 이어진 것을 감지하면:
//   store.setState({ alert: { level: 'bad', title: '거북목 자세가 감지되었습니다', message: '...' } })
export function renderAlertBanner(el, state, { onDismiss } = {}) {
    const alert = state.alert;
    if (!alert) {
    el.hidden = true;
    el.innerHTML = '';
    return;
}
    el.hidden = false;
    el.innerHTML = `
    <section class="alert-banner" data-level="${alert.level === 'warn' ? 'warn' : 'bad'}" role="alert">
    <div class="alert-banner__icon">${icon(alert.level === 'warn' ? 'circleAlert' : 'triangleAlert', { size: 24 })}</div>
    <div class="alert-banner__body">
        <strong>${escapeHtml(alert.title)}</strong>
        <p>${escapeHtml(alert.message)}</p>
    </div>
    <button type="button" class="icon-btn" aria-label="알림 닫기" data-role="dismiss">${icon('x', { size: 18 })}</button>
    </section>
    `;
    el.querySelector('[data-role="dismiss"]').addEventListener('click', () => onDismiss?.());
}