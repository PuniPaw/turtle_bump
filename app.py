
# app.py
# D 담당: Flask + SQLite + ERD 기반 데이터 저장 및 통계 API

from flask import Flask, request, jsonify
from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import sqlite3
import uuid
import math
import time

app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "neckcare_erd.sqlite3"
KST = ZoneInfo("Asia/Seoul")

# C 담당이 사용하는 정적 서버 주소
ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}

# ERD에 있는 7개 상태
# label, is_alert 값은 팀에서 최종 확인해야 하는 임시 시드
STATE_SEEDS = [
    ("GOOD", "바른 자세", 1, 0),
    ("TURTLE", "거북목", 1, 1),
    ("WAIST", "새우등", 1, 1),
    ("CLOSE", "화면에 가까움", 1, 0),
    ("NOVIS", "인식 불가", 0, 0),
    ("CALIB", "초기 자세 설정", 0, 0),
    ("IDLE", "대기", 0, 0),
]

VALID_STATES = {row[0] for row in STATE_SEEDS}
COUNTED_STATES = {"GOOD", "TURTLE", "WAIST", "CLOSE"}


# --------------------------------------------------
# 1. DB 연결 및 초기화
# --------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init_db():
    with get_db() as conn:
        # 기존 ERD의 컬럼 구조를 유지한다.
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at DATETIME(3) NOT NULL,
                ended_at DATETIME(3),
                total_duration_sec INTEGER NOT NULL DEFAULT 0,
                valid_duration_sec INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS posture_states (
                state VARCHAR(32) PRIMARY KEY,
                label VARCHAR(32) NOT NULL,
                is_counted BOOLEAN NOT NULL DEFAULT 1,
                is_alert BOOLEAN NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS posture_events (
                event_id CHAR(36) PRIMARY KEY,
                session_id INTEGER NOT NULL,
                state VARCHAR(32) NOT NULL,
                started_at DATETIME(3) NOT NULL,
                ended_at DATETIME(3),
                duration_sec FLOAT NOT NULL DEFAULT 0,
                alert_triggered BOOLEAN NOT NULL DEFAULT 0,

                FOREIGN KEY (session_id)
                    REFERENCES sessions(session_id),

                FOREIGN KEY (state)
                    REFERENCES posture_states(state)
            );

            CREATE INDEX IF NOT EXISTS idx_events_session
            ON posture_events(session_id);
        """)

        # 이미 존재하는 시드 값은 덮어쓰지 않는다.
        conn.executemany("""
            INSERT OR IGNORE INTO posture_states
            (state, label, is_counted, is_alert)
            VALUES (?, ?, ?, ?)
        """, STATE_SEEDS)


# --------------------------------------------------
# 2. 시간 및 오류 처리
# --------------------------------------------------

def now_ms():
    return int(time.time() * 1000)


def to_utc(ms):
    """epoch 밀리초 -> UTC DATETIME(3) 문자열"""
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return dt.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def from_utc(value):
    """UTC DATETIME(3) 문자열 -> epoch 밀리초"""
    dt = datetime.strptime(
        value, "%Y-%m-%d %H:%M:%S.%f"
    ).replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def read_ms(value, name):
    if type(value) is not int:
        raise ValueError(f"{name}은 밀리초 정수여야 합니다.")
    if value < 0 or value > 32503680000000:
        raise ValueError(f"{name}이 허용 범위를 벗어났습니다.")
    return value


def json_body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("JSON 객체가 필요합니다.")
    return data


def api_error(message, status=400):
    return jsonify({
        "ok": False,
        "error": {
            "code": status,
            "message": message
        }
    }), status


@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin")

    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Methods"] = (
            "GET, POST, OPTIONS"
        )
        response.headers["Access-Control-Allow-Headers"] = (
            "Content-Type"
        )

    return response


@app.before_request
def handle_options():
    if request.method == "OPTIONS":
        return "", 204


# --------------------------------------------------
# 3. 측정 세션 생성
# POST /api/sessions
# --------------------------------------------------

@app.post("/api/sessions")
def create_session():
    try:
        data = json_body()
        started_ms = read_ms(
            data.get("started_at_ms", now_ms()),
            "started_at_ms"
        )

        if started_ms > now_ms() + 60000:
            raise ValueError("미래의 시작 시각입니다.")

        with get_db() as conn:
            cursor = conn.execute("""
                INSERT INTO sessions (started_at)
                VALUES (?)
            """, (to_utc(started_ms),))

            session_id = cursor.lastrowid

        return jsonify({
            "session_id": session_id,
            "started_at_ms": started_ms
        }), 201

    except ValueError as error:
        return api_error(str(error))


# --------------------------------------------------
# 4. 자세 구간 저장
# POST /api/sessions/<session_id>/events
# --------------------------------------------------

@app.post("/api/sessions/<int:session_id>/events")
def save_posture_events(session_id):
    try:
        data = json_body()
        events = data.get("events")

        if not isinstance(events, list):
            raise ValueError("events는 배열이어야 합니다.")

        if len(events) > 500:
            raise ValueError("한 번에 최대 500건까지 저장합니다.")

        # 먼저 모든 이벤트를 검증한다.
        cleaned = []

        for event in events:
            if not isinstance(event, dict):
                raise ValueError("이벤트는 객체여야 합니다.")

            event_id = str(uuid.UUID(event["event_id"]))
            state = event["state"]

            if state not in VALID_STATES:
                raise ValueError(f"알 수 없는 자세 상태: {state}")

            start_ms = read_ms(
                event["started_at_ms"], "started_at_ms"
            )

            end_value = event.get("ended_at_ms")
            end_ms = (
                None if end_value is None
                else read_ms(end_value, "ended_at_ms")
            )

            if end_ms is not None and end_ms < start_ms:
                raise ValueError("종료 시각이 시작 시각보다 빠릅니다.")

            duration = (
                0.0 if end_ms is None
                else (end_ms - start_ms) / 1000
            )

            supplied = event.get("duration_sec")

            if supplied is not None:
                if (
                    type(supplied) not in (int, float)
                    or not math.isfinite(supplied)
                    or abs(supplied - duration) > 0.02
                ):
                    raise ValueError(
                        "duration_sec와 실제 시간 차이가 일치하지 않습니다."
                    )

            alert = event.get("alert_triggered", False)

            if type(alert) is not bool:
                raise ValueError(
                    "alert_triggered는 true 또는 false여야 합니다."
                )

            cleaned.append((
                event_id,
                session_id,
                state,
                to_utc(start_ms),
                to_utc(end_ms) if end_ms is not None else None,
                duration,
                int(alert)
            ))

        with get_db() as conn:
            session = conn.execute("""
                SELECT * FROM sessions WHERE session_id = ?
            """, (session_id,)).fetchone()

            if session is None:
                return api_error("세션이 존재하지 않습니다.", 404)

            if session["ended_at"] is not None:
                return api_error("이미 종료된 세션입니다.", 409)

            # 한 묶음 전체를 하나의 트랜잭션으로 저장
            for row in cleaned:
                existing = conn.execute("""
                    SELECT * FROM posture_events
                    WHERE event_id = ?
                """, (row[0],)).fetchone()

                if existing is None:
                    conn.execute("""
                        INSERT INTO posture_events
                        (event_id, session_id, state,
                         started_at, ended_at,
                         duration_sec, alert_triggered)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    """, row)
                    continue

                # 같은 UUID라도 다른 구간이면 충돌
                if (
                    existing["session_id"] != session_id
                    or existing["state"] != row[2]
                    or existing["started_at"] != row[3]
                ):
                    return api_error(
                        "이미 다른 이벤트에 사용된 event_id입니다.", 409
                    )

                # 이미 닫힌 구간은 중복 재전송으로 간주
                if existing["ended_at"] is not None:
                    continue

                # 진행 중 구간을 같은 UUID로 닫을 수 있음
                conn.execute("""
                    UPDATE posture_events
                    SET ended_at = ?,
                        duration_sec = ?,
                        alert_triggered = ?
                    WHERE event_id = ?
                """, (row[4], row[5], row[6], row[0]))

        return jsonify({
            "ok": True,
            "received_count": len(cleaned)
        })

    except (ValueError, KeyError, TypeError) as error:
        return api_error(str(error))


# --------------------------------------------------
# 5. 세션 종료
# POST /api/sessions/<session_id>/end
# --------------------------------------------------

@app.post("/api/sessions/<int:session_id>/end")
def end_session(session_id):
    try:
        data = json_body()

        ended_ms = read_ms(
            data.get("ended_at_ms", now_ms()),
            "ended_at_ms"
        )

        # reason은 API에서 받지만 ERD에 컬럼이 없어 DB에 저장하지 않음
        reason = data.get("reason", "camera_off")
        if not isinstance(reason, str) or len(reason) > 100:
            raise ValueError("reason 형식이 올바르지 않습니다.")

        with get_db() as conn:
            session = conn.execute("""
                SELECT * FROM sessions WHERE session_id = ?
            """, (session_id,)).fetchone()

            if session is None:
                return api_error("세션이 존재하지 않습니다.", 404)

            # 이미 종료된 세션은 최초 종료 결과 그대로 반환
            if session["ended_at"] is None:
                start_ms = from_utc(session["started_at"])

                if ended_ms < start_ms:
                    raise ValueError("종료 시각이 시작 시각보다 빠릅니다.")

                # 종료되지 않은 자세 구간을 함께 마감
                opened = conn.execute("""
                    SELECT event_id, started_at
                    FROM posture_events
                    WHERE session_id = ? AND ended_at IS NULL
                """, (session_id,)).fetchall()

                for event in opened:
                    event_start = from_utc(event["started_at"])
                    event_end = max(event_start, ended_ms)

                    conn.execute("""
                        UPDATE posture_events
                        SET ended_at = ?, duration_sec = ?
                        WHERE event_id = ?
                    """, (
                        to_utc(event_end),
                        (event_end - event_start) / 1000,
                        event["event_id"]
                    ))

                # is_counted=1인 구간만 유효 측정 시간으로 계산
                valid = conn.execute("""
                    SELECT COALESCE(SUM(e.duration_sec), 0)
                    FROM posture_events e
                    JOIN posture_states s ON e.state = s.state
                    WHERE e.session_id = ?
                      AND s.is_counted = 1
                """, (session_id,)).fetchone()[0]

                total = (ended_ms - start_ms) // 1000

                conn.execute("""
                    UPDATE sessions
                    SET ended_at = ?,
                        total_duration_sec = ?,
                        valid_duration_sec = ?
                    WHERE session_id = ?
                """, (
                    to_utc(ended_ms),
                    total,
                    round(valid),
                    session_id
                ))

            result = conn.execute("""
                SELECT * FROM sessions WHERE session_id = ?
            """, (session_id,)).fetchone()

        return jsonify({
            "ok": True,
            "session_id": session_id,
            "ended_at_ms": from_utc(result["ended_at"]),
            "total_duration_sec": result["total_duration_sec"],
            "valid_duration_sec": result["valid_duration_sec"]
        })

    except ValueError as error:
        return api_error(str(error))


# --------------------------------------------------
# 6. 통계 공통 함수
# --------------------------------------------------

def get_period_start(period, as_of_ms):
    now = datetime.fromtimestamp(as_of_ms / 1000, KST)

    if period == "today":
        start = now.replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        previous = start - timedelta(days=1)

    elif period == "week":
        start = now - timedelta(days=7)
        previous = start - timedelta(days=7)

    elif period == "month":
        start = now - timedelta(days=30)
        previous = start - timedelta(days=30)

    else:
        raise ValueError("period는 today, week, month 중 하나입니다.")

    return (
        int(start.timestamp() * 1000),
        int(previous.timestamp() * 1000)
    )


def load_events(conn, start_ms, end_ms):
    """저장 완료된 종료 구간만 조회하고 기간에 맞춰 시간 자르기"""

    rows = conn.execute("""
        SELECT event_id, state, started_at, ended_at
        FROM posture_events
        WHERE ended_at IS NOT NULL
          AND started_at < ?
          AND ended_at > ?
        ORDER BY started_at
    """, (to_utc(end_ms), to_utc(start_ms))).fetchall()

    result = []

    for row in rows:
        event_start = from_utc(row["started_at"])
        event_end = from_utc(row["ended_at"])

        overlap = max(
            0,
            min(event_end, end_ms) - max(event_start, start_ms)
        ) / 1000

        if overlap <= 0:
            continue

        result.append({
            "id": row["event_id"],
            "state": row["state"],
            "started_ms": event_start,
            "ended_ms": event_end,
            "duration_sec": overlap
        })

    return result


def calculate_summary(events, start_ms, end_ms):
    seconds = {state: 0.0 for state in VALID_STATES}
    turtle_count = 0
    shrimp_count = 0
    bad_durations = []

    for event in events:
        state = event["state"]
        seconds[state] += event["duration_sec"]

        # 이벤트 시작이 조회 기간 안에 있을 때 횟수 집계
        if start_ms <= event["started_ms"] < end_ms:
            if state == "TURTLE":
                turtle_count += 1
                bad_durations.append(event["duration_sec"])
            elif state == "WAIST":
                shrimp_count += 1
                bad_durations.append(event["duration_sec"])

    valid_sec = sum(
        seconds[state] for state in COUNTED_STATES
    )

    good_ratio = (
        seconds["GOOD"] / valid_sec * 100
        if valid_sec > 0 else None
    )

    avg_duration = (
        sum(bad_durations) / len(bad_durations)
        if bad_durations else None
    )

    return {
        "seconds": seconds,
        "measuredSec": valid_sec,
        "turtleCount": turtle_count,
        "shrimpCount": shrimp_count,
        "goodRatio": good_ratio,
        "avgDurationSec": avg_duration
    }


def rounded(value):
    return round(value, 2) if value is not None else None


# --------------------------------------------------
# 7. 홈 누적 측정 시간
# GET /api/summary/home
# --------------------------------------------------

@app.get("/api/summary/home")
def home_summary():
    try:
        as_of_ms = read_ms(
            int(request.args.get("as_of_ms", now_ms())),
            "as_of_ms"
        )

        with get_db() as conn:
            events = load_events(conn, 0, as_of_ms)

        valid_events = [
            event for event in events
            if event["state"] in COUNTED_STATES
        ]

        measured = sum(
            event["duration_sec"] for event in valid_events
        )

        return jsonify({
            "measured_sec": (
                round(measured) if valid_events else None
            )
        })

    except ValueError as error:
        return api_error(str(error))


# --------------------------------------------------
# 8. C 대시보드 통계
# GET /api/stats?period=today&unit=day
# --------------------------------------------------

@app.get("/api/stats")
def get_statistics():
    try:
        period = request.args.get("period", "today")
        unit = request.args.get("unit", "day")

        if unit not in ("day", "week"):
            raise ValueError("unit은 day 또는 week입니다.")

        as_of_ms = read_ms(
            int(request.args.get("as_of_ms", now_ms())),
            "as_of_ms"
        )

        start_ms, previous_ms = get_period_start(
            period, as_of_ms
        )

        with get_db() as conn:
            current_events = load_events(
                conn, start_ms, as_of_ms
            )
            previous_events = load_events(
                conn, previous_ms, start_ms
            )

        if not current_events and not previous_events:
            return jsonify({
                "summary": None,
                "trend": {"turtle": [], "shrimp": []},
                "distribution": None,
                "records": []
            })

        current = calculate_summary(
            current_events, start_ms, as_of_ms
        )
        previous = calculate_summary(
            previous_events, previous_ms, start_ms
        )

        def metric(name):
            return {
                "value": rounded(current[name])
                         if current_events else None,
                "prev": rounded(previous[name])
                        if previous_events else None
            }

        summary = {
            "measuredSec": metric("measuredSec"),
            "turtleCount": metric("turtleCount"),
            "shrimpCount": metric("shrimpCount"),
            "goodRatio": metric("goodRatio"),
            "avgDurationSec": metric("avgDurationSec")
        }

        # 일별/주별 발생 횟수
        buckets = {}

        for event in current_events:
            if event["state"] not in ("TURTLE", "WAIST"):
                continue

            if not start_ms <= event["started_ms"] < as_of_ms:
                continue

            dt = datetime.fromtimestamp(
                event["started_ms"] / 1000, KST
            )

            if unit == "day":
                key = dt.strftime("%Y-%m-%d")
            else:
                monday = dt.date() - timedelta(
                    days=dt.weekday()
                )
                key = monday.isoformat()

            if key not in buckets:
                buckets[key] = {"turtle": 0, "shrimp": 0}

            kind = (
                "turtle" if event["state"] == "TURTLE"
                else "shrimp"
            )
            buckets[key][kind] += 1

        trend = {"turtle": [], "shrimp": []}

        for key in sorted(buckets):
            label = key[5:].replace("-", "/")

            for kind in ("turtle", "shrimp"):
                trend[kind].append({
                    "label": label,
                    "count": buckets[key][kind]
                })

        # 자세별 지속 시간 분포
        valid = current["measuredSec"]

        mapping = [
            ("good", "GOOD"),
            ("turtle", "TURTLE"),
            ("shrimp", "WAIST"),
            ("other", "CLOSE")
        ]

        distribution = None

        if valid > 0:
            distribution = {
                "totalSec": rounded(valid),
                "items": [
                    {
                        "type": name,
                        "sec": rounded(
                            current["seconds"][state]
                        ),
                        "ratio": rounded(
                            current["seconds"][state] / valid * 100
                        )
                    }
                    for name, state in mapping
                ]
            }

        # 최근 감지 기록
        type_map = {
            "GOOD": "good",
            "TURTLE": "turtle",
            "WAIST": "shrimp"
        }

        records = [
            {
                "id": event["id"],
                "startedAt": event["started_ms"],
                "type": type_map[event["state"]],
                "durationSec": rounded(
                    event["duration_sec"]
                )
            }
            for event in current_events
            if event["state"] in type_map
            and start_ms <= event["started_ms"] < as_of_ms
        ]

        return jsonify({
            "summary": summary,
            "trend": trend,
            "distribution": distribution,
            "records": records
        })

    except ValueError as error:
        return api_error(str(error))


# --------------------------------------------------
# 9. 서버 실행
# --------------------------------------------------

if __name__ == "__main__":
    init_db()

    # C는 5173, D Flask API는 5000 포트 사용
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )
