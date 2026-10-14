# ============================================================
# app.py
# D 담당: Flask 서버 + SQLite 데이터베이스 + API
#
# 주요 기능
# 1. 웹페이지 제공
# 2. 측정 세션 생성 및 종료
# 3. 자세 판정 데이터 저장
# 4. 측정 기록 및 통계 조회
# 5. 스마트폰 WebRTC 연결 신호 중계
# ============================================================

from flask import Flask, jsonify, request, send_from_directory
from pathlib import Path
from contextlib import closing
import sqlite3
import uuid
import time
import math
import threading


# ------------------------------------------------------------
# 1. 기본 설정
# ------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "posture.db"

app = Flask(__name__)

# B 담당의 판정 상태
VALID_STATUSES = {
    "GOOD",      # 바른 자세
    "TURTLE",    # 거북목
    "WAIST",     # 허리 굽힘
    "CLOSE",     # 화면에 너무 가까움
    "NOVIS",     # 얼굴 또는 어깨 인식 불가
    "CALIB",     # 초기 자세 보정
    "IDLE"       # 대기
}

# 통계 계산에 사용하는 상태
MEASURED_STATUSES = {
    "GOOD", "TURTLE", "WAIST", "CLOSE"
}

# B 담당의 측정값
MEASURE_FIELDS = (
    "fwd", "appr", "drop",
    "dist", "yaw", "pitch", "neck"
)

# WebRTC 연결 정보 임시 보관
rooms = {}
rooms_lock = threading.Lock()
ROOM_TTL = 600


def now_ms():
    """현재 시간을 밀리초로 반환"""
    return int(time.time() * 1000)


# ------------------------------------------------------------
# 2. SQLite 데이터베이스
# ------------------------------------------------------------

def get_db():
    """SQLite 연결 객체 생성"""

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row

    # 세션과 측정 데이터 간 관계 적용
    conn.execute("PRAGMA foreign_keys = ON")

    return conn


