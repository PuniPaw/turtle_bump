
/*
 * bcintegration.js
 * D 담당: C 프론트엔드와 Flask API 연결
 *
 * 주요 역할
 * - 측정 세션 생성
 * - 자세 이벤트 저장 대기열 관리
 * - UUID별 최신 스냅샷 유지
 * - 통계 조회 전 이벤트 저장
 * - 카메라 종료 및 실패 재시도
 *
 * 주의:
 * 자세 판정, 카메라 제어, 경고 발생은 C 담당 역할이다.
 */

import {
    startSession,
    saveEvents,
    endSession,
    sendEndBeacon
} from "./storage.js";

import {
    createStatsProvider,
    updateHomeMeasuredSec
} from "./stats.js";

const VALID_STATES = new Set([
    "GOOD",
    "TURTLE",
    "WAIST",
    "CLOSE",
    "NOVIS",
    "CALIB",
    "IDLE"
]);

const VALID_REASONS = new Set([
    "camera_off",
    "pagehide",
    "input_ended"
]);

let sessionId = null;

// 아직 서버에 저장하지 못한 이벤트
let pendingEvents = new Map();

// 중복 요청 방지
let startingPromise = null;
let savingPromise = null;
let stoppingPromise = null;

// 종료 실패 시 동일 요청으로 재시도하기 위한 데이터
let pendingEndRequest = null;

let lastError = null;

// --------------------------------------------------
// 1. 이벤트 데이터 검사
// --------------------------------------------------
function normalizeEvent(event) {
    if (!event || typeof event !== "object") {
        throw new Error("자세 이벤트 객체가 필요합니다.");
    }

    if (!VALID_STATES.has(event.state)) {
        throw new Error("허용되지 않은 자세 상태입니다.");
    }

    if (
        typeof event.event_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(event.event_id)
    ) {
        throw new Error("올바른 UUID가 필요합니다.");
    }

    if (!Number.isInteger(event.started_at_ms)) {
        throw new Error("started_at_ms가 필요합니다.");
    }

    const endedAt = event.ended_at_ms ?? null;

    if (
        endedAt !== null &&
        (
            !Number.isInteger(endedAt) ||
            endedAt < event.started_at_ms
        )
    ) {
        throw new Error("이벤트 종료 시각이 올바르지 않습니다.");
    }

    if (typeof event.alert_triggered !== "boolean") {
        throw new Error("alert_triggered는 Boolean이어야 합니다.");
    }

    return {
        event_id: event.event_id.toLowerCase(),
        state: event.state,
        started_at_ms: event.started_at_ms,
        ended_at_ms: endedAt,
        alert_triggered: event.alert_triggered
    };
}

// --------------------------------------------------
// 2. 동일 UUID의 이벤트 합치기
// --------------------------------------------------
function mergeEvent(oldEvent, newEvent) {
    if (!oldEvent) {
        return newEvent;
    }

    if (
        oldEvent.state !== newEvent.state ||
        oldEvent.started_at_ms !== newEvent.started_at_ms
    ) {
        throw new Error(
            "동일 UUID에 서로 다른 자세 구간을 사용할 수 없습니다."
        );
    }

    const oldEnd = oldEvent.ended_at_ms;
    const newEnd = newEvent.ended_at_ms;

    let mergedEnd = null;

    if (oldEnd === null) {
        mergedEnd = newEnd;
    } else if (newEnd === null) {
        mergedEnd = oldEnd;
    } else {
        mergedEnd = Math.max(oldEnd, newEnd);
    }

    return {
        ...newEvent,
        ended_at_ms: mergedEnd,
        // 실제 경고 발생 이력은 되돌리지 않음
        alert_triggered:
            oldEvent.alert_triggered ||
            newEvent.alert_triggered
    };
}

