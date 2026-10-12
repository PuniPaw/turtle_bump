
import {
    getStats,
    getSession,
    listSessions
} from "./storage.js";

// 1. 세션 통계 요약
export async function getStatsSummary(sessionId) {
    const stats = await getStats(sessionId);

    return {
        averageAngle: Number(
            stats.averageAngle.toFixed(1)
        ),
        badRatio: Number(
            stats.badRatio.toFixed(1)
        ),
        totalEvents: stats.totalEvents
    };
}

// 2. 자세 상태별 개수 계산
export async function getStatusCounts(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    const events = session.events;

    return {
        good: events.filter(
            e => e.status === "good"
        ).length,

        warn: events.filter(
            e => e.status === "warn"
        ).length,

        bad: events.filter(
            e => e.status === "bad"
        ).length
    };
}

// 3. 그래프에 사용할 시간별 데이터
export async function getChartData(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    return session.events.map(event => ({
        time: new Date(event.ts).toLocaleTimeString(),
        angle: event.angle,
        status: event.status
    }));
}

// 4. 이전 측정 기록 요약
export async function getSessionHistory() {
    const sessions = await listSessions();

    return sessions.map(session => ({
        sessionId: session.sessionId,
        startTime: new Date(
            session.startTime
        ).toLocaleString(),
        endTime: session.endTime
            ? new Date(session.endTime).toLocaleString()
            : "측정 중",
        totalEvents: session.events.length
    }));
}
