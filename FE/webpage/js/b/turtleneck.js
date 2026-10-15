/*
 * 거북목 / 허리굽힘 / 의자 당김 판정 v4 — JavaScript 이식판
 * (Python v4: MediaPipe Pose + Face Landmarker, 학습 모델 없음)
 *
 * 이 파일에는 "판정 로직"만 들어 있습니다. 카메라·MediaPipe 실행·화면 그리기는 웹페이지 쪽 코드가 맡고,
 * 매 프레임 MediaPipe 결과를 tracker.process(...)에 넘기기만 하면 됩니다. (사용 예는 demo.html)
 *
 * 일반 <script src="posture-v4.js">로 불러오면 window.PostureV4 가 생깁니다.
 * (type="module"이 아니어도 되고, 크롬 확장 content script에서도 그대로 쓸 수 있음)
 *
 * ── 웹페이지 쪽 사용법 ─────────────────────────────────────────────
 *   const tracker = new PostureV4.PostureTracker({
 *     onPostureChange(e) { ... },   // e = { state, prev_state, alert, reanchoring, reference_updated, timestamp, values }
 *     onSessionStart(s)  { ... },   // s = { started_at }                  -> DB: 측정 시작 저장
 *     onSessionEnd(s)    { ... },   // s = { started_at, ended_at, last_measured_at, reason }  -> DB: 측정 종료 저장
 *     onCalibFail()      { ... },   // 3초 동안 얼굴·양 어깨가 충분히 안 잡힘
 *   });
 *   tracker.startCalib();                        // Python의 's' 키 (바른 자세 버튼)
 *   // 매 프레임:
 *   tracker.process({ poseResult, faceResult, width, height });
 *   tracker.stop('button');                      // 카메라 연결 해제 버튼
 *   tracker.stop('unload');                      // pagehide 등 (ended_at = 마지막으로 실제 측정된 시각)
 *
 * state 값: GOOD / TURTLE / WAIST / CLOSE / NOVIS / CALIB / IDLE
 * 모든 timestamp(started_at, ended_at, timestamp ...)는 Date.now() 기준 epoch 밀리초입니다.
 * 판정 내부 시간 계산은 Python의 perf_counter처럼 performance.now()(초 단위)로 합니다.
 */
