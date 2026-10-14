
/*
 * stats.js
 * D 담당: 서버 통계 조회
 *
 * 실제 통계 계산은 Flask에서 수행한다.
 */

import {
    getHomeSummary,
    getStats
} from "./storage.js";

// 통계 조회 전에 필요한 작업 실행
async function runBeforeQuery(beforeQuery, asOf) {
    if (typeof beforeQuery === "function") {
        await beforeQuery(asOf);
    }
}

// C 담당의 통계 화면에 제공할 Provider
export function createStatsProvider({
    beforeQuery
} = {}) {
    return {
        async query({
            period = "today",
            unit = "day",
            asOf = Date.now()
        } = {}) {
            // 1. 현재 자세 스냅샷 생성 및 저장
            await runBeforeQuery(beforeQuery, asOf);

            // 2. 저장 완료 후 Flask 통계 조회
            return getStats({
                period,
                unit,
                asOf
            });
        }
    };
}

// 홈 화면 누적 측정 시간 갱신
export async function updateHomeMeasuredSec(
    store,
    asOf = Date.now(),
    beforeQuery
) {
    await runBeforeQuery(beforeQuery, asOf);

    const result = await getHomeSummary(asOf);

    // 기존 store 구조가 있을 경우 값 갱신
    if (
        store &&
        typeof store.setState === "function"
    ) {
        const oldState =
            typeof store.getState === "function"
                ? store.getState()
                : {};

        store.setState({
            stats: {
                ...(oldState?.stats || {}),
                measuredSec: result.measured_sec
            }
        });
    }

    return result;
}

// 통계 데이터를 직접 조회하는 함수
export async function loadStats({
    period = "today",
    unit = "day",
    asOf = Date.now(),
    beforeQuery
} = {}) {
    await runBeforeQuery(beforeQuery, asOf);

    return getStats({
        period,
        unit,
        asOf
    });
}
