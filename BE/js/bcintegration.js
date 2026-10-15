/*
 * bcintegration.js
 * D 담당 - C와 Flask 사이의 저장 브리지
 *
 * NeckCare v0.3.3 최종 보완본
 *
 * C 담당:
 * - 자세 상태 판단
 * - UUID 생성
 * - 상태 전환 시각 결정
 * - is_final 및 alert_triggered 결정
 *
 * D 담당:
 * - 이벤트 검증
 * - 저장 대기열
 * - Flask API 전송
 * - 종료 재시도
 *
 * 다중 세션 버퍼는 아직 구현하지 않는다.
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

const STATES = new Set([
    "GOOD",
    "TURTLE",
    "WAIST",
    "CLOSE",
    "NOVIS",
    "CALIB",
    "IDLE"
]);

const END_REASONS = new Set([
    "camera_off",
    "pagehide",
    "input_ended"
]);

// 현재 세션
let sessionId = null;

// 저장되지 않았거나 최신 변경이 남아 있는 이벤트
const pendingEvents = new Map();

// 이미 서버 저장이 성공한 최신 이벤트 정보
const savedEvents = new Map();

let startingPromise = null;
let savingPromise = null;
let stoppingPromise = null;

// 종료 요청 실패 시 최초 데이터를 유지
let pendingEndRequest = null;

let lastError = null;


// ========================================
// 1. 이벤트 검사
// ========================================

function normalizeEvent(event) {
    if (!event || typeof event !== "object") {
        throw new Error("이벤트 객체가 필요합니다.");
    }

    const {
        event_id,
        state,
        started_at_ms,
        ended_at_ms,
        is_final,
        alert_triggered
    } = event;

    if (
        typeof event_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(event_id)
    ) {
        throw new Error("유효한 이벤트 UUID가 필요합니다.");
    }

    if (!STATES.has(state)) {
        throw new Error("허용되지 않은 자세 상태입니다.");
    }

    if (!Number.isSafeInteger(started_at_ms)) {
        throw new Error("시작 시각이 올바르지 않습니다.");
    }

    if (
        ended_at_ms !== null &&
        (
            !Number.isSafeInteger(ended_at_ms) ||
            ended_at_ms <= started_at_ms
        )
    ) {
        // 0초 이벤트와 역행 구간 금지
        throw new Error("종료 시각은 시작 시각보다 커야 합니다.");
    }

    if (typeof is_final !== "boolean") {
        throw new Error("is_final은 Boolean이어야 합니다.");
    }

    if (is_final && ended_at_ms === null) {
        throw new Error("최종 이벤트에는 종료 시각이 필요합니다.");
    }

    if (typeof alert_triggered !== "boolean") {
        throw new Error("alert_triggered는 Boolean이어야 합니다.");
    }

    return {
        event_id: event_id.toLowerCase(),
        state,
        started_at_ms,
        ended_at_ms,
        is_final,
        alert_triggered
    };
}


// ========================================
// 2. 동일 UUID 이벤트 병합
// ========================================

function mergeEvent(oldEvent, nextEvent) {
    if (!oldEvent) {
        return nextEvent;
    }

    if (
        oldEvent.event_id !== nextEvent.event_id ||
        oldEvent.state !== nextEvent.state ||
        oldEvent.started_at_ms !== nextEvent.started_at_ms
    ) {
        throw new Error(
            "동일 UUID에 다른 자세 구간을 사용할 수 없습니다."
        );
    }

    // 이미 최종화된 이벤트
    if (oldEvent.is_final) {
        // 뒤늦게 도착한 과거 스냅샷은 무시한다.
        if (!nextEvent.is_final) {
            return oldEvent;
        }

        // 최종화된 값은 경고값까지 변경 금지
        if (
            oldEvent.ended_at_ms !== nextEvent.ended_at_ms ||
            oldEvent.alert_triggered !== nextEvent.alert_triggered
        ) {
            throw new Error(
                "최종화된 이벤트는 변경할 수 없습니다."
            );
        }

        return oldEvent;
    }

    // 미확정 이벤트를 최종화하는 경우
    if (nextEvent.is_final) {
        const oldEnd = oldEvent.ended_at_ms;

        if (
            oldEnd !== null &&
            nextEvent.ended_at_ms < oldEnd
        ) {
            throw new Error(
                "최종 종료 시각이 기존 스냅샷보다 빠릅니다."
            );
        }

        // 최종화 시점의 경고값은 C가 확정한 값 사용
        return nextEvent;
    }

    // 미확정 스냅샷끼리 병합
    const oldEnd = oldEvent.ended_at_ms;
    const nextEnd = nextEvent.ended_at_ms;

    let mergedEnd = null;

    if (oldEnd === null) {
        mergedEnd = nextEnd;
    } else if (nextEnd === null) {
        mergedEnd = oldEnd;
    } else {
        mergedEnd = Math.max(oldEnd, nextEnd);
    }

    return {
        ...oldEvent,
        ended_at_ms: mergedEnd,

        // 실제 경고 시작 사실은 되돌리지 않는다.
        alert_triggered:
            oldEvent.alert_triggered ||
            nextEvent.alert_triggered
    };
}


// ========================================
// 3. 측정 시작
// ========================================

export async function beginMonitoring(
    startedAtMs = Date.now()
) {
    // 현재 구현은 단일 세션만 지원한다.
    // 종료 실패한 이전 세션의 버퍼를 덮어쓰지 않는다.
    if (pendingEndRequest || stoppingPromise) {
        throw new Error(
            "이전 세션 종료가 완료되지 않았습니다. 종료 재시도가 필요합니다."
        );
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
        savedEvents.clear();
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


// ========================================
// 4. C가 생성한 이벤트 받기
// ========================================

export async function receivePostureEvent(
    event,
    { flush = false } = {}
) {
    if (startingPromise) {
        await startingPromise;
    }

    if (sessionId === null) {
        throw new Error("측정 세션이 없습니다.");
    }

    if (pendingEndRequest || stoppingPromise) {
        throw new Error("종료 중에는 이벤트를 추가할 수 없습니다.");
    }

    const next = normalizeEvent(event);

    // 대기열과 저장 완료 정보 중 최신 값을 기준으로 병합
    const old =
        pendingEvents.get(next.event_id) ||
        savedEvents.get(next.event_id);

    const merged = mergeEvent(old, next);

    // 내용이 변하지 않은 오래된 스냅샷은 다시 저장하지 않음
    if (merged !== old) {
        pendingEvents.set(next.event_id, merged);
    }

    if (flush) {
        await flushEvents();
    }

    return merged;
}


// ========================================
// 5. 미저장 이벤트 전송
// ========================================

export async function flushEvents() {
    if (startingPromise) {
        await startingPromise;
    }

    if (savingPromise) {
        return savingPromise;
    }

    if (sessionId === null || pendingEvents.size === 0) {
        return;
    }

    const id = sessionId;

    savingPromise = (async () => {
        while (pendingEvents.size > 0) {
            const batch = [
                ...pendingEvents.values()
            ].slice(0, 500);

            await saveEvents(id, batch);

            // 서버가 정상 응답했을 때만 저장 완료 처리
            for (const sent of batch) {
                const previous = savedEvents.get(sent.event_id);
                const saved = mergeEvent(previous, sent);

                savedEvents.set(sent.event_id, saved);

                // 전송 도중 새 스냅샷이 들어온 경우
                // 새 스냅샷을 지우지 않는다.
                if (pendingEvents.get(sent.event_id) === sent) {
                    pendingEvents.delete(sent.event_id);
                }
            }

            lastError = null;
        }
    })();

    try {
        await savingPromise;
    } catch (error) {
        // 전송 실패한 이벤트는 대기열에 남는다.
        lastError = error;
        throw error;
    } finally {
        savingPromise = null;
    }
}


// ========================================
// 6. 통계 조회 전 스냅샷 저장
// ========================================

export async function flushBeforeStats(
    asOf = Date.now(),
    createSnapshot
) {
    if (typeof createSnapshot === "function") {
        const snapshot = await createSnapshot(asOf);

        if (snapshot) {
            const events = Array.isArray(snapshot)
                ? snapshot
                : [snapshot];

            for (const event of events) {
                await receivePostureEvent(event);
            }
        }
    }

    await flushEvents();
}


// ========================================
// 7. 종료 요청 고정
// ========================================

function freezeEndRequest(reason, endedAtMs) {
    if (pendingEndRequest) {
        return pendingEndRequest;
    }

    if (!END_REASONS.has(reason)) {
        throw new Error("종료 사유가 올바르지 않습니다.");
    }

    if (!Number.isSafeInteger(endedAtMs)) {
        throw new Error("종료 시각이 올바르지 않습니다.");
    }

    pendingEndRequest = {
        sessionId,
        reason,
        endedAtMs,
        events: null
    };

    return pendingEndRequest;
}


// ========================================
// 8. 세션 종료
// ========================================

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

    // 최초 종료 시각을 보존한다.
    const frozen = freezeEndRequest(reason, endedAtMs);

    stoppingPromise = (async () => {
        if (frozen.events === null) {
            // 기존 저장 요청이 진행 중이면 완료를 기다린다.
            if (savingPromise) {
                try {
                    await savingPromise;
                } catch {
                    // 실패한 이벤트는 대기열에 남아 있다.
                }
            }

            // C가 이미 is_final=true로 확정한 이벤트를 포함
            // D가 임의로 is_final을 변경하지 않는다.
            const events = [
                ...pendingEvents.values()
            ];

            if (events.length > 500) {
                throw new Error(
                    "종료 이벤트가 500개를 초과했습니다."
                );
            }

            frozen.events = events.map(
                event => ({ ...event })
            );
        }

        const result = await endSession(
            frozen.sessionId,
            frozen.reason,
            frozen.endedAtMs,
            frozen.events
        );

        // 서버에서 종료 성공을 확인한 뒤 초기화
        sessionId = null;
        pendingEvents.clear();
        savedEvents.clear();
        pendingEndRequest = null;
        lastError = null;

        return result;
    })();

    try {
        return await stoppingPromise;
    } catch (error) {
        // 종료 실패 시 최초 페이로드 유지
        lastError = error;
        throw error;
    } finally {
        stoppingPromise = null;
    }
}


// ========================================
// 9. 종료 실패 재시도
// ========================================

export async function retryFinishMonitoring() {
    if (!pendingEndRequest) {
        throw new Error("재시도할 종료 요청이 없습니다.");
    }

    return finishMonitoring(
        pendingEndRequest.reason,
        pendingEndRequest.endedAtMs
    );
}


// ========================================
// 10. 페이지 이탈 시 종료 요청
// ========================================

export function finishOnPageHide() {
    if (sessionId === null) {
        return false;
    }

    const frozen = freezeEndRequest(
        "pagehide",
        Date.now()
    );

    if (frozen.events === null) {
        frozen.events = [
            ...pendingEvents.values()
        ].map(event => ({ ...event }));
    }

    // C가 최종화해 둔 이벤트만 최종 상태로 전송한다.
    // 진행 중 이벤트를 D가 임의로 최종화하지 않는다.
    return sendEndBeacon(
        frozen.sessionId,
        frozen.reason,
        frozen.endedAtMs,
        frozen.events
    );
}


// ========================================
// 11. C 통계 Provider 연결
// ========================================

export function getStatsProvider({
    createSnapshot
} = {}) {
    return createStatsProvider({
        beforeQuery: asOf =>
            flushBeforeStats(asOf, createSnapshot)
    });
}


// ========================================
// 12. 홈 화면 측정 시간
// ========================================

export async function refreshHomeStats(
    store,
    { createSnapshot } = {}
) {
    const asOf = Date.now();

    return updateHomeMeasuredSec(
        store,
        asOf,
        time => flushBeforeStats(time, createSnapshot)
    );
}


// ========================================
// 13. 현재 저장 상태
// ========================================

export function getCurrentSessionId() {
    return sessionId;
}

export function getSaveStatus() {
    return {
        sessionId,
        pendingCount: pendingEvents.size,
        saving: Boolean(savingPromise),
        stopping: Boolean(stoppingPromise),
        needsEndRetry: Boolean(pendingEndRequest),
        error: lastError?.message ?? null
    };
}