
// stats.js
// D 담당: Flask 통계 API와 C 화면 데이터 연결

import {
    getStats,
    getHomeSummary
} from "./storage.js";


// --------------------------------------------------
// 1. 통계 조회
// C registerStatsProvider의 query와 동일한 인자 사용
// --------------------------------------------------

export async function queryStats({
    period = "today",
    unit = "day",
    asOf = Date.now()
} = {}) {
    const validPeriods = ["today", "week", "month"];
    const validUnits = ["day", "week"];

    if (!validPeriods.includes(period)) {
        throw new Error("지원하지 않는 통계 기간입니다.");
    }

    if (!validUnits.includes(unit)) {
        throw new Error("지원하지 않는 그래프 단위입니다.");
    }

    const result = await getStats({
        period,
        unit,
        asOf
    });

    // 서버 응답이 예상한 형태인지 확인
    if (
        !result ||
        !("summary" in result) ||
        !result.trend ||
        !Array.isArray(result.records)
    ) {
        throw new Error("통계 응답 형식이 올바르지 않습니다.");
    }

    return result;
}


// --------------------------------------------------
// 2. 홈 누적 측정 시간
// --------------------------------------------------

export async function queryMeasuredSec(
    asOf = Date.now()
) {
    const result = await getHomeSummary(asOf);

    // 기록이 없으면 null을 유지한다.
    // 0과 null을 혼동하지 않는다.
    return result.measured_sec ?? null;
}


// --------------------------------------------------
// 3. C 담당이 사용할 통계 Provider 생성
// --------------------------------------------------

export function createStatsProvider() {
    return {
        async query({ period, unit, asOf }) {
            return await queryStats({
                period,
                unit,
                asOf
            });
        }
    };
}


// --------------------------------------------------
// 4. 홈 화면의 누적 측정 시간 갱신
// --------------------------------------------------

export async function updateHomeMeasuredSec(store) {
    if (!store || typeof store.setState !== "function") {
        throw new Error("C의 store 객체가 필요합니다.");
    }

    const measuredSec = await queryMeasuredSec();

    // C의 store가 사용하는 stats 필드 유지
    store.setState({
        stats: {
            measuredSec
        }
    });

    return measuredSec;
}
