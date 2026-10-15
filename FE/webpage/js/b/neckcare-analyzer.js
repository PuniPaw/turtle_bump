/**
 * neckcare-analyzer.js — NeckCare 연동용 B(자세 판정) 모듈 (ES module)
 *
 * 판정 로직은 ./turtleneck.js (B의 v4 JS 이식판, 원본과 바이트 단위로 동일한 사본)의 PostureTracker를
 * "그대로" 씀. 이 파일은 그 바깥을 감싸는 층(래퍼)만 담당함:
 *   - MediaPipe Pose/Face Landmarker 로딩 (demo.html과 같은 버전·모델·옵션)
 *   - C가 넘겨준 <video>에서 직접 프레임을 읽는 추론 루프 (카메라를 따로 열지 않음)
 *   - registerAnalyzer 계약(beginBaseline / finishBaseline / start / stop)과 결과·오류 콜백
 * 판정 기준값(PostureV4.CONFIG), EMA, HOLD, 기준 자동 갱신은 손대지 않음.
 *
 * 사용:
 *   import { createNeckCareAnalyzer } from './neckcare-analyzer.js';
 *   const analyzer = createNeckCareAnalyzer({ onResult: (r) => ..., onError: (e) => ... });
 *   window.neckcare.registerAnalyzer(analyzer);
 * 자세한 설명은 README.md
 */
import './turtleneck.js';   // 일반 스크립트. 실행되면 globalThis.PostureV4 가 생김
import { FilesetResolver, PoseLandmarker, FaceLandmarker }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const PV4 = globalThis.PostureV4;
const { PostureTracker } = PV4;

export const MEDIAPIPE_VERSION = '0.10.14';
export const ANALYZER_VERSION = 'neckcare-b 1.0 (turtleneck.js v4)';

/** B 원래 상태값 (turtleneck.js PostureTracker.update 반환값) */
export const B_STATES = Object.freeze(['IDLE', 'CALIB', 'GOOD', 'TURTLE', 'WAIST', 'CLOSE', 'NOVIS']);
/** HOLD_SEC(0.5초) 안정화를 거쳐 나오는 상태 */
const STABILIZED = new Set(['GOOD', 'TURTLE', 'WAIST', 'CLOSE']);

export const DEFAULT_OPTIONS = Object.freeze({
  // ---- 모델 (demo.html과 동일) ----
  wasmBase: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  poseModel: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  faceModel: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  delegate: 'GPU',          // demo.html과 동일. 'CPU'로 고정 가능
  cpuFallback: true,        // GPU로 만들기 실패하면 CPU로 한 번 더 시도

  // ---- 결과 전달 ----
  emit: 'change',           // 'change' = 상태/사유/플래그가 바뀔 때만, 'frame' = 분석한 프레임마다
  onResult: null,           // (result) => void
  onError: null,            // (error)  => void

  // ---- 래퍼 동작값 (판정 기준 아님) ----
  recalibrateAfterNovisMs: null, // NOVIS가 이 시간 이상 이어지면 '다시 설정 필요' 확정. null = 확정 안 함 (합의 필요)
  inputStallMs: 2000,       // 판정 중 새 영상 프레임이 이 시간 동안 없으면 onError('input_stalled')
  videoReadyTimeoutMs: 5000,// beginBaseline에서 video가 재생 가능해질 때까지 기다리는 최대 시간
  baselineGraceMs: 2000,    // finishBaseline이 측정(3초) 완료를 추가로 기다리는 여유 시간
  watchdogMs: 200,          // requestVideoFrameCallback이 멈췄을 때(video 숨김 등) 타이머로 대신 분석하는 간격
});

