// NeckCare D 담당 - stats.js
// 역할: 측정 기록을 C 담당 UI에 필요한 통계 데이터로 변환

import {
    getSession,
    getStats,
    listSessions
} from "./storage.js";

import { buildEmptyTrend } from "./state.js";


// 샘플 사이 간격이 3초를 초과하면
// 카메라 끊김 또는 측정 중단으로 간주
const MAX_GAP_MS = 3000;


// --------------------------------------------------
// 1. 측정 기록 시간순 정렬
// --------------------------------------------------

function sortEvents(events) {

    return [...events].sort(
        (a, b) => a.ts - b.ts
    );
}


// --------------------------------------------------
// 2. 자세 상태별 측정 건수
// --------------------------------------------------

export function countStatuses(events) {

    const counts = {
        good: 0,
        warn: 0,
        bad: 0
    };

    for (const event of events) {

        if (Object.hasOwn(counts, event.status)) {
            counts[event.status]++;
        }
    }

    return counts;
}


// --------------------------------------------------
// 3. 연속된 자세 상태를 구간으로 묶기
// --------------------------------------------------

export function buildDetectionHistory(events) {

    const sorted = sortEvents(events);
    const groups = [];

    let current = null;

    for (const event of sorted) {

        // 이전 데이터가 없거나 상태가 달라진 경우
        // 또는 3초 이상 측정이 끊긴 경우 새 구간 시작
        const newGroup =
            current === null ||
            current.status !== event.status ||
            event.ts - current.lastTs > MAX_GAP_MS;

        if (newGroup) {

            current = {
                ts: event.ts,
                lastTs: event.ts,
                status: event.status
            };

            groups.push(current);

        } else {

            // 같은 자세가 연속되면 종료 시각 갱신
            current.lastTs = event.ts;
        }
    }

    // C 담당 UI의 history 데이터 형식으로 변환
    return groups.map(group => ({

        ts: group.ts,

        status: group.status,

        // 첫 샘플부터 마지막 샘플까지 관측된 시간
        durationSec: Number(
            (
                (group.lastTs - group.ts) / 1000
            ).toFixed(1)
        )

    })).reverse();
}


// --------------------------------------------------
// 4. C 담당 통계 카드용 데이터
// --------------------------------------------------

export function buildDashboardStats(session) {

    const events = sortEvents(session.events);

    // 종료된 세션은 종료 시각,
    // 진행 중인 세션은 현재 시각 사용
    const endTime = session.endTime ?? Date.now();

    // 측정 시작부터 현재 또는 종료까지 경과 시간
    const totalMinutes = Math.max(
        0,
        (endTime - session.startTime) / 60000
    );

    // 연속된 자세 상태 구간 계산
    const history = buildDetectionHistory(events);

    // bad 구간만 추출
    const badGroups = history.filter(
        item => item.status === "bad"
    );

    // 거북목 발생 횟수
    const turtleCount = badGroups.length;

    // 각 bad 구간의 지속 시간
    const durations = badGroups.map(
        item => item.durationSec
    );

    // bad 구간의 총 관측 시간
    const totalBadSeconds = durations.reduce(
        (sum, value) => sum + value,
        0
    );

    // 평균 지속 시간
    const avgDurationSec = turtleCount
        ? totalBadSeconds / turtleCount
        : 0;

    // 가장 길었던 지속 시간
    const maxDurationSec = turtleCount
        ? Math.max(...durations)
        : 0;

    // 자세 상태별 판정 건수
    const counts = countStatuses(events);

    const totalCount =
        counts.good + counts.warn + counts.bad;

    // bad 판정 건수 / 전체 유효 판정 건수
    // 약 1초 간격으로 수집한다는 전제의 근사 비율
    const turtleRate = totalCount
        ? counts.bad / totalCount * 100
        : 0;

    return {
        totalMinutes: Number(
            totalMinutes.toFixed(1)
        ),

        turtleCount,

        turtleRate: Number(
            turtleRate.toFixed(1)
        ),

        avgDurationSec: Number(
            avgDurationSec.toFixed(1)
        ),

        maxDurationSec: Number(
            maxDurationSec.toFixed(1)
        ),

        hasRecords: events.length > 0
    };
}


// --------------------------------------------------
// 5. 시간별 발생 빈도 그래프
// --------------------------------------------------

