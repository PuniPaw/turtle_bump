
import {
  getHomeSummary,
  getStats
} from "./storage.js";

// C 담당의 stats-source.js에서 사용할 Provider
export function createStatsProvider({
  beforeQuery = null
} = {}) {
  return {
    async query({
      period = "today",
      unit = "day",
      asOf = Date.now()
    } = {}) {
      // 현재 자세 이벤트를 먼저 저장
      if (typeof beforeQuery === "function") {
        await beforeQuery(asOf);
      }

      // 서버에서 계산한 통계 반환
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
  beforeQuery = null
) {
  if (typeof beforeQuery === "function") {
    await beforeQuery(asOf);
  }

  const result = await getHomeSummary(asOf);

  if (
    store &&
    typeof store.setState === "function"
  ) {
    const oldState = store.getState?.() || {};

    store.setState({
      stats: {
        ...(oldState.stats || {}),
        measuredSec: result.measured_sec
      }
    });
  }

  return result;
}

// 통계 조회 전 이벤트 저장을 지원하는 함수
export async function loadStats({
  period = "today",
  unit = "day",
  asOf = Date.now(),
  beforeQuery = null
} = {}) {
  if (typeof beforeQuery === "function") {
    await beforeQuery(asOf);
  }

  return getStats({
    period,
    unit,
    asOf
  });
}
