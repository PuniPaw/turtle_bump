import { icon } from '../icons.js';
import { NOTIFY_LEVELS } from '../notify.js';

const CHANNELS = [
  { key: 'system', icon: 'monitor', label: 'Windows 알림' },
  { key: 'banner', icon: 'panelTop', label: '화면 경고 배너' },
  { key: 'sound', icon: 'volume2', label: '알림음' },
];

const LEVEL_IDS = Object.keys(NOTIFY_LEVELS);

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
              <span class="notify-channel__icon">${icon(c.icon, { size: 20 })}</span>
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
      const on = conf.channels[row.dataset.channel];
      row.dataset.on = String(on);
      row.querySelector('[data-role="state"]').textContent = on ? '켜짐' : '꺼짐';
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
