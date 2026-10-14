// ============================================================
// d-integration.js
// D 담당: 자세 판정 결과 수집 및 통합
//
// 주요 기능
// 1. 측정 세션 시작
// 2. B 담당의 판정 결과 수신
// 3. 측정 데이터를 Flask에 자동 저장
// 4. C 담당 대시보드 통계 갱신
// 5. 측정 종료 및 저장 실패 처리
// ============================================================

import {
    startSession,
    saveEvents,
    endSession,
    getSession
} from "./storage.js";

import {
    buildDashboardStats,
    buildDashboardTrend,
    buildDetectionHistory
} from "./stats.js";


// ------------------------------------------------------------
// 1. 기본 설정
// ------------------------------------------------------------

// 측정 데이터 수집 간격: 1초
const SAMPLE_INTERVAL_MS = 1000;

// 5건 이상 모이면 자동 저장
const SAVE_BATCH_SIZE = 5;

// 통계 화면 자동 갱신 간격: 5초
const DASHBOARD_INTERVAL_MS = 5000;

// B 담당의 자세 판정 상태
const VALID_STATUSES = new Set([
    "GOOD",
    "TURTLE",
    "WAIST",
    "CLOSE",
    "NOVIS",
    "CALIB",
    "IDLE"
]);

// B 담당이 제공하는 수치 데이터
const MEASURE_FIELDS = [
    "fwd",
    "appr",
    "drop",
    "dist",
    "yaw",
    "pitch",
    "neck"
];


// ------------------------------------------------------------
// 2. 현재 측정 상태
// ------------------------------------------------------------

// Flask가 발급한 현재 세션 ID
let sessionId = null;

// 측정 시작 중복 방지
let starting = null;

// 측정 종료 중복 방지
let stopping = false;

// 서버에 저장되지 않은 측정 데이터
let pendingEvents = [];

// 마지막 수집 시각
let lastAcceptedTs = -Infinity;

// 저장 요청을 순서대로 처리하기 위한 Promise
let saveQueue = Promise.resolve();

// 마지막 저장 오류
let lastSaveError = null;

// 통계 자동 갱신 타이머
let dashboardTimer = null;

// 현재 통계 조회 중인지 확인
let dashboardUpdating = false;

// Flask 세션 종료가 성공했는지 확인
let serverEnded = false;


// ------------------------------------------------------------
// 3. 판정 결과 형식 변환
// ------------------------------------------------------------

function normalizePosture(posture) {

    if (!posture || typeof posture !== "object") {
        return null;
    }

    // B의 원본 상태가 있으면 우선 사용
    // C 화면 표시용 상태와 혼동하지 않도록 함
    let status = posture.rawStatus ?? posture.status;

    // 소문자 good은 GOOD으로 변환
    // 기존 C의 정상 자세 판정과 호환
    if (status === "good") {
        status = "GOOD";
    }

    // bad는 TURTLE과 WAIST를 구분할 수 없음
    // warn도 CLOSE와 정확히 같은 의미가 아님
    // 따라서 임의로 변환하지 않음
    if (!VALID_STATUSES.has(status)) {
        return null;
    }

    // 대기 상태는 저장하지 않음
    if (status === "IDLE") {
        return null;
    }

    // 측정 시각이 없으면 현재 시각 사용
    const ts = posture.ts ?? Date.now();

    if (!Number.isSafeInteger(ts) || ts < 0) {
        return null;
    }

    const event = {
        ts,
        status
    };

    // B 담당의 측정값 복사
    for (const field of MEASURE_FIELDS) {

        const value = posture[field];

        // 값이 없으면 null로 처리
        if (value == null) {

            event[field] = null;
            continue;
        }

        // 숫자가 아니거나 무한대이면 거부
        if (
            typeof value !== "number" ||
            !Number.isFinite(value)
        ) {
            return null;
        }

        event[field] = value;
    }

    return event;
}


// ------------------------------------------------------------
// 4. 측정 세션 시작
// ------------------------------------------------------------

