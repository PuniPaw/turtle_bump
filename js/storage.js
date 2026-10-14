
 // Flask + MariaDB API client (5173 -> 5000)
export const API_BASE = 'http://127.0.0.1:5000';

async function requestJSON(path, options = {}) {
    const response = await fetch(API_BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });

    const raw = await response.text();
    let data;

    try {
    data = raw ? JSON.parse(raw) : null;
    } catch {
    throw new Error(`JSON 응답 오류: HTTP ${response.status}`);
    }

    if (!response.ok) {
    const message = typeof data?.error === 'string'
        ? data.error
        : data?.error?.message;
    throw new Error(message || `서버 요청 실패: HTTP ${response.status}`);
    }

    return data;
}

export async function startSession(startedAtMs = Date.now()) {
    const result = await requestJSON('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ started_at_ms: startedAtMs })
    });
    return result.session_id;
}

export async function saveEvents(sessionId, events) {
    return requestJSON(`/api/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({ events })
    });
}

export async function endSession(
    sessionId,
    reason = 'camera_off',
    endedAtMs = Date.now()
) {
    return requestJSON(`/api/sessions/${sessionId}/end`, {
    method: 'POST',
    body: JSON.stringify({
        ended_at_ms: endedAtMs,
        reason
    })
    });
}

export async function getHomeSummary(asOfMs = Date.now()) {
    return requestJSON(`/api/summary/home?as_of_ms=${asOfMs}`);
}

export async function getStats({
    period = 'today',
    unit = 'day',
    asOf = Date.now()
} = {}) {
    const params = new URLSearchParams({
    period,
    unit,
    as_of_ms: String(asOf)
    });

    return requestJSON(`/api/stats?${params}`);
}