export function buildDashboardTrend(
    events,
    period = "hour"
) {

    const now = new Date();
    const nowMs = now.getTime();

    // C 담당 state.js에서 사용하는 기간 값
    const validPeriods = ["hour", "today", "week"];

    if (!validPeriods.includes(period)) {
        period = "hour";
    }

    // C 담당이 정한 그래프 축 생성
    // hour: 13개, today: 13개, week: 7개
    const points = buildEmptyTrend(period, now);

    const counts = points.map(() => ({
        total: 0,
        bad: 0
    }));

    // 오늘 자정
    const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
    ).getTime();

    // 6일 전 자정: 오늘 포함 총 7일
    const weekStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 6
    ).getTime();

    for (const event of events) {

        let index = -1;

        // 미래 데이터는 통계에서 제외
        if (event.ts > nowMs) continue;

        if (period === "hour") {

            // 현재로부터 몇 분 전인지 계산
            const age = nowMs - event.ts;

            if (age >= 0 && age <= 3600000) {

                // 5분 단위로 13개 지점에 분류
                index = Math.min(
                    12,
                    Math.floor(
                        (3600000 - age) / 300000
                    )
                );
            }

        } else if (period === "today") {

            if (event.ts >= todayStart) {

                // 00~01시 = 0번
                // 02~03시 = 1번 ...
                // 22~23시 = 11번
                index = Math.floor(
                    new Date(event.ts).getHours() / 2
                );
            }

        } else if (period === "week") {

            if (event.ts >= weekStart) {

                const d = new Date(event.ts);

                // 일광절약시간 변경에도 날짜 차이를
                // 안정적으로 계산하기 위해 달력 날짜 사용
                const dayNumber = Date.UTC(
                    d.getFullYear(),
                    d.getMonth(),
                    d.getDate()
                ) / 86400000;

                const first = new Date(weekStart);

                const firstNumber = Date.UTC(
                    first.getFullYear(),
                    first.getMonth(),
                    first.getDate()
                ) / 86400000;

                index = dayNumber - firstNumber;
            }
        }

        if (index < 0 || index >= counts.length) {
            continue;
        }

        counts[index].total++;

        if (event.status === "bad") {
            counts[index].bad++;
        }
    }

    // 각 시간 구간의 bad 비율 계산
    return {
        period,

        points: points.map((point, i) => ({

            label: point.label,

            rate: counts[i].total
                ? Number(
                    (
                        counts[i].bad /
                        counts[i].total * 100
                    ).toFixed(1)
                )
                : 0
        }))
    };
}


// --------------------------------------------------
// 6. 특정 세션의 통계 조회
// --------------------------------------------------

export async function getStatsSummary(sessionId) {

    // Flask에서 계산한 기본 통계
    return getStats(sessionId);
}


// --------------------------------------------------
// 7. 특정 세션의 대시보드 통계 조회
// --------------------------------------------------

export async function getDashboardStats(sessionId) {

    const session = await getSession(sessionId);

    return buildDashboardStats(session);
}


// --------------------------------------------------
// 8. 특정 세션의 그래프 데이터 조회
// --------------------------------------------------

export async function getTrendData(
    sessionId,
    period = "hour"
) {

    const session = await getSession(sessionId);

    return buildDashboardTrend(
        session.events,
        period
    );
}


// --------------------------------------------------
// 9. 최근 감지 기록 조회
// --------------------------------------------------

export async function getDetectionHistory(sessionId) {

    const session = await getSession(sessionId);

    return buildDetectionHistory(
        session.events
    );
}


// --------------------------------------------------
// 10. 과거 측정 세션 목록 조회
// --------------------------------------------------

export async function getSessionHistory() {

    const sessions = await listSessions();

    return sessions.map(session => ({

        sessionId: session.sessionId,

        startTime: new Date(
            session.startTime
        ).toLocaleString(),

        endTime: session.endTime === null
            ? "측정 중"
            : new Date(
                session.endTime
            ).toLocaleString(),

        totalEvents: session.totalEvents
    }));
}


// --------------------------------------------------
// 11. 측정 데이터 CSV 다운로드
// --------------------------------------------------

export async function exportSessionCSV(sessionId) {

    const session = await getSession(sessionId);

    const lines = [
        "time,angle,status",

        ...session.events.map(event =>
            `${new Date(event.ts).toISOString()},${event.angle},${event.status}`
        )
    ];

    // Excel에서 한글 및 UTF-8 문자 깨짐 방지
    const blob = new Blob(
        ["\uFEFF" + lines.join("\r\n")],
        { type: "text/csv;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = `neckcare_${sessionId}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    // 임시 다운로드 URL 해제
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}