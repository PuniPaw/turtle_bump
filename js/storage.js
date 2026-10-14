// ============================================================
// storage.js
// D 담당: Flask API 통신
//
// 1. 측정 세션 시작
// 2. 자세 판정 데이터 전송
// 3. 측정 종료
// 4. 세션 목록 및 기록 조회
// 5. 통계 조회
// ============================================================


// Flask 서버의 기본 API 주소
const API = "/api/sessions";


// ------------------------------------------------------------
// 1. 공통 API 요청 함수
// ------------------------------------------------------------

async function requestJSON(url, options = {}) {

    // Flask 서버에 HTTP 요청
    const response = await fetch(url, options);

    // 서버가 반환한 응답 읽기
    const raw = await response.text();

    let data = null;

    try {

        // JSON 응답을 JavaScript 객체로 변환
        data = raw ? JSON.parse(raw) : null;

    } catch {

        throw new Error(
            `서버 응답이 JSON 형식이 아닙니다. (${response.status})`
        );
    }

    // 400, 404, 500 등 오류 응답 처리
    if (!response.ok) {

        throw new Error(
            data?.error ||
            `서버 요청 실패 (${response.status})`
        );
    }

    return data;
}


// ------------------------------------------------------------
// 2. 측정 세션 시작
// ------------------------------------------------------------

export async function startSession() {

    // Flask 서버에 새 세션 생성 요청
    const result = await requestJSON(API, {
        method: "POST"
    });

    // 서버가 발급한 세션 ID 반환
    return result.sessionId;
}


// ------------------------------------------------------------
// 3. 측정 데이터 저장
// ------------------------------------------------------------

export async function saveEvents(sessionId, events) {

    // events는 측정 결과 배열
    //
    // 예시:
    // [
    //   {
    //     ts: Date.now(),
    //     status: "TURTLE",
    //     fwd: 4.2,
    //     appr: 1.5,
    //     drop: 0.8,
    //     dist: 2.1,
    //     yaw: 3.0
    //   }
    // ]

    if (!Array.isArray(events)) {

        throw new Error(
            "측정 데이터는 배열이어야 합니다."
        );
    }

    if (!sessionId) {

        throw new Error(
            "세션 ID가 없습니다."
        );
    }

    // 측정 결과를 JSON으로 변환해 Flask로 전송
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}/events`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                events
            })
        }
    );
}


// ------------------------------------------------------------
// 4. 측정 세션 종료
// ------------------------------------------------------------

export async function endSession(sessionId) {

    // 종료 시각을 Flask DB에 기록
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}/end`,
        {
            method: "POST"
        }
    );
}


// ------------------------------------------------------------
// 5. 전체 측정 세션 목록
// ------------------------------------------------------------

export async function listSessions() {

    // 저장된 전체 세션 목록 반환
    return requestJSON(API);
}


// ------------------------------------------------------------
// 6. 특정 세션 조회
// ------------------------------------------------------------

export async function getSession(sessionId) {

    // 해당 세션의 측정 시각, 상태, 수치 데이터 조회
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}`
    );
}


// ------------------------------------------------------------
// 7. 서버 통계 조회
// ------------------------------------------------------------

export async function getStats(sessionId) {

    // 거북목 / 허리 굽힘 등의 판정 비율 조회
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}/stats`
    );
}