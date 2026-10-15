// NeckCare 알림 오버레이: 화면 중앙 상단 경고창 + 화면을 돌아다니는 거북이.
//
// 같은 파일을 두 곳에서 쓴다. 한쪽을 고치면 다른 쪽에도 그대로 복사할 것.
//   - 웹페이지:       neckcare_webpage/js/alert-overlay.js   (notify.js가 import)
//   - 확장 프로그램:  turtle-extension/overlay.js           (content.js보다 먼저 주입)
// 그래서 ES 모듈 문법(export)을 쓰지 않고 globalThis.NeckCareAlertOverlay로 내보낸다.
//
// 거북이 디자인·걷는 모션·이동 방식은 turtle-extension 원본 content.js 기준이다.
// 바뀐 점: 마릿수는 호출하는 쪽이 정하고, 화면 밖에서 들어오는 동안만 원본 속도의 2.5배로 이동한다.
// Shadow DOM으로 페이지 CSS와 격리하고, pointer-events:none으로 클릭·스크롤·입력을 그대로 통과시킨다.
(function (g) {
  if (g.NeckCareAlertOverlay) return;

  const SIZE = 100;                 // 거북이 너비(px)
  const SPEED_MIN = 35;             // px/s (원본)
  const SPEED_MAX = 60;             // px/s (원본)
  const ENTRY_SPEED_MULTIPLIER = 2.5;
  const BUBBLE_LINES = ['목 좀 펴세요', '거북이 될래요?', '어깨 뒤로!', '턱 당기기'];
  const BUBBLE_INTERVAL_MS = 4000;

  const STYLE = `
    :host { all: initial; }
    .turtle {
      position: absolute; left: 0; top: 0; width: ${SIZE}px;
      will-change: transform;
    }
    .body {
      transform-origin: 50% 50%;
      filter: drop-shadow(0 3px 4px rgba(0,0,0,.25));
    }
    .body svg { width: 100%; height: auto; display: block; overflow: visible; }
    .bob { animation: bob .6s ease-in-out infinite; }
    .leg { transform-box: fill-box; transform-origin: 50% 0%; animation: step .6s ease-in-out infinite; }
    .leg.b { animation-delay: -.3s; }
    .head { transform-box: fill-box; transform-origin: 0% 50%; animation: nod 1.2s ease-in-out infinite; }
    .resting .leg, .resting .bob { animation-play-state: paused; }
    .resting .head { animation-duration: 2.4s; }
    .bubble {
      position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
      margin-bottom: 4px; white-space: nowrap;
      font: 600 13px/1.4 "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      background: #fff; color: #1f2a24; border: 1px solid #d3dbd3;
      padding: 3px 9px; border-radius: 10px;
    }
    @keyframes bob { 50% { transform: translateY(-2px); } }
    @keyframes step { 0%,100% { transform: rotate(-22deg); } 50% { transform: rotate(22deg); } }
    @keyframes nod { 50% { transform: translateX(3px) rotate(4deg); } }

    .alert {
      position: absolute; top: 20px; left: 50%; z-index: 1;
      transform: translateX(-50%);
      display: flex; align-items: center; gap: 14px;
      box-sizing: border-box;
      width: max-content; max-width: min(560px, calc(100vw - 32px));
      padding: 14px 22px 14px 14px;
      border-radius: 18px;
      background: #fff;
      border: 1px solid #ffd3d8;
      box-shadow: 0 12px 32px rgba(31, 29, 43, .18);
      font: 14px/1.45 "Pretendard Variable", Pretendard, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
      color: #1f1d2b;
      word-break: keep-all;
      animation: drop .25s ease-out;
    }
    .alert[hidden] { display: none; }
    .alert__icon {
      display: grid; place-items: center; flex: none;
      width: 42px; height: 42px; border-radius: 50%;
      background: #ec4b5c; color: #fff;
    }
    .alert__title { display: block; font-size: 16px; font-weight: 800; color: #ec4b5c; }
    .alert__message { margin: 2px 0 0; color: #5d5a72; }
    @keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }

    @media (prefers-reduced-motion: reduce) {
      .leg, .head, .bob, .alert { animation: none; }
    }
  `;

  const TURTLE_SVG = `
    <svg viewBox="0 0 120 64" xmlns="http://www.w3.org/2000/svg">
      <g class="bob">
        <rect class="leg b" x="26" y="40" width="10" height="16" rx="5" fill="#3f6427"/>
        <rect class="leg"   x="70" y="40" width="10" height="16" rx="5" fill="#3f6427"/>
        <path d="M14 40 L4 44 L15 46 Z" fill="#9cc26a"/>
        <g class="head">
          <rect x="88" y="30" width="18" height="10" rx="5" fill="#9cc26a"/>
          <ellipse cx="108" cy="32" rx="10" ry="8" fill="#9cc26a"/>
          <circle cx="111" cy="29" r="1.8" fill="#1f2a24"/>
          <path d="M112 36 Q115 37 117 35" stroke="#1f2a24" stroke-width="1.2" fill="none" stroke-linecap="round"/>
        </g>
        <rect class="leg"   x="34" y="42" width="11" height="17" rx="5.5" fill="#9cc26a"/>
        <rect class="leg b" x="78" y="42" width="11" height="17" rx="5.5" fill="#9cc26a"/>
        <path d="M14 44 Q16 8 54 8 Q92 8 94 44 Z" fill="#5c8a3a"/>
        <path d="M14 44 H94" stroke="#3f6427" stroke-width="4" stroke-linecap="round"/>
        <path d="M40 14 L36 30 L54 38 L72 30 L68 14 M36 30 L22 38 M72 30 L86 38 M54 38 L54 44"
              stroke="#3f6427" stroke-width="2" fill="none" stroke-linejoin="round"/>
      </g>
    </svg>`;

  const ALERT_ICON = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>
    </svg>`;

  const rand = (a, b) => a + Math.random() * (b - a);

  function create() {
    let host = null;
    let root = null;
    let alertBox = null;
    const turtles = [];
    let rafId = null;
    let last = 0;
    let bubbleTimer = null;
    let bubbleIndex = 0;

    function ensureHost() {
      if (!host) {
        host = document.createElement('div');
        host.setAttribute('data-neckcare-overlay', '');
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;';
        root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
          <style>${STYLE}</style>
          <div class="alert" role="alert" hidden>
            <div class="alert__icon">${ALERT_ICON}</div>
            <div>
              <strong class="alert__title"></strong>
              <p class="alert__message"></p>
            </div>
          </div>`;
        alertBox = root.querySelector('.alert');
      }
      // 페이지가 body를 갈아끼우는 경우(SPA 등)에도 다시 붙인다.
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    }

    // ---------- 거북이 한 마리 ----------
    function spawnTurtle(withBubble) {
      const W = innerWidth, H = innerHeight;
      const el = document.createElement('div');
      el.className = 'turtle';
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = TURTLE_SVG;
      el.appendChild(body);

      let bubble = null;
      if (withBubble) {
        bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = BUBBLE_LINES[0];
        el.appendChild(bubble);
      }
      root.appendChild(el);

      // 화면 밖 랜덤한 가장자리에서 등장해 안쪽을 향해 기어 들어옴
      const side = Math.floor(Math.random() * 4);
      let x, y;
      if (side === 0) { x = -SIZE; y = rand(0, H); }
      else if (side === 1) { x = W + SIZE; y = rand(0, H); }
      else if (side === 2) { x = rand(0, W); y = -SIZE; }
      else { x = rand(0, W); y = H + SIZE; }
      const heading = Math.atan2(H / 2 - y, W / 2 - x);

      const t = {
        el, body, bubble,
        x, y, heading,
        speed: rand(SPEED_MIN, SPEED_MAX),
        entering: true,               // 화면 안쪽에 들어올 때까지 빠르게 이동
        turnRate: 0,
        restUntil: 0,
        nextDecision: performance.now() + rand(800, 2000),
      };
      turtles.push(t);
      draw(t);
    }

    // ---------- 움직임 ----------
    function stepTurtle(t, dt, now) {
      const W = innerWidth, H = innerHeight;
      const margin = SIZE * 0.6;
      const outside = t.x < margin || t.x > W - margin || t.y < margin || t.y > H - margin;
      if (t.entering && !outside) t.entering = false;

      // 가끔 방향 바꾸기 / 멈춰서 쉬기 (들어오는 중에는 쉬지 않음)
      if (!t.entering && now > t.nextDecision) {
        if (Math.random() < 0.2) {
          t.restUntil = now + rand(800, 2200);
        }
        t.turnRate = rand(-1.4, 1.4);
        t.nextDecision = now + rand(1200, 3500);
      }

      const resting = now < t.restUntil;
      t.el.classList.toggle('resting', resting);
      if (resting) return;

      // 화면 가장자리에 가까우면 중앙 쪽으로 방향을 틀기
      if (outside) {
        const toCenter = Math.atan2(H / 2 - t.y, W / 2 - t.x);
        let diff = toCenter - t.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        t.heading += Math.sign(diff) * Math.min(Math.abs(diff), 2.5 * dt);
      } else {
        t.heading += t.turnRate * dt + rand(-0.3, 0.3) * dt;
      }

      const speed = t.entering ? t.speed * ENTRY_SPEED_MULTIPLIER : t.speed;
      t.x += Math.cos(t.heading) * speed * dt;
      t.y += Math.sin(t.heading) * speed * dt;
    }

    function draw(t) {
      // 그림은 오른쪽을 바라봄. 왼쪽으로 갈 땐 좌우 반전해서 등껍질이 위로 오게 함
      const facingLeft = Math.cos(t.heading) < 0;
      const angle = facingLeft ? t.heading - Math.PI : t.heading;
      t.el.style.transform = `translate(${t.x - SIZE / 2}px, ${t.y - SIZE * 0.27}px)`;
      t.body.style.transform = `rotate(${angle}rad) scaleX(${facingLeft ? -1 : 1})`;
    }

    function loop(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      for (const t of turtles) { stepTurtle(t, dt, now); draw(t); }
      rafId = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (rafId) return;
      last = performance.now();
      rafId = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    }

    function clearTurtles() {
      stopLoop();
      clearInterval(bubbleTimer);
      bubbleTimer = null;
      while (turtles.length) turtles.pop().el.remove();
    }

    return {
      // count: 거북이 수(0이면 경고창만), title/message: 경고창 문구(title이 없으면 경고창 숨김)
      show({ count = 0, title = '', message = '' } = {}) {
        clearTurtles();
        ensureHost();
        alertBox.querySelector('.alert__title').textContent = title;
        alertBox.querySelector('.alert__message').textContent = message;
        alertBox.hidden = !title;

        for (let i = 0; i < count; i++) spawnTurtle(i === 0);
        if (count > 0) {
          startLoop();
          bubbleIndex = 0;
          bubbleTimer = setInterval(() => {
            const bubble = turtles[0] && turtles[0].bubble;
            if (!bubble) return;
            bubbleIndex = (bubbleIndex + 1) % BUBBLE_LINES.length;
            bubble.textContent = BUBBLE_LINES[bubbleIndex];
          }, BUBBLE_INTERVAL_MS);
        }
      },
      // 보이는 중일 때 경고창 문구만 바꾼다(거북이는 그대로 이어서 움직임).
      update({ title = '', message = '' } = {}) {
        if (!host || !host.isConnected || !alertBox) return;
        alertBox.querySelector('.alert__title').textContent = title;
        alertBox.querySelector('.alert__message').textContent = message;
        alertBox.hidden = !title;
      },
      // 거북이·경고창·애니메이션 루프·타이머를 모두 정리하고 오버레이를 페이지에서 뗀다.
      hide() {
        clearTurtles();
        if (alertBox) alertBox.hidden = true;
        if (host) host.remove();
      },
      isShowing: () => Boolean(host && host.isConnected),
      // 페이지가 오버레이를 지워버렸을 때 다시 붙인다(보이는 중일 때만 호출).
      ensureMounted() {
        if (host && !host.isConnected) (document.body || document.documentElement).appendChild(host);
      },
    };
  }

  g.NeckCareAlertOverlay = { create };
})(globalThis);
