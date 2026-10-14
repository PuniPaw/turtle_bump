// ============================================================
// stats.js
// D 담당: 측정 데이터 통계 처리
//
// 1. 자세 상태별 판정 건수
// 2. 거북목 / 허리 굽힘 발생 구간
// 3. 평균 및 최장 지속 시간
// 4. 최근 1시간 / 오늘 / 7일 그래프
// 5. 감지 이력 및 CSV 다운로드
// ============================================================

import {
    getSession,
    getStats,
    listSessions
} from "./storage.js";

import {
    buildEmptyTrend
} from "./state.js";


// ------------------------------------------------------------
// 1. 기본 설정
// ------------------------------------------------------------

// 연속 측정 간격이 3초를 넘으면 다른 구간으로 판단
const MAX_GAP_MS = 3000;

// 유효한 자세 판정
const VALID_STATUSES = new Set([
    "GOOD",
    "TURTLE",
    "WAIST",
    "CLOSE"
]);


// ------------------------------------------------------------
// 2. 시간순 데이터 정렬
// ------------------------------------------------------------

function sortEvents(events) {

    // 원본 배열은 변경하지 않고 복사 후 정렬
    return [...events].sort(
        (a, b) => a.ts - b.ts
    );
}


// ------------------------------------------------------------
// 3. 자세 상태별 판정 건수
// ------------------------------------------------------------

export function countStatuses(events) {

    const counts = {
        GOOD: 0,
        TURTLE: 0,
        WAIST: 0,
        CLOSE: 0
    };

    for (const event of events) {

        if (Object.hasOwn(counts, event.status)) {
            counts[event.status]++;
        }
    }

    return counts;
}


// ------------------------------------------------------------
// 4. 연속된 자세 판정을 구간으로 묶기
// ------------------------------------------------------------

export function buildPostureGroups(events) {

    const sorted = sortEvents(events);

    const groups = [];

    let current = null;

    for (const event of sorted) {

        // 인식 불가 / 보정 / 대기 상태는
        // 연속 자세 판정 구간을 끊음
        if (!VALID_STATUSES.has(event.status)) {

            current = null;
            continue;
        }

        const newGroup =
            current === null ||
            current.status !== event.status ||
            event.ts - current.lastTs > MAX_GAP_MS;

        if (newGroup) {

            // 새로운 자세 판정 구간 생성
            current = {
                ts: event.ts,
                lastTs: event.ts,
                status: event.status,
                sampleCount: 1
            };

            groups.push(current);

        } else {

            // 같은 자세가 이어지는 경우
            current.lastTs = event.ts;
            current.sampleCount++;
        }
    }

    // 각 구간의 지속 시간 계산
    return groups.map(group => ({

        ts: group.ts,

        status: group.status,

        // 최초 측정과 마지막 측정 사이의 시간
        // 단일 샘플은 0초로 계산
        durationSec: Number(
            (
                (group.lastTs - group.ts) / 1000
            ).toFixed(1)
        ),

        sampleCount: group.sampleCount
    }));
}


// ------------------------------------------------------------
// 5. C 담당 감지 기록 형식으로 변환
// ------------------------------------------------------------

export function buildDetectionHistory(events) {

    const groups = buildPostureGroups(events);

    // C 담당 UI에서 사용하는 상태값
    const statusMap = {
        GOOD: "good",
        TURTLE: "bad",
        WAIST: "bad",
        CLOSE: "warn"
    };

    // 최근 기록이 위에 오도록 역순 정렬
    return groups.map(group => ({

        ts: group.ts,

        durationSec: group.durationSec,

        status: statusMap[group.status]

    })).reverse();
}


// ------------------------------------------------------------
// 6. C 담당 통계 카드 데이터 계산
// ------------------------------------------------------------