export async function beginMonitoring(store = null) {

    // 이미 측정 중이면 기존 세션 반환
    if (sessionId !== null) {
        return sessionId;
    }

    // 이전 세션 종료 중에는 새 측정 시작 금지
    if (stopping) {
        throw new Error(
            "이전 측정이 종료 중입니다."
        );
    }

    // 서버 요청 중복 방지
    if (starting) {
        return starting;
    }

    starting = startSession()
        .then(id => {

            sessionId = id;

            pendingEvents = [];

            lastAcceptedTs = -Infinity;

            lastSaveError = null;

            serverEnded = false;

            return id;
        })
        .finally(() => {
            starting = null;
        });

    const id = await starting;

    // C 담당 store가 전달되면
    // 5초마다 통계 갱신 시작
    if (store) {
        startDashboardTimer(store);
    }

    return id;
}


// ------------------------------------------------------------
// 5. B 담당 자세 판정 결과 수신
// ------------------------------------------------------------

export function receivePosture(posture) {

    // 측정 중이 아니거나 종료 중이면 무시
    if (
        sessionId === null ||
        stopping ||
        serverEnded
    ) {
        return;
    }

    // B 담당 결과를 저장 형식으로 변환
    const event = normalizePosture(posture);

    if (!event) {
        return;
    }

    // 이전 수집 시각보다 빠른 데이터 무시
    // 1초 이내 중복 측정도 제외
    if (
        event.ts - lastAcceptedTs <
        SAMPLE_INTERVAL_MS
    ) {
        return;
    }

    lastAcceptedTs = event.ts;

    // 저장 대기 배열에 추가
    pendingEvents.push(event);

    // 5건 이상이면 서버 저장
    if (pendingEvents.length >= SAVE_BATCH_SIZE) {

        flushEvents().catch(error => {

            console.error(
                "자세 데이터 저장 실패:",
                error
            );
        });
    }
}


// ------------------------------------------------------------
// 6. 저장 대기 데이터를 Flask로 전송
// ------------------------------------------------------------

export function flushEvents() {

    // 이전 저장 요청이 끝난 뒤 실행
    const task = saveQueue.then(async () => {

        if (
            sessionId === null ||
            pendingEvents.length === 0
        ) {
            return;
        }

        if (serverEnded) {
            throw new Error(
                "종료된 세션에는 데이터를 저장할 수 없습니다."
            );
        }

        const id = sessionId;

        // 서버는 한 번에 최대 1000건 허용
        // 오래 저장하지 못한 경우에도 나누어 전송
        while (pendingEvents.length > 0) {

            const batch = pendingEvents.splice(
                0,
                1000
            );

            try {

                // Flask API로 데이터 전송
                await saveEvents(id, batch);

                // 정상 저장되면 오류 상태 초기화
                lastSaveError = null;

            } catch (error) {

                // 실패한 데이터를 배열 앞에 복구
                pendingEvents.unshift(...batch);

                lastSaveError = error;

                // 호출한 곳에서 오류 처리
                throw error;
            }
        }
    });

    // 실패해도 다음 저장 요청이 실행되도록
    // Promise 체인의 오류를 별도로 처리
    saveQueue = task.catch(() => {});

    return task;
}


// ------------------------------------------------------------
// 7. C 담당 대시보드 통계 갱신
// ------------------------------------------------------------

export async function updateDashboard(
    store,
    period = null
) {

    if (!store || sessionId === null) {
        return;
    }

    // 중복 통계 조회 방지
    if (dashboardUpdating) {
        return;
    }

    dashboardUpdating = true;

    try {

        // 아직 저장하지 않은 데이터 먼저 저장
        await flushEvents();

        if (pendingEvents.length > 0) {
            throw new Error(
                "저장되지 않은 측정 데이터가 있습니다."
            );
        }

        const id = sessionId;

        // 현재 세션의 측정 기록 조회
        const session = await getSession(id);

        // 조회 중 다른 세션으로 바뀌었으면 무시
        if (id !== sessionId) {
            return;
        }

        // 현재 선택된 그래프 기간 사용
        const selectedPeriod =
            period ??
            store.getState().trend?.period ??
            "hour";

        // C 담당 state.js의 구조에 맞춰 갱신
        store.setState({

            stats: buildDashboardStats(session),

            trend: buildDashboardTrend(
                session.events,
                selectedPeriod
            ),

            history: buildDetectionHistory(
                session.events
            )
        });

    } finally {

        dashboardUpdating = false;
    }
}


