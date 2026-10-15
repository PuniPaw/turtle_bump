// 초기 자세 설정 진행 관리. 화면은 CameraPreview(showCalibration / hideCalibration)가 그린다.
//
// 진행
//   - 판정 모듈이 없으면: 안내(1초) → 3·2·1(각 1초) → "자세 분석 기능 연결 대기 중"(2초) → "연결 성공!"(1.2초)
//   - 판정 모듈이 있으면: "자세 분석을 준비하는 중"(beginBaseline이 끝날 때까지) → 3·2·1(B의 3초 수집과 같은 구간)
//     → "기준 자세를 확인하는 중" → 성공했을 때만 "거북목 판정 시작!"(2초) 후 판정 시작
//
// 이 파일은 측정·판정을 하지 않는다. 실제 측정은 registerAnalyzer()로 등록되는 B 파트 모듈이 한다.
// [연결 위치] B(판정) 파트가 아래 모양의 객체를 등록한다(window.neckcare.registerAnalyzer로도 가능).
//   beginBaseline(video)  카운트다운 직전: 기준 자세 측정 준비·시작 (Promise 가능, 준비가 끝나야 카운트다운 시작)
//   finishBaseline()      카운트다운 끝: Promise<{ ok: boolean }> — ok일 때만 판정 시작
//   start()               판정 시작 (결과는 store.setState({ posture })로 넣는다)
//   stop()                카메라 해제·재연결·설정 취소 시 측정/판정 중지

const GUIDE_MS = 1000;
const STEP_MS = 1000;
const COUNT_FROM = 3;
const END_MS = 2000;
const CONNECTED_MS = 1200;

const TEXT = {
  loading: '자세 분석을 준비하는 중이에요. 바른 자세로 앉아 주세요',
  guide: '3초 동안 바른 자세를 유지해주세요',
  checking: '기준 자세를 확인하는 중이에요',
  waiting: '자세 분석 기능 연결 대기 중',
  connected: '연결 성공!',
  start: '거북목 판정 시작!',
  failed: '기준 자세를 설정하지 못했어요. 카메라를 다시 연결해 주세요.',
};

// 탭 이동·화면 전환 시 취소 후 돌아오면 다시 시작하는 단계(판정 시작 전 단계만)
const SETUP_PHASES = new Set(['guide', 'countdown', 'checking']);