def init_db():
    """DB 파일 및 테이블 생성"""

    with closing(get_db()) as conn:
        with conn:

            # 한 번의 측정을 하나의 세션으로 관리
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    start_time INTEGER NOT NULL,
                    end_time INTEGER
                )
            """)

            # B 담당 최신 판정 데이터를 저장하는 테이블
            #
            # 기존 events 테이블과 충돌하지 않도록
            # posture_events_v2라는 새 이름을 사용
            # 기존 데이터는 삭제하지 않음
            conn.execute("""
                CREATE TABLE IF NOT EXISTS posture_events_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    ts INTEGER NOT NULL,
                    status TEXT NOT NULL,

                    fwd REAL,
                    appr REAL,
                    drop_value REAL,
                    dist REAL,
                    yaw REAL,
                    pitch REAL,
                    neck REAL,

                    FOREIGN KEY (session_id)
                        REFERENCES sessions(session_id)
                        ON DELETE CASCADE
                )
            """)

            # 세션별 기록 조회 성능 개선
            conn.execute("""
                CREATE INDEX IF NOT EXISTS
                    idx_posture_events_session
                ON posture_events_v2(session_id, ts)
            """)


def find_session(conn, session_id):
    """세션 ID로 측정 세션 찾기"""

    return conn.execute("""
        SELECT session_id, start_time, end_time
        FROM sessions
        WHERE session_id = ?
    """, (session_id,)).fetchone()


def error_response(message, status=400):
    """API 오류 응답을 공통 형식으로 반환"""

    return jsonify({
        "ok": False,
        "error": message
    }), status


# ------------------------------------------------------------
# 3. HTML / CSS / JavaScript 제공
# ------------------------------------------------------------

@app.get("/")
def index():
    """메인 웹 대시보드"""

    return send_from_directory(BASE_DIR, "index.html")


@app.get("/phone.html")
def phone_page():
    """스마트폰 카메라 페이지"""

    return send_from_directory(BASE_DIR, "phone.html")


@app.get("/favicon.svg")
def favicon():
    """파비콘 제공"""

    return send_from_directory(BASE_DIR, "favicon.svg")


@app.get("/css/<path:filename>")
def serve_css(filename):
    """CSS 파일 제공"""

    return send_from_directory(BASE_DIR / "css", filename)


@app.get("/js/<path:filename>")
def serve_js(filename):
    """JavaScript 모듈 제공"""

    return send_from_directory(BASE_DIR / "js", filename)


# ------------------------------------------------------------
# 4. WebRTC 연결 신호 중계
# ------------------------------------------------------------

def cleanup_rooms():
    """10분 이상 지난 연결 정보를 삭제

    이 함수는 rooms_lock 내부에서 호출
    """

    current = time.time()

    for code in list(rooms.keys()):

        updated = rooms[code].get("updated", 0)

        if current - updated > ROOM_TTL:
            del rooms[code]


@app.route(
    "/api/signal/<room>/<role>",
    methods=["GET", "POST"]
)
def signal(room, role):
    """PC와 스마트폰 간 WebRTC 연결 정보 교환"""

    room = room.upper()

    # 4자리 영문·숫자 방 코드 검사
    if (
        len(room) != 4
        or not room.isascii()
        or not room.isalnum()
        or role not in ("offer", "answer")
    ):
        return error_response("잘못된 연결 요청")

    if request.method == "POST":

        # SDP 연결 정보의 최대 크기 제한
        if (
            request.content_length is not None
            and request.content_length > 100000
        ):
            return error_response("요청 크기 초과", 413)

        data = request.get_json(silent=True)

        if not isinstance(data, dict):
            return error_response("JSON 형식 오류")

        with rooms_lock:

            cleanup_rooms()

            entry = rooms.setdefault(room, {})

            entry[role] = data
            entry["updated"] = time.time()

        return jsonify({"ok": True})

    # 상대방이 보낸 offer 또는 answer 조회
    with rooms_lock:

        cleanup_rooms()

        data = rooms.get(room, {}).get(role)

    if data is None:
        return "", 204

    response = jsonify(data)
    response.headers["Cache-Control"] = "no-store"

    return response


# ------------------------------------------------------------
# 5. 측정 시작
# ------------------------------------------------------------

@app.post("/api/sessions")
def start_session():
    """새로운 측정 세션 생성"""

    session_id = str(uuid.uuid4())
    start_time = now_ms()

    with closing(get_db()) as conn:
        with conn:

            conn.execute("""
                INSERT INTO sessions (
                    session_id, start_time
                )
                VALUES (?, ?)
            """, (session_id, start_time))

    return jsonify({
        "sessionId": session_id,
        "startTime": start_time
    }), 201


# ------------------------------------------------------------
# 6. 자세 판정 데이터 저장
# ------------------------------------------------------------

@app.post("/api/sessions/<session_id>/events")
def save_events(session_id):
    """B 담당의 판정 결과를 SQLite에 저장"""

    payload = request.get_json(silent=True)

    if not isinstance(payload, dict):
        return error_response("JSON 객체가 필요합니다.")

    events = payload.get("events")

    if not isinstance(events, list):
        return error_response("events 배열이 필요합니다.")

    if len(events) > 1000:
        return error_response(
            "한 번에 최대 1000건까지 저장 가능합니다."
        )

    prepared = []

    # 데이터 전체를 먼저 검증
    # 잘못된 데이터가 있으면 아무것도 저장하지 않음
    for event in events:

        if not isinstance(event, dict):
            return error_response("측정 데이터 형식 오류")

        ts = event.get("ts")
        status = event.get("status")

        if type(ts) is not int or ts < 0:
            return error_response("측정 시각 오류")

        if status not in VALID_STATUSES:
            return error_response(
                f"지원하지 않는 자세 상태: {status}"
            )

        values = {}

        for field in MEASURE_FIELDS:

            value = event.get(field)

            if value is not None:

                # NaN, Infinity, 문자열 등 잘못된 값 거부
                if (
                    type(value) not in (int, float)
                    or not math.isfinite(value)
                ):
                    return error_response(
                        f"{field} 측정값 오류"
                    )

            values[field] = value

        prepared.append((
            session_id,
            ts,
            status,
            values["fwd"],
            values["appr"],
            values["drop"],
            values["dist"],
            values["yaw"],
            values["pitch"],
            values["neck"]
        ))

    with closing(get_db()) as conn:
        with conn:

            session = find_session(conn, session_id)

            if session is None:
                return error_response(
                    "측정 세션이 존재하지 않습니다.", 404
                )

            if session["end_time"] is not None:
                return error_response(
                    "이미 종료된 세션입니다.", 409
                )

            # 여러 측정 데이터를 한 번에 저장
            conn.executemany("""
                INSERT INTO posture_events_v2 (
                    session_id,
                    ts,
                    status,
                    fwd,
                    appr,
                    drop_value,
                    dist,
                    yaw,
                    pitch,
                    neck
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, prepared)

    return jsonify({
        "ok": True,
        "savedCount": len(prepared)
    }), 201


