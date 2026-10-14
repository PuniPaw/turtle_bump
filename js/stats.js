/*
 * stats.js
 * D 담당 - 통계 조회 연결
 *
 * v0.3.3 최종 보완본
 *
 * 통계 계산은 app.py에서 담당한다.
 * 이 파일은 서버 응답을 그대로 전달한다.
 *
 * null과 0을 임의로 바꾸지 않는다.
 */

import {
    getHomeSummary,
    getStats
} from "./storage.js";

// 통계 조회 전 현재 이벤트 저장 작업
async function runBeforeQuery(beforeQuery, asOf) {
    if (typeof beforeQuery === "function") {
        await beforeQuery(asOf);
    }
}

// C의 stats-source.js에서 사용할 Provider
export function createStatsProvider({
    beforeQuery
} = {}) {
    return {
        async query({
            period = "today",
            unit = "day",
            asOf = Date.now()
        } = {}) {
            // 먼저 최신 자세 스냅샷을 DB에 저장한다.
            await runBeforeQuery(beforeQuery, asOf);

            // 저장이 완료되면 통계를 조회한다.
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

    // null: 기록 없음
    // 0: 기록은 있으나 유효 측정시간 0초
    const measuredSec = result.measured_sec;

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
                measuredSec
            }
        });
    }

    return result;
}

// 직접 통계를 조회할 때 사용
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