/** 얼굴/어깨가 안 잡힌 이유. turtleneck.js measure()가 null을 돌려주는 조건을 같은 순서로 확인만 함 */
function missingReason(poseResult, faceResult, width, height) {
  const faceLm = faceResult && faceResult.faceLandmarks && faceResult.faceLandmarks[0];
  if (!faceLm) return 'no_face';
  const mat = faceResult.facialTransformationMatrixes && faceResult.facialTransformationMatrixes[0];
  if (!mat) return 'no_face_matrix';
  const poseLm = poseResult && poseResult.landmarks && poseResult.landmarks[0];
  if (!poseLm || !poseLm[11] || !poseLm[12]) return 'no_pose';
  const vis = (p) => (p.visibility == null ? 1 : p.visibility);
  if (vis(poseLm[11]) < PV4.CONFIG.VIS_TH || vis(poseLm[12]) < PV4.CONFIG.VIS_TH) return 'shoulders_not_visible';
  const sh = Math.hypot((poseLm[11].x - poseLm[12].x) * width, (poseLm[11].y - poseLm[12].y) * height);
  if (sh < 1) return 'shoulders_invalid';
  return null;
}

async function createLandmarkers(opt, delegate) {
  const fileset = await FilesetResolver.forVisionTasks(opt.wasmBase);
  let pose = null;
  try {
    pose = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opt.poseModel, delegate },
      runningMode: 'VIDEO', numPoses: 1,
      minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    const face = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opt.faceModel, delegate },
      runningMode: 'VIDEO', numFaces: 1,
      minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,   // 필수: 머리 거리·yaw/pitch 계산
    });
    return { pose, face, delegate };
  } catch (e) {
    if (pose) pose.close();
    throw e;
  }
}

/**
 * registerAnalyzer에 넘길 객체를 만든다.
 * @returns {{beginBaseline, finishBaseline, start, stop, onResult, onError, getLatest, getDebug, dispose}}
 */
export function createNeckCareAnalyzer(options = {}) {
  const opt = Object.assign({}, DEFAULT_OPTIONS, options);
  const resultListeners = new Set();
  const errorListeners = new Set();
  if (opt.onResult) resultListeners.add(opt.onResult);
  if (opt.onError) errorListeners.add(opt.onError);

  let modelsPromise = null;
  let models = null;
  let gen = 0;                 // 진행 번호. beginBaseline/stop마다 증가 -> 늦게 끝난 비동기 작업은 무시
  let video = null;
  let tracker = null;
  let started = false;
  let rvfcId = null, timerId = null;
  let lastTs = -1, lastVideoTime = -1;
  let lastStepAt = 0, lastNewFrameAt = 0, stalled = false, inputEnded = false;
  let calib = null;            // { frames, valid, missing: {reason: n}, failReason, waiters: [] }
  let last = null;             // 마지막으로 계산한 결과 (emit 여부와 무관)
  let lastEmitted = null;
  let stateSince = null, stateSincePerf = null, prevState = null;
  let novisSince = null, recalibrationRequired = false;
  let lastInferenceError = null;
  const fps = { n: 0, since: 0, value: 0 };

  // ---------- 모델 ----------
  function loadModels() {
    if (!modelsPromise) {
      modelsPromise = (async () => {
        try {
          return await createLandmarkers(opt, opt.delegate);
        } catch (e) {
          if (opt.delegate === 'GPU' && opt.cpuFallback) {
            console.warn('[neckcare-b] GPU 대리자 생성 실패 -> CPU로 다시 시도', e);
            return await createLandmarkers(opt, 'CPU');
          }
          throw e;
        }
      })().catch((e) => { modelsPromise = null; throw e; });
    }
    return modelsPromise;
  }

  // ---------- 알림 ----------
  function emitError(type, error, detail) {
    const ev = {
      type,                                   // 'model_load_failed' | 'video_not_ready' | 'inference_error' | 'input_stalled' | 'input_ended'
      message: error ? String(error.message || error) : type,
      error: error || null,
      detail: detail || null,
      timestamp: Date.now(),
    };
    for (const cb of errorListeners) {
      try { cb(ev); } catch (e) { console.error('[neckcare-b] onError 콜백 오류', e); }
    }
    if (!errorListeners.size) console.warn('[neckcare-b]', ev.type, ev.message);
  }

  function emitResult(r) {
    lastEmitted = r;
    for (const cb of resultListeners) {
      try { cb(r); } catch (e) { console.error('[neckcare-b] onResult 콜백 오류', e); }
    }
  }

  function changed(a, b) {
    return !b || a.state !== b.state || a.reason !== b.reason || a.gated !== b.gated
      || a.reanchoring !== b.reanchoring || a.reference_updated || a.needs_recalibration !== b.needs_recalibration;
  }

  // ---------- 정리 ----------
  function cancelLoop() {
    if (rvfcId !== null && video && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfcId);
    rvfcId = null;
    if (timerId !== null) clearInterval(timerId);
    timerId = null;
  }

  function settleCalib(result) {
    if (!calib) return;
    const ws = calib.waiters;
    calib.waiters = [];
    for (const w of ws) w(result);
  }

  function halt(reason) {
    gen += 1;
    cancelLoop();
    settleCalib({ ok: false, reason });
    calib = null;
    tracker = null;
    video = null;
    started = false;
    last = lastEmitted = null;
    stateSince = stateSincePerf = prevState = null;
    novisSince = null;
    recalibrationRequired = false;
    stalled = inputEnded = false;
    lastVideoTime = -1;
  }

  // ---------- 추론 루프 ----------
  function nextTs() {
    lastTs = Math.max(lastTs + 1, Math.floor(performance.now()));
    return lastTs;
  }

  function startLoop(myGen) {
    const v = video;
    const useRvfc = typeof v.requestVideoFrameCallback === 'function';
    const onFrame = () => {
      if (myGen !== gen) return;
      step(myGen);
      if (useRvfc) rvfcId = v.requestVideoFrameCallback(onFrame);
    };
    if (useRvfc) rvfcId = v.requestVideoFrameCallback(onFrame);
    // video가 display:none이거나 rVFC가 오지 않을 때 대신 분석 + 입력 중단 감시
    timerId = setInterval(() => {
      if (myGen !== gen) return;
      const now = performance.now();
      if (!useRvfc || now - lastStepAt > opt.watchdogMs) step(myGen);
      checkInput(now);
    }, Math.max(16, Math.floor(opt.watchdogMs / 2)));
  }

  function checkInput(now) {
    if (!video) return;
    const stream = video.srcObject;
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    if (track && track.readyState === 'ended') {
      if (!inputEnded) { inputEnded = stalled = true; emitError('input_ended', null, { track: track.label }); }
      return;
    }
    if (opt.inputStallMs != null && lastNewFrameAt && now - lastNewFrameAt > opt.inputStallMs) {
      if (!stalled) {
        stalled = true;
        emitError('input_stalled', null, { ms_since_last_frame: Math.round(now - lastNewFrameAt) });
      }
    }
  }

  function step(myGen) {
    lastStepAt = performance.now();
    if (!video || !tracker || !models) return;
    if (video.readyState < 2 || !video.videoWidth) return;
    const vt = video.currentTime;
    if (vt === lastVideoTime) return;                 // 같은 프레임은 다시 분석하지 않음
    lastVideoTime = vt;
    lastNewFrameAt = lastStepAt;
    if (stalled && !inputEnded) stalled = false;

    const width = video.videoWidth, height = video.videoHeight;
    let poseResult, faceResult;
    try {
      const ts = nextTs();
      poseResult = models.pose.detectForVideo(video, ts);
      faceResult = models.face.detectForVideo(video, ts);
      lastInferenceError = null;
    } catch (e) {
      if (!lastInferenceError) emitError('inference_error', e);   // 연속 오류는 한 번만 알림
      lastInferenceError = e;
      return;
    }
    if (myGen !== gen) return;

    const reason = missingReason(poseResult, faceResult, width, height);
    const prevPhase = tracker.phase;
    const { state } = tracker.process({ poseResult, faceResult, width, height });

    // fps
    fps.n += 1;
    if (lastStepAt - fps.since >= 1000) {
      fps.value = (fps.n * 1000) / (lastStepAt - fps.since);
      fps.n = 0; fps.since = lastStepAt;
    }

    // 기준 자세 수집 기록
    if (prevPhase === 'calib' && calib) {
      calib.frames += 1;
      if (reason) calib.missing[reason] = (calib.missing[reason] || 0) + 1;
      else calib.valid += 1;
      if (tracker.phase !== 'calib') {
        if (tracker.phase === 'live') settleCalib(baselineOk());
        else {
          calib.failReason = 'not_visible';
          settleCalib(baselineFail('not_visible'));
        }
      }
    }
    if (tracker.phase !== 'live') return;

    // ---- 결과 만들기 (판정은 tracker가 이미 끝냄. 여기서는 읽기만) ----
    const wall = Date.now();
    if (!last || last.state !== state) {
      prevState = last ? last.state : null;
      stateSince = wall; stateSincePerf = lastStepAt;
    }
    if (state === 'NOVIS') {
      if (novisSince === null) novisSince = lastStepAt;
      if (opt.recalibrateAfterNovisMs != null && lastStepAt - novisSince >= opt.recalibrateAfterNovisMs) {
        recalibrationRequired = true;
      }
    } else {
      novisSince = null;
    }
    const r = {
      source: 'neckcare-b',
      state,                                         // B 원래 값
      prev_state: prevState,                         // 직전의 '다른' state
      stabilized: STABILIZED.has(state),
      alert: state === 'TURTLE' || state === 'WAIST', // turtleneck.js process()의 alert와 같은 정의
      state_since: stateSince,                       // Date.now() ms
      duration_ms: lastStepAt - stateSincePerf,
      reason: state === 'NOVIS' ? reason : null,
      gated: tracker.gated,                          // 고개 회전(YAW_TH 초과)으로 직전 판정 유지 중
      reanchoring: tracker.calm_since !== null,      // 의자 이동 감지, 기준 갱신 대기 중
      reference_updated: tracker.msg === 'REFERENCE UPDATED',
      novis_ms: novisSince === null ? 0 : lastStepAt - novisSince,
      needs_recalibration: recalibrationRequired,
      timestamp: wall,                               // Date.now() ms
      perf_time: lastStepAt,                         // performance.now() ms
      values: tracker.last_ema ? Object.assign({}, tracker.last_ema) : null,
    };
    const shouldEmit = started && (opt.emit === 'frame' || changed(r, lastEmitted));
    last = r;
    if (shouldEmit) emitResult(r);
  }

  function baselineOk() {
    return {
      ok: true,
      base: Object.assign({}, tracker.base),
      frames: calib.frames,
      valid_frames: calib.valid,
      delegate: models.delegate,
    };
  }

  function baselineFail(reason) {
    return {
      ok: false,
      reason,                                        // 'not_visible' | 'timeout' | 'cancelled' | 'restarted' | 'stopped' | 'not_started'
      frames: calib ? calib.frames : 0,
      valid_frames: calib ? calib.valid : 0,
      missing: calib ? Object.assign({}, calib.missing) : {},
    };
  }

  function waitVideoReady(v, myGen) {
    if (v.readyState >= 2 && v.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(t);
        v.removeEventListener('loadeddata', onReady);
        v.removeEventListener('resize', onReady);
        fn(arg);
      };
      const onReady = () => {
        if (myGen !== gen) done(reject, new Error('cancelled'));
        else if (v.readyState >= 2 && v.videoWidth > 0) done(resolve);
      };
      const t = setTimeout(() => done(reject, new Error('video_not_ready')), opt.videoReadyTimeoutMs);
      v.addEventListener('loadeddata', onReady);
      v.addEventListener('resize', onReady);
    });
  }

  // ---------- 공개 API ----------
  const api = {
    /**
     * 기준 자세 측정 시작. 모델 로딩·준비를 끝낸 뒤, 끝나는 즉시 3초 수집을 시작함.
     * 이전 기준값·진행 중인 루프는 모두 버림. 실패하면 예외를 던짐.
     */
    async beginBaseline(v) {
      halt('restarted');
      const myGen = gen;
      if (!v || typeof v.readyState !== 'number') throw new TypeError('beginBaseline(video): HTMLVideoElement가 필요합니다');
      try {
        models = await loadModels();
      } catch (e) {
        emitError('model_load_failed', e);
        throw e;
      }
      if (myGen !== gen) throw new Error('cancelled');
      try {
        await waitVideoReady(v, myGen);
      } catch (e) {
        if (e.message !== 'cancelled') emitError('video_not_ready', e);
        throw e;
      }
      if (myGen !== gen) throw new Error('cancelled');
      // 준비 실행: 첫 추론(GPU 셰이더 준비 등)이 느리므로 수집 시작 전에 한 번 돌림
      try {
        const ts = nextTs();
        models.pose.detectForVideo(v, ts);
        models.face.detectForVideo(v, ts);
      } catch (e) {
        emitError('inference_error', e);
        throw e;
      }
      if (myGen !== gen) throw new Error('cancelled');
      video = v;
      tracker = new PostureTracker({});
      calib = { frames: 0, valid: 0, missing: {}, failReason: null, waiters: [] };
      lastNewFrameAt = performance.now();
      fps.since = lastNewFrameAt; fps.n = 0;
      tracker.startCalib();                           // turtleneck.js: CALIB_SEC(3초) 수집 시작
      startLoop(myGen);
    },

    /** 기준 자세 측정 결과. ok === true면 성공. 예외는 던지지 않음 */
    async finishBaseline() {
      const myGen = gen;
      if (!tracker || !calib) return baselineFail('not_started');
      if (tracker.phase === 'live') return baselineOk();
      if (tracker.phase !== 'calib') return baselineFail(calib.failReason || 'not_visible');
      const waitMs = PV4.CONFIG.CALIB_SEC * 1000 + opt.baselineGraceMs;
      const result = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(baselineFail(
          inputEnded ? 'input_ended' : stalled ? 'input_stalled' : 'timeout')), waitMs);
        calib.waiters.push((r) => { clearTimeout(t); resolve(r); });
      });
      if (myGen !== gen) return baselineFail('cancelled');
      return result;
    },

    /** 판정 결과 전달 시작 (동기). start(cb)로 콜백을 같이 넘길 수도 있음 */
    start(cb) {
      if (typeof cb === 'function') resultListeners.add(cb);
      if (!tracker || tracker.phase !== 'live') {
        console.warn('[neckcare-b] start(): 기준 자세가 설정되지 않아 무시합니다');
        return;
      }
      started = true;
      if (last) emitResult(last);                     // 현재 상태를 바로 한 번 보냄
    },

    /** 모든 수집·추론 루프·타이머 정리, 기준값 삭제 (동기). 모델은 재사용을 위해 유지 */
    stop() {
      halt('stopped');
    },

    /** 결과 콜백 등록. 해제 함수를 돌려줌 */
    onResult(cb) {
      resultListeners.add(cb);
      return () => resultListeners.delete(cb);
    },

    /** 오류 콜백 등록. 해제 함수를 돌려줌 */
    onError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },

    /** 마지막으로 계산한 결과 (start 전이면 null일 수 있음) */
    getLatest() {
      return last ? Object.assign({}, last) : null;
    },

    /** 디버그 정보 */
    getDebug() {
      return {
        version: ANALYZER_VERSION,
        phase: tracker ? tracker.phase : 'idle',
        started,
        delegate: models ? models.delegate : null,
        fps: Math.round(fps.value * 10) / 10,
        video: video ? { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState } : null,
        stalled,
        calib: calib ? { frames: calib.frames, valid: calib.valid, missing: Object.assign({}, calib.missing) } : null,
        lines: tracker ? tracker.lines() : [],
        config: Object.assign({}, PV4.CONFIG),
      };
    },

    /** stop() + 모델 해제. 페이지를 떠날 때 등 */
    dispose() {
      halt('stopped');
      if (models) { models.pose.close(); models.face.close(); }
      models = null; modelsPromise = null;
    },
  };
  return api;
}
