import { icon } from '../icons.js';

// 판정 결과(store.posture)를 화면 문구로 바꾸는 표. 판정 자체는 B 모듈이 하고, posture-adapter.js가 값을 넣는다.
// 판정 결과가 들어오기 전(unknown)에는 "미측정"만 보여준다.
//   status: unknown | good | warn(나쁜 자세, 경고 전) | bad(경고 중), kind: turtle | waist, reason: novis | recalibration
const STATUS_VIEW = {
  unknown: { tone: 'idle', title: '미측정', desc: '아직 자세 분석 결과가 없습니다.' },
  good: { tone: 'good', title: '바른 자세', desc: '지금 자세를 유지해 주세요.' },
  warn: { tone: 'warn', title: '거북목 주의', desc: '고개가 앞으로 나와 있어요.' },
  bad: { tone: 'bad', title: '거북목 자세', desc: '고개를 들고 어깨를 펴 주세요.' },
};
const WAIST_VIEW = {
  warn: { tone: 'warn', title: '허리 굽음 주의', desc: '허리가 앞으로 굽어 있어요.' },
  bad: { tone: 'bad', title: '허리 굽음 자세', desc: '허리를 펴고 등을 의자에 기대 주세요.' },
};
const REASON_VIEW = {
  novis: { tone: 'idle', title: '자세 확인 중', desc: '얼굴과 어깨가 화면에 보이도록 앉아 주세요.' },
  recalibration: { tone: 'bad', title: '자세 판단 어려움', desc: '초기자세 설정을 다시 해주세요.' },
};

function postureView(p) {
  if (p.status === 'unknown' && REASON_VIEW[p.reason]) return REASON_VIEW[p.reason];
  if (p.kind === 'waist' && WAIST_VIEW[p.status]) return WAIST_VIEW[p.status];
  return STATUS_VIEW[p.status] ?? STATUS_VIEW.unknown;
}

// 보라색 사람 아바타(장식)
const AVATAR = `
<svg class="posture-panel__avatar" viewBox="0 0 120 120" aria-hidden="true">
  <defs>
    <linearGradient id="avatarBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ece8ff"/><stop offset="1" stop-color="#cfc6ff"/></linearGradient>
    <linearGradient id="avatarBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9b87ff"/><stop offset="1" stop-color="#5e45e0"/></linearGradient>
    <clipPath id="avatarClip"><circle cx="60" cy="60" r="56"/></clipPath>
  </defs>
  <circle cx="60" cy="60" r="56" fill="url(#avatarBg)"/>
  <g clip-path="url(#avatarClip)">
    <circle cx="60" cy="43" r="17" fill="url(#avatarBody)"/>
    <path d="M24 112 C26 82 42 66 60 66 C78 66 94 82 96 112 Z" fill="url(#avatarBody)"/>
    <path d="M49 67 L60 82 L71 67 Z" fill="#fff"/>
    <path d="M58 74 L55.5 96 L60 101 L64.5 96 L62 74 Z" fill="#4b33c9"/>
  </g>
</svg>`;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function renderPostureStatus(el, state) {
  const view = postureView(state.posture);

  el.innerHTML = `
    <section class="card home-card" aria-label="현재 자세 상태">
      <h2 class="home-card__title">
        <span class="home-card__badge">${icon('personStanding', { size: 18 })}</span>현재 자세 상태
        <span class="tip" tabindex="0" aria-label="카메라와 자세 분석 모델이 연결되면 현재 자세가 표시됩니다.">
          ${icon('info', { size: 18 })}
          <span class="tip__bubble" role="tooltip">카메라와 자세 분석 모델이 연결되면 현재 자세가 표시됩니다.</span>
        </span>
      </h2>
      <div class="posture-panel" data-tone="${view.tone}">
        ${AVATAR}
        <div class="posture-panel__text">
          <strong class="posture-panel__title">${view.title}</strong>
          <p class="posture-panel__desc">${view.desc}</p>
        </div>
      </div>
    </section>
  `;
}

// 누적 측정 시간. 값은 실제 측정 기록(state.stats.measuredSec, 초)이 있을 때만 표시한다.
// [연결 위치] D(저장/통계) 파트가 store.setState({ stats: { measuredSec } })로 넣는다. 없으면 "--:--:--".
export function renderMeasureTime(el, state) {
  const sec = state.stats.measuredSec;
  const has = isNum(sec);
  const p = (n) => String(n).padStart(2, '0');
  const value = has ? `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(Math.floor(sec % 60))}` : '--:--:--';

  el.innerHTML = `
    <section class="card home-card measure-card" aria-label="누적 측정 시간">
      <span class="measure-card__icon">${icon('clock', { size: 40 })}</span>
      <div class="measure-card__body">
        <h2 class="measure-card__title">누적 측정 시간</h2>
        <strong class="measure-card__value" data-empty="${!has}">${value}</strong>
        <p class="measure-card__desc">${has ? '지금까지 측정된 시간이에요.' : '아직 측정 데이터가 없습니다.'}</p>
      </div>
    </section>
  `;
}
