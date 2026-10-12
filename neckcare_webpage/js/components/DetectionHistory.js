import { icon } from '../icons.js';
import { formatClock, formatSeconds } from '../utils/format.js';

const STATUS_LABEL = { good: '정상', warn: '주의', bad: '거북목' };
const TONE = { good: 'good', warn: 'warn', bad: 'bad' };

// 최근 감지 이력. state.history = [{ ts, durationSec, status }]
export function renderDetectionHistory(el, state) {
  const rows = state.history.slice(0, 6);
  el.innerHTML = `
    <section class="card history-card" aria-label="최근 거북목 감지 기록">
      <div class="card__head">
        <h2 class="card__title">${icon('history', { size: 20, className: 'card__title-icon' })}최근 감지 기록</h2>
      </div>
      <table class="table">
        <thead><tr><th scope="col">시간</th><th scope="col">지속 시간</th><th scope="col">상태</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${formatClock(r.ts)}</td>
              <td>${formatSeconds(r.durationSec)}</td>
              <td><span class="chip chip--sm" data-tone="${TONE[r.status] ?? 'idle'}">${STATUS_LABEL[r.status] ?? '-'}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${rows.length === 0 ? `
        <div class="empty">
          <div class="empty__icon">${icon('inbox', { size: 24 })}</div>
          <p class="empty__title">아직 기록된 자세 분석 결과가 없습니다.</p>
          <p class="empty__desc">분석을 시작하면 거북목이 감지된 시간과 지속 시간이 여기에 쌓여요.</p>
        </div>` : ''}
    </section>
  `;
}
