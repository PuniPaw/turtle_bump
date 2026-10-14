// NeckCare D 담당 - storage.js
// 역할: Flask 서버와 통신하여 측정 기록 저장 및 조회

// Flask의 측정 세션 API 주소
const API = "/api/sessions";


// --------------------------------------------------
// 1. 공통 API 요청 함수
// --------------------------------------------------

async function requestJSON(url, options = {}) {

    // fetch(): 브라우저에서 서버에 HTTP 요청을 보냄
    const response = await fetch(url, options);

    // 서버 응답을 텍스트로 읽기
    const raw = await response.text();

    let data = null;

    // Flask가 반환한 JSON 데이터를 JS 객체로 변환
    try {
        data = raw ? JSON.parse(raw) : null;
    } catch {
        throw new Error(
            `서버 응답을 해석하지 못했습니다. (${response.status})`
        );
    }

    // 400, 404, 500 등 서버 오류 처리
    if (!response.ok) {
        throw new Error(
            data?.error || `서버 요청 실패 (${response.status})`
        );
    }

    return data;
}


// --------------------------------------------------
// 2. 측정 시작
// --------------------------------------------------

export async function startSession() {

    // Flask에 POST 요청 → 새 세션 생성
    const result = await requestJSON(API, {
        method: "POST"
    });

    // 생성된 세션 ID 반환
    return result.sessionId;
}


// --------------------------------------------------
// 3. 자세 판정 결과 저장
// --------------------------------------------------

export async function saveEvents(sessionId, events) {

    // events는 여러 측정 결과가 담긴 배열
    if (!Array.isArray(events)) {
        throw new Error("events는 배열이어야 합니다.");
    }

    // 예: [{ts: 1234, angle: 25, status: "bad"}]
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}/events`,
        {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            // JavaScript 객체를 JSON 문자열로 변환
            body: JSON.stringify({ events })
        }
    );
}


// --------------------------------------------------
// 4. 측정 종료
// --------------------------------------------------

export async function endSession(sessionId) {

    // 해당 세션의 종료 시각을 DB에 기록
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}/end`,
        {
            method: "POST"
        }
    );
}


// --------------------------------------------------
// 5. 전체 세션 목록 조회
// --------------------------------------------------

export async function listSessions() {

    // 과거 측정 세션 목록을 반환
    return requestJSON(API);
}


// --------------------------------------------------
// 6. 특정 세션의 측정 기록 조회
// --------------------------------------------------

export async function getSession(sessionId) {

    // 세션 정보와 events 배열을 함께 가져옴
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}`
    );
}


// --------------------------------------------------
// 7. 기본 통계 조회
// --------------------------------------------------

export async function getStats(sessionId) {

    // 평균 각도, bad 판정 비율, 총 측정 건수 조회
    return requestJSON(
        `${API}/${encodeURIComponent(sessionId)}/stats`
    );
}