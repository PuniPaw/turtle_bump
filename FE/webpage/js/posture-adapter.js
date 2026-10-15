// B 판정 모듈(js/b/neckcare-analyzer.js) 결과를 NeckCare 화면·알림으로 바꾸는 연결 계층(Adapter).
// B의 판정 로직은 건드리지 않고, B가 보내는 결과(state·state_since·needs_recalibration …)만 읽는다.
//
// 상태 대응 (B state → store.posture)
//   GOOD, CLOSE        → status 'good'     (CLOSE는 별도 문구 없이 바른 자세로 표시)
//   TURTLE, WAIST      → status 'warn'     (나쁜 자세가 BAD_ALERT_MS 이어지면 'bad' + 경고)
//                        kind 'turtle' | 'waist'
//   NOVIS              → status 'unknown', reason 'novis'  (판정 불가: 타이머 일시정지, 진행 중인 경고는 유지)
//   needs_recalibration→ status 'unknown', reason 'recalibration' (경고 끄고 "자세 판단이 어렵습니다" 안내)
//
// 경고 시점 정책(팀 합의)
//   - 거북목·허리 굽음이 약 5초 이어지면 경고. B의 안정화(HOLD 0.5초)를 포함해 자세가 시작된 시점부터 센다.
//   - 거북목 ↔ 허리 굽음으로 바뀌어도 하나의 나쁜 자세 구간으로 보고 이어서 센다(경고 문구만 바뀜).
//   - 판정 불가(NOVIS) 동안은 일시정지(지난 시간은 유지, 시간은 더하지 않음).
//   - 바른 자세(GOOD·CLOSE)가 되면 초기화하고 경고를 끈다.
import {
  loadNotifyLevel, startPostureAlert, stopPostureAlert,
  showRecalibrationNotice, hideRecalibrationNotice,
} from './notify.js';

export const BAD_ALERT_MS = 5000;   // 나쁜 자세 지속 → 경고까지(팀 합의: 약 5초)
const B_HOLD_MS = 500;               // B의 안정화 시간(turtleneck.js CONFIG.HOLD_SEC). 나쁜 자세 시작 시점 보정에만 사용

const KIND_OF = { TURTLE: 'turtle', WAIST: 'waist' };
const IDLE_POSTURE = { ts: null, angle: null, status: 'unknown', kind: null, reason: null };

// onState(state): 저장용 확정 상태 알림(B 결과 GOOD/TURTLE/WAIST/CLOSE/NOVIS, 수명주기 CALIB/IDLE)
// onAlertStart(): 자세 경고가 비활성→활성으로 시작될 때(명세 v0.3.3의 alert_triggered)
// 둘 다 선택이며 화면·알림 정책에는 영향을 주지 않는다(session-recorder.js가 사용).
export function createPostureAdapter({ store, onState = () => {}, onAlertStart = () => {} }) {
  let badMs = 0;          // 지금 나쁜 자세 구간에서 이미 지난 시간(일시정지 전까지 누적)
  let runningSince = null;// 시간을 세는 중이면 performance.now() 기준 시작 시각
  let kind = null;        // 현재 나쁜 자세 종류
  let alerting = false;
  let timer = null;
  let recalibration = false;

  function clearTimer() {
    clearTimeout(timer);
    timer = null;
  }

  const elapsed = () => badMs + (runningSince === null ? 0 : performance.now() - runningSince);

  function setPosture(patch) {
    store.setState({ posture: { ...IDLE_POSTURE, ...patch } });
  }

  function fireAlert() {
    timer = null;
    alerting = true;
    onAlertStart();
    startPostureAlert(loadNotifyLevel(), { kind });
    setPosture({ ts: Date.now(), status: 'bad', kind });
  }

  function schedule() {
    clearTimer();
    if (alerting) return;
    const remain = BAD_ALERT_MS - elapsed();
    if (remain <= 0) fireAlert();
    else timer = setTimeout(fireAlert, remain);
  }

  function pause() {
    if (runningSince !== null) {
      badMs = elapsed();
      runningSince = null;
    }
    clearTimer();
  }

  // 나쁜 자세 구간 종료(바른 자세 복귀·초기화)
  function resetBad() {
    clearTimer();
    badMs = 0;
    runningSince = null;
    kind = null;
    if (alerting) {
      alerting = false;
      stopPostureAlert();
    }
  }

  function handleResult(r) {
    if (!r) return;
    onState(r.state);   // 저장용: B 확정 상태 그대로(화면 처리와 별개)
    if (recalibration) return;

    if (r.needs_recalibration) {
      recalibration = true;
      resetBad();
      showRecalibrationNotice();
      setPosture({ ts: r.timestamp, reason: 'recalibration' });
      return;
    }

    const badKind = KIND_OF[r.state];
    if (badKind) {
      const firstInSegment = badMs === 0 && runningSince === null;
      kind = badKind;
      if (runningSince === null) {
        // 새 구간이면 B 안정화 시간만큼 이미 지난 것으로 본다(자세가 실제로 시작된 시점부터 계산)
        if (firstInSegment) badMs = B_HOLD_MS + Math.max(0, r.duration_ms || 0);
        runningSince = performance.now();
      }
      if (alerting) startPostureAlert(loadNotifyLevel(), { kind });   // 종류가 바뀌면 문구만 바뀜(중복 실행 없음)
      else schedule();
      setPosture({ ts: r.timestamp, status: alerting ? 'bad' : 'warn', kind });
      return;
    }

    if (r.state === 'NOVIS') {
      pause();
      setPosture({ ts: r.timestamp, reason: 'novis', kind });
      return;
    }

    // GOOD, CLOSE
    resetBad();
    setPosture({ ts: r.timestamp, status: 'good' });
  }

  function handleError(e) {
    console.warn('[neckcare-b]', e?.type, e?.message, e?.detail ?? '');
    // 입력이 끊기면 판정이 멈추므로 시간도 멈춘다(진행 중인 경고는 유지)
    if (e?.type === 'input_stalled' || e?.type === 'input_ended') pause();
  }

  // 분석 시작 전·카메라 해제·재설정 시 모든 상태 정리
  function reset() {
    resetBad();
    recalibration = false;
    hideRecalibrationNotice();
    store.setState({ posture: { ...IDLE_POSTURE }, analysis: { status: 'idle' } });
  }

  // calibration.js의 registerAnalyzer에 넘길 객체로 감싼다(계약은 그대로, 시작·정리만 끼워 넣음).
  function wrap(analyzer) {
    return {
      async beginBaseline(video) {
        reset();
        onState('CALIB');   // 초기 자세 설정 구간(유효 측정시간 제외)
        return analyzer.beginBaseline(video);
      },
      finishBaseline: () => analyzer.finishBaseline(),
      start() {
        analyzer.start();
        store.setState({ analysis: { status: 'running' } });
      },
      stop() {
        analyzer.stop();
        reset();
        onState('IDLE');    // 판정 중지(기준 자세 실패·설정 취소). 카메라 OFF 때는 저장 세션이 먼저 끝나 무시됨
      },
    };
  }

  return { handleResult, handleError, wrap, reset };
}
