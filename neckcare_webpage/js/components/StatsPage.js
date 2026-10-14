import { icon } from '../icons.js';
import { escapeHtml } from '../utils/format.js';

// 통계 화면. state.report만 보고 그린다. 값은 D 파트 조회 결과(stats-source.js)로만 채워지고,
// 결과가 없으면 "—"와 빈 상태 안내를 보여준다(0과 "데이터 없음"을 구분).

const DASH = '—';

const PERIODS = [
  { id: 'today', label: '오늘' },
  { id: 'week', label: '7일' },
  { id: 'month', label: '30일' },
];

const BAD_TYPES = [
  { id: 'turtle', label: '거북목' },
  { id: 'shrimp', label: '새우등' },
];

const UNITS = [
  { id: 'day', label: '일별 보기' },
  { id: 'week', label: '주별 보기' },
];

const RECORD_FILTERS = [
  { id: 'all', label: '전체 자세' },
  { id: 'turtle', label: '거북목' },
  { id: 'shrimp', label: '새우등' },
];

const DEFAULT_CAPTION = '지금까지 기록된 세션의 분석 결과를 불러옵니다.';

// 자세 유형 표시(색·표식). 새우등은 🦐
const TYPES = {
  good: { label: '바른 자세', color: '#5ed6a6', mark: '<span class="st-dot" style="--c:#5ed6a6"></span>' },
  turtle: { label: '거북목', color: '#7c6cf0', mark: `<span class="st-mark st-mark--turtle">${icon('personStanding', { size: 20 })}</span>` },
  shrimp: { label: '새우등', color: '#ff8fab', mark: '<span class="st-mark st-mark--shrimp" aria-hidden="true">🦐</span>' },
  other: { label: '기타', color: '#e3ddfb', mark: '<span class="st-dot" style="--c:#e3ddfb"></span>' },
};

// ---- 포맷 ----------------------------------------------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

