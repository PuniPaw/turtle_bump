
// storage.js
// D 담당: Flask 서버와 통신하는 공통 API 모듈

// C의 정적 서버(5173)와 D의 Flask 서버(5000)를 분리
export const API_BASE = "http://127.0.0.1:5000";

// --------------------------------------------------
// 1. 공통 요청 함수
// --------------------------------------------------

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
            `서버 응답이 JSON이 아닙니다. HTTP ${response.status}`
        );
    }

    if (!response.ok) {
        const message =
            data?.error?.message ||
            `서버 요청 실패: HTTP ${response.status}`;

        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return data;
}


// --------------------------------------------------
// 2. 측정 세션 생성
// --------------------------------------------------

export async function startSession(startedAtMs = Date.now()) {
    const result = await requestJSON("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
            started_at_ms: startedAtMs
        })
    });

    // ERD의 session_id는 INT
    return result.session_id;
}


// --------------------------------------------------
// 3. 자세 구간 저장
// --------------------------------------------------

export async function saveEvents(sessionId, events) {
    if (!Number.isInteger(sessionId)) {
        throw new Error("유효한 sessionId가 필요합니다.");
    }

    if (!Array.isArray(events)) {
        throw new Error("events는 배열이어야 합니다.");
    }

    return await requestJSON(
        `/api/sessions/${sessionId}/events`,
        {
            method: "POST",
            body: JSON.stringify({ events })
        }
    );
}


// --------------------------------------------------
// 4. 측정 세션 종료
// --------------------------------------------------

export async function endSession(
    sessionId,
    reason = "camera_off",
    endedAtMs = Date.now()
) {
    return await requestJSON(
        `/api/sessions/${sessionId}/end`,
        {
            method: "POST",
            body: JSON.stringify({
                ended_at_ms: endedAtMs,
                reason
            })
        }
    );
}


// --------------------------------------------------
// 5. 홈 누적 측정 시간 조회
// --------------------------------------------------

export async function getHomeSummary(
    asOfMs = Date.now()
) {
    return await requestJSON(
        `/api/summary/home?as_of_ms=${asOfMs}`
    );
}


// --------------------------------------------------
// 6. 오늘 / 7일 / 30일 통계 조회
// --------------------------------------------------

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

    return await requestJSON(
        `/api/stats?${params.toString()}`
    );
}


// --------------------------------------------------
// 7. 페이지 종료 시 세션 종료 요청
// --------------------------------------------------

export function sendEndBeacon(
    sessionId,
    reason = "pagehide"
) {
    if (!Number.isInteger(sessionId)) {
        return false;
    }

    const url =
        `${API_BASE}/api/sessions/${sessionId}/end`;

    const body = JSON.stringify({
        ended_at_ms: Date.now(),
        reason
    });

    // sendBeacon은 응답 내용을 읽을 수 없다.
    // true는 전송 예약 성공이지 DB 저장 성공이 아니다.
    const blob = new Blob([body], {
        type: "application/json"
    });

    return navigator.sendBeacon(url, blob);
}
