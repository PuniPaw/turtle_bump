// 측정 세션·자세 이벤트 저장 브리지 — NeckCare API 명세서 v0.3.3 5장·8장 기준.
// B의 판정·C의 알림은 그대로 두고, posture-adapter.js가 알려 주는 "확정 상태"와 "경고 시작"만 받아
// 서버에 보낼 이벤트 구간을 만든다. 측정값을 만들거나 추정하지 않는다.
//
// 규칙 요약(명세)
//   - 카메라 실제 연결 성공 시각을 고정하고 세션 1개 생성(중복 연결 무시). 첫 구간은 CALIB(유효시간 제외).
//   - 상태 전환 시 transitionAtMs = Date.now() 하나로 이전 구간 종료(is_final=true)와 새 구간 시작을 맞춘다.
//   - 0초 구간은 보내지 않는다. 최종화된 구간(종료 시각·경고값 포함)은 이후 바꾸지 않는다.
//   - alert_triggered = C의 자세 경고가 비활성→활성으로 시작된 구간만 true(TURTLE→WAIST로 이어진 경고는 false).
//   - 전송 시점: 통계 갱신 직전(진행 중 구간은 ended_at_ms=asOf, is_final=false 스냅샷), 카메라 OFF, pagehide.
//   - 실패한 최종 구간은 같은 UUID·같은 종료 시각으로 보관했다가 재전송한다.
//   - 종료 실패 시 최초 종료 내용을 고정해 재시도하고, 카메라 재연결은 새 세션으로 따로 진행한다.
import * as api from './backend-api.js';

const STATES = new Set(['GOOD', 'TURTLE', 'WAIST', 'CLOSE', 'NOVIS', 'CALIB', 'IDLE']);
const RETRY_MS = [2000, 5000, 10000, 30000, 60000];

