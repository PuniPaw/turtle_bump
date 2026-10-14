# NeckCare D 담당 백엔드
# 역할:
# 1. HTML, CSS, JavaScript 파일을 브라우저에 제공
# 2. PC와 스마트폰 사이의 WebRTC 연결 신호 중계
# 3. SQLite에 자세 측정 세션 및 판정 결과 저장
# 4. 저장된 측정 기록과 기본 통계 제공

from flask import Flask, jsonify, request, send_from_directory
from pathlib import Path
import sqlite3
import uuid
import time
import math
import threading

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "posture.db"

app = Flask(__name__)

# WebRTC 연결 정보를 임시 보관하는 메모리
# 10분이 지나면 오래된 방 정보를 제거
ROOM_TTL = 600
rooms = {}
rooms_lock = threading.Lock()


def now_ms():
    """현재 시각을 JavaScript Date.now()와 같은 밀리초로 반환"""
    return int(time.time() * 1000)


def get_db():
    """SQLite 데이터베이스 연결"""
    conn = sqlite3.connect(DB_PATH)

    # 조회 결과를 컬럼 이름으로 접근할 수 있게 설정
    conn.row_factory = sqlite3.Row

    # 외래키 제약 조건 활성화
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """서버 시작 시 필요한 테이블 자동 생성"""

    with get_db() as conn:

        # 한 번의 자세 측정 시작~종료를 하나의 세션으로 관리
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                start_time INTEGER NOT NULL,
                end_time INTEGER
            )
        """)

        # 각 세션에서 수집한 자세 판정 결과 저장
        conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                ts INTEGER NOT NULL,
                angle REAL NOT NULL,
                status TEXT NOT NULL
                    CHECK(status IN ('good', 'warn', 'bad')),
                FOREIGN KEY(session_id)
                    REFERENCES sessions(session_id)
                    ON DELETE CASCADE
            )
        """)

        # 특정 세션의 기록을 빠르게 조회하기 위한 인덱스
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_session
            ON events(session_id, ts)
        """)


def find_session(conn, session_id):
    """세션 ID로 기존 세션을 조회"""
    return conn.execute(
        "SELECT * FROM sessions WHERE session_id = ?",
        (session_id,)
    ).fetchone()


# --------------------------------------------------
# 웹페이지 및 정적 파일 제공
# --------------------------------------------------

@app.get("/")
def home():
    """PC 대시보드 화면"""
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/phone.html")
def phone_page():
    """스마트폰 카메라 송출 화면"""
    return send_from_directory(BASE_DIR, "phone.html")


@app.get("/favicon.svg")
def favicon():
    return send_from_directory(BASE_DIR, "favicon.svg")


@app.get("/css/<path:filename>")
def css_file(filename):
    """CSS 폴더 내부 파일 제공"""
    return send_from_directory(BASE_DIR / "css", filename)


@app.get("/js/<path:filename>")
def js_file(filename):
    """JS 하위 폴더까지 포함해 모듈 제공"""
    return send_from_directory(BASE_DIR / "js", filename)


# --------------------------------------------------
# WebRTC 시그널링
# --------------------------------------------------

def cleanup_rooms():
    """10분 이상 갱신되지 않은 연결 정보 제거

    반드시 rooms_lock을 잡은 상태에서 호출한다.
    """
    current = time.time()

    for code in list(rooms):
        if current - rooms[code]["updated"] > ROOM_TTL:
            del rooms[code]


@app.route(
    "/api/signal/<room>/<role>",
    methods=["GET", "POST"]
)
def signal(room, role):
    """PC와 스마트폰의 offer/answer SDP 중계

    WebRTC 영상 자체를 Flask DB에 저장하지 않는다.
    단, TURN 서버를 사용하는 경우 영상이 외부 중계 서버를
    통과할 수 있다.
    """

    room = room.upper()

    # 예상하지 못한 방 코드와 요청 유형 차단
    if (
        not room.isalnum()
        or len(room) != 4
        or role not in ("offer", "answer")
    ):
        return jsonify({"error": "잘못된 연결 요청"}), 400

    if request.method == "POST":

        # 비정상적으로 큰 연결 정보는 거부
        if (
            request.content_length is None
            or request.content_length > 100_000
        ):
            return jsonify({"error": "요청 크기 초과"}), 413

        data = request.get_json(silent=True)

        if not isinstance(data, dict):
            return jsonify({"error": "JSON 형식 오류"}), 400

        with rooms_lock:
            cleanup_rooms()

            entry = rooms.setdefault(room, {})
            entry[role] = data
            entry["updated"] = time.time()

        return jsonify({"ok": True})

    # GET 요청: 상대 브라우저가 올린 SDP 조회
    with rooms_lock:
        cleanup_rooms()
        data = rooms.get(room, {}).get(role)

    if data is None:
        # 아직 상대방이 연결 정보를 보내지 않음
        return "", 204

    response = jsonify(data)
    response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------
# SQLite 자세 측정 REST API
# --------------------------------------------------

@app.post("/api/sessions")
def start_session():
    """새 측정 세션 생성"""

    session_id = str(uuid.uuid4())
    start_time = now_ms()

    with get_db() as conn:
        conn.execute("""
            INSERT INTO sessions (session_id, start_time)
            VALUES (?, ?)
        """, (session_id, start_time))

    return jsonify({
        "sessionId": session_id,
        "startTime": start_time
    }), 201


@app.post("/api/sessions/<session_id>/events")
def save_events(session_id):
    """B 담당의 판정 결과를 여러 건 묶어서 저장"""

    payload = request.get_json(silent=True)

    if not isinstance(payload, dict):
        return jsonify({"error": "JSON 객체가 필요합니다."}), 400

    events = payload.get("events")

    if not isinstance(events, list):
        return jsonify({"error": "events 배열이 필요합니다."}), 400

    if len(events) > 1000:
        return jsonify({"error": "최대 1000건까지 저장 가능"}), 400

    # 데이터 형식 검증
    for event in events:

        if not isinstance(event, dict):
            return jsonify({"error": "잘못된 측정 데이터"}), 400

        ts = event.get("ts")
        angle = event.get("angle")
        status = event.get("status")

        if (
            type(ts) is not int
            or ts < 0
            or type(angle) not in (int, float)
            or not math.isfinite(angle)
            or not 0 <= angle <= 180
            or status not in ("good", "warn", "bad")
        ):
            return jsonify({"error": "측정값 형식 오류"}), 400

    with get_db() as conn:

        session = find_session(conn, session_id)

        if session is None:
            return jsonify({"error": "세션 없음"}), 404

        if session["end_time"] is not None:
            return jsonify({"error": "종료된 세션"}), 409

        # executemany: 여러 행을 한 번에 INSERT
        conn.executemany("""
            INSERT INTO events (session_id, ts, angle, status)
            VALUES (?, ?, ?, ?)
        """, [
            (session_id, e["ts"], e["angle"], e["status"])
            for e in events
        ])

    return jsonify({"savedCount": len(events)}), 201


@app.post("/api/sessions/<session_id>/end")
def end_session(session_id):
    """측정 종료 시각 기록"""

    with get_db() as conn:

        session = find_session(conn, session_id)

        if session is None:
            return jsonify({"error": "세션 없음"}), 404

        end_time = session["end_time"]

        # 이미 종료됐다면 기존 종료 시각 유지
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


@app.get("/api/sessions")
def list_sessions():
    """전체 측정 세션 목록 조회"""

    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                s.session_id,
                s.start_time,
                s.end_time,
                COUNT(e.id) AS total_events
            FROM sessions s
            LEFT JOIN events e
                ON s.session_id = e.session_id
            GROUP BY s.session_id
            ORDER BY s.start_time DESC
        """).fetchall()

    return jsonify([
        {
            "sessionId": r["session_id"],
            "startTime": r["start_time"],
            "endTime": r["end_time"],
            "totalEvents": r["total_events"]
        }
        for r in rows
    ])