# ------------------------------------------------------------
# 7. 측정 종료
# ------------------------------------------------------------

@app.post("/api/sessions/<session_id>/end")
def end_session(session_id):
    """측정 종료 시간 저장"""

    with closing(get_db()) as conn:
        with conn:

            session = find_session(conn, session_id)

            if session is None:
                return error_response("세션 없음", 404)

            end_time = session["end_time"]

            # 중복 종료 요청이 와도 기존 종료 시각 유지
            if end_time is None:

                end_time = now_ms()

                conn.execute("""
                    UPDATE sessions
                    SET end_time = ?
                    WHERE session_id = ?
                """, (end_time, session_id))

    return jsonify({
        "sessionId": session_id,
        "endTime": end_time
    })


# ------------------------------------------------------------
# 8. 전체 측정 세션 목록
# ------------------------------------------------------------

@app.get("/api/sessions")
def list_sessions():
    """측정 세션 목록 조회"""

    with closing(get_db()) as conn:

        rows = conn.execute("""
            SELECT
                s.session_id,
                s.start_time,
                s.end_time,
                COUNT(e.id) AS total_events
            FROM sessions s
            LEFT JOIN posture_events_v2 e
                ON s.session_id = e.session_id
            GROUP BY
                s.session_id,
                s.start_time,
                s.end_time
            ORDER BY s.start_time DESC
        """).fetchall()

    return jsonify([
        {
            "sessionId": row["session_id"],
            "startTime": row["start_time"],
            "endTime": row["end_time"],
            "totalEvents": row["total_events"]
        }
        for row in rows
    ])


# ------------------------------------------------------------
# 9. 특정 세션의 측정 기록 조회
# ------------------------------------------------------------

@app.get("/api/sessions/<session_id>")
def session_detail(session_id):
    """저장된 자세 판정 기록 조회"""

    with closing(get_db()) as conn:

        session = find_session(conn, session_id)

        if session is None:
            return error_response("세션 없음", 404)

        rows = conn.execute("""
            SELECT
                ts,
                status,
                fwd,
                appr,
                drop_value AS "drop",
                dist,
                yaw,
                pitch,
                neck
            FROM posture_events_v2
            WHERE session_id = ?
            ORDER BY ts, id
        """, (session_id,)).fetchall()

    return jsonify({
        "sessionId": session_id,
        "startTime": session["start_time"],
        "endTime": session["end_time"],
        "events": [dict(row) for row in rows]
    })


# ------------------------------------------------------------
# 10. 기본 통계 조회
# ------------------------------------------------------------

@app.get("/api/sessions/<session_id>/stats")
def session_stats(session_id):
    """자세 상태별 판정 건수와 비율 계산"""

    with closing(get_db()) as conn:

        if find_session(conn, session_id) is None:
            return error_response("세션 없음", 404)

        rows = conn.execute("""
            SELECT status, COUNT(*) AS count
            FROM posture_events_v2
            WHERE session_id = ?
            GROUP BY status
        """, (session_id,)).fetchall()

    counts = {
        status: 0
        for status in VALID_STATUSES
    }

    for row in rows:
        counts[row["status"]] = row["count"]

    # 인식 불가 / 보정 / 대기 상태는 분모에서 제외
    valid_total = sum(
        counts[status]
        for status in MEASURED_STATUSES
    )

    def rate(status):
        if valid_total == 0:
            return 0

        return round(
            counts[status] / valid_total * 100, 1
        )

    return jsonify({
        "totalEvents": valid_total,
        "statusCounts": counts,
        "turtleRate": rate("TURTLE"),
        "waistRate": rate("WAIST"),
        "closeRate": rate("CLOSE")
    })


# ------------------------------------------------------------
# 11. 서버 시작
# ------------------------------------------------------------

# Flask 실행 전에 데이터베이스 초기화
init_db()

if __name__ == "__main__":

    # 로컬 PC 테스트용 서버
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )