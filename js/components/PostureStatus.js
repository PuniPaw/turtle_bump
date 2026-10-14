import { icon } from '../icons.js';

// 판정 결과(status)를 화면 문구로 바꾸는 표. 판정 자체는 B(판정 로직) 파트가 한다.
const STATUS_VIEW = {
  unknown: {
    tone: 'idle',
    icon: 'hourglass',
    title: '자세 분석 대기 중',
    desc: '아직 자세 분석이 시작되지 않았습니다.',
    judgment: '측정할 수 없음',
  },
  good: { tone: 'good', icon: 'circleCheck', title: '바른 자세', desc: '지금 자세를 유지해 주세요.', judgment: '정상' },
  warn: { tone: 'warn', icon: 'circleAlert', title: '주의 자세', desc: '목이 조금씩 앞으로 나오고 있어요.', judgment: '주의' },
  bad: { tone: 'bad', icon: 'triangleAlert', title: '거북목 자세', desc: '목이 앞으로 많이 기울어져 있어요.', judgment: '거북목' },
};

export function renderPostureStatus(el, state) {
  const view = STATUS_VIEW[state.posture.status] ?? STATUS_VIEW.unknown;
  const { angle } = state.posture;
  const isWaiting = state.posture.status === 'unknown';

  el.innerHTML = `
    <section class="card status-card" data-tone="${view.tone}" aria-label="현재 자세 상태">
      <div class="status-card__main">
        <div class="status-card__icon">${icon(view.icon, { size: 26 })}</div>
        <div>
          <span class="eyebrow">현재 자세 상태</span>
          <h2 class="status-card__title">${view.title}</h2>
          <p class="status-card__desc">${view.desc}</p>
        </div>
      </div>
      <dl class="status-card__facts">
        <div class="fact">
          <dt>거북목 판단</dt>
          <dd><span class="chip" data-tone="${view.tone}">${view.judgment}</span></dd>
        </div>
        <div class="fact">
          <dt>목 기울기 각도</dt>
          <dd class="fact__value">${typeof angle === 'number' ? `${angle.toFixed(0)}°` : '—'}</dd>
        </div>
      </dl>
      ${isWaiting ? `
        <p class="status-card__note">${icon('info', { size: 16 })}<span>카메라와 자세 분석 모델이 연결되면 결과를 확인할 수 있습니다.</span></p>
      ` : ''}
    </section>
  `;
}