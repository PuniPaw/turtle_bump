
// bcintegration.js
// D 담당: C의 자세 구간 데이터를 Flask DB에 저장

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


// --------------------------------------------------
// 1. 기본 설정
// --------------------------------------------------

// 자세 구간이 종료되면 저장을 요청한다.
// 여러 건을 모아서 보낼 수 있도록 최대 묶음 크기 설정
const BATCH_SIZE = 10;

// 재전송해도 같은 event_id를 사용한다.
const VALID_STATES = new Set([
    "GOOD",
    "TURTLE",
    "WAIST",
    "CLOSE",
    "NOVIS",
    "CALIB",
    "IDLE"
]);


// --------------------------------------------------
// 2. 현재 세션 상태
// --------------------------------------------------

let currentSessionId = null;

// 서버에 아직 저장하지 못한 이벤트
let pendingEvents = [];

// 중복 저장 요청 방지
let savingPromise = null;

// 중복 시작·종료 방지
let startingPromise = null;
let stoppingPromise = null;

let lastError = null;


// --------------------------------------------------
// 3. 측정 시작
// C가 기준 자세 설정에 성공했을 때 호출
// --------------------------------------------------

export async function beginMonitoring(
    startedAtMs = Date.now()
) {
    if (currentSessionId !== null) {
        return currentSessionId;
    }

    if (startingPromise) {
        return await startingPromise;
    }

    startingPromise = (async () => {
        const id = await startSession(startedAtMs);

        currentSessionId = id;
        pendingEvents = [];
        lastError = null;

        console.log(
            "[D] 측정 세션 시작:",
            currentSessionId
        );

        return id;
    })();

    try {
        return await startingPromise;
    } finally {
        startingPromise = null;
    }
}


// --------------------------------------------------
// 4. C가 만든 자세 구간을 저장 대기열에 추가
//
// event 예시 (테스트용 형식):
// {
//   event_id: crypto.randomUUID(),
//   state: "TURTLE",
//   started_at_ms: 100000,
//   ended_at_ms: 110000,
//   duration_sec: 10,
//   alert_triggered: true
// }
// --------------------------------------------------

export async function receivePostureEvent(event) {
    if (currentSessionId === null) {
        throw new Error(
            "측정 세션이 시작되지 않았습니다."
        );
    }

    if (!event || typeof event !== "object") {
        throw new Error("이벤트 객체가 필요합니다.");
    }

    if (!VALID_STATES.has(event.state)) {
        throw new Error(
            `알 수 없는 자세 상태: ${event.state}`
        );
    }

    if (!event.event_id) {
        throw new Error("event_id UUID가 필요합니다.");
    }

    if (!Number.isInteger(event.started_at_ms)) {
        throw new Error("started_at_ms가 필요합니다.");
    }

    // 완료된 구간만 저장 대기열에 추가
    if (!Number.isInteger(event.ended_at_ms)) {
        throw new Error(
            "구간 종료 시각이 필요합니다."
        );
    }

    if (event.ended_at_ms < event.started_at_ms) {
        throw new Error("이벤트 시간 순서가 잘못됐습니다.");
    }

    const durationSec =
        (event.ended_at_ms - event.started_at_ms) / 1000;

    const normalized = {
        event_id: event.event_id,
        state: event.state,
        started_at_ms: event.started_at_ms,
        ended_at_ms: event.ended_at_ms,
        duration_sec: durationSec,
        alert_triggered: event.alert_triggered === true
    };

    // 같은 UUID가 이미 대기 중이면 중복 추가하지 않음
    const index = pendingEvents.findIndex(
        item => item.event_id === normalized.event_id
    );

    if (index === -1) {
        pendingEvents.push(normalized);
    } else {
        pendingEvents[index] = normalized;
    }

    // 상태 구간이 끝났을 때 즉시 저장 요청
    await flushEvents();
}


// --------------------------------------------------
// 5. 대기 중인 이벤트를 서버에 저장
// --------------------------------------------------

export async function flushEvents() {
    if (savingPromise) {
        return await savingPromise;
    }

    if (
        currentSessionId === null ||
        pendingEvents.length === 0
    ) {
        return;
    }

    const sessionId = currentSessionId;

    savingPromise = (async () => {
        while (pendingEvents.length > 0) {
            const batch = pendingEvents.slice(0, BATCH_SIZE);

            try {
                await saveEvents(sessionId, batch);

                // 서버가 성공 응답을 보낸 경우에만 제거
                const savedIds = new Set(
                    batch.map(item => item.event_id)
                );

                pendingEvents = pendingEvents.filter(
                    item => !savedIds.has(item.event_id)
                );

                lastError = null;

                console.log(
                    "[D] 이벤트 저장 완료:",
                    batch.length
                );

            } catch (error) {
                lastError = error;

                console.error(
                    "[D] 이벤트 저장 실패:",
                    error
                );

                // 실패한 이벤트는 대기열에 유지
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
// 6. 측정 종료
// C가 카메라 OFF 시 호출
// --------------------------------------------------

export async function finishMonitoring(
    reason = "camera_off"
) {
    if (stoppingPromise) {
        return await stoppingPromise;
    }

    if (currentSessionId === null) {
        return null;
    }

    stoppingPromise = (async () => {
        // 반드시 남은 데이터를 먼저 저장
        await flushEvents();

        const result = await endSession(
            currentSessionId,
            reason
        );

        console.log(
            "[D] 측정 세션 종료:",
            result
        );

        currentSessionId = null;
        pendingEvents = [];
        lastError = null;

        return result;
    })();

    try {
        return await stoppingPromise;
    } finally {
        stoppingPromise = null;
    }
}


// --------------------------------------------------
// 7. 페이지 종료 시 전송 시도
// --------------------------------------------------

export function finishOnPageHide() {
    if (currentSessionId === null) {
        return false;
    }

    // 일반적인 종료에서는 finishMonitoring()을 사용해야 함.
    // sendBeacon은 마지막 이벤트 저장 완료를 보장하지 않음.
    return sendEndBeacon(
        currentSessionId,
        "pagehide"
    );
}


// --------------------------------------------------
// 8. C 통계 Provider 반환
// --------------------------------------------------

export function getStatsProvider() {
    return createStatsProvider();
}


// --------------------------------------------------
// 9. C 홈 화면 측정 시간 갱신
// --------------------------------------------------

export async function refreshHomeStats(store) {
    return await updateHomeMeasuredSec(store);
}


// --------------------------------------------------
// 10. 현재 저장 상태 확인
// --------------------------------------------------

export function getCurrentSessionId() {
    return currentSessionId;
}

export function getSaveStatus() {
    return {
        sessionId: currentSessionId,
        pendingCount: pendingEvents.length,
        saving: savingPromise !== null,
        stopping: stoppingPromise !== null,
        error: lastError?.message ?? null
    };
}
