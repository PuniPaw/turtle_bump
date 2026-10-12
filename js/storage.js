
const STORAGE_KEY = "turtle_neck_sessions";

const VALID_STATUSES = ["good", "warn", "bad"];

// 1. 전체 세션 불러오기
function readSessions() {
    let raw;

    try {
        raw = localStorage.getItem(STORAGE_KEY);
    } catch (error) {
        console.error("저장소 접근 실패:", error);
        throw new Error("브라우저 저장소에 접근할 수 없습니다.");
    }

    if (raw === null) {
        return [];
    }

    try {
        const sessions = JSON.parse(raw);

        if (!Array.isArray(sessions)) {
            throw new Error("세션 데이터가 배열이 아닙니다.");
        }

        return sessions;
    } catch (error) {
        console.error("세션 데이터 읽기 실패:", error);
        throw new Error("저장된 측정 기록을 읽을 수 없습니다.");
    }
}

// 2. 전체 세션 저장하기
function writeSessions(sessions) {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(sessions)
        );
    } catch (error) {
        console.error("데이터 저장 실패:", error);
        throw new Error(
            "측정 기록 저장에 실패했습니다. 저장 공간을 확인해주세요."
        );
    }
}

// 3. 측정 데이터 유효성 검사
function validateEvents(events) {
    if (!Array.isArray(events)) {
        throw new Error("events는 배열이어야 합니다.");
    }

    for (const event of events) {
        if (
            !event ||
            !Number.isFinite(event.ts) ||
            !Number.isFinite(event.angle) ||
            event.angle < 0 ||
            event.angle > 180 ||
            !VALID_STATUSES.includes(event.status)
        ) {
            throw new Error("잘못된 측정 데이터입니다.");
        }
    }
}

// 4. 새로운 측정 세션 시작
export async function startSession() {
    const sessionId = crypto.randomUUID();
    const sessions = readSessions();

    const newSession = {
        sessionId: sessionId,
        startTime: Date.now(),
        endTime: null,
        events: []
    };

    sessions.push(newSession);
    writeSessions(sessions);

    return sessionId;
}

// 5. 측정 결과 저장
export async function saveEvents(sessionId, events) {
    validateEvents(events);

    const sessions = readSessions();

    const session = sessions.find(
        s => s.sessionId === sessionId
    );

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    if (session.endTime !== null) {
        throw new Error("이미 종료된 세션입니다.");
    }

    // 여러 측정 데이터를 한 번에 추가
    session.events.push(...events);

    writeSessions(sessions);
}

// 6. 측정 세션 종료
export async function endSession(sessionId) {
    const sessions = readSessions();

    const session = sessions.find(
        s => s.sessionId === sessionId
    );

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    if (session.endTime === null) {
        session.endTime = Date.now();
        writeSessions(sessions);
    }
}

// 7. 전체 세션 목록 조회
export async function listSessions() {
    return readSessions();
}

// 8. 특정 세션 조회
export async function getSession(sessionId) {
    const sessions = readSessions();

    return sessions.find(
        s => s.sessionId === sessionId
    ) || null;
}

// 9. 기본 통계 계산
export async function getStats(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    const events = session.events;

    if (events.length === 0) {
        return {
            averageAngle: 0,
            badRatio: 0,
            totalEvents: 0
        };
    }

    const totalAngle = events.reduce(
        (sum, event) => sum + event.angle,
        0
    );

    const badCount = events.filter(
        event => event.status === "bad"
    ).length;

    return {
        averageAngle: totalAngle / events.length,
        badRatio: (badCount / events.length) * 100,
        totalEvents: events.length
    };
}

// 10. 특정 세션 삭제 (선택 기능)
export async function deleteSession(sessionId) {
    const sessions = readSessions();

    const exists = sessions.some(
        s => s.sessionId === sessionId
    );

    if (!exists) {
        throw new Error("삭제할 세션을 찾을 수 없습니다.");
    }

    const filtered = sessions.filter(
        s => s.sessionId !== sessionId
    );

    writeSessions(filtered);
}