// --------------------------------------------------
// 3. 카메라 연결 성공 후 세션 시작
// --------------------------------------------------
export async function beginMonitoring(
    startedAtMs = Date.now()
) {
    // 종료 실패 상태에서 새로운 세션을 만들지 않음
    if (pendingEndRequest) {
        throw new Error(
            "이전 측정 종료가 완료되지 않았습니다. 종료 재시도가 필요합니다."
        );
    }

    if (stoppingPromise) {
        await stoppingPromise;
    }

    if (sessionId !== null) {
        return sessionId;
    }

    if (startingPromise) {
        return startingPromise;
    }

    startingPromise = (async () => {
        const id = await startSession(startedAtMs);

        sessionId = id;
        pendingEvents.clear();
        lastError = null;

        return id;
    })();

    try {
        return await startingPromise;
    } catch (error) {
        lastError = error;
        throw error;
    } finally {
        startingPromise = null;
    }
}

// --------------------------------------------------
// 4. C가 전달한 자세 이벤트 받기
// --------------------------------------------------
export async function receivePostureEvent(
    event,
    { flush = false } = {}
) {
    if (startingPromise) {
        await startingPromise;
    }

    if (sessionId === null) {
        throw new Error("현재 측정 세션이 없습니다.");
    }

    // 종료가 시작된 뒤에는 새 이벤트를 받지 않음
    if (pendingEndRequest || stoppingPromise) {
        throw new Error("세션 종료 중에는 이벤트를 추가할 수 없습니다.");
    }

    const next = normalizeEvent(event);
    const old = pendingEvents.get(next.event_id);

    const merged = mergeEvent(old, next);

    pendingEvents.set(next.event_id, merged);

    if (flush) {
        await flushEvents();
    }
}

// --------------------------------------------------
// 5. 미저장 이벤트를 서버에 전송
// --------------------------------------------------
export async function flushEvents() {
    if (startingPromise) {
        await startingPromise;
    }

    // 이미 저장 중이라면 같은 작업 완료를 기다림
    if (savingPromise) {
        return savingPromise;
    }

    if (sessionId === null || pendingEvents.size === 0) {
        return;
    }

    const id = sessionId;

    savingPromise = (async () => {
        while (pendingEvents.size > 0) {
            // 서버 최대 요청 크기: 500개
            const batch = [
                ...pendingEvents.values()
            ].slice(0, 500);

            try {
                await saveEvents(id, batch);

                // 저장 중 새로운 스냅샷이 들어왔다면
                // 기존보다 긴 이벤트는 대기열에 남겨 둠
                for (const item of batch) {
                    const current = pendingEvents.get(
                        item.event_id
                    );

                    if (current === item) {
                        pendingEvents.delete(item.event_id);
                    }
                }

                lastError = null;
            } catch (error) {
                // 실패한 이벤트는 삭제하지 않음
                lastError = error;
                throw error;
            }
        }
    })();

    try {
        await savingPromise;
    } finally {
        savingPromise = null;
    }
}

// --------------------------------------------------
// 6. 통계 조회 전 이벤트 저장
// --------------------------------------------------
export async function flushBeforeStats(
    asOf = Date.now(),
    createSnapshot
) {
    // C가 전달한 콜백으로 현재 자세 스냅샷 생성
    if (typeof createSnapshot === "function") {
        const snapshot = await createSnapshot(asOf);

        if (snapshot) {
            if (Array.isArray(snapshot)) {
                for (const event of snapshot) {
                    await receivePostureEvent(event);
                }
            } else {
                await receivePostureEvent(snapshot);
            }
        }
    }

    // 저장이 성공해야 통계 조회를 진행
    await flushEvents();
}

// --------------------------------------------------
// 7. 종료 요청 데이터 최초 확정
// --------------------------------------------------
function freezeEndRequest(reason, endedAtMs) {
    if (pendingEndRequest) {
        return pendingEndRequest;
    }

    if (!VALID_REASONS.has(reason)) {
        throw new Error("종료 사유가 올바르지 않습니다.");
    }

    if (!Number.isInteger(endedAtMs)) {
        throw new Error("종료 시각이 올바르지 않습니다.");
    }

    // 최초 종료 시각과 사유를 고정
    pendingEndRequest = {
        sessionId,
        reason,
        endedAtMs,
        events: null
    };

    return pendingEndRequest;
}