export function createCalibration({ view, getVideo, isCameraConnected, isViewActive = () => true }) {
  let analyzer = null;
  let active = null;        // 지금 진행 중인 판정 모듈(등록 객체)
  let token = 0;            // 시작할 때마다 증가. 이전 진행의 늦은 타이머·비동기 결과를 무시하는 데 쓴다.
  let phase = 'idle';       // idle | guide | countdown | checking | ending | analyzing
  let restartOnVisible = false;
  const waits = new Map();  // timeout id → resolve

  const alive = (t) => t === token;

  // ms 뒤 true(계속 진행) / 취소되면 즉시 false
  function wait(ms, t) {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        waits.delete(id);
        resolve(alive(t));
      }, ms);
      waits.set(id, resolve);
    });
  }

  function clearWaits() {
    for (const [id, resolve] of waits) {
      clearTimeout(id);
      resolve(false);
    }
    waits.clear();
  }

  function stopAnalyzer() {
    if (!active) return;
    try {
      active.stop();
    } catch (err) {
      console.error('판정 모듈 stop 실패', err);
    }
    active = null;
  }

  // 진행 중인 설정(또는 판정)을 모두 정리한다.
  function reset() {
    token++;
    clearWaits();
    stopAnalyzer();
    view.hide();
    phase = 'idle';
  }

  async function run(t) {
    const mod = analyzer;
    active = mod;

    phase = 'guide';
    if (mod) {
      // 판정 모듈 준비(첫 연결 땐 모델 로딩) 동안 안내. 준비가 끝나는 즉시 B가 3초 수집을 시작하므로
      // 1초 안내 대기 없이 바로 3·2·1을 세어 화면과 실제 수집 구간을 맞춘다.
      view.show({ phase: 'waiting', text: TEXT.loading });
      try {
        await mod.beginBaseline(getVideo());
      } catch (err) {
        console.error('기준 자세 측정 준비 실패', err);
        if (alive(t)) await fail(t);
        return;
      }
      if (!alive(t)) return;
    } else {
      view.show({ phase: 'guide', text: TEXT.guide });
      if (!(await wait(GUIDE_MS, t))) return;
    }

    phase = 'countdown';
    for (let n = COUNT_FROM; n >= 1; n--) {
      view.show({ phase: 'countdown', text: TEXT.guide, count: n });
      if (!(await wait(STEP_MS, t))) return;
    }

    if (!mod) {
      // 판정 모듈이 없을 때: UI 카운트다운만 하고 끝낸다. 판정은 시작하지 않는다.
      phase = 'ending';
      active = null;
      view.show({ phase: 'waiting', text: TEXT.waiting });
      if (!(await wait(END_MS, t))) return;
      view.show({ phase: 'connected', text: TEXT.connected });
      if (!(await wait(CONNECTED_MS, t))) return;
      view.hide();
      phase = 'idle';
      return;
    }

    phase = 'checking';
    view.show({ phase: 'checking', text: TEXT.checking });
    let ok = false;
    try {
      const result = await mod.finishBaseline();
      ok = Boolean(result && result.ok);
    } catch (err) {
      console.error('기준 자세 측정 실패', err);
    }
    if (!alive(t)) return;            // 그 사이 카메라 해제·취소됨: 늦게 온 결과는 무시
    if (!ok) {
      await fail(t);
      return;
    }

    phase = 'analyzing';
    try {
      mod.start();
    } catch (err) {
      console.error('판정 시작 실패', err);
      await fail(t);
      return;
    }
    view.show({ phase: 'start', text: TEXT.start });
    if (!(await wait(END_MS, t))) return;
    view.hide();
  }

  async function fail(t) {
    stopAnalyzer();
    phase = 'ending';
    view.show({ phase: 'failed', text: TEXT.failed });
    if (!(await wait(END_MS, t))) return;
    view.hide();
    phase = 'idle';
  }

  // 사용자가 지금 카메라 화면을 볼 수 있는지(탭이 보이고, 홈 화면이 열려 있는지)
  const canShow = () => !document.hidden && isViewActive();

  // 카메라 연결 성공 시 호출. 이전 진행은 정리하고 처음부터 시작한다.
  function start() {
    reset();
    restartOnVisible = false;
    if (!canShow()) {
      restartOnVisible = true;   // 탭이 숨겨졌거나 다른 화면이면 돌아왔을 때 시작
      return;
    }
    run(token);
  }

  // 카메라 해제 시 호출. 설정 UI·타이머·판정을 모두 정리한다.
  function cancel() {
    restartOnVisible = false;
    reset();
  }

  // 초기 설정 단계라면 취소하고, 돌아왔을 때 다시 시작하도록 표시한다.
  // 판정이 시작된 뒤(analyzing)에는 아무것도 하지 않는다(카메라·판정 유지).
  function suspend() {
    if (SETUP_PHASES.has(phase)) {
      reset();
      restartOnVisible = true;
    }
  }

  // 다시 볼 수 있게 되면, 취소됐던 초기 설정을 카메라가 연결돼 있을 때만 처음부터 다시 시작한다.
  function resume() {
    if (!restartOnVisible || !canShow()) return;
    restartOnVisible = false;
    if (isCameraConnected()) start();
  }

  // 초기 설정 중 탭을 떠나면 취소하고, 돌아왔을 때 카메라가 연결돼 있으면 처음부터 다시 시작한다.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else resume();
  });

  function registerAnalyzer(mod) {
    const required = ['beginBaseline', 'finishBaseline', 'start', 'stop'];
    const missing = required.filter((name) => typeof mod?.[name] !== 'function');
    if (missing.length) throw new TypeError(`판정 모듈에 필요한 함수가 없습니다: ${missing.join(', ')}`);
    analyzer = mod;   // 다음 카메라 연결(또는 재시작)부터 적용
  }

  // suspend / resume: 홈 ↔ 통계 화면 전환 때 main.js가 호출한다(카메라는 건드리지 않음).
  return { start, cancel, suspend, resume, registerAnalyzer, getPhase: () => phase };
}
