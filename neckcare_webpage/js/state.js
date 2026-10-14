// 대시보드 전체 상태. UI 컴포넌트는 이 값을 받아 그리기만 한다.
// 나중에 좌표 추출(A) · 판정(B) · 저장/통계(D) 파트가 store.setState(...)로 값을 넣으면 화면이 갱신된다.
//
// 이번 단계는 UI 프로토타입이므로 모든 값은 "초기값"이다. 가짜 측정값을 넣지 않는다.

export const PERIODS = [
  { id: 'hour', label: '최근 1시간' },
  { id: 'today', label: '오늘' },
  { id: 'week', label: '최근 7일' },
];

// 기간별 빈 추이 데이터(모든 값 0). 실제 데이터가 연결되면 getStats() 결과로 교체한다.
export function buildEmptyTrend(period, now = new Date()) {
  if (period === 'today') {
    return Array.from({ length: 13 }, (_, i) => ({ label: `${i * 2}시`, rate: 0 }));
  }
  if (period === 'week') {
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(now.getDate() - (6 - i));
      return { label: i === 6 ? '오늘' : days[d.getDay()], rate: 0 };
    });
  }
  return Array.from({ length: 13 }, (_, i) => {
    const minAgo = 60 - i * 5;
    return { label: minAgo === 0 ? '지금' : `${minAgo}분 전`, rate: 0 };
  });
}

export const initialState = {
  // 현재 화면: 'home' | 'stats' (주소 #stats와 맞춘다. 화면 전환은 카메라·세션에 영향 없음)
  view: 'home',

  // 통계 화면 조회 상태. 값은 D 파트 조회 결과로만 채운다(stats-source.js 참고).
  report: {
    status: 'unavailable',  // unavailable | idle | loading | success | empty | error
    attempted: false,       // "분석 결과 불러오기"를 한 번이라도 눌렀는지
    period: 'week',         // today | week | month (화면 전환 후에도 유지)
    countType: 'turtle',    // 요약 카드: turtle | shrimp
    trendType: 'turtle',    // 추이 그래프: turtle | shrimp
    trendUnit: 'day',       // day | week
    recordFilter: 'all',    // all | turtle | shrimp
    data: null,             // 마지막 정상 조회 결과(조회 실패 시에도 유지)
    dataKey: null,          // data를 받은 조건 `${period}:${trendUnit}`
    lastLoadedAt: null,
    error: null,
  },

  // 분석 세션 상태: 'idle'(대기) | 'running'(분석 중)
  analysis: { status: 'idle' },

  // 카메라 연결 상태
  camera: { connected: false, error: null },

  // 판정 결과 (팀 인터페이스 { ts, angle, status } 기준)
  // status: 'unknown'(측정 불가) | 'good' | 'warn' | 'bad'
  // kind: 나쁜 자세 종류 'turtle' | 'waist' | null, reason: 'novis'(판정 불가) | 'recalibration'(다시 설정 필요) | null
  // angle: B 판정에는 목 각도 값이 없어 null로 둔다(팀 합의)
  posture: { ts: null, angle: null, status: 'unknown', kind: null, reason: null },

  // 누적 통계
  stats: {
    measuredSec: null,  // 홈 "누적 측정 시간"(초). null = 측정 기록 없음(0과 구분)
    totalMinutes: 0,
    turtleCount: 0,
    turtleRate: 0,      // %
    avgDurationSec: 0,
    maxDurationSec: 0,
    hasRecords: false,
  },

  // 발생 빈도 추이 그래프
  trend: { period: 'hour', points: buildEmptyTrend('hour') },

  // 감지 이력: [{ ts, durationSec, status }]
  history: [],

  // 나쁜 자세 알림: null 또는 { level: 'warn' | 'bad', title, message }
  alert: null,
};

export function createStore(initial) {
  let state = structuredClone(initial);
  const listeners = new Set();
  return {
    getState: () => state,
    // 1단계 깊이까지 병합: setState({ stats: { turtleCount: 3 } })
    setState(patch) {
      const next = { ...state };
      for (const [key, value] of Object.entries(patch)) {
        const isObj = value && typeof value === 'object' && !Array.isArray(value);
        next[key] = isObj && state[key] && typeof state[key] === 'object' ? { ...state[key], ...value } : value;
      }
      state = next;
      listeners.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