// --------------------------------------------------
// 8. 카메라 OFF 시 세션 종료
// --------------------------------------------------
export async function finishMonitoring(
    reason = "camera_off",
    endedAtMs = Date.now()
) {
    if (stoppingPromise) {
        return stoppingPromise;
    }

    if (startingPromise) {
        await startingPromise;
    }

    if (sessionId === null) {
        return null;
    }

    // 재시도 시 새로운 endedAtMs를 사용하지 않음
    const endRequest = freezeEndRequest(
        reason,
        endedAtMs
    );

    stoppingPromise = (async () => {
        // 첫 종료 요청에서만 이벤트 최종본을 확정
        if (endRequest.events === null) {
            // 이미 진행 중인 이벤트 저장 요청을 기다림
            if (savingPromise) {
                try {
                    await savingPromise;
                } catch {
                    // 실패 이벤트는 pendingEvents에 남음
                }
            }

            // 남은 이벤트를 종료 API에 함께 보냄
            const remaining = [
                ...pendingEvents.values()
            ];

            if (remaining.length > 500) {
                throw new Error(
                    "종료 대기 이벤트가 500개를 초과했습니다."
                );
            }

            // 재시도 때도 동일한 이벤트 배열을 사용
            endRequest.events = remaining.map(
                event => ({ ...event })
            );
        }

        const result = await endSession(
            endRequest.sessionId,
            endRequest.reason,
            endRequest.endedAtMs,
            endRequest.events
        );

        // 종료 성공 확인 후에만 초기화
        sessionId = null;
        pendingEvents.clear();
        pendingEndRequest = null;
        lastError = null;

        return result;
    })();

    try {
        return await stoppingPromise;
    } catch (error) {
        // 실패해도 세션과 종료 요청 정보를 유지
        lastError = error;
        throw error;
    } finally {
        stoppingPromise = null;
    }
}

// --------------------------------------------------
// 9. 종료 실패 시 재시도
// --------------------------------------------------
export async function retryFinishMonitoring() {
    if (!pendingEndRequest) {
        throw new Error("재시도할 종료 요청이 없습니다.");
    }

    // 저장된 최초 종료 시각과 사유 그대로 사용
    return finishMonitoring(
        pendingEndRequest.reason,
        pendingEndRequest.endedAtMs
    );
}

// --------------------------------------------------
// 10. 페이지 이탈 시 Beacon 전송
// --------------------------------------------------
export function finishOnPageHide() {
    if (sessionId === null) {
        return false;
    }

    // 이미 종료 요청이 있으면 해당 시각을 유지
    const requestData = freezeEndRequest(
        "pagehide",
        Date.now()
    );

    // 기존 종료 데이터가 있으면 그대로 사용
    if (requestData.events === null) {
        requestData.events = [
            ...pendingEvents.values()
        ].map(event => ({ ...event }));
    }

    return sendEndBeacon(
        requestData.sessionId,
        requestData.reason,
        requestData.events,
        requestData.endedAtMs
    );
}

// --------------------------------------------------
// 11. C의 통계 화면에 Provider 전달
// --------------------------------------------------
export function getStatsProvider({
    createSnapshot
} = {}) {
    return createStatsProvider({
        beforeQuery: asOf =>
            flushBeforeStats(asOf, createSnapshot)
    });
}

// --------------------------------------------------
// 12. 홈 화면 측정 시간 갱신
// --------------------------------------------------
export async function refreshHomeStats(
    store,
    { createSnapshot } = {}
) {
    const asOf = Date.now();

    return updateHomeMeasuredSec(
        store,
        asOf,
        time => flushBeforeStats(
            time,
            createSnapshot
        )
    );
}

// --------------------------------------------------
// 13. 현재 상태 확인
// --------------------------------------------------
export function getCurrentSessionId() {
    return sessionId;
}

export function getSaveStatus() {
    return {
        sessionId,
        pendingCount: pendingEvents.size,
        saving: !!savingPromise,
        stopping: !!stoppingPromise,
        needsEndRetry: !!pendingEndRequest,
        error: lastError?.message ?? null
    };
}