@app.get("/api/sessions/<session_id>")
def session_detail(session_id):
    """특정 세션의 측정 데이터 전체 조회"""

    with get_db() as conn:

        session = find_session(conn, session_id)

        if session is None:
            return jsonify({"error": "세션 없음"}), 404

        events = conn.execute("""
            SELECT ts, angle, status
            FROM events
            WHERE session_id = ?
            ORDER BY ts, id
        """, (session_id,)).fetchall()

    return jsonify({
        "sessionId": session_id,
        "startTime": session["start_time"],
        "endTime": session["end_time"],
        "events": [dict(row) for row in events]
    })


@app.get("/api/sessions/<session_id>/stats")
def session_stats(session_id):
    """SQLite 집계 함수로 기본 통계 계산"""

    with get_db() as conn:

        if find_session(conn, session_id) is None:
            return jsonify({"error": "세션 없음"}), 404

        row = conn.execute("""
            SELECT
                COUNT(*) AS total_events,
                AVG(angle) AS average_angle,
                SUM(
                    CASE WHEN status = 'bad' THEN 1 ELSE 0 END
                ) AS bad_count
            FROM events
            WHERE session_id = ?
        """, (session_id,)).fetchone()

    total = row["total_events"]

    return jsonify({
        "averageAngle": round(row["average_angle"] or 0, 1),
        "badRatio": round(
            (row["bad_count"] or 0) / total * 100, 1
        ) if total else 0,
        "totalEvents": total
    })


# DB 초기화 후 서버 시작
init_db()

if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )