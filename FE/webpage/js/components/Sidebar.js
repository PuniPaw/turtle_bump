import { icon, turtleArt } from '../icons.js';

const NAV = [
  { id: 'home', label: '홈', icon: 'house' },
  { id: 'stats', label: '통계', icon: 'chartColumn' },
];

const LOGO = `
<svg class="brand__mark" viewBox="0 0 40 40" aria-hidden="true">
  <defs>
    <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a99cff"/><stop offset="1" stop-color="#6c5ce7"/>
    </linearGradient>
  </defs>
  <rect width="40" height="40" rx="12" fill="url(#brandGrad)"/>
  <circle cx="21" cy="14" r="5.2" fill="#fff"/>
  <path d="M19 20c-1.6 3.2-1.4 6.6.4 10.5M24.5 20.5c1.8 3 2.6 6.2 2.3 10" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/>
</svg>`;

export function mountSidebar(el, { onNavigate }) {
  el.innerHTML = `
    <div class="brand">
      ${LOGO}
      <div>
        <div class="brand__name">NeckCare</div>
        <div class="brand__tag">바른 자세가,<br />더 나은 하루를 만듭니다.</div>
      </div>
    </div>
    <nav class="nav" aria-label="주 메뉴">
      ${NAV.map((item) => `
        <button type="button" class="nav__item${item.id === 'home' ? ' is-active' : ''}" data-nav="${item.id}" ${item.id === 'home' ? 'aria-current="page"' : ''}>
          ${icon(item.icon, { size: 20 })}<span>${item.label}</span>
        </button>`).join('')}
    </nav>
    <div class="sidebar-card sidebar-card--mascot">
      ${turtleArt({ width: 132, className: 'sidebar-card__mascot' })}
      <p class="sidebar-card__text">오늘도<br />바른 자세로!</p>
    </div>
  `;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    const item = NAV.find((n) => n.id === btn.dataset.nav);
    onNavigate?.(item);
  });

  return {
    // 현재 화면 메뉴를 라벤더 배경으로 강조한다.
    setActive(id) {
      el.querySelectorAll('[data-nav]').forEach((btn) => {
        const on = btn.dataset.nav === id;
        btn.classList.toggle('is-active', on);
        if (on) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      });
    },
  };
}
