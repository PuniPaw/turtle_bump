import { icon } from '../icons.js';
import { PERIODS } from '../state.js';
import { formatMinutes, escapeHtml } from '../utils/format.js';

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

// 거북목 발생 빈도 카드: 요약(비율 링 + 횟수 + 누적 시간) + 추이 선 그래프.
// [연결 위치] D(통계) 파트가 getStats() 결과를 store.setState({ stats, trend })로 넣으면 갱신된다.
export function mountFrequencyChart(el, { onPeriodChange } = {}) {
  el.innerHTML = `
    <section class="card freq-card" aria-label="거북목 발생 빈도">
      <div class="card__head">
        <h2 class="card__title">거북목 발생 빈도
          <span class="tip" tabindex="0" aria-label="분석한 시간 중 거북목 자세로 판정된 시간의 비율입니다.">
            ${icon('info', { size: 16 })}
            <span class="tip__bubble" role="tooltip">분석한 시간 중 거북목 자세로 판정된 시간의 비율입니다.</span>
          </span>
        </h2>
        <span class="chip" data-tone="idle" data-role="data-chip">데이터 없음</span>
      </div>

      <div class="freq-summary">
        <div class="ring" role="img" data-role="ring-label">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle cx="50" cy="50" r="${RING_R}" class="ring__track"/>
            <circle cx="50" cy="50" r="${RING_R}" class="ring__value" data-role="ring"
                    stroke-dasharray="0 ${RING_C}" transform="rotate(-90 50 50)"/>
          </svg>
          <div class="ring__center"><strong data-role="rate">0%</strong><span data-role="period-caption">최근 1시간</span></div>
        </div>
        <dl class="freq-summary__list">
          <div><dt>${icon('triangleAlert', { size: 16 })}거북목 발생 횟수</dt><dd data-role="count">0회</dd></div>
          <div><dt>${icon('clock', { size: 16 })}분석 누적 시간</dt><dd data-role="total">0분</dd></div>
        </dl>
      </div>

      <div class="freq-trend">
        <div class="freq-trend__head">
          <h3 class="card__subtitle">거북목 발생 빈도 추이</h3>
          <div class="segmented" role="tablist" aria-label="기간 선택">
            ${PERIODS.map((p) => `<button type="button" role="tab" class="segmented__btn" data-period="${p.id}">${p.label}</button>`).join('')}
          </div>
        </div>
        <div class="chart" data-role="chart"></div>
        <div class="chart__legend"><span class="legend-dot"></span>거북목 발생 비율 (%)</div>
        <p class="empty-note" data-role="empty-note">${icon('chartLine', { size: 16 })}<span>분석 데이터가 아직 없습니다.</span></p>
      </div>
    </section>
  `;

  const q = (role) => el.querySelector(`[data-role="${role}"]`);
  const chartHost = q('chart');
  let lastState = null;

  el.querySelector('.segmented').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-period]');
    if (btn) onPeriodChange?.(btn.dataset.period);
  });

  new ResizeObserver(() => lastState && drawChart(chartHost, lastState.trend.points)).observe(chartHost);

  return {
    update(state) {
      lastState = state;
      const { stats, trend } = state;
      const rate = Math.max(0, Math.min(100, stats.turtleRate));
      const periodLabel = PERIODS.find((p) => p.id === trend.period)?.label ?? '';

      q('rate').textContent = `${Math.round(rate)}%`;
      q('ring').setAttribute('stroke-dasharray', `${(RING_C * rate) / 100} ${RING_C}`);
      q('ring').style.visibility = rate > 0 ? 'visible' : 'hidden'; // 0%일 때 둥근 끝점이 찍히지 않게
      q('ring-label').setAttribute('aria-label', `거북목 발생 비율 ${Math.round(rate)}%`);
      q('period-caption').textContent = periodLabel;
      q('count').textContent = `${stats.turtleCount}회`;
      q('total').textContent = formatMinutes(stats.totalMinutes);
      q('data-chip').hidden = stats.hasRecords;
      q('empty-note').hidden = stats.hasRecords;

      el.querySelectorAll('[data-period]').forEach((b) => {
        const active = b.dataset.period === trend.period;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });

      drawChart(chartHost, trend.points);
    },
  };
}

function drawChart(host, points) {
  const w = Math.max(240, host.clientWidth);
  const h = 190;
  const pad = { t: 12, r: 14, b: 30, l: 40 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const n = points.length;
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => pad.t + ih * (1 - Math.max(0, Math.min(100, v)) / 100);

  const longest = Math.max(1, ...points.map((p) => p.label.length));
  const maxLabels = Math.max(2, Math.floor(iw / (longest * 11 + 18)));
  const step = Math.ceil(n / maxLabels);

  const grid = [0, 25, 50, 75, 100].map((v) => `
    <line class="chart__grid${v === 0 ? ' chart__grid--base' : ''}" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="chart__axis" x="${pad.l - 10}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join('');

  const xLabels = points.map((p, i) => {
    const show = i === n - 1 || (i % step === 0 && n - 1 - i >= step * 0.6);
    return show ? `<text class="chart__axis" x="${x(i)}" y="${h - 8}" text-anchor="middle">${escapeHtml(p.label)}</text>` : '';
  }).join('');

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : '';
  const dots = points.map((p, i) => `<circle class="chart__dot" cx="${x(i)}" cy="${y(p.rate)}" r="3"><title>${escapeHtml(p.label)}: ${p.rate}%</title></circle>`).join('');

  host.innerHTML = `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="거북목 발생 빈도 추이 그래프">
      <defs>
        <linearGradient id="freqArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--primary)" stop-opacity="0.22"/>
          <stop offset="1" stop-color="var(--primary)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#freqArea)"/>
      <path class="chart__line" d="${line}"/>
      ${dots}
      ${xLabels}
    </svg>`;
}