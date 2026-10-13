import { icon } from '../icons.js';
import { NOTIFY_LEVELS } from '../notify.js';

// 알림 오버레이(alert-overlay.js)의 거북이 그림을 작게 줄인 아이콘
const TURTLE_MINI = `
<svg class="turtle-mini" width="30" height="16" viewBox="0 0 120 64" aria-hidden="true">
  <rect x="26" y="40" width="10" height="16" rx="5" fill="#3f6427"/>
  <rect x="70" y="40" width="10" height="16" rx="5" fill="#3f6427"/>
  <path d="M14 40 L4 44 L15 46 Z" fill="#9cc26a"/>
  <rect x="88" y="30" width="18" height="10" rx="5" fill="#9cc26a"/>
  <ellipse cx="108" cy="32" rx="10" ry="8" fill="#9cc26a"/>
  <circle cx="111" cy="29" r="1.8" fill="#1f2a24"/>
  <rect x="34" y="42" width="11" height="17" rx="5.5" fill="#9cc26a"/>
  <rect x="78" y="42" width="11" height="17" rx="5.5" fill="#9cc26a"/>
  <path d="M14 44 Q16 8 54 8 Q92 8 94 44 Z" fill="#5c8a3a"/>
  <path d="M14 44 H94" stroke="#3f6427" stroke-width="4" stroke-linecap="round"/>
</svg>`;

const CHANNELS = [
  { key: 'system', icon: icon('monitor', { size: 20 }), label: 'Windows 알림' },
  { key: 'overlay', icon: icon('panelTop', { size: 20 }), label: '화면 경고창' },
  { key: 'turtles', icon: TURTLE_MINI, label: '거북이 등장' },
];

const LEVEL_IDS = Object.keys(NOTIFY_LEVELS);

function channelState(conf, key) {
  if (key === 'turtles') return conf.turtles > 0 ? { on: true, text: `${conf.turtles}마리` } : { on: false, text: '꺼짐' };
  const on = Boolean(conf.channels[key]);
  return { on, text: on ? '켜짐' : '꺼짐' };
}

// 알림 강도 설정 카드. 선택 상태는 이 컴포넌트가 들고, 바뀌면 onChange로 알린다.
export function mountNotifySettings(el, { initialLevel, onChange, onPreview } = {}) {
  el.innerHTML = `
    <section class="card notify-card" aria-labelledby="notify-title">
      <div class="card__head notify-card__head">
        <h2 class="card__title" id="notify-title">${icon('bell', { size: 20, className: 'card__title-icon' })}알림 강도 설정</h2>
        <p class="card__desc">내게 맞는 자세 알림 방식을 선택하세요.</p>
      </div>

      <div class="level-picker" role="radiogroup" aria-labelledby="notify-title">
        ${LEVEL_IDS.map((id) => `
          <button type="button" class="level-picker__btn" role="radio" data-level="${id}">${NOTIFY_LEVELS[id].label}</button>`).join('')}
      </div>

      <div class="notify-detail" aria-live="polite">
        <strong class="notify-detail__title">선택한 강도: <span data-role="level-label"></span></strong>
        <p class="notify-detail__summary" data-role="summary"></p>
        <ul class="notify-channels">
          ${CHANNELS.map((c) => `
            <li class="notify-channel" data-channel="${c.key}">
              <span class="notify-channel__icon">${c.icon}</span>
              <span class="notify-channel__label">${c.label}</span>
              <span class="state-chip" data-role="state"></span>
            </li>`).join('')}
        </ul>
      </div>

      <button type="button" class="btn btn--primary btn--block" data-role="preview">
        ${icon('bell', { size: 18 })}<span>알림 미리보기</span>
      </button>
    </section>
  `;

  const buttons = [...el.querySelectorAll('.level-picker__btn')];
  let level = NOTIFY_LEVELS[initialLevel] ? initialLevel : LEVEL_IDS[0];

  function paint() {
    const conf = NOTIFY_LEVELS[level];
    buttons.forEach((btn) => {
      const selected = btn.dataset.level === level;
      btn.setAttribute('aria-checked', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    });
    el.querySelector('[data-role="level-label"]').textContent = conf.label;
    el.querySelector('[data-role="summary"]').textContent = conf.summary;
    el.querySelectorAll('.notify-channel').forEach((row) => {
      const { on, text } = channelState(conf, row.dataset.channel);
      row.dataset.on = String(on);
      row.querySelector('[data-role="state"]').textContent = text;
    });
  }

  function select(next, { focus = false } = {}) {
    if (!NOTIFY_LEVELS[next]) return;
    const changed = next !== level;
    level = next;
    paint();
    if (focus) buttons.find((b) => b.dataset.level === next)?.focus();
    if (changed) onChange?.(level);
  }

  buttons.forEach((btn) => btn.addEventListener('click', () => select(btn.dataset.level)));

  // 라디오 그룹 키보드 이동(좌우 화살표)
  el.querySelector('.level-picker').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = LEVEL_IDS.indexOf(level);
    select(LEVEL_IDS[(i + step + LEVEL_IDS.length) % LEVEL_IDS.length], { focus: true });
  });

  el.querySelector('[data-role="preview"]').addEventListener('click', () => onPreview?.(level));

  paint();
  return { getLevel: () => level };
}
