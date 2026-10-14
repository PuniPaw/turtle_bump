// NeckCare D 담당 - d-integration.js
// 역할:
// 1. 측정 시작 및 종료 관리
// 2. B 담당의 자세 판정 결과 수신
// 3. 측정 결과를 일정 간격으로 Flask에 저장
// 4. 통계를 계산하여 C 담당 대시보드에 반영

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


// --------------------------------------------------
// 1. 측정 세션 관리 변수
// --------------------------------------------------

// 현재 세션 ID
let sessionId = null;

// 중복 시작 방지
let starting = null;

// 측정 종료 중인지 표시
let stopping = false;

// 아직 서버에 저장하지 않은 측정 결과
let pendingEvents = [];

// 마지막으로 수집한 측정 시각
let lastAcceptedTs = -Infinity;

// 서버 저장 요청을 순서대로 실행하기 위한 Promise
let saveQueue = Promise.resolve();

// 저장 중인 데이터가 있는지 표시
let saving = false;

// 마지막 저장 오류
let lastSaveError = null;


// --------------------------------------------------
// 2. 측정 시작
// --------------------------------------------------

export async function beginMonitoring() {

    // 이미 측정 중이면 기존 세션 ID 반환
    if (sessionId !== null) {
        return sessionId;
    }

    // 측정 종료 중에는 새 세션을 시작하지 않음
    if (stopping) {
        throw new Error("이전 측정이 종료 중입니다.");
    }

    // 동시에 시작 요청이 들어오면 같은 결과를 기다림
    if (starting) {
        return starting;
    }

    // Flask 서버에 세션 생성 요청
    starting = startSession()
        .then(id => {

            sessionId = id;

            pendingEvents = [];
            lastAcceptedTs = -Infinity;
            lastSaveError = null;

            return id;
        })
        .finally(() => {
            starting = null;
        });

    return starting;
}


// --------------------------------------------------
// 3. B 담당 자세 판정 결과 받기
// --------------------------------------------------

export function receivePosture(posture) {

    // 측정 중이 아니거나 종료 중이면 무시
    if (!sessionId || stopping || !posture) {
        return;
    }

    const { ts, angle, status } = posture;

    // 데이터 형식 검사
    if (
        !Number.isSafeInteger(ts) ||
        !Number.isFinite(angle) ||
        angle < 0 ||
        angle > 180 ||
        !["good", "warn", "bad"].includes(status)
    ) {
        return;
    }

    // 약 1초 간격으로 데이터 수집
    // 매 프레임 저장하면 DB 요청이 과도해질 수 있음
    if (ts - lastAcceptedTs < 1000) {
        return;
    }

    lastAcceptedTs = ts;

    // 서버로 전송하기 전 임시 배열에 저장
    pendingEvents.push({
        ts,
        angle,
        status
    });

    // 5건이 쌓이면 묶어서 저장
    if (pendingEvents.length >= 5) {

        flushEvents().catch(error => {
            console.error(
                "자동 저장 실패:",
                error
            );
        });
    }
}


// --------------------------------------------------
// 4. 누적된 데이터를 Flask 서버에 저장
// --------------------------------------------------

export function flushEvents() {

    // 이미 저장 작업이 진행 중이라면
    // 해당 작업이 끝난 뒤 다음 저장을 처리
    const task = saveQueue.then(async () => {

        if (!sessionId || pendingEvents.length === 0) {
            return;
        }

        const id = sessionId;

        // 저장할 데이터를 대기 배열에서 꺼냄
        const batch = pendingEvents.splice(0);

        saving = true;

        try {

            // Flask API를 호출해 SQLite에 저장
            await saveEvents(id, batch);

            lastSaveError = null;

        } catch (error) {

            // 저장 실패 시 데이터를 복원
            // 다음 요청에서 재시도할 수 있도록 유지
            pendingEvents.unshift(...batch);

            lastSaveError = error;

            throw error;

        } finally {
            saving = false;
        }
    });

    // 실패하더라도 Promise 대기열 자체는 유지
    // 실제 호출자는 task에서 오류를 확인할 수 있음
    saveQueue = task.catch(() => {});

    return task;
}


// --------------------------------------------------
// 5. C 담당 대시보드 갱신
// --------------------------------------------------

export async function updateDashboard(
    store,
    period = "hour"
) {

    if (!sessionId) {
        return;
    }

    // 남은 데이터를 먼저 저장
    await flushEvents();

    // 저장 실패 후 복원된 데이터가 있다면
    // 통계가 불완전해지는 것을 방지
    if (pendingEvents.length > 0) {
        throw new Error(
            "저장되지 않은 측정 데이터가 있습니다."
        );
    }

    // Flask에서 현재 세션의 기록 조회
    const session = await getSession(sessionId);

    // C 담당의 실제 state.js 형식에 맞춰 전달
    store.setState({

        // 통계 카드 6개 항목
        stats: buildDashboardStats(session),

        // hour / today / week 그래프
        trend: buildDashboardTrend(
            session.events,
            period
        ),

        // 최근 감지 기록
        history: buildDetectionHistory(
            session.events
        )
    });
}


// --------------------------------------------------
// 6. 측정 종료
// --------------------------------------------------

export async function finishMonitoring(
    store,
    period = "hour"
) {

    // 세션 생성 중이면 완료될 때까지 기다림
    if (starting) {
        await starting;
    }

    if (!sessionId || stopping) {
        return;
    }

    // 이후 들어오는 B의 측정 데이터는 받지 않음
    stopping = true;

    try {

        // 서버에 남은 데이터 모두 저장
        await flushEvents();

        // 저장되지 않은 데이터가 있다면 종료하지 않음
        if (pendingEvents.length > 0) {
            throw new Error(
                "저장되지 않은 측정 데이터가 있습니다."
            );
        }

        // SQLite에 측정 종료 시각 기록
        await endSession(sessionId);

        // 종료된 세션의 통계를 화면에 반영
        await updateDashboard(store, period);

        // 정상 종료된 경우에만 세션 초기화
        sessionId = null;
        pendingEvents = [];
        lastAcceptedTs = -Infinity;

    } finally {

        stopping = false;
    }
}


// --------------------------------------------------
// 7. 현재 측정 세션 확인
// --------------------------------------------------

export function getCurrentSessionId() {
    return sessionId;
}


// --------------------------------------------------
// 8. 저장 상태 확인
// --------------------------------------------------

export function getSaveStatus() {

    return {
        sessionId,
        pendingCount: pendingEvents.length,
        saving,
        lastError: lastSaveError?.message ?? null
    };
}


// --------------------------------------------------
// 9. C 담당 store 변경 감지
// --------------------------------------------------

export function connectPostureStore(store) {

    // 마지막으로 처리한 posture 객체
    let lastPosture = store.getState().posture;

    // B 담당이 setState로 posture를 변경하면 실행
    const unsubscribe = store.subscribe(state => {

        const posture = state.posture;

        // 동일한 객체를 다시 저장하지 않음
        if (posture === lastPosture) {
            return;
        }

        lastPosture = posture;

        // B 담당의 자세 판정 결과 저장
        receivePosture(posture);
    });

    // 나중에 구독을 해제할 수 있도록 반환
    return unsubscribe;
}