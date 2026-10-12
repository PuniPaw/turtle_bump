
const STORAGE_KEY = "turtle_neck_sessions";

// 전체 세션 불러오기
function readSessions() {
    return JSON.parse(
        localStorage.getItem(STORAGE_KEY) || "[]"
    );
}

// 전체 세션 저장하기
function writeSessions(sessions) {
    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(sessions)
    );
}

// 1. 새로운 측정 세션 시작
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

// 2. 자세 판정 데이터 저장
export async function saveEvents(sessionId, events) {
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

    session.events.push(...events);

    writeSessions(sessions);
}

// 3. 측정 세션 종료
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

// 4. 전체 세션 목록 조회
export async function listSessions() {
    return readSessions();
}

// 5. 특정 세션 조회
export async function getSession(sessionId) {
    const sessions = readSessions();

    return sessions.find(
        s => s.sessionId === sessionId
    ) || null;
}

// 6. 특정 세션 통계 계산
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
