import { icon } from '../icons.js';
import { formatMinutes, formatSeconds } from '../utils/format.js';

export function StatCard({ iconName, tone = 'primary', label, value, note }) {
  return `
    <article class="stat-card">
      <div class="stat-card__icon" data-tone="${tone}">${icon(iconName, { size: 18 })}</div>
      <div class="stat-card__label">${label}</div>
      <div class="stat-card__value">${value}</div>
      <div class="stat-card__note">${note}</div>
    </article>`;
}

// "거북목 발생 현황" 패널: 주요 수치 4개.
export function renderStatsOverview(el, state) {
  const s = state.stats;
  const noRecord = !s.hasRecords;
  el.innerHTML = `
    <section class="card" aria-label="거북목 발생 현황">
      <div class="card__head">
        <h2 class="card__title">${icon('activity', { size: 20, className: 'card__title-icon' })}거북목 발생 현황</h2>
      </div>
      <div class="stat-grid">
        ${StatCard({ iconName: 'clock', label: '분석 누적 시간', value: formatMinutes(s.totalMinutes), note: noRecord ? '아직 분석하지 않았어요' : '이번 세션 기준' })}
        ${StatCard({ iconName: 'triangleAlert', tone: 'coral', label: '거북목 발생 횟수', value: `${s.turtleCount}회`, note: noRecord ? '감지된 기록 없음' : '이번 세션 기준' })}
        ${StatCard({ iconName: 'timer', tone: 'amber', label: '평균 지속 시간', value: formatSeconds(s.avgDurationSec), note: noRecord ? '기록 없음 · 초기값' : '거북목 1회 평균' })}
        ${StatCard({ iconName: 'hourglass', tone: 'green', label: '최장 지속 시간', value: formatSeconds(s.maxDurationSec), note: noRecord ? '기록 없음 · 초기값' : '가장 길었던 1회' })}
      </div>
    </section>
  `;
}
