
import {
    getStats,
    getSession,
    listSessions
} from "./storage.js";

// 1. 기본 통계 요약
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

// 2. 자세 상태별 측정 건수
export async function getStatusCounts(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    const counts = {
        good: 0,
        warn: 0,
        bad: 0
    };

    for (const event of session.events) {
        if (Object.hasOwn(counts, event.status)) {
            counts[event.status]++;
        }
    }

    return counts;
}

// 3. 시간 기준 자세 통계
export async function getTimeBasedStats(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    // 원본 데이터를 변경하지 않고 시간순 정렬
    const events = [...session.events].sort(
        (a, b) => a.ts - b.ts
    );

    const durations = {
        good: 0,
        warn: 0,
        bad: 0
    };

    // 3초를 초과하는 간격은 측정 누락으로 간주
    const MAX_GAP = 3000;

    for (let i = 0; i < events.length - 1; i++) {
        const current = events[i];
        const next = events[i + 1];

        const duration = next.ts - current.ts;

        if (duration <= 0 || duration > MAX_GAP) {
            continue;
        }

        if (Object.hasOwn(durations, current.status)) {
            durations[current.status] += duration;
        }
    }

    const totalTime =
        durations.good +
        durations.warn +
        durations.bad;

    return {
        goodSeconds: durations.good / 1000,
        warnSeconds: durations.warn / 1000,
        badSeconds: durations.bad / 1000,
        totalSeconds: totalTime / 1000,

        goodRatio: totalTime > 0
            ? durations.good / totalTime * 100 : 0,

        warnRatio: totalTime > 0
            ? durations.warn / totalTime * 100 : 0,

        badRatio: totalTime > 0
            ? durations.bad / totalTime * 100 : 0
    };
}

// 4. 시간별 그래프 데이터
export async function getChartData(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    return [...session.events]
        .sort((a, b) => a.ts - b.ts)
        .map(event => ({
            ts: event.ts,
            time: new Date(event.ts).toLocaleTimeString(),
            angle: event.angle,
            status: event.status
        }));
}

// 5. 이전 측정 세션 목록
export async function getSessionHistory() {
    const sessions = await listSessions();

    return sessions
        .slice()
        .sort((a, b) => b.startTime - a.startTime)
        .map(session => ({
            sessionId: session.sessionId,

            startTime: new Date(
                session.startTime
            ).toLocaleString(),

            endTime: session.endTime !== null
                ? new Date(session.endTime).toLocaleString()
                : "측정 중",

            totalEvents: session.events.length
        }));
}

// 6. CSV 파일 다운로드
export async function exportSessionCSV(sessionId) {
    const session = await getSession(sessionId);

    if (!session) {
        throw new Error("세션을 찾을 수 없습니다.");
    }

    const header = "time,angle,status";

    const rows = [...session.events]
        .sort((a, b) => a.ts - b.ts)
        .map(event => {
            const time = new Date(
                event.ts
            ).toISOString();

            return [
                time,
                event.angle,
                event.status
            ].join(",");
        });

    // Excel에서 한글이 깨지는 문제 예방
    const csv = "\uFEFF" +
        [header, ...rows].join("\r\n");

    const blob = new Blob([csv], {
        type: "text/csv;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = `posture_${sessionId}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    // 다운로드 시작 후 객체 URL 해제
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}