function fmtDuration(sec) {
  if (!isNum(sec)) return DASH;
  const s = Math.abs(sec);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}시간 ${m}분` : `${h}시간`;
  }
  if (s >= 60) return `${Math.round(s / 60)}분`;
  return `${round1(s)}초`;
}

function fmtClock(ts) {
  if (!isNum(ts)) return DASH;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 요약 카드 정의. better: 값이 커지는 쪽이 좋은지(up) 작아지는 쪽이 좋은지(down)
const SUMMARY = {
  measured: { key: 'measuredSec', better: 'up', value: fmtDuration, diff: (d) => fmtDuration(d), pct: true },
  bad: { better: 'down', value: (v) => (isNum(v) ? `${v}회` : DASH), diff: (d) => `${Math.abs(d)}회`, pct: true },
  good: { key: 'goodRatio', better: 'up', value: (v) => (isNum(v) ? `${round1(v)}%` : DASH), diff: (d) => `${round1(Math.abs(d))}%p`, pct: false },
  avg: { key: 'avgDurationSec', better: 'down', value: fmtDuration, diff: (d) => fmtDuration(d), pct: true },
};

// 이전 기간 대비 변화: 이번·이전 값이 모두 실제로 있을 때만 계산한다(임의 생성 없음).
function changeView(conf, metric) {
  if (!metric || !isNum(metric.value) || !isNum(metric.prev)) return { text: DASH, tone: 'none' };
  const d = metric.value - metric.prev;
  if (d === 0) return { text: '변화 없음', tone: 'none' };
  const up = d > 0;
  const pct = conf.pct && metric.prev !== 0 ? ` (${Math.round(Math.abs(d / metric.prev) * 100)}%)` : '';
  const sign = up ? '+' : '-';
  return {
    text: `${up ? '▲' : '▼'} ${sign}${conf.diff(d)}${pct}`,
    tone: (up ? 'up' : 'down') === conf.better ? 'good' : 'bad',
  };
}

function segmented(name, items, cls) {
  return `<div class="${cls}" role="radiogroup" data-group="${name}">
    ${items.map((it) => `<button type="button" role="radio" data-value="${it.id}">${it.label}</button>`).join('')}
  </div>`;
}

function select(name, items, label) {
  return `<label class="st-select"><span class="sr-only">${label}</span>
    <select data-select="${name}">${items.map((it) => `<option value="${it.id}">${it.label}</option>`).join('')}</select>
    ${icon('chevronDown', { size: 16, className: 'st-select__icon' })}
  </label>`;
}

export function mountStatsPage(el, handlers = {}) {
  el.innerHTML = `
    <div class="stats">
      <header class="st-head">
        <div>
          <h1 class="st-head__title">통계</h1>
          <p class="st-head__sub">나의 자세 습관을 한눈에 확인해보세요.</p>
        </div>
        <div class="st-head__actions">
          <div class="st-load">
            <button type="button" class="st-load__btn" data-role="load">${icon('download', { size: 20 })}<span>분석 결과 불러오기</span></button>
            <p class="st-load__caption" data-role="caption" aria-live="polite">${DEFAULT_CAPTION}</p>
          </div>
          ${segmented('period', PERIODS, 'st-period')}
        </div>
      </header>

      <div class="st-summary">
        <article class="card st-sum" data-card="measured">
          <div class="st-sum__icon">${icon('clock', { size: 24 })}</div>
          <h2 class="st-sum__title">총 측정 시간</h2>
          <strong class="st-sum__value" data-role="value">${DASH}</strong>
          <p class="st-sum__change" data-role="change" data-tone="none">${DASH}</p>
        </article>
        <article class="card st-sum st-sum--toggle" data-card="bad">
          <div class="st-sum__row">
            <div class="st-sum__icon">${icon('personStanding', { size: 24 })}</div>
            <div class="st-sum__row-text">
              <h2 class="st-sum__title">잘못된 자세 발생 횟수</h2>
              ${segmented('countType', BAD_TYPES, 'st-toggle')}
            </div>
          </div>
          <strong class="st-sum__value" data-role="value">${DASH}</strong>
          <p class="st-sum__change" data-role="change" data-tone="none">${DASH}</p>
        </article>
        <article class="card st-sum" data-card="good">
          <div class="st-sum__icon">${icon('personStanding', { size: 24 })}</div>
          <h2 class="st-sum__title">바른 자세 비율</h2>
          <strong class="st-sum__value" data-role="value">${DASH}</strong>
          <p class="st-sum__change" data-role="change" data-tone="none">${DASH}</p>
        </article>
        <article class="card st-sum" data-card="avg">
          <div class="st-sum__icon">${icon('timer', { size: 24 })}</div>
          <h2 class="st-sum__title">평균 지속 시간</h2>
          <strong class="st-sum__value" data-role="value">${DASH}</strong>
          <p class="st-sum__change" data-role="change" data-tone="none">${DASH}</p>
        </article>
      </div>

      <div class="st-mid">
        <section class="card st-trend" aria-label="잘못된 자세 발생 추이">
          <div class="st-card-head">
            <h2 class="st-card-head__title">잘못된 자세 발생 추이</h2>
            <div class="st-card-head__controls">
              ${segmented('trendType', BAD_TYPES, 'st-toggle')}
              ${select('trendUnit', UNITS, '집계 단위')}
            </div>
          </div>
          <p class="st-card-sub">선택한 기간 동안의 잘못된 자세 발생 횟수 변화를 확인하세요.</p>
          <div class="st-chart-wrap">
            <div class="st-chart" data-role="chart"></div>
            <div class="st-empty st-empty--overlay" data-role="trend-empty">
              <span class="st-empty__icon">${icon('chartLine', { size: 22 })}</span>
              <strong>아직 분석 결과가 없습니다.</strong>
              <span>분석 결과를 불러오면 자세 발생 추이가 표시됩니다.</span>
            </div>
          </div>
        </section>

        <section class="card st-dist" aria-label="자세 유형 비율">
          <h2 class="st-card-head__title">자세 유형 비율</h2>
          <p class="st-card-sub">선택한 기간 동안의 자세 유형 분포입니다.</p>
          <div class="st-dist__body">
            <div class="st-donut" data-role="donut"></div>
            <ul class="st-legend" data-role="legend"></ul>
          </div>
        </section>
      </div>

      <section class="card st-records" aria-label="자세 감지 기록">
        <div class="st-card-head">
          <div>
            <h2 class="st-card-head__title">자세 감지 기록</h2>
            <p class="st-card-sub">최근 감지된 자세 기록입니다.</p>
          </div>
          ${select('recordFilter', RECORD_FILTERS, '자세 필터')}
        </div>
        <div class="st-table-wrap">
          <table class="st-table">
            <thead><tr><th scope="col">시간</th><th scope="col">자세 상태</th><th scope="col">지속 시간</th><th scope="col">메모</th></tr></thead>
            <tbody data-role="rows"></tbody>
          </table>
          <p class="st-empty" data-role="records-empty">아직 감지 기록이 없습니다.</p>
        </div>
      </section>
    </div>
  `;

  const q = (role) => el.querySelector(`[data-role="${role}"]`);
  const chartHost = q('chart');
  let last = null;

  el.querySelector('[data-role="load"]').addEventListener('click', () => handlers.onLoad?.());
  el.querySelectorAll('[data-group]').forEach((group) => {
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (btn) handlers.onChange?.(group.dataset.group, btn.dataset.value);
    });
  });
  el.querySelectorAll('[data-select]').forEach((sel) => {
    sel.addEventListener('change', () => handlers.onChange?.(sel.dataset.select, sel.value));
  });

  new ResizeObserver(() => last && drawTrend(chartHost, trendPoints(last))).observe(chartHost);

  // 지금 선택(기간·단위)과 같은 조건으로 받은 데이터만 보여준다.
  function currentData(r) {
    return r.data && r.dataKey === `${r.period}:${r.trendUnit}` ? r.data : null;
  }

  function trendPoints(r) {
    const data = currentData(r);
    const pts = data?.trend?.[r.trendType];
    return Array.isArray(pts) && pts.length ? pts : null;
  }

  function paintGroups(r) {
    const values = { period: r.period, countType: r.countType, trendType: r.trendType };
    el.querySelectorAll('[data-group]').forEach((group) => {
      group.querySelectorAll('[data-value]').forEach((btn) => {
        const on = btn.dataset.value === values[group.dataset.group];
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-checked', String(on));
      });
    });
    el.querySelectorAll('[data-select]').forEach((sel) => {
      const v = { trendUnit: r.trendUnit, recordFilter: r.recordFilter }[sel.dataset.select];
      if (sel.value !== v) sel.value = v;
    });
  }

  function paintCaption(r) {
    const cap = q('caption');
    const btn = q('load');
    const lastAt = isNum(r.lastLoadedAt) ? ` · 마지막 조회 ${fmtClock(r.lastLoadedAt)}` : '';
    const text = {
      unavailable: r.attempted ? '통계 데이터 연동 준비 중입니다.' : DEFAULT_CAPTION,
      idle: DEFAULT_CAPTION,
      loading: '분석 결과를 불러오는 중이에요…',
      success: `저장 완료된 기록 기준${lastAt}`,
      empty: `선택한 기간에 저장된 분석 결과가 없습니다${lastAt}`,
      error: `불러오지 못했어요. 이전 결과를 유지합니다${lastAt}`,
    }[r.status] ?? DEFAULT_CAPTION;
    cap.textContent = text;
    cap.dataset.status = r.status;
    btn.disabled = r.status === 'loading';
  }

  function paintSummary(r) {
    const s = currentData(r)?.summary ?? {};
    for (const [card, conf] of Object.entries(SUMMARY)) {
      const key = card === 'bad' ? (r.countType === 'shrimp' ? 'shrimpCount' : 'turtleCount') : conf.key;
      const metric = s[key] ?? null;
      const root = el.querySelector(`[data-card="${card}"]`);
      root.querySelector('[data-role="value"]').textContent = metric ? conf.value(metric.value) : DASH;
      const ch = changeView(conf, metric);
      const chEl = root.querySelector('[data-role="change"]');
      chEl.textContent = ch.text;
      chEl.dataset.tone = ch.tone;
    }
  }

  function paintDistribution(r) {
    const dist = currentData(r)?.distribution;
    const items = Array.isArray(dist?.items) ? dist.items : [];
    const byType = Object.fromEntries(items.map((it) => [it.type, it]));
    q('donut').innerHTML = donutSvg(items, dist?.totalSec);
    q('legend').innerHTML = Object.entries(TYPES).map(([type, t]) => {
      const it = byType[type];
      return `<li class="st-legend__item">
        ${t.mark}
        <span class="st-legend__text"><strong>${t.label}</strong><small>${it ? fmtDuration(it.sec) : DASH}</small></span>
        <span class="st-legend__pct">${it && isNum(it.ratio) ? `${round1(it.ratio)}%` : DASH}</span>
      </li>`;
    }).join('');
  }

  function paintRecords(r) {
    const records = Array.isArray(currentData(r)?.records) ? currentData(r).records : [];
    const rows = r.recordFilter === 'all' ? records : records.filter((rec) => rec.type === r.recordFilter);
    q('rows').innerHTML = rows.map((rec) => {
      const t = TYPES[rec.type] ?? { label: escapeHtml(rec.type), mark: '' };
      // 메모: 전체 보기에서 거북목·새우등만 유형 이름, 나머지는 "—"
      const memo = r.recordFilter === 'all' && (rec.type === 'turtle' || rec.type === 'shrimp') ? t.label : DASH;
      return `<tr>
        <td>${fmtClock(rec.startedAt)}</td>
        <td><span class="st-state">${t.mark}${t.label}</span></td>
        <td>${isNum(rec.durationSec) ? fmtDuration(rec.durationSec) : DASH}</td>
        <td>${memo}</td>
      </tr>`;
    }).join('');
    q('records-empty').hidden = rows.length > 0;
  }

  return {
    update(state) {
      const r = state.report;
      last = r;
      paintGroups(r);
      paintCaption(r);
      paintSummary(r);
      const pts = trendPoints(r);
      q('trend-empty').hidden = Boolean(pts);
      drawTrend(chartHost, pts);
      paintDistribution(r);
      paintRecords(r);
    },
  };
}

// ---- 도넛 ----------------------------------------------------------------
function donutSvg(items, totalSec) {
  const R = 74;
  const C = 2 * Math.PI * R;
  const valid = items.filter((it) => isNum(it.ratio) && it.ratio > 0 && TYPES[it.type]);
  let offset = 0;
  const arcs = valid.map((it) => {
    const len = (C * it.ratio) / 100;
    const arc = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${TYPES[it.type].color}" stroke-width="34"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"/>`;
    offset += len;
    return arc;
  }).join('');
  return `
    <svg viewBox="0 0 200 200" role="img" aria-label="자세 유형 비율 ${valid.length ? '' : '(데이터 없음)'}">
      <circle cx="100" cy="100" r="${R}" fill="none" stroke="#eeecf6" stroke-width="34"/>
      ${arcs}
    </svg>
    <div class="st-donut__center"><span>전체</span><strong>${fmtDuration(totalSec)}</strong></div>`;
}