export function createSessionRecorder({ onStatus = () => {}, onSessionEnded = () => {} } = {}) {
  let active = null;        // 지금 측정 중인 세션
  const closings = [];      // 종료 요청을 재시도 중인 이전 세션들
  let flushing = Promise.resolve();

  // ---- 세션 ----------------------------------------------------------------
  function newSession(startedAtMs) {
    const s = {
      startedAtMs,
      sessionId: null,
      failed: false,
      current: null,   // 진행 중 구간 { event_id, state, started_at_ms, alert_triggered }
      finals: [],      // 최종화됐지만 아직 저장 확인 안 된 구간(고정된 값)
    };
    s.ready = api.createSession(startedAtMs)
      .then((r) => {
        s.sessionId = r.session_id;
        onStatus('session_started', { sessionId: s.sessionId });
        return s.sessionId;
      })
      .catch((err) => {
        s.failed = true;   // 임의 session_id를 만들지 않는다. 카메라·판정은 계속 동작
        onStatus('session_failed', { error: err });
        return null;
      });
    return s;
  }

  function openEvent(s, state, at) {
    s.current = { event_id: crypto.randomUUID(), state, started_at_ms: at, alert_triggered: false };
  }

  // 진행 중 구간을 at 시각으로 최종화. 0초면 보내지 않고 버린다.
  function closeEvent(s, at) {
    const c = s.current;
    s.current = null;
    if (!c || !(at > c.started_at_ms)) return;
    s.finals.push(Object.freeze({ ...c, ended_at_ms: at, is_final: true }));
  }

  // ---- 전송 ----------------------------------------------------------------
  async function sendEvents(sessionId, events) {
    for (let i = 0; i < events.length; i += api.MAX_EVENTS_PER_REQUEST) {
      await api.saveEvents(sessionId, events.slice(i, i + api.MAX_EVENTS_PER_REQUEST));
    }
  }

  // 현재 세션의 미전송 최종 구간 + (asOf가 있으면) 진행 중 구간 스냅샷을 저장한다.
  async function flushActive(asOf) {
    const s = active;
    if (!s) return true;
    const sessionId = await s.ready;
    if (!sessionId) return false;     // 세션 생성 실패: 저장 불가(카메라·판정은 계속)
    if (s !== active) return true;    // 그 사이 카메라 OFF: 남은 구간은 종료 요청이 보낸다

    const finals = s.finals.slice();
    const events = [...finals];
    const c = s.current;
    if (asOf != null && c && asOf > c.started_at_ms) {
      events.push({ ...c, ended_at_ms: asOf, is_final: false });
    }
    if (!events.length) return true;

    try {
      await sendEvents(sessionId, events);
      s.finals = s.finals.filter((e) => !finals.includes(e));
      onStatus('saved', { sessionId, count: events.length });
      return true;
    } catch (err) {
      if (err.permanent) {
        // 다시 보내도 바뀌지 않는 오류(검증 실패·충돌·종료된 세션): 무한 재시도하지 않고 기록만 남긴다
        s.finals = s.finals.filter((e) => !finals.includes(e));
        console.error('[neckcare] 이벤트 저장 거부', err.status, err.reason, err.message);
      } else {
        console.warn('[neckcare] 이벤트 저장 실패(다음 전송 때 재시도)', err.message);
      }
      onStatus('save_failed', { sessionId, error: err });
      return false;
    }
  }

  // ---- 종료(재시도 포함) ------------------------------------------------------
  async function runClose(job) {
    clearTimeout(job.timer);
    const sessionId = await job.session.ready;
    if (!sessionId) {
      remove(job);
      return;
    }
    try {
      // 500개를 넘으면 앞부분은 /events로 먼저 저장(멱등)하고 나머지를 /end에 동봉
      const events = job.events;
      const head = events.slice(0, Math.max(0, events.length - api.MAX_EVENTS_PER_REQUEST));
      const tail = events.slice(head.length);
      await sendEvents(sessionId, head);
      const result = await api.endSession(sessionId, { endedAtMs: job.endedAtMs, reason: job.reason, events: tail });
      remove(job);
      onStatus('session_ended', { sessionId, result });
      onSessionEnded(result);
    } catch (err) {
      if (err.permanent) {
        remove(job);
        console.error('[neckcare] 세션 종료 거부', err.status, err.reason, err.message);
        onStatus('end_failed', { sessionId, error: err, final: true });
        return;
      }
      const wait = RETRY_MS[Math.min(job.attempts, RETRY_MS.length - 1)];
      job.attempts += 1;
      console.warn(`[neckcare] 세션 종료 실패, ${wait / 1000}초 뒤 같은 내용으로 재시도`, err.message);
      onStatus('end_failed', { sessionId, error: err, final: false, attempts: job.attempts });
      job.timer = setTimeout(() => runClose(job), wait);
    }
  }

  function remove(job) {
    clearTimeout(job.timer);
    const i = closings.indexOf(job);
    if (i >= 0) closings.splice(i, 1);
  }

  // ---- 공개 API --------------------------------------------------------------
  return {
    // 카메라 스트림 실제 연결 성공 직후 호출. 이미 측정 중이면 무시(중복 연결 방지)
    start() {
      if (active) return;
      const at = Date.now();
      active = newSession(at);
      openEvent(active, 'CALIB', at);
    },

    // 확정 상태(B 결과 GOOD/TURTLE/WAIST/CLOSE/NOVIS, C 수명주기 CALIB/IDLE)
    setState(state) {
      const s = active;
      if (!s || !STATES.has(state) || s.current?.state === state) return;
      const transitionAtMs = Date.now();
      closeEvent(s, transitionAtMs);
      openEvent(s, state, transitionAtMs);
    },

    // C의 자세 경고가 비활성→활성으로 시작됨: 현재 구간에만 표시(최종화 전)
    markAlertStarted() {
      if (active?.current) active.current.alert_triggered = true;
    },

    // 통계 갱신 직전: 미전송 최종 구간 + 진행 중 스냅샷(ended_at_ms=asOf) 저장. 종료 재시도도 함께 시도
    flush(asOf = Date.now()) {
      closings.forEach((job) => { if (!job.timer) return; runClose(job); });
      flushing = flushing.then(() => flushActive(asOf), () => flushActive(asOf));
      return flushing;
    },

    // 카메라 OFF(또는 입력 종료). 최초 종료 시각을 고정하고 마지막 구간을 최종화해 종료 요청
    stop(reason = 'camera_off') {
      const s = active;
      if (!s) return Promise.resolve();
      active = null;
      const endedAtMs = Date.now();
      closeEvent(s, endedAtMs);
      const job = { session: s, endedAtMs, reason, events: Object.freeze(s.finals.slice()), attempts: 0, timer: null };
      closings.push(job);
      return flushing.then(() => runClose(job), () => runClose(job));
    },

    // pagehide: 최선 노력 전송(성공 보장 없음)
    pageHide() {
      if (active) {
        const s = active;
        active = null;
        const endedAtMs = Date.now();
        closeEvent(s, endedAtMs);
        if (s.sessionId) api.endSessionBestEffort(s.sessionId, { endedAtMs, reason: 'pagehide', events: s.finals });
      }
      for (const job of closings) {
        if (job.session.sessionId) {
          api.endSessionBestEffort(job.session.sessionId, { endedAtMs: job.endedAtMs, reason: job.reason, events: job.events });
        }
      }
    },

    // 디버그용 상태
    getStatus() {
      return {
        active: active && {
          sessionId: active.sessionId,
          failed: active.failed,
          current: active.current && { ...active.current },
          pendingFinals: active.finals.length,
        },
        closing: closings.map((j) => ({ sessionId: j.session.sessionId, endedAtMs: j.endedAtMs, attempts: j.attempts, events: j.events.length })),
      };
    },
  };
}