export function buildDashboardStats(session) {

    const events = sortEvents(session.events);

    const counts = countStatuses(events);

    // 측정 종료 전이면 현재 시각을 종료 시각으로 사용
    const endTime = session.endTime ?? Date.now();

    // 전체 세션 경과 시간(분)
    const totalMinutes = Math.max(
        0,
        (endTime - session.startTime) / 60000
    );

    // 통계에 포함할 유효 판정 수
    const totalValid =
        counts.GOOD +
        counts.TURTLE +
        counts.WAIST +
        counts.CLOSE;

    const groups = buildPostureGroups(events);

    // 거북목 상태로 판정된 구간만 선택
    const turtleGroups = groups.filter(
        group => group.status === "TURTLE"
    );

    // 거북목 발생 횟수
    const turtleCount = turtleGroups.length;

    // 각 거북목 구간의 지속 시간
    const durations = turtleGroups.map(
        group => group.durationSec
    );

    const totalDuration = durations.reduce(
        (sum, value) => sum + value,
        0
    );

    // 평균 지속 시간
    const avgDurationSec = turtleCount > 0
        ? totalDuration / turtleCount
        : 0;

    // 최장 지속 시간
    const maxDurationSec = durations.length > 0
        ? Math.max(...durations)
        : 0;

    // 유효 판정 중 거북목 판정 비율
    const turtleRate = totalValid > 0
        ? counts.TURTLE / totalValid * 100
        : 0;

    // C 담당 state.js와 동일한 구조
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

        hasRecords: totalValid > 0
    };
}


// ------------------------------------------------------------
// 7. B 담당의 추가 판정 통계
// ------------------------------------------------------------

export function buildExtraStats(session) {

    const events = session.events;

    const counts = countStatuses(events);

    const groups = buildPostureGroups(events);

    const totalValid = Object.values(counts).reduce(
        (sum, value) => sum + value,
        0
    );

    // 허리 굽힘 발생 구간 수
    const waistCount = groups.filter(
        group => group.status === "WAIST"
    ).length;

    // 화면 접근 발생 구간 수
    const closeCount = groups.filter(
        group => group.status === "CLOSE"
    ).length;

    // 허리 굽힘 비율
    const waistRate = totalValid > 0
        ? counts.WAIST / totalValid * 100
        : 0;

    // 화면 접근 비율
    const closeRate = totalValid > 0
        ? counts.CLOSE / totalValid * 100
        : 0;

    return {
        waistCount,
        closeCount,

        waistRate: Number(
            waistRate.toFixed(1)
        ),

        closeRate: Number(
            closeRate.toFixed(1)
        )
    };
}


// ------------------------------------------------------------
// 8. 기간별 거북목 발생 비율 그래프
// ------------------------------------------------------------

