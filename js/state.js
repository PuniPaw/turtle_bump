// ============================================================
// state.js
// C 담당: 웹 대시보드 상태 관리
//
// 역할
// 1. 카메라 연결 상태 저장
// 2. 현재 자세 판정 상태 저장
// 3. 통계 데이터 저장
// 4. 그래프 데이터 저장
// 5. 상태 변경 시 화면 갱신
// ============================================================


// ------------------------------------------------------------
// 1. 그래프 기간 선택 항목
// ------------------------------------------------------------

export const PERIODS = [
    {
        id: "hour",
        label: "최근 1시간"
    },
    {
        id: "today",
        label: "오늘"
    },
    {
        id: "week",
        label: "최근 7일"
    }
];


// ------------------------------------------------------------
// 2. 빈 그래프 데이터 생성
// ------------------------------------------------------------

export function buildEmptyTrend(
    period,
    now = new Date()
) {

    // 오늘: 2시간 간격으로 표시
    if (period === "today") {

        return Array.from(
            { length: 13 },
            (_, i) => ({
                label: `${i * 2}시`,
                rate: 0
            })
        );
    }

    // 최근 7일: 요일별로 표시
    if (period === "week") {

        const days = [
            "일", "월", "화", "수",
            "목", "금", "토"
        ];

        return Array.from(
            { length: 7 },
            (_, i) => {

                const date = new Date(now);

                date.setDate(
                    now.getDate() - (6 - i)
                );

                return {
                    label: i === 6
                        ? "오늘"
                        : days[date.getDay()],
                    rate: 0
                };
            }
        );
    }

    // 최근 1시간: 5분 간격으로 표시
    return Array.from(
        { length: 13 },
        (_, i) => {

            const minAgo = 60 - i * 5;

            return {
                label: minAgo === 0
                    ? "지금"
                    : `${minAgo}분 전`,
                rate: 0
            };
        }
    );
}


// ------------------------------------------------------------
// 3. 대시보드 초기 상태
// ------------------------------------------------------------

export const initialState = {

    // 분석 진행 상태
    analysis: {
        status: "idle"
    },

    // 카메라 연결 상태
    camera: {
        connected: false,
        error: null
    },

    // 현재 자세 판정
    posture: {
        ts: null,
        angle: null,
        status: "unknown"
    },

    // 거북목 통계
    stats: {
        totalMinutes: 0,
        turtleCount: 0,
        turtleRate: 0,
        avgDurationSec: 0,
        maxDurationSec: 0,
        hasRecords: false
    },

    // 그래프 상태
    trend: {
        period: "hour",
        points: buildEmptyTrend("hour")
    },

    // 과거 감지 기록
    history: [],

    // 경고 배너
    alert: null
};


// ------------------------------------------------------------
// 4. 상태 저장소 생성
// ------------------------------------------------------------

export function createStore(initial) {

    // 초기 상태 복사
    let state = structuredClone(initial);

    // 상태 변경을 감지할 함수 목록
    const listeners = new Set();

    return {

        // 현재 상태 반환
        getState() {
            return state;
        },

        // 상태 변경
        setState(patch) {

            const next = { ...state };

            for (
                const [key, value]
                of Object.entries(patch)
            ) {

                // 객체인지 확인
                const isObj =
                    value !== null &&
                    typeof value === "object" &&
                    !Array.isArray(value);

                // 기존 객체와 새 객체 병합
                if (
                    isObj &&
                    state[key] !== null &&
                    typeof state[key] === "object" &&
                    !Array.isArray(state[key])
                ) {

                    next[key] = {
                        ...state[key],
                        ...value
                    };

                } else {

                    next[key] = value;
                }
            }

            // 변경된 상태 저장
            state = next;

            // 구독 중인 화면 갱신 함수 실행
            listeners.forEach(
                callback => callback(state)
            );
        },

        // 상태 변경 감지 등록
        subscribe(callback) {

            listeners.add(callback);

            // 필요하면 구독 해제
            return () => {
                listeners.delete(callback);
            };
        }
    };
}