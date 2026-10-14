import { icon } from '../icons.js';

const TIPS = [
  { icon: 'monitor', title: '모니터는 눈높이에 맞추기', desc: '화면 위쪽 끝이 눈높이와 비슷하도록 높이를 조절하세요.' },
  { icon: 'alarmClock', title: '30~50분마다 자리에서 일어나기', desc: '오래 앉아 있지 말고 주기적으로 일어나 몸을 움직여 주세요.' },
  { icon: 'personStanding', title: '목과 어깨 스트레칭하기', desc: '턱을 당기고 어깨를 천천히 돌려 굳은 근육을 풀어 주세요.' },
  { icon: 'eye', title: '고개를 앞으로 내밀지 않기', desc: '글자가 작다면 고개 대신 화면 배율을 키워 보세요.' },
];

export function renderPostureTips(el) {
  el.innerHTML = `
    <section class="card" aria-label="바른 자세를 위한 팁">
      <div class="card__head">
        <h2 class="card__title">${icon('lightbulb', { size: 20, className: 'card__title-icon' })}바른 자세를 위한 팁</h2>
      </div>
      <ul class="tips">
        ${TIPS.map((t) => `
          <li class="tip-item">
            <span class="tip-item__icon">${icon(t.icon, { size: 20 })}</span>
            <div>
              <strong class="tip-item__title">${t.title}</strong>
              <p class="tip-item__desc">${t.desc}</p>
            </div>
          </li>`).join('')}
      </ul>
    </section>
  `;
}