import { formatDateTime } from '../utils/format.js';

const ANALYSIS_LABEL = {
  idle: { text: '분석 대기 중', tone: 'idle' },
  running: { text: '실시간 분석 중', tone: 'good' },
};

export function mountHeader(el) {
  el.innerHTML = `
    <div class="header__text">
      <h1 class="header__title">안녕하세요!</h1>
      <p class="header__sub">NeckCare가 웹캠으로 목 자세를 살펴보고, 거북목이 길어지기 전에 알려드려요.</p>
    </div>
    <div class="header__meta">
      <span class="pill" data-role="analysis"><span class="pill__dot"></span><span data-role="analysis-text"></span></span>
      <time class="header__time" data-role="clock"></time>
    </div>
  `;

  const clock = el.querySelector('[data-role="clock"]');
  const tick = () => {
    const now = new Date();
    clock.textContent = formatDateTime(now);
    clock.dateTime = now.toISOString();
  };
  tick();
  setInterval(tick, 15_000);

  const pill = el.querySelector('[data-role="analysis"]');
  const pillText = el.querySelector('[data-role="analysis-text"]');

  return {
    update(state) {
      const s = ANALYSIS_LABEL[state.analysis.status] ?? ANALYSIS_LABEL.idle;
      pill.dataset.tone = s.tone;
      pillText.textContent = s.text;
    },
  };
}