(function (root) {
  'use strict';

  // ================= 설정값 (여기만 조정) — Python v4와 동일 =================
  // 조정 예: PostureV4.CONFIG.FWD_TH = 3.5;
  const CONFIG = {
    CALIB_SEC: 3.0,     // 초기 자세 측정 시간(초)
    VIS_TH: 0.5,        // 어깨 랜드마크 신뢰도 기준
    EMA_ALPHA: 0.3,     // 스무딩
    HOLD_SEC: 0.5,      // 같은 판정이 이 시간 이상 유지돼야 화면에 표시
    FOV_V_DEG: 63.0,    // Face Landmarker가 가정하는 카메라 세로 화각

    FWD_TH: 3.0,        // 거북목: 머리가 어깨보다 초기 대비 이 cm 이상 앞으로
    LEAN_TH: 6.0,       // 허리굽힘: 어깨가 카메라 쪽으로 이 cm 이상 다가옴 (현재 기준 대비)
    LEAN_FWD_TH: 2.0,   //   + 머리도 같이 이 cm 이상 앞으로
    DROP_TH: 3.0,       //   또는 어깨가 이 cm 이상 내려감
    DROP_STRONG_TH: 5.0,// 어깨가 이 cm 이상 내려가면 다가옴과 상관없이 허리굽힘
    CLOSE_TH: 10.0,     // 의자 당김 안내: 어깨가 처음 측정 대비 이 cm 이상 다가옴
    CLOSE_FWD_TH: 2.0,  //   그리고 |fwd|가 이 cm 미만
    YAW_TH: 25.0,       // 고개를 이 각도 이상 돌리면 판정 보류 (직전 판정 유지)

    // ---- 기준 자동 갱신 ----
    REANCHOR_SEC: 1.8,
    REANCHOR_MOVE_TH: 8.0,
    REANCHOR_STABLE: 3.0,
    REANCHOR_FWD_TH: 2.0,
    REANCHOR_FWD_RANGE: 1.5,
    TILT_MAX: 0.5,
  };
  // ==========================================================================

  const LM_CHIN = 152;
  const DEG = 180 / Math.PI;

  // ---------- 작은 유틸 (Python statistics.median 과 같은 규칙) ----------
  function median(arr) {
    const v = Array.from(arr).sort((a, b) => a - b);
    const n = v.length;
    if (n === 0) throw new Error('median of empty list');
    const mid = n >> 1;
    return n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function focalPx(h) {
    return (h / 2) / Math.tan((CONFIG.FOV_V_DEG / 2) / DEG);
  }

  /**
   * facial transformation matrix를 (행, 열) 접근 함수로 바꿈.
   * - 2차원 배열 [[..4],[..4],..] (Python numpy와 같은 모양)
   * - 길이 16 평탄 배열 / Float32Array
   * - MediaPipe JS의 Matrix 객체 { rows, columns, data }
   * 평탄 배열은 행 우선/열 우선 여부를 자동 판별함: 마지막 행이 [0,0,0,1]인 위치를 보고 결정.
   * (이동량 z는 항상 수십 cm라 0이 아니므로 판별이 헷갈리지 않음)
   */
  function matAccessor(mat) {
    if (mat == null) return null;
    if (Array.isArray(mat) && Array.isArray(mat[0])) return (r, c) => mat[r][c];
    const d = mat.data !== undefined ? mat.data : mat;
    if (!d || d.length < 16) return null;
    const rowMajor = Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]) < 1e-6;
    return rowMajor ? (r, c) => d[r * 4 + c] : (r, c) => d[c * 4 + r];
  }

  /** 4x4 facial transformation matrix -> [yaw, pitch] 도 */
  function eulerDeg(M) {
    const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let j = 0; j < 3; j++) {
      const n = Math.hypot(M(0, j), M(1, j), M(2, j));   // 열 벡터 정규화 (np.linalg.norm(r, axis=0))
      for (let i = 0; i < 3; i++) r[i][j] = M(i, j) / n;
    }
    const yaw = Math.asin(clamp(-r[2][0], -1, 1)) * DEG;
    const pitch = Math.atan2(r[2][1], r[2][2]) * DEG;
    return [yaw, pitch];
  }

  /**
   * 한 프레임의 원시 측정값. 어깨 또는 얼굴이 안 보이면 null
   * poseLm : Pose 랜드마크 배열 (11, 12 어깨만 사용, x/y는 0~1 정규화 좌표)
   * faceLm : Face Landmarker 478점 (152 턱만 사용)
   * faceMat: facial transformation matrix
   */
  function measure(poseLm, faceLm, faceMat, w, h) {
    const M = matAccessor(faceMat);
    if (!poseLm || !M) return null;
    const a = poseLm[11], b = poseLm[12];
    if (!a || !b) return null;
    // visibility 필드가 없는 버전이면 통과시킴
    const va = a.visibility == null ? 1 : a.visibility;
    const vb = b.visibility == null ? 1 : b.visibility;
    if (va < CONFIG.VIS_TH || vb < CONFIG.VIS_TH) return null;
    const sh = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
    if (sh < 1) return null;
    const [yaw, pitch] = eulerDeg(M);
    return {
      z_head: -M(2, 3),                                   // 카메라 -> 머리 거리(cm)
      yaw: yaw,
      pitch: pitch,
      sh: sh,                                             // 어깨폭(px)
      sh_y: (a.y + b.y) / 2 * h - h / 2,                  // 화면 중앙 기준 어깨 높이(px, 아래가 +)
      chin_y: faceLm && faceLm[LM_CHIN] ? faceLm[LM_CHIN].y * h - h / 2 : NaN,
      f: focalPx(h),
    };
  }

  /** 어깨 깊이 z_sh(cm)와 높이 Y_sh(cm). k = (어깨 깊이 x 어깨폭 px) 상수 */
  function shoulder3d(sh, sh_y, f, k) {
    const z_sh = k / sh;
    return [z_sh, sh_y * z_sh / f];
  }

  /** 3초 동안 모은 측정값으로 초기값 계산 (중앙값) */
  function makeBase(samples) {
    if (samples.length < 10) return null;
    const med = (key) => median(samples.map((s) => s[key]));
    const k = median(samples.map((s) => s.z_head * s.sh));
    const base = {
      k: k, sh: med('sh'), sh_y: med('sh_y'), z_head: med('z_head'),
      yaw: med('yaw'), pitch: med('pitch'), f: samples[0].f,
    };
    base.offset = median(samples.map((s) => k / s.sh - s.z_head));
    const necks = samples
      .filter((s) => !Number.isNaN(s.chin_y))
      .map((s) => shoulder3d(s.sh, s.sh_y, s.f, k)[1] - s.chin_y * s.z_head / s.f);
    base.neck = necks.length ? median(necks) : NaN;
    return base;
  }

  /** 의자 이동 전후 두 위치에서 '머리~어깨 깊이 차는 그대로'라는 조건으로 k를 다시 풂 */
  function refineK(base, old, neu) {
    const den = 1 / old.sh - 1 / neu.sh;
    if (Math.abs(den) < 1e-9) return;
    const k = (old.z_head - neu.z_head) / den;
    if (0.7 * base.k < k && k < 1.3 * base.k) {          // 이상값이면 무시
      base.k = k;
      base.offset = k / neu.sh - neu.z_head;
    }
  }

  function features(m, base, ref) {
    const k = base.k;
    const [z_sh, y_sh] = shoulder3d(m.sh, m.sh_y, m.f, k);
    const [ref_z, ref_y] = shoulder3d(ref.sh, ref.sh_y, m.f, k);
    const dz = z_sh - ref_z;
    const neck = y_sh - m.chin_y * m.z_head / m.f;
    return {
      fwd: (z_sh - m.z_head) - base.offset,
      appr: -dz,
      drop: (y_sh - ref_y) - ref.tilt * dz,               // 카메라 기울기 보정
      dist: k / base.sh - z_sh,
      yaw: m.yaw - base.yaw,
      pitch: m.pitch - base.pitch,
      neck: neck - base.neck,                             // 표시용
      z_head: m.z_head,
      z_sh: z_sh,
      Y_sh: y_sh,
    };
  }

  /** 하위 10% ~ 상위 10% 범위 (한두 프레임 튀는 값 무시) */
  function p10p90(vals) {
    const v = Array.from(vals).sort((a, b) => a - b);
    const n = v.length;
    return v[Math.floor(n * 9 / 10)] - v[Math.floor(n / 10)];
  }

  function judge(f) {
    const C = CONFIG;
    const leaning = f.appr > C.LEAN_TH && (f.fwd > C.LEAN_FWD_TH || f.drop > C.DROP_TH);
    if (leaning || f.drop > C.DROP_STRONG_TH) return 'WAIST';
    if (f.fwd > C.FWD_TH) return 'TURTLE';
    if (f.dist > C.CLOSE_TH && Math.abs(f.fwd) < C.CLOSE_FWD_TH) return 'CLOSE';
    return 'GOOD';
  }

  const BANNER = {
    GOOD:   { text: 'GOOD POSTURE',                     color: '#009600' },
    TURTLE: { text: 'WARNING: TURTLE NECK',             color: '#ff0000' },
    WAIST:  { text: 'WARNING: LEANING FORWARD (WAIST)', color: '#ff7800' },
    CLOSE:  { text: 'TOO CLOSE TO SCREEN (chair)',      color: '#c8aa00' },
    NOVIS:  { text: 'FACE / SHOULDERS NOT VISIBLE',     color: '#5a5a5a' },
    CALIB:  { text: 'CALIBRATING - sit straight',       color: '#8c8c00' },
    IDLE:   { text: "press 's' to calibrate",           color: '#3c3c3c' },
  };

  const nowSec = () =>
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

  /** Python V4Tracker와 같은 구조 (calib -> live, EMA, HOLD, 기준 자동 갱신) + 콜백/세션 시각 */
  class PostureTracker {
    constructor(callbacks) {
      this.cb = callbacks || {};
      this.phase = 'idle';
      this.calib = [];
      this.base = this.ref = null;
      this.ema = {};
      this.cand = 'GOOD'; this.cand_since = 0.0; this.shown = 'GOOD';
      this.calm_since = null; this.calm_buf = [];
      this.msg = '';
      this.reanchors = 0;
      this.gated = false;
      this.last_ema = null;
      // 콜백·세션용
      this._emitted = null;
      this._emittedReanchoring = false;
      this.session = null;            // { started_at, last_measured_at }
    }

    /** Python의 's' 키 */
    startCalib(now) {
      this.phase = 'calib';
      this.phase_start = now === undefined ? nowSec() : now;
      this.calib = [];
    }

    /** Python V4Tracker.update 그대로. m = measure(...) 결과 또는 null, now = 초 */
    update(m, now) {
      const C = CONFIG;
      this.msg = ''; this.gated = false;
      if (this.phase === 'idle') return 'IDLE';
      if (this.phase === 'calib') {
        if (m) this.calib.push(m);
        if (now - this.phase_start >= C.CALIB_SEC) {
          this.base = makeBase(this.calib);
          if (this.base === null) {
            this.phase = 'idle'; this.calib = [];
            return 'IDLE';
          }
          this.phase = 'live'; this.ema = {};
          this.ref = { sh: this.base.sh, sh_y: this.base.sh_y, z_head: this.base.z_head, tilt: 0.0 };
          this.calm_since = null; this.calm_buf = [];
          this.cand = 'GOOD'; this.cand_since = now; this.shown = 'GOOD';
        }
        return 'CALIB';
      }

      if (m === null || m === undefined) return 'NOVIS';
      const f = features(m, this.base, this.ref);
      if (Math.abs(f.yaw) > C.YAW_TH) {                  // 고개를 많이 돌림 -> 직전 판정 유지
        this.gated = true;
        this.msg = `head turned (${f.yaw >= 0 ? '+' : ''}${f.yaw.toFixed(0)} deg) - holding`;
        this.calm_since = null; this.calm_buf = [];
        return this.shown;
      }
      const ema = this.ema;
      for (const k of Object.keys(f)) {
        const v = f[k];
        ema[k] = !(k in ema) ? v : C.EMA_ALPHA * v + (1 - C.EMA_ALPHA) * ema[k];
      }
      const state = judge(ema);
      if (state !== this.cand) { this.cand = state; this.cand_since = now; }
      if (now - this.cand_since >= C.HOLD_SEC) this.shown = this.cand;
      const shown = this.shown;
      this.last_ema = Object.assign({}, ema);

      // ---- 기준 자동 갱신: 어깨 거리는 크게 변했는데 머리 전진(fwd)은 그대로 = 의자를 옮김 ----
      const moved = Math.abs(f.appr) > C.REANCHOR_MOVE_TH;
      const fwdOk = Math.abs(ema.fwd) < C.REANCHOR_FWD_TH;
      const dropOk = f.appr < 0 || ema.drop < C.DROP_TH;
      if (!(moved && fwdOk && dropOk)) {
        this.calm_since = null; this.calm_buf = [];
      } else {
        if (this.calm_since === null) { this.calm_since = now; this.calm_buf = []; }
        this.calm_buf.push(Object.assign({}, m, { z_sh: f.z_sh, fwd: ema.fwd }));
        if (now - this.calm_since >= C.REANCHOR_SEC) {
          const buf = this.calm_buf;
          const spread = p10p90(buf.map((s) => s.z_sh));
          if (spread < C.REANCHOR_STABLE && p10p90(buf.map((s) => s.fwd)) < C.REANCHOR_FWD_RANGE) {
            const neu = {
              sh: median(buf.map((s) => s.sh)),
              sh_y: median(buf.map((s) => s.sh_y)),
              z_head: median(buf.map((s) => s.z_head)),
            };
            refineK(this.base, this.ref, neu);
            const f_ = m.f;
            const [oz, oy] = shoulder3d(this.ref.sh, this.ref.sh_y, f_, this.base.k);
            const [nz, ny] = shoulder3d(neu.sh, neu.sh_y, f_, this.base.k);
            // 의자 이동은 수평 이동 -> 이때 보인 상하 변화(dY/dZ)가 카메라 기울기
            neu.tilt = nz === oz ? 0 : clamp((ny - oy) / (nz - oz), -C.TILT_MAX, C.TILT_MAX);
            this.ref = neu;
            this.ema = {};
            this.reanchors += 1;
            this.msg = 'REFERENCE UPDATED';
          }
          this.calm_since = null; this.calm_buf = [];
        }
      }
      if (this.calm_since !== null) this.msg = 'chair moved - hold still';
      return shown;
    }

    /**
     * 웹페이지에서 매 프레임 호출하는 함수.
     * poseResult: PoseLandmarker.detectForVideo 결과 (또는 { landmarks: [[...33점]] })
     * faceResult: FaceLandmarker.detectForVideo 결과 (outputFacialTransformationMatrixes: true 필요)
     * width/height: 영상 픽셀 크기 (video.videoWidth / videoHeight)
     * 반환: { state, m }
     */
    process({ poseResult, faceResult, width, height, now }) {
      const t = now === undefined ? nowSec() : now;
      const poseLm = poseResult && poseResult.landmarks && poseResult.landmarks[0] || null;
      const faceLm = faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks[0] || null;
      const faceMat = faceResult && faceResult.facialTransformationMatrixes &&
        faceResult.facialTransformationMatrixes[0] || null;
      const m = faceLm ? measure(poseLm, faceLm, faceMat, width, height) : null;

      const prevPhase = this.phase;
      const state = this.update(m, t);
      const wall = Date.now();

      if (prevPhase === 'calib' && this.phase === 'live') {
        if (!this.session) {                                // 재보정이면 세션을 새로 열지 않음
          this.session = { started_at: wall, last_measured_at: wall };
          if (this.cb.onSessionStart) this.cb.onSessionStart({ started_at: wall });
        }
      } else if (prevPhase === 'calib' && this.phase === 'idle') {
        if (this.cb.onCalibFail) this.cb.onCalibFail();
      }
      if (this.session && this.phase === 'live' && m) this.session.last_measured_at = wall;

      const reanchoring = this.calm_since !== null;
      const refUpdated = this.msg === 'REFERENCE UPDATED';
      if (state !== this._emitted || reanchoring !== this._emittedReanchoring || refUpdated) {
        const ev = {
          state: state,
          prev_state: this._emitted,
          alert: state === 'TURTLE' || state === 'WAIST',
          reanchoring: reanchoring,
          reference_updated: refUpdated,
          timestamp: wall,
          values: this.last_ema ? Object.assign({}, this.last_ema) : null,
        };
        this._emitted = state;
        this._emittedReanchoring = reanchoring;
        if (this.cb.onPostureChange) this.cb.onPostureChange(ev);
      }
      return { state: state, m: m };
    }

    /** 현재 세션 정보 (heartbeat 전송용). 측정 중이 아니면 null */
    getSession() {
      return this.session ? Object.assign({}, this.session) : null;
    }

    /**
     * 측정 종료. reason: 'button' | 'unload' | 그 밖의 문자열
     * - 'button' : ended_at = 지금
     * - 그 외    : ended_at = 마지막으로 실제 측정된 시각 (탭이 숨겨져 판정이 멈춘 시간을 빼기 위해)
     * 동기 함수라 pagehide 안에서 반환값을 바로 sendBeacon으로 보낼 수 있음. 세션이 없으면 null
     */
    stop(reason) {
      reason = reason || 'button';
      const s = this.session;
      let out = null;
      if (s) {
        const now = Date.now();
        out = {
          started_at: s.started_at,
          ended_at: reason === 'button' ? now : s.last_measured_at,
          last_measured_at: s.last_measured_at,
          reason: reason,
        };
        if (this.cb.onSessionEnd) this.cb.onSessionEnd(out);
      }
      this.session = null;
      this.phase = 'idle';
      this.calib = [];
      this.calm_since = null; this.calm_buf = [];
      this._emitted = null;
      return out;
    }

    /** 화면 표시용 수치 줄 (Python lines()와 동일) */
    lines() {
      const e = this.last_ema;
      if (this.phase !== 'live' || !e) return [];
      const s = (v, w, d) => ((v >= 0 ? '+' : '') + v.toFixed(d)).padStart(w);
      const C = CONFIG;
      return [
        `fwd   ${s(e.fwd, 6, 1)}cm (turtle > ${C.FWD_TH})`,
        `appr  ${s(e.appr, 6, 1)}cm (lean > ${C.LEAN_TH})`,
        `drop  ${s(e.drop, 6, 1)}cm (waist > ${C.DROP_TH})`,
        `dist  ${s(e.dist, 6, 1)}cm (close > ${C.CLOSE_TH})`,
        `yaw ${s(e.yaw, 4, 0)}  pitch ${s(e.pitch, 4, 0)}  neck ${s(e.neck, 5, 1)}cm`,
        `head ${e.z_head.toFixed(1).padStart(5)}cm  shoulder ${e.z_sh.toFixed(1).padStart(5)}cm  tilt ${s(this.ref.tilt, 0, 2)}`,
      ];
    }
  }

  const api = {
    CONFIG, BANNER, LM_CHIN,
    PostureTracker,
    measure, features, judge, makeBase, refineK, eulerDeg, matAccessor, shoulder3d, focalPx, median, p10p90,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PostureV4 = api;
})(typeof window !== 'undefined' ? window : globalThis);