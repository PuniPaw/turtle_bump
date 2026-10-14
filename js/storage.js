
const API_BASE = "http://127.0.0.1:5000";

const VALID_REASONS = new Set([
  "camera_off",
  "pagehide",
  "input_ended"
]);

function checkSessionId(sessionId) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw new Error("올바른 sessionId가 필요합니다.");
  }
}

function checkEvents(events) {
  if (!Array.isArray(events) || events.length > 500) {
    throw new Error("events는 최대 500개의 배열이어야 합니다.");
  }
}

async function requestJSON(path, options = {}) {
  let response;

  try {
    response = await fetch(API_BASE + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
  } catch (error) {
    const err = new Error(
      "Flask 서버에 연결할 수 없습니다. app.py 실행 상태를 확인하세요."
    );
    err.cause = error;
    throw err;
  }

  const raw = await response.text();

  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        `서버가 JSON이 아닌 응답을 반환했습니다. HTTP ${response.status}`
      );
    }
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || `HTTP ${response.status}`
    );

    error.status = response.status;
    error.reason = data?.error?.reason || null;

    throw error;
  }

  return data;
}

// 1. 세션 생성
export async function startSession(
  startedAtMs = Date.now()
) {
  const result = await requestJSON("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      started_at_ms: startedAtMs
    })
  });

  return result.session_id;
}

// 2. 이벤트 저장
export async function saveEvents(sessionId, events) {
  checkSessionId(sessionId);
  checkEvents(events);

  return requestJSON(
    `/api/sessions/${sessionId}/events`,
    {
      method: "POST",
      body: JSON.stringify({ events })
    }
  );
}

// 3. 세션 종료
export async function endSession(
  sessionId,
  reason = "camera_off",
  endedAtMs = Date.now(),
  events = []
) {
  checkSessionId(sessionId);
  checkEvents(events);

  if (!VALID_REASONS.has(reason)) {
    throw new Error("올바르지 않은 종료 사유입니다.");
  }

  return requestJSON(
    `/api/sessions/${sessionId}/end`,
    {
      method: "POST",
      body: JSON.stringify({
        ended_at_ms: endedAtMs,
        reason,
        events
      })
    }
  );
}

// 4. 홈 누적 측정 시간
export async function getHomeSummary(
  asOfMs = Date.now()
) {
  return requestJSON(
    `/api/summary/home?as_of_ms=${asOfMs}`
  );
}

// 5. 기간별 통계
export async function getStats({
  period = "today",
  unit = "day",
  asOf = Date.now()
} = {}) {
  const params = new URLSearchParams({
    period,
    unit,
    as_of_ms: String(asOf)
  });

  return requestJSON(`/api/stats?${params}`);
}

// 6. 브라우저 페이지 이탈 시 종료 시도
export function sendEndBeacon(
  sessionId,
  reason = "pagehide",
  events = [],
  endedAtMs = Date.now()
) {
  if (
    !Number.isInteger(sessionId) ||
    sessionId <= 0 ||
    !VALID_REASONS.has(reason) ||
    !Array.isArray(events) ||
    events.length > 500 ||
    typeof navigator.sendBeacon !== "function"
  ) {
    return false;
  }

  const body = JSON.stringify({
    ended_at_ms: endedAtMs,
    reason,
    events
  });

  const blob = new Blob([body], {
    type: "application/json"
  });

  // Beacon 요청은 64KB 미만으로 제한
  if (blob.size >= 64 * 1024) {
    return false;
  }

  // true는 전송 예약 성공이며 DB 저장 성공은 아님
  return navigator.sendBeacon(
    `${API_BASE}/api/sessions/${sessionId}/end`,
    blob
  );
}
