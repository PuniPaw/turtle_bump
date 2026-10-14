/*
 * storage.js
 * D 담당 - Flask API 통신
 *
 * v0.3.3 최종 보완본
 *
 * 주요 역할
 * 1. 측정 세션 생성
 * 2. 자세 이벤트 저장
 * 3. 측정 세션 종료
 * 4. 홈 및 통계 조회
 * 5. 페이지 종료 시 sendBeacon 전송
 *
 * 주의:
 * 이벤트의 is_final 값은 C가 생성하고,
 * 이 파일은 해당 값을 변경하지 않고 전송한다.
 */

export const API_BASE = "http://127.0.0.1:5000";

// 공통 JSON 요청 함수
async function requestJSON(path, options = {}) {
    const response = await fetch(API_BASE + path, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    const raw = await response.text();

    let data = null;

    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        throw new Error(
            `JSON 응답 해석 실패 (HTTP ${response.status})`
        );
    }

    if (!response.ok) {
        const error = new Error(
            data?.error?.message ||
            `서버 요청 실패 (HTTP ${response.status})`
        );

        // Flask에서 전달한 오류 종류를 유지한다.
        error.status = response.status;
        error.reason = data?.error?.reason || null;

        throw error;
    }

    return data;
}

// 1. 세션 생성
export async function startSession(startedAtMs = Date.now()) {
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
    if (!Number.isInteger(sessionId)) {
        throw new Error("세션 ID가 올바르지 않습니다.");
    }

    if (!Array.isArray(events) || events.length > 500) {
        throw new Error("이벤트는 최대 500개까지 전송할 수 있습니다.");
    }

    // 이벤트 내부의 is_final은 그대로 보낸다.
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
    reason,
    endedAtMs,
    events = []
) {
    if (!Number.isInteger(sessionId)) {
        throw new Error("세션 ID가 올바르지 않습니다.");
    }

    if (!Array.isArray(events) || events.length > 500) {
        throw new Error("종료 이벤트는 최대 500개입니다.");
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
    const params = new URLSearchParams({
        as_of_ms: String(asOfMs)
    });

    return requestJSON(`/api/summary/home?${params}`);
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

// 6. 페이지 이탈 시 종료 요청
export function sendEndBeacon(
    sessionId,
    reason,
    endedAtMs,
    events = []
) {
    if (
        !Number.isInteger(sessionId) ||
        !Number.isInteger(endedAtMs) ||
        !Array.isArray(events) ||
        events.length > 500
    ) {
        return false;
    }

    const payload = JSON.stringify({
        ended_at_ms: endedAtMs,
        reason,
        events
    });

    const blob = new Blob([payload], {
        type: "application/json"
    });

    // 브라우저의 Beacon 크기 제한을 고려한다.
    if (blob.size >= 64 * 1024) {
        console.warn("[D] Beacon 전송 크기 초과");
        return false;
    }

    if (
        typeof navigator === "undefined" ||
        typeof navigator.sendBeacon !== "function"
    ) {
        return false;
    }

    // true는 전송 예약 성공일 뿐 DB 저장 완료는 아니다.
    return navigator.sendBeacon(
        `${API_BASE}/api/sessions/${sessionId}/end`,
        blob
    );
}