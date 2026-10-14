// 통계 조회 연결 자리. 실제 저장·조회는 D(저장/통계) 파트 모듈이 한다. 이 파일은 데이터를 만들지 않는다.
//
// [연결 위치] D 파트가 조회 모듈을 등록한다(window.neckcare.registerStatsProvider로도 가능).
//   registerStatsProvider({ query({ period, unit, asOf }) → Promise<StatsResult | null> })
//     period: 'today' | 'week' | 'month'   (기간 경계·시간대는 D와 협의)
//     unit:   'day' | 'week'                (추이 그래프 집계 단위)
//     asOf:   조회 시각(ms). 이 시각까지 "DB에 저장 완료된" 기록만 돌려준다.
//             종료된 세션 + 진행 중인 세션의 저장 완료 구간을 함께 집계한다.
//             아직 저장되지 않은 값이나 끝나지 않은 구간을 임의로 완료 처리한 값은 넣지 않는다.
//
// StatsResult (초안, D와 협의 필요). 값이 없으면 null(= 화면에 "—"), 0은 실제로 0일 때만.
//   {
//     summary: {
//       measuredSec:    { value, prev },   // 유효 측정 시간(초), prev = 이전 같은 길이 기간
//       turtleCount:    { value, prev },   // 거북목 발생 횟수(구간 단위, 프레임 단위 아님)
//       shrimpCount:    { value, prev },   // 새우등 발생 횟수
//       goodRatio:      { value, prev },   // 바른 자세 비율(%)
//       avgDurationSec: { value, prev },   // 평균 지속 시간(초) — 대상은 D와 협의
//     },
//     trend: { turtle: [{ label, count }], shrimp: [{ label, count }] },
//     distribution: { totalSec, items: [{ type: 'good'|'turtle'|'shrimp'|'other', sec, ratio }] },
//     records: [{ id, startedAt, type: 'good'|'turtle'|'shrimp', durationSec }],
//   }
//
// 조회 상태(state.report.status)
//   unavailable 조회 모듈 미연결(기본) / idle 조회 전 / loading 조회 중
//   success 조회 성공 / empty 조회했지만 결과 없음 / error 조회 실패(이전 정상 데이터는 유지)

let provider = null;
let requestSeq = 0;

export function registerStatsProvider(mod) {
  if (typeof mod?.query !== 'function') throw new TypeError('통계 조회 모듈에 query({ period, unit, asOf }) 함수가 필요합니다.');
  provider = mod;
}

export function hasStatsProvider() {
  return Boolean(provider);
}

function isEmptyResult(data) {
  if (!data) return true;
  const hasSummary = Object.values(data.summary ?? {}).some((m) => m && m.value != null);
  const hasTrend = ['turtle', 'shrimp'].some((k) => (data.trend?.[k] ?? []).length > 0);
  const hasDist = (data.distribution?.items ?? []).length > 0;
  const hasRecords = (data.records ?? []).length > 0;
  return !(hasSummary || hasTrend || hasDist || hasRecords);
}

// 현재 선택된 기간·단위로 조회한다. 카메라·측정 세션에는 영향을 주지 않는다.
// 결과: 'unavailable' | 'success' | 'empty' | 'error' | 'stale'(더 최근 요청이 있어 무시됨)
export async function loadStats(store) {
  if (!provider) {
    store.setState({ report: { status: 'unavailable', error: null } });
    return 'unavailable';
  }
  const { period, trendUnit } = store.getState().report;
  const seq = ++requestSeq;
  const asOf = Date.now();
  store.setState({ report: { status: 'loading', error: null } });
  try {
    const data = await provider.query({ period, unit: trendUnit, asOf });
    if (seq !== requestSeq) return 'stale';
    const empty = isEmptyResult(data);
    store.setState({
      report: {
        status: empty ? 'empty' : 'success',
        data: empty ? null : data,
        dataKey: `${period}:${trendUnit}`,
        lastLoadedAt: asOf,
      },
    });
    return empty ? 'empty' : 'success';
  } catch (err) {
    if (seq !== requestSeq) return 'stale';
    console.error('통계 조회 실패', err);
    // 이전 정상 데이터(data, lastLoadedAt)는 지우거나 0으로 바꾸지 않는다.
    store.setState({ report: { status: 'error', error: err?.message || String(err) } });
    return 'error';
  }
}
