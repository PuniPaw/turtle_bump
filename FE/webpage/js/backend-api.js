// D(Flask) 백엔드 API 클라이언트 — NeckCare API 명세서 v0.3.3 기준.
//   POST /api/sessions                   세션 생성
//   POST /api/sessions/{id}/events       자세 이벤트 저장(최대 500개)
//   POST /api/sessions/{id}/end          세션 종료(+미전송 이벤트 동봉 가능)
//   GET  /api/summary/home?as_of_ms=     홈 누적 측정 시간
//   GET  /api/stats?period=&unit=&as_of_ms=  통계
// 시각은 모두 UTC epoch 밀리초 정수(Date.now()). 요청 필드는 snake_case.
// 이 파일은 통신만 한다. 데이터를 만들거나 계산하지 않는다.

// 개발 주소(명세 1장). 바꿔야 하면 페이지에서 window.NECKCARE_API_BASE를 먼저 지정한다.
export const API_BASE = (globalThis.NECKCARE_API_BASE || 'http://127.0.0.1:5000/api').replace(/\/$/, '');

export const MAX_EVENTS_PER_REQUEST = 500;
export const BEACON_MAX_BYTES = 64 * 1024;

// 서버 오류: status(HTTP, 네트워크 오류는 0), reason(명세 2장 error.reason)
export class ApiError extends Error {
  constructor(message, { status = 0, reason = 'NETWORK', body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
    this.body = body;
  }
  // 다시 보내도 결과가 바뀌지 않는 오류(요청 자체가 잘못됨·충돌). 네트워크·5xx는 재시도 대상
  get permanent() {
    return this.status >= 400 && this.status < 500;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(`백엔드 서버에 연결하지 못했습니다 (${API_BASE})`, { status: 0, reason: 'NETWORK' });
  }

  const raw = await res.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ApiError(`서버 응답이 JSON이 아닙니다 (HTTP ${res.status})`, { status: res.status, reason: 'BAD_RESPONSE' });
    }
  }
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(e.message || `서버 요청 실패 (HTTP ${res.status})`, {
      status: res.status,
      reason: e.reason || 'UNKNOWN',
      body: data,
    });
  }
  return data;
}

// 6.1 세션 생성 → { session_id, started_at_ms }
export function createSession(startedAtMs) {
  return request('/sessions', { method: 'POST', body: { started_at_ms: startedAtMs } });
}

// 6.2 이벤트 저장 → { ok, received_count, saved, updated, ignored }
export function saveEvents(sessionId, events) {
  return request(`/sessions/${sessionId}/events`, { method: 'POST', body: { events } });
}

// 6.3 세션 종료 → { ok, session_id, ended_at_ms, total_duration_sec, valid_duration_sec }
export function endSession(sessionId, { endedAtMs, reason, events = [] }) {
  return request(`/sessions/${sessionId}/end`, {
    method: 'POST',
    body: { ended_at_ms: endedAtMs, reason, events },
  });
}

// 6.3 pagehide용 최선 노력 종료. 반환값 true는 "전송 예약"일 뿐 DB 저장 성공이 아니다(명세 8장).
// 본문은 64KB 미만으로 맞춘다(넘치면 오래된 이벤트부터 뺀다).
export function endSessionBestEffort(sessionId, { endedAtMs, reason, events = [] }) {
  const url = `${API_BASE}/sessions/${sessionId}/end`;
  let list = events.slice(-MAX_EVENTS_PER_REQUEST);
  let body = JSON.stringify({ ended_at_ms: endedAtMs, reason, events: list });
  while (new Blob([body]).size >= BEACON_MAX_BYTES && list.length) {
    list = list.slice(1);
    body = JSON.stringify({ ended_at_ms: endedAtMs, reason, events: list });
  }
  // keepalive fetch와 sendBeacon을 함께 시도한다. 종료 요청은 같은 내용 재전송이 멱등이고(명세 6.3),
  // 브라우저에 따라 교차 출처 JSON 전송이 한쪽에서 막힐 수 있어서다.
  let queued = false;
  try {
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    queued = true;
  } catch { /* 무시 */ }
  try {
    queued = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })) || queued;
  } catch { /* 무시 */ }
  return queued;
}

// 6.4 홈 누적 측정 시간 → { measured_sec: number | null }
export function getHomeSummary(asOfMs) {
  return request(`/summary/home?as_of_ms=${asOfMs}`);
}

// 6.5 통계 → C 통계 화면 StatsResult 형식 그대로(stats-source.js 참고)
export function getStats({ period, unit, asOf }) {
  const q = new URLSearchParams({ period, unit, as_of_ms: String(asOf) });
  return request(`/stats?${q}`);
}
