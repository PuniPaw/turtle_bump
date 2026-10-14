import { icon } from '../icons.js';

const NAV = [
  { id: 'home', label: '홈', icon: 'house' },
  { id: 'analysis', label: '자세 분석', icon: 'scanFace' },
  { id: 'stats', label: '통계', icon: 'chartColumn' },
  { id: 'settings', label: '설정', icon: 'settings' },
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

const TURTLE = `
<svg class="sidebar-card__art" viewBox="0 0 160 70" aria-hidden="true">
  <path d="M6 62h148" stroke="#d9d3fb" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="78" cy="48" rx="34" ry="20" fill="#b9aef9"/>
  <path d="M50 46c6-16 50-16 56 0" fill="#9d8ff3"/>
  <path d="M64 34l14 10 14-10M78 44v-14" stroke="#c8bffb" stroke-width="2" fill="none" stroke-linecap="round"/>
  <ellipse cx="118" cy="44" rx="11" ry="9" fill="#c8bffb"/>
  <circle cx="122" cy="42" r="1.8" fill="#4b3fb0"/>
  <path d="M58 60v-6M98 60v-6" stroke="#9d8ff3" stroke-width="7" stroke-linecap="round"/>
</svg>`;

export function mountSidebar(el, { onNavigate }) {
  el.innerHTML = `
    <div class="brand">
      ${LOGO}
      <div>
        <div class="brand__name">NeckCare</div>
        <div class="brand__tag">바른 자세가, 더 나은 하루를 만듭니다.</div>
      </div>
    </div>
    <nav class="nav" aria-label="주 메뉴">
      ${NAV.map((item) => `
        <button type="button" class="nav__item${item.id === 'home' ? ' is-active' : ''}" data-nav="${item.id}" ${item.id === 'home' ? 'aria-current="page"' : ''}>
          ${icon(item.icon, { size: 20 })}<span>${item.label}</span>
        </button>`).join('')}
    </nav>
    <div class="sidebar-card">
      <div class="sidebar-card__icon">${icon('sprout', { size: 18 })}</div>
      <p class="sidebar-card__text">지금의 작은 교정이<br />건강한 목을 만듭니다.</p>
      ${TURTLE}
    </div>
  `;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    const item = NAV.find((n) => n.id === btn.dataset.nav);
    onNavigate?.(item);
  });
}