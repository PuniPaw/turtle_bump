import { icon, turtleArt } from '../icons.js';
import { NOTIFY_LEVELS } from '../notify.js';

const LEVEL_IDS = Object.keys(NOTIFY_LEVELS);

// 홈 화면 카드에 보이는 강도 이름(동작·저장 값은 notify.js의 weak/medium/strong 그대로)
const DISPLAY_LABEL = { weak: '약함', medium: '중간', strong: '세게' };
// 카드 일러스트의 거북이 수(장식). 실제 등장 수는 NOTIFY_LEVELS[...].turtles
const ART_COUNT = { weak: 1, medium: 2, strong: 3 };

function channelLines(conf) {
  return [
    conf.channels.system ? 'Windows 알림 켜짐' : 'Windows 알림 안켜짐',
    conf.channels.overlay ? '화면 경고창 켜짐' : '화면 경고창 안켜짐',
    conf.turtles > 0 ? `거북이 등장 ${conf.turtles}마리` : '거북이 등장 X',
  ];
}

// 알림 강도 설정 카드(약함·중간·세게 3단). 선택 상태는 이 컴포넌트가 들고, 바뀌면 onChange로 알린다.
export function mountNotifySettings(el, { initialLevel, onChange, onPreview } = {}) {
  el.innerHTML = `
    <section class="card home-card level-section" aria-labelledby="notify-title">
      <div class="home-card__head">
        <h2 class="home-card__title" id="notify-title">${icon('bell', { size: 26, className: 'home-card__icon' })}알림 강도 설정</h2>
        <button type="button" class="soft-btn" data-role="preview">미리보기</button>
      </div>
      <div class="level-cards" role="radiogroup" aria-labelledby="notify-title">
        ${LEVEL_IDS.map((id) => `
          <div class="level-card" role="radio" tabindex="-1" data-level="${id}">
            <strong class="level-card__name">${DISPLAY_LABEL[id] ?? NOTIFY_LEVELS[id].label}</strong>
            <div class="level-card__art">${Array.from({ length: ART_COUNT[id] ?? 1 }, () => turtleArt({ width: 58 })).join('')}</div>
            <ul class="check-list level-card__list">
              ${channelLines(NOTIFY_LEVELS[id]).map((line) => `<li><span class="check-list__mark">${icon('check', { size: 14 })}</span>${line}</li>`).join('')}
            </ul>
          </div>`).join('')}
      </div>
    </section>
  `;

  const cards = [...el.querySelectorAll('.level-card')];
  let level = NOTIFY_LEVELS[initialLevel] ? initialLevel : LEVEL_IDS[0];

  function paint() {
    cards.forEach((card) => {
      const selected = card.dataset.level === level;
      card.setAttribute('aria-checked', String(selected));
      card.tabIndex = selected ? 0 : -1;
    });
  }

  function select(next, { focus = false } = {}) {
    if (!NOTIFY_LEVELS[next]) return;
    const changed = next !== level;
    level = next;
    paint();
    if (focus) cards.find((c) => c.dataset.level === next)?.focus();
    if (changed) onChange?.(level);
  }

  cards.forEach((card) => card.addEventListener('click', () => select(card.dataset.level)));

  // 라디오 그룹 키보드: 화살표로 이동, Enter/Space로 선택
  el.querySelector('.level-cards').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.level-card');
      if (card) {
        e.preventDefault();
        select(card.dataset.level);
      }
      return;
    }
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
