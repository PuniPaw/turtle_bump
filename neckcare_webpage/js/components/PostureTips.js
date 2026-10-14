import { icon } from '../icons.js';

const TIPS = [
  '모니터는 눈높이에 맞추기',
  '등을 의자에 충분히 기대기',
  '화면과 50~70cm 거리 유지하기',
  '틈틈이 스트레칭하기',
];

// 의자에 바르게 앉아 노트북을 쓰는 사람(장식). 초록 점선은 곧은 상체 정렬 표시.
const ILLUSTRATION = `
<svg class="tips-card__art" viewBox="0 0 260 160" aria-hidden="true">
  <ellipse cx="130" cy="150" rx="112" ry="8" fill="#ece8fb"/>
  <rect x="150" y="78" width="98" height="6" rx="3" fill="#cfd3e6"/>
  <rect x="227" y="84" width="6" height="60" fill="#b9bed6"/>
  <rect x="214" y="142" width="32" height="4" rx="2" fill="#b9bed6"/>
  <path d="M182 77 L194 49 L198 49 L186 77 Z" fill="#9aa1c0"/>
  <rect x="160" y="75" width="38" height="3" rx="1.5" fill="#8a91b0"/>
  <path d="M56 58 C49 62 48 92 54 106 L63 106 C59 92 60 70 65 61 Z" fill="#3c4466"/>
  <rect x="54" y="104" width="60" height="8" rx="4" fill="#3c4466"/>
  <rect x="82" y="112" width="5" height="22" fill="#3c4466"/>
  <path d="M62 140 L84.5 132 L107 140" stroke="#3c4466" stroke-width="4" fill="none" stroke-linecap="round"/>
  <circle cx="62" cy="142" r="4" fill="#2b3150"/><circle cx="107" cy="142" r="4" fill="#2b3150"/><circle cx="84.5" cy="140" r="4" fill="#2b3150"/>
  <path d="M72 96 H124 a8 8 0 0 1 8 8 V138 H120 V108 H72 Z" fill="#4a5a9a"/>
  <path d="M117 136 H141 a4 4 0 0 1 0 8 H117 Z" fill="#e8ecf6"/>
  <path d="M68 58 C66 72 68 90 74 100 H100 C100 86 98 70 92 58 Z" fill="#7aa7f0"/>
  <path d="M88 64 C96 76 112 80 160 76" stroke="#7aa7f0" stroke-width="9" fill="none" stroke-linecap="round"/>
  <circle cx="162" cy="76" r="4.5" fill="#f2c7a5"/>
  <rect x="77" y="46" width="9" height="13" rx="3" fill="#f2c7a5"/>
  <circle cx="83" cy="35" r="14" fill="#f2c7a5"/>
  <path d="M69 34 C68 19 85 15 96 23 C92 26 86 26 82 30 C77 30 73 34 71 41 Z" fill="#5a3b2a"/>
  <line x1="74" y1="20" x2="74" y2="104" stroke="#3ccf91" stroke-width="2.5" stroke-dasharray="4 4"/>
  <circle cx="74" cy="20" r="3.5" fill="#3ccf91"/>
  <circle cx="74" cy="104" r="5" fill="#3ccf91"/>
</svg>`;

export function renderPostureTips(el) {
  el.innerHTML = `
    <section class="card home-card tips-card" aria-label="바른 자세를 위한 팁">
      <h2 class="home-card__title">${icon('lightbulb', { size: 26, className: 'home-card__icon' })}바른 자세를 위한 팁</h2>
      ${ILLUSTRATION}
      <ul class="check-list tips-card__list">
        ${TIPS.map((t) => `<li><span class="check-list__mark">${icon('check', { size: 14 })}</span>${t}</li>`).join('')}
      </ul>
    </section>
  `;
}
