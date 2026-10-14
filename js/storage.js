
/*
 * storage.js
 * D 담당: Flask API 통신
 *
 * 역할
 * 1. 세션 생성
 * 2. 자세 이벤트 저장
 * 3. 세션 종료
 * 4. 홈 및 통계 조회
 * 5. 페이지 종료 시 Beacon 전송
 */

export const API_BASE = "http://127.0.0.1:5000";

// Flask 서버에 JSON 요청을 보내는 공통 함수
async function requestJSON(path, options = {}) {
    const response = await fetch(API_BASE + path, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const raw = await response.text();

    let data;
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        throw new Error(
            `서버 JSON 응답을 읽지 못했습니다. HTTP ${response.status}`
        );
    }

    if (!response.ok) {
        const error = new Error(
            data?.error?.message ||
            `서버 요청 실패: HTTP ${response.status}`
        );

        // app.py에서 전달하는 오류 정보를 보존
        error.status = response.status;
        error.reason = data?.error?.reason || null;
        throw error;
    }

    return data;
}

// 1. 카메라 연결 성공 후 세션 생성
export async function startSession(startedAtMs = Date.now()) {
    const result = await requestJSON("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
            started_at_ms: startedAtMs
        })
    });

    return result.session_id;
}

// 2. 자세 이벤트 저장
export async function saveEvents(sessionId, events) {
    if (!Number.isInteger(sessionId)) {
        throw new Error("sessionId가 올바르지 않습니다.");
    }

    if (!Array.isArray(events) || events.length > 500) {
        throw new Error("events는 최대 500개 배열이어야 합니다.");
    }

    return requestJSON(
        `/api/sessions/${sessionId}/events`,
        {
            method: "POST",
            body: JSON.stringify({ events })
        }
    );
}

// 3. 세션 종료
// 재시도할 때는 반드시 같은 endedAtMs와 events를 전달
export async function endSession(
    sessionId,
    reason = "camera_off",
    endedAtMs = Date.now(),
    events = []
) {
    if (!Number.isInteger(sessionId)) {
        throw new Error("sessionId가 올바르지 않습니다.");
    }

    if (!Array.isArray(events) || events.length > 500) {
        throw new Error("종료 이벤트가 500개를 초과했습니다.");
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

// 4. 홈 화면 누적 측정 시간
export async function getHomeSummary(asOfMs = Date.now()) {
    const query = new URLSearchParams({
        as_of_ms: String(asOfMs)
    });

    return requestJSON(`/api/summary/home?${query}`);
}

// 5. 기간별 통계 조회
export async function getStats({
    period = "today",
    unit = "day",
    asOf = Date.now()
} = {}) {
    const query = new URLSearchParams({
        period,
        unit,
        as_of_ms: String(asOf)
    });

    return requestJSON(`/api/stats?${query}`);
}

// 6. 페이지 이탈 시 종료 요청
// true는 전송 예약 성공이며 DB 저장 완료를 의미하지 않음
export function sendEndBeacon(
    sessionId,
    reason = "pagehide",
    events = [],
    endedAtMs = Date.now()
) {
    if (
        !Number.isInteger(sessionId) ||
        !Array.isArray(events) ||
        events.length > 500
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

    // Beacon 전송 크기 제한 고려
    if (blob.size >= 64 * 1024) {
        console.warn("[D] Beacon 데이터가 너무 큽니다.");
        return false;
    }

    if (
        typeof navigator === "undefined" ||
        typeof navigator.sendBeacon !== "function"
    ) {
        return false;
    }

    return navigator.sendBeacon(
        `${API_BASE}/api/sessions/${sessionId}/end`,
        blob
    );
}