// ------------------------------------------------------------
// 8. 대시보드 자동 갱신 시작
// ------------------------------------------------------------

export function startDashboardTimer(store) {

    // 기존 타이머가 있으면 먼저 중지
    stopDashboardTimer();

    dashboardTimer = setInterval(() => {

        if (sessionId === null || stopping) {
            return;
        }

        updateDashboard(store).catch(error => {

            console.error(
                "통계 자동 갱신 실패:",
                error
            );
        });

    }, DASHBOARD_INTERVAL_MS);
}


// ------------------------------------------------------------
// 9. 대시보드 자동 갱신 중지
// ------------------------------------------------------------

export function stopDashboardTimer() {

    if (dashboardTimer !== null) {

        clearInterval(dashboardTimer);

        dashboardTimer = null;
    }
}


// ------------------------------------------------------------
// 10. 측정 종료
// ------------------------------------------------------------

export async function finishMonitoring(
    store = null,
    period = null
) {

    // 측정 시작 요청이 진행 중이면 기다림
    if (starting) {
        await starting;
    }

    if (sessionId === null || stopping) {
        return;
    }

    stopping = true;

    // 종료하는 동안 자동 통계 갱신 중지
    stopDashboardTimer();

    try {

        // 남은 측정 데이터 저장
        if (!serverEnded) {

            await flushEvents();

            if (pendingEvents.length > 0) {

                throw new Error(
                    "저장되지 않은 측정 데이터가 있습니다."
                );
            }

            // Flask에 측정 종료 요청
            await endSession(sessionId);

            serverEnded = true;
        }

        // 마지막 통계 갱신
        // 통계 조회가 실패해도 세션 종료 자체는 유지
        if (store) {

            try {

                // 저장이 완료된 세션의 통계 조회
                await updateDashboard(store, period);

            } catch (error) {

                console.error(
                    "마지막 통계 조회 실패:",
                    error
                );
            }
        }

        // 정상적으로 종료된 경우 초기화
        sessionId = null;

        pendingEvents = [];

        lastAcceptedTs = -Infinity;

        lastSaveError = null;

        serverEnded = false;

    } finally {

        stopping = false;
    }
}


// ------------------------------------------------------------
// 11. 현재 측정 세션 ID 확인
// ------------------------------------------------------------

export function getCurrentSessionId() {

    return sessionId;
}


// ------------------------------------------------------------
// 12. 저장 상태 확인
// ------------------------------------------------------------

export function getSaveStatus() {

    return {

        sessionId,

        // 아직 저장되지 않은 데이터 수
        pendingCount: pendingEvents.length,

        // 마지막 오류 메시지
        lastError:
            lastSaveError?.message ?? null,

        // 종료 중인지 확인
        stopping,

        // 서버 측 종료 완료 여부
        serverEnded
    };
}


// ------------------------------------------------------------
// 13. C 담당 store와 연결
// ------------------------------------------------------------

export function connectPostureStore(store) {

    let lastPosture = store.getState().posture;

    // C 담당의 상태 변경을 구독
    const unsubscribe = store.subscribe(state => {

        const posture = state.posture;

        // 같은 객체면 중복 처리하지 않음
        if (posture === lastPosture) {
            return;
        }

        lastPosture = posture;

        // 자세 판정 결과를 저장 모듈에 전달
        receivePosture(posture);
    });

    // 필요할 때 구독을 해제할 수 있도록 반환
    return unsubscribe;
}