export function buildDashboardTrend(
    events,
    period = "hour"
) {

    const now = new Date();

    const nowMs = now.getTime();

    // C 담당 그래프에서 사용하는 기간
    if (!["hour", "today", "week"].includes(period)) {
        period = "hour";
    }

    // C 담당이 만든 그래프 축 생성 함수 사용
    const points = buildEmptyTrend(period, now);

    // 각 시간 구간의 판정 건수
    const buckets = points.map(() => ({
        total: 0,
        turtle: 0
    }));

    // 오늘 00:00
    const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
    ).getTime();

    // 6일 전 00:00
    const weekStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 6
    ).getTime();

    // 날짜 비교용 함수
    // 일광절약시간제 변경에도 날짜 차이가 정확하도록
    // UTC 기준의 달력 날짜 번호 사용
    function dayNumber(date) {

        return Date.UTC(
            date.getFullYear(),
            date.getMonth(),
            date.getDate()
        ) / 86400000;
    }

    for (const event of events) {

        // GOOD / TURTLE / WAIST / CLOSE만 사용
        if (!VALID_STATUSES.has(event.status)) {
            continue;
        }

        // 미래 시각의 데이터 제외
        if (event.ts > nowMs) {
            continue;
        }

        let index = -1;

        if (period === "hour") {

            const age = nowMs - event.ts;

            // 최근 1시간 이내 데이터
            if (age >= 0 && age <= 3600000) {

                // C의 13개 표시 지점 중
                // 5분 간격 구간에 배정
                index = Math.min(
                    12,
                    Math.floor(
                        (3600000 - age) / 300000
                    )
                );
            }

        } else if (period === "today") {

            if (event.ts >= todayStart) {

                // 00~01시 → 0번
                // 02~03시 → 1번
                // ...
                // 22~23시 → 11번
                const hour = new Date(
                    event.ts
                ).getHours();

                index = Math.floor(hour / 2);
            }

        } else if (period === "week") {

            if (event.ts >= weekStart) {

                // 최근 7일의 날짜별 구간
                index = dayNumber(
                    new Date(event.ts)
                ) - dayNumber(
                    new Date(weekStart)
                );
            }
        }

        // 기간에 포함되지 않은 데이터 제외
        if (
            index < 0 ||
            index >= buckets.length
        ) {
            continue;
        }

        buckets[index].total++;

        if (event.status === "TURTLE") {
            buckets[index].turtle++;
        }
    }

    // C 담당 그래프가 사용하는 label/rate 형식
    return {
        period,

        points: points.map((point, index) => {

            const bucket = buckets[index];

            const rate = bucket.total > 0
                ? bucket.turtle / bucket.total * 100
                : 0;

            return {
                label: point.label,
                rate: Number(rate.toFixed(1))
            };
        })
    };
}


// ------------------------------------------------------------
// 9. 서버에 저장된 통계 조회
// ------------------------------------------------------------

export async function getStatsSummary(sessionId) {

    return getStats(sessionId);
}


// ------------------------------------------------------------
// 10. 대시보드 통계 조회
// ------------------------------------------------------------

export async function getDashboardStats(sessionId) {

    const session = await getSession(sessionId);

    return buildDashboardStats(session);
}


// ------------------------------------------------------------
// 11. 그래프 데이터 조회
// ------------------------------------------------------------

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


// ------------------------------------------------------------
// 12. 감지 기록 조회
// ------------------------------------------------------------

export async function getDetectionHistory(sessionId) {

    const session = await getSession(sessionId);

    return buildDetectionHistory(
        session.events
    );
}


// ------------------------------------------------------------
// 13. 과거 측정 세션 목록 조회
// ------------------------------------------------------------

export async function getSessionHistory() {

    return listSessions();
}


// ------------------------------------------------------------
// 14. CSV 파일 다운로드
// ------------------------------------------------------------

export async function exportSessionCSV(sessionId) {

    const session = await getSession(sessionId);

    // CSV 첫 번째 줄: 컬럼명
    const header = [
        "time",
        "status",
        "fwd",
        "appr",
        "drop",
        "dist",
        "yaw",
        "pitch",
        "neck"
    ];

    // 측정 데이터를 CSV 행으로 변환
    const rows = session.events.map(event => [

        new Date(event.ts).toISOString(),

        event.status,

        event.fwd ?? "",
        event.appr ?? "",
        event.drop ?? "",
        event.dist ?? "",
        event.yaw ?? "",
        event.pitch ?? "",
        event.neck ?? ""
    ]);

    const csv = [
        header.join(","),
        ...rows.map(row => row.join(","))
    ].join("\r\n");

    // 엑셀에서 UTF-8 문자가 깨지지 않도록 BOM 추가
    const blob = new Blob(
        ["\uFEFF" + csv],
        {
            type: "text/csv;charset=utf-8"
        }
    );

    const url = URL.createObjectURL(blob);

    // 브라우저 다운로드 링크 생성
    const link = document.createElement("a");

    link.href = url;
    link.download = `neckcare_${sessionId}.csv`;

    document.body.appendChild(link);

    // 자동 다운로드 실행
    link.click();

    // 임시 링크 제거
    link.remove();

    // 임시 URL 해제
    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}