// ---- 추이 그래프 -----------------------------------------------------------
function niceMax(max) {
  if (max <= 5) return 5;
  const raw = max / 5;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find((m) => m * pow >= raw) * pow;
  return step * 5;
}

function drawTrend(host, points) {
  const w = Math.max(260, host.clientWidth);
  const h = 230;
  const pad = { t: 18, r: 24, b: 30, l: 62 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const rows = [0, 1, 2, 3, 4, 5];
  const yAt = (ratio) => pad.t + ih * (1 - ratio);

  // 데이터가 없으면 눈금 숫자 없이 빈 격자만 그린다.
  if (!points) {
    host.innerHTML = `
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
        ${rows.map((i) => `<line class="st-grid${i === 0 ? ' st-grid--base' : ''}" x1="${pad.l}" x2="${w - pad.r}" y1="${yAt(i / 5)}" y2="${yAt(i / 5)}"/>`).join('')}
        <text class="st-axis-label" transform="translate(16 ${pad.t + ih / 2}) rotate(-90)" text-anchor="middle">발생 횟수 (회)</text>
      </svg>`;
    return;
  }

  const counts = points.map((p) => (isNum(p.count) ? p.count : 0));
  const top = niceMax(Math.max(...counts));
  const n = points.length;
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => yAt(v / top);
  const step = Math.ceil(n / Math.max(2, Math.floor(iw / 64)));
  const line = counts.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const lx = x(n - 1);
  const ly = y(counts[n - 1]);

  host.innerHTML = `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="잘못된 자세 발생 추이 그래프">
      <defs><linearGradient id="stTrendArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--primary)" stop-opacity="0.22"/><stop offset="1" stop-color="var(--primary)" stop-opacity="0"/>
      </linearGradient></defs>
      ${rows.map((i) => `
        <line class="st-grid${i === 0 ? ' st-grid--base' : ''}" x1="${pad.l}" x2="${w - pad.r}" y1="${yAt(i / 5)}" y2="${yAt(i / 5)}"/>
        <text class="st-axis" x="${pad.l - 12}" y="${yAt(i / 5) + 4}" text-anchor="end">${(top / 5) * i}</text>`).join('')}
      <text class="st-axis-label" transform="translate(16 ${pad.t + ih / 2}) rotate(-90)" text-anchor="middle">발생 횟수 (회)</text>
      <path d="${area}" fill="url(#stTrendArea)"/>
      <path class="st-line" d="${line}"/>
      ${counts.map((c, i) => `<circle class="st-dot-pt" cx="${x(i)}" cy="${y(c)}" r="4.5"><title>${escapeHtml(points[i].label)}: ${c}회</title></circle>`).join('')}
      <line class="st-guide" x1="${lx}" x2="${lx}" y1="${ly}" y2="${yAt(0)}"/>
      <g transform="translate(${Math.min(lx, w - pad.r - 26)} ${Math.max(ly - 22, 14)})">
        <rect class="st-bubble" x="-28" y="-14" width="56" height="26" rx="8"/>
        <text class="st-bubble__text" x="0" y="4" text-anchor="middle">${counts[n - 1]}회</text>
      </g>
      ${points.map((p, i) => ((i % step === 0 || i === n - 1) ? `<text class="st-axis" x="${x(i)}" y="${h - 8}" text-anchor="middle">${escapeHtml(p.label)}</text>` : '')).join('')}
    </svg>`;
}
