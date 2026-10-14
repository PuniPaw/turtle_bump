
import os
import math
import logging
import traceback
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from contextlib import contextmanager

import MySQLdb
import MySQLdb.cursors
from dotenv import load_dotenv
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

# ============================================================
# 1. 기본 설정
# ============================================================

load_dotenv()

app = Flask(__name__)

CORS(
    app,
    resources={r"/api/*": {"origins": "*"}}
)

logging.basicConfig(level=logging.INFO)

KST = timezone(timedelta(hours=9))
UTC = timezone.utc

COUNTED_STATES = {"GOOD", "TURTLE", "WAIST", "CLOSE"}
ALL_STATES = COUNTED_STATES | {"NOVIS", "CALIB", "IDLE"}
ALERT_STATES = {"TURTLE", "WAIST"}

MAX_EVENTS = 500

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "127.0.0.1"),
    "user": os.getenv("DB_USER", "root"),
    "passwd": os.getenv("DB_PASSWORD", ""),
    "db": os.getenv("DB_NAME", "turtle_bump"),
    "port": int(os.getenv("DB_PORT", "3306")),
    "charset": "utf8mb4",
    "cursorclass": MySQLdb.cursors.DictCursor,
    "autocommit": False,
}


# ============================================================
# 2. 공통 함수
# ============================================================

class APIError(Exception):
    def __init__(self, status, reason, message):
        super().__init__(message)
        self.status = status
        self.reason = reason
        self.message = message


def fail(status, reason, message):
    raise APIError(status, reason, message)


def is_int(value):
    # bool은 Python에서 int의 하위 타입이므로 별도로 제외
    return type(value) is int


def valid_ms(value):
    return is_int(value) and 0 <= value <= 253402300799999


def utc_dt(ms):
    return datetime.fromtimestamp(ms / 1000, tz=UTC).replace(
        tzinfo=None
    )


def dt_ms(value):
    if value is None:
        return None

    # DB DATETIME은 UTC로 저장하고 읽음
    return int(
        value.replace(tzinfo=UTC).timestamp() * 1000
    )


def seconds(ms):
    return round(ms / 1000, 3)


def require_json_object():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        fail(400, "INVALID_REQUEST", "JSON 객체가 필요합니다.")

    return data


def require_ms(data, key):
    value = data.get(key)

    if not valid_ms(value):
        fail(
            400,
            "INVALID_REQUEST",
            f"{key}는 유효한 밀리초 정수여야 합니다."
        )

    return value


def get_as_of():
    raw = request.args.get("as_of_ms")

    if raw is None:
        return int(datetime.now(UTC).timestamp() * 1000)

    try:
        value = int(raw)
    except (ValueError, TypeError):
        fail(400, "INVALID_REQUEST", "as_of_ms가 잘못되었습니다.")

    if str(value) != raw or not valid_ms(value):
        fail(400, "INVALID_REQUEST", "as_of_ms가 잘못되었습니다.")

    return value


@contextmanager
def db_connection():
    conn = MySQLdb.connect(**DB_CONFIG)

    try:
        with conn.cursor() as cur:
            cur.execute("SET time_zone = '+00:00'")

        yield conn
        conn.commit()

    except Exception:
        conn.rollback()
        raise

    finally:
        conn.close()


def fetch_one(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def fetch_all(conn, sql, params=()):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


# ============================================================
# 3. 에러 처리
# ============================================================

@app.errorhandler(APIError)
def handle_api_error(error):
    return jsonify({
        "ok": False,
        "error": {
            "code": error.status,
            "reason": error.reason,
            "message": error.message
        }
    }), error.status


@app.errorhandler(Exception)
def handle_exception(error):
    # 중요: 실제 오류를 Flask 실행 터미널에 출력
    print("\n========== FLASK ERROR ==========", flush=True)
    traceback.print_exc()
    print("=================================\n", flush=True)

    if isinstance(error, HTTPException):
        return jsonify({
            "ok": False,
            "error": {
                "code": error.code,
                "reason": "INVALID_REQUEST",
                "message": error.description
            }
        }), error.code

    return jsonify({
        "ok": False,
        "error": {
            "code": 500,
            "reason": "INTERNAL_ERROR",
            "message": "서버 내부 오류가 발생했습니다."
        }
    }), 500


# ============================================================
# 4. DB 테이블 생성
# ============================================================

def init_db():
    with db_connection() as conn:
        with conn.cursor() as cur:

            cur.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    started_at DATETIME(3) NOT NULL,
                    ended_at DATETIME(3) NULL,
                    total_duration_sec DOUBLE NULL,
                    valid_duration_sec DOUBLE NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS posture_states (
                    state VARCHAR(20) PRIMARY KEY,
                    label VARCHAR(50) NOT NULL,
                    is_counted BOOLEAN NOT NULL,
                    is_alert BOOLEAN NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS posture_events (
                    event_id VARCHAR(36) PRIMARY KEY,
                    session_id BIGINT NOT NULL,
                    state VARCHAR(20) NOT NULL,
                    started_at DATETIME(3) NOT NULL,
                    ended_at DATETIME(3) NULL,
                    duration_sec DOUBLE NULL,
                    alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
                    is_final BOOLEAN NOT NULL DEFAULT FALSE,
                    INDEX idx_session_start (
                        session_id, started_at
                    ),
                    CONSTRAINT fk_event_session
                        FOREIGN KEY (session_id)
                        REFERENCES sessions(session_id),
                    CONSTRAINT fk_event_state
                        FOREIGN KEY (state)
                        REFERENCES posture_states(state)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            states = [
                ("GOOD", "바른 자세", 1, 0),
                ("TURTLE", "거북목", 1, 1),
                ("WAIST", "허리 자세 불량", 1, 1),
                ("CLOSE", "카메라 근접", 1, 0),
                ("NOVIS", "인식 불가", 0, 0),
                ("CALIB", "보정 중", 0, 0),
                ("IDLE", "대기 중", 0, 0)
            ]

            cur.executemany("""
                INSERT IGNORE INTO posture_states
                (state, label, is_counted, is_alert)
                VALUES (%s, %s, %s, %s)
            """, states)


# ============================================================
# 5. 이벤트 유효성 검사
# ============================================================

def prepare_events(data):
    events = data.get("events")

    if not isinstance(events, list):
        fail(400, "INVALID_REQUEST", "events는 배열이어야 합니다.")

    if len(events) > MAX_EVENTS:
        fail(400, "INVALID_REQUEST", "이벤트는 최대 500개입니다.")

    prepared = []

    for index, event in enumerate(events):
        if not isinstance(event, dict):
            fail(
                400,
                "INVALID_REQUEST",
                f"events[{index}]는 객체여야 합니다."
            )

        event_id = event.get("event_id")
        state = event.get("state")
        start = event.get("started_at_ms")
        end = event.get("ended_at_ms")
        final = event.get("is_final")
        alert = event.get("alert_triggered")

        if not isinstance(event_id, str) or not event_id.strip():
            fail(400, "INVALID_REQUEST", "event_id가 필요합니다.")

        if len(event_id) > 36:
            fail(400, "INVALID_REQUEST", "event_id가 너무 깁니다.")

        if state not in ALL_STATES:
            fail(400, "INVALID_REQUEST", "유효하지 않은 자세 상태입니다.")

        if not valid_ms(start):
            fail(400, "INVALID_REQUEST", "started_at_ms가 잘못되었습니다.")

        if end is not None:
            if not valid_ms(end) or end <= start:
                fail(
                    400,
                    "INVALID_REQUEST",
                    "ended_at_ms는 시작 시각보다 커야 합니다."
                )

        if type(final) is not bool:
            fail(400, "INVALID_REQUEST", "is_final은 boolean이어야 합니다.")

        if type(alert) is not bool:
            fail(
                400,
                "INVALID_REQUEST",
                "alert_triggered는 boolean이어야 합니다."
            )

        if final and end is None:
            fail(
                400,
                "INVALID_REQUEST",
                "최종 이벤트에는 종료 시각이 필요합니다."
            )

        prepared.append({
            "event_id": event_id,
            "state": state,
            "start": start,
            "end": end,
            "final": final,
            "alert": alert
        })

    return prepared


def lock_session(conn, session_id):
    row = fetch_one(conn, """
        SELECT *
        FROM sessions
        WHERE session_id = %s
        FOR UPDATE
    """, (session_id,))

    if row is None:
        fail(404, "SESSION_NOT_FOUND", "세션을 찾을 수 없습니다.")

    return row


def validate_event_range(event, session, closing_ms=None):
    session_start = dt_ms(session["started_at"])

    session_end = (
        closing_ms
        if closing_ms is not None
        else dt_ms(session["ended_at"])
    )

    if event["start"] < session_start:
        fail(
            409,
            "EVENT_OUT_OF_RANGE",
            "이벤트가 세션 시작보다 빠릅니다."
        )

    if session_end is not None:
        if event["start"] >= session_end:
            fail(
                409,
                "EVENT_OUT_OF_RANGE",
                "이벤트 시작이 세션 종료 범위를 벗어났습니다."
            )

        if event["end"] is not None and event["end"] > session_end:
            fail(
                409,
                "EVENT_OUT_OF_RANGE",
                "이벤트 종료가 세션 종료 범위를 벗어났습니다."
            )


def validate_overlaps(conn, session_id):
    rows = fetch_all(conn, """
        SELECT event_id, started_at, ended_at
        FROM posture_events
        WHERE session_id = %s
        ORDER BY started_at, event_id
    """, (session_id,))

    # 서로 다른 이벤트의 확정된 시간 구간이 겹치는지 검사.
    # NULL 종료 시각은 추정하지 않음.
    previous_start = None
    maximum_end = None

    for row in rows:
        start = dt_ms(row["started_at"])
        end = dt_ms(row["ended_at"])

        if previous_start is not None and start == previous_start:
            fail(
                409,
                "EVENT_OVERLAP",
                "서로 다른 이벤트의 시작 시각이 같습니다."
            )

        if maximum_end is not None and start < maximum_end:
            fail(
                409,
                "EVENT_OVERLAP",
                "서로 다른 이벤트의 시간 구간이 겹칩니다."
            )

        previous_start = start

        if end is not None:
            if maximum_end is None or end > maximum_end:
                maximum_end = end


def upsert_events(conn, session, events, closing_ms=None):
    result = {
        "saved": 0,
        "updated": 0,
        "ignored": 0
    }

    session_id = session["session_id"]

    for event in events:
        validate_event_range(event, session, closing_ms)

        old = fetch_one(conn, """
            SELECT *
            FROM posture_events
            WHERE event_id = %s
            FOR UPDATE
        """, (event["event_id"],))

        if old is None:
            duration = (
                seconds(event["end"] - event["start"])
                if event["end"] is not None
                else None
            )

            with conn.cursor() as cur:
                cur.execute("""
                    INSERT INTO posture_events (
                        event_id,
                        session_id,
                        state,
                        started_at,
                        ended_at,
                        duration_sec,
                        alert_triggered,
                        is_final
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (
                    event["event_id"],
                    session_id,
                    event["state"],
                    utc_dt(event["start"]),
                    utc_dt(event["end"]) if event["end"] is not None else None,
                    duration,
                    int(event["alert"]),
                    int(event["final"])
                ))

            result["saved"] += 1
            continue

        # UUID가 같으면 세션, 상태, 시작 시각은 불변
        if (
            old["session_id"] != session_id
            or old["state"] != event["state"]
            or dt_ms(old["started_at"]) != event["start"]
        ):
            fail(
                409,
                "EVENT_ID_CONFLICT",
                "동일 UUID의 불변 필드가 다릅니다."
            )

        old_end = dt_ms(old["ended_at"])
        old_final = bool(old["is_final"])
        old_alert = bool(old["alert_triggered"])

        # 이미 최종화된 이벤트
        if old_final:
            if (
                event["final"]
                and event["end"] == old_end
                and event["alert"] == old_alert
            ):
                result["ignored"] += 1
                continue

            # 최종화 전 스냅샷 재전송은 무시
            if not event["final"]:
                result["ignored"] += 1
                continue

            fail(
                409,
                "EVENT_FINALIZED",
                "최종화된 이벤트는 변경할 수 없습니다."
            )

        # 미확정 이벤트는 종료 시각을 뒤로 돌릴 수 없음
        if (
            old_end is not None
            and event["end"] is not None
            and event["end"] < old_end
        ):
            fail(
                409,
                "EVENT_TIME_REGRESSION",
                "이벤트 종료 시각이 이전보다 빠릅니다."
            )

        # 이전에 저장된 종료 시각을 NULL로 되돌릴 수 없음
        if old_end is not None and event["end"] is None:
            result["ignored"] += 1
            continue

        new_end = event["end"]

        # 미확정 상태에서는 경고 발생 여부가 누적됨
        new_alert = old_alert or event["alert"]

        # 최종화 시에도 이전에 관측한 경고를 유지
        if event["final"]:
            new_alert = old_alert or event["alert"]

        if (
            old_end == new_end
            and old_alert == new_alert
            and old_final == event["final"]
        ):
            result["ignored"] += 1
            continue

        duration = (
            seconds(new_end - event["start"])
            if new_end is not None
            else None
        )

        with conn.cursor() as cur:
            cur.execute("""
                UPDATE posture_events
                SET ended_at = %s,
                    duration_sec = %s,
                    alert_triggered = %s,
                    is_final = %s
                WHERE event_id = %s
            """, (
                utc_dt(new_end) if new_end is not None else None,
                duration,
                int(new_alert),
                int(event["final"]),
                event["event_id"]
            ))

        result["updated"] += 1

    validate_overlaps(conn, session_id)

    return result


# ============================================================
# 6. 세션 생성
# POST /api/sessions
# ============================================================

@app.post("/api/sessions")
def create_session():
    data = require_json_object()
    start = require_ms(data, "started_at_ms")

    with db_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO sessions (started_at)
                VALUES (%s)
            """, (utc_dt(start),))

            session_id = cur.lastrowid

    return jsonify({
        "session_id": session_id,
        "started_at_ms": start
    }), 201


# ============================================================
# 7. 이벤트 저장
# POST /api/sessions/<id>/events
# ============================================================

@app.post("/api/sessions/<int:session_id>/events")
def save_events(session_id):
    data = require_json_object()
    events = prepare_events(data)

    with db_connection() as conn:
        session = lock_session(conn, session_id)

        if session["ended_at"] is not None:
            fail(
                409,
                "SESSION_CLOSED",
                "이미 종료된 세션입니다."
            )

        result = upsert_events(conn, session, events)

    return jsonify({
        "ok": True,
        "received_count": len(events),
        **result
    }), 200


# ============================================================
# 8. 세션 종료
# POST /api/sessions/<id>/end
# ============================================================

@app.post("/api/sessions/<int:session_id>/end")
def end_session(session_id):
    data = require_json_object()

    # 종료 재시도는 기존 저장 결과를 우선 반환
    with db_connection() as conn:
        session = lock_session(conn, session_id)

        if session["ended_at"] is not None:
            return jsonify({
                "ok": True,
                "session_id": session_id,
                "ended_at_ms": dt_ms(session["ended_at"]),
                "total_duration_sec": session["total_duration_sec"],
                "valid_duration_sec": session["valid_duration_sec"]
            }), 200

        end = require_ms(data, "ended_at_ms")
        reason = data.get("reason")

        if reason is not None and reason not in {
            "camera_off", "pagehide", "input_ended"
        }:
            fail(400, "INVALID_REQUEST", "reason이 잘못되었습니다.")

        start = dt_ms(session["started_at"])

        if end <= start:
            fail(
                400,
                "INVALID_REQUEST",
                "세션 종료 시각은 시작 시각보다 커야 합니다."
            )

        events = prepare_events({
            "events": data.get("events", [])
        })

        # 이벤트 저장과 세션 종료를 하나의 트랜잭션으로 처리
        upsert_events(conn, session, events, closing_ms=end)

        # 이미 저장된 이벤트도 종료 범위 안에 있어야 함
        rows = fetch_all(conn, """
            SELECT state, started_at, ended_at
            FROM posture_events
            WHERE session_id = %s
        """, (session_id,))

        valid_ms_total = 0

        for row in rows:
            event_start = dt_ms(row["started_at"])
            event_end = dt_ms(row["ended_at"])

            if event_start >= end:
                fail(
                    409,
                    "EVENT_OUT_OF_RANGE",
                    "기존 이벤트 시작이 세션 종료보다 늦습니다."
                )

            if event_end is not None and event_end > end:
                fail(
                    409,
                    "EVENT_OUT_OF_RANGE",
                    "기존 이벤트 종료가 세션 종료보다 늦습니다."
                )

            if (
                row["state"] in COUNTED_STATES
                and event_end is not None
            ):
                valid_ms_total += event_end - event_start

        total_duration = seconds(end - start)
        valid_duration = seconds(valid_ms_total)

        with conn.cursor() as cur:
            cur.execute("""
                UPDATE sessions
                SET ended_at = %s,
                    total_duration_sec = %s,
                    valid_duration_sec = %s
                WHERE session_id = %s
            """, (
                utc_dt(end),
                total_duration,
                valid_duration,
                session_id
            ))

    return jsonify({
        "ok": True,
        "session_id": session_id,
        "ended_at_ms": end,
        "total_duration_sec": total_duration,
        "valid_duration_sec": valid_duration
    }), 200


# ============================================================
# 9. 통계 계산 공통 함수
# ============================================================

def period_bounds(period, as_of):
    now_kst = datetime.fromtimestamp(as_of / 1000, KST)

    today = now_kst.replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    if period == "today":
        current_start = today
        previous_start = today - timedelta(days=1)
        previous_end = previous_start + (
            now_kst - today
        )

    elif period == "week":
        current_start = today - timedelta(days=6)
        previous_start = current_start - timedelta(days=7)
        previous_end = current_start

    elif period == "month":
        current_start = today - timedelta(days=29)
        previous_start = current_start - timedelta(days=30)
        previous_end = current_start

    else:
        fail(400, "INVALID_REQUEST", "period가 잘못되었습니다.")

    def to_ms(value):
        return int(value.timestamp() * 1000)

    return (
        to_ms(current_start),
        as_of,
        to_ms(previous_start),
        to_ms(previous_end)
    )


def load_events(conn, start_ms, end_ms):
    # 해당 기간과 교차할 수 있는 이벤트 조회
    return fetch_all(conn, """
        SELECT
            event_id,
            session_id,
            state,
            started_at,
            ended_at,
            alert_triggered,
            is_final
        FROM posture_events
        WHERE started_at < %s
          AND (
              ended_at IS NULL
              OR ended_at > %s
              OR started_at >= %s
          )
        ORDER BY started_at
    """, (
        utc_dt(end_ms),
        utc_dt(start_ms),
        utc_dt(start_ms)
    ))


def load_started_events(conn, start_ms, end_ms):
    return fetch_all(conn, """
        SELECT event_id, state, started_at
        FROM posture_events
        WHERE started_at >= %s
          AND started_at < %s
        ORDER BY started_at
    """, (
        utc_dt(start_ms),
        utc_dt(end_ms)
    ))


def has_records(conn, start_ms, end_ms):
    row = fetch_one(conn, """
        SELECT EXISTS (
            SELECT 1
            FROM sessions
            WHERE started_at < %s
              AND (
                  ended_at IS NULL
                  OR ended_at > %s
              )
        ) AS found
    """, (
        utc_dt(end_ms),
        utc_dt(start_ms)
    ))

    return bool(row["found"])


def calculate_metrics(conn, start_ms, end_ms):
    events = load_events(conn, start_ms, end_ms)
    started = load_started_events(conn, start_ms, end_ms)

    durations = {
        "good": 0,
        "turtle": 0,
        "shrimp": 0,
        "other": 0
    }

    bad_event_count = 0
    bad_duration_ms = 0

    records = []

    for event in events:
        state = event["state"]

        event_start = dt_ms(event["started_at"])
        event_end = dt_ms(event["ended_at"])

        # NULL 종료 시각은 미확정 시간으로 계산하지 않음
        if event_end is None:
            continue

        clipped_start = max(event_start, start_ms)
        clipped_end = min(event_end, end_ms)

        if clipped_end <= clipped_start:
            continue

        duration_ms = clipped_end - clipped_start

        if state == "GOOD":
            durations["good"] += duration_ms

        elif state == "TURTLE":
            durations["turtle"] += duration_ms
            bad_event_count += 1
            bad_duration_ms += duration_ms

        elif state == "WAIST":
            durations["shrimp"] += duration_ms
            bad_event_count += 1
            bad_duration_ms += duration_ms

        elif state == "CLOSE":
            durations["other"] += duration_ms

        if state in {"GOOD", "TURTLE", "WAIST"}:
            record_type = {
                "GOOD": "good",
                "TURTLE": "turtle",
                "WAIST": "shrimp"
            }[state]

            records.append({
                "id": event["event_id"],
                "startedAt": event_start,
                "type": record_type,
                "durationSec": seconds(duration_ms)
            })

    measured_ms = sum(durations.values())

    turtle_count = sum(
        1 for event in started
        if event["state"] == "TURTLE"
    )

    shrimp_count = sum(
        1 for event in started
        if event["state"] == "WAIST"
    )

    good_ratio = (
        round(durations["good"] / measured_ms * 100, 2)
        if measured_ms > 0
        else None
    )

    avg_duration = (
        seconds(bad_duration_ms / bad_event_count)
        if bad_event_count > 0
        else None
    )

    return {
        "measuredSec": seconds(measured_ms),
        "turtleCount": turtle_count,
        "shrimpCount": shrimp_count,
        "goodRatio": good_ratio,
        "avgDurationSec": avg_duration,
        "durations": durations,
        "records": records,
        "started": started
    }


# ============================================================
# 10. 홈 측정시간 조회
# GET /api/summary/home
# ============================================================

@app.get("/api/summary/home")
def home_summary():
    as_of = get_as_of()

    with db_connection() as conn:
        existing = has_records(conn, 0, as_of)

        if not existing:
            return jsonify({
                "measured_sec": None
            }), 200

        metrics = calculate_metrics(conn, 0, as_of)

    return jsonify({
        "measured_sec": metrics["measuredSec"]
    }), 200


# ============================================================
# 11. 통계 추이 생성
# ============================================================

def make_trend(start_ms, end_ms, events, period, unit):
    start_kst = datetime.fromtimestamp(start_ms / 1000, KST)
    end_kst = datetime.fromtimestamp(end_ms / 1000, KST)

    trend = {
        "turtle": [],
        "shrimp": []
    }

    if period == "today":
        # 오늘은 날짜 하나
        buckets = [
            (start_kst, end_kst, start_kst.strftime("%m/%d"))
        ]

    else:
        buckets = []
        current = start_kst

        step_days = 7 if unit == "week" else 1

        while current < end_kst:
            next_time = min(
                current + timedelta(days=step_days),
                end_kst
            )

            label = (
                current.strftime("%m/%d")
                if unit == "day"
                else (
                    current.strftime("%m/%d")
                    + "~"
                    + (next_time - timedelta(milliseconds=1)).strftime("%m/%d")
                )
            )

            buckets.append((current, next_time, label))
            current = next_time

    for bucket_start, bucket_end, label in buckets:
        left = int(bucket_start.timestamp() * 1000)
        right = int(bucket_end.timestamp() * 1000)

        turtle = 0
        shrimp = 0

        for event in events:
            started = dt_ms(event["started_at"])

            if left <= started < right:
                if event["state"] == "TURTLE":
                    turtle += 1

                elif event["state"] == "WAIST":
                    shrimp += 1

        trend["turtle"].append({
            "label": label,
            "count": turtle
        })

        trend["shrimp"].append({
            "label": label,
            "count": shrimp
        })

    return trend


# ============================================================
# 12. 기간별 통계 조회
# GET /api/stats
# ============================================================

@app.get("/api/stats")
def stats_api():
    period = request.args.get("period", "today")
    unit = request.args.get("unit", "day")

    if period not in {"today", "week", "month"}:
        fail(400, "INVALID_REQUEST", "period가 잘못되었습니다.")

    if unit not in {"day", "week"}:
        fail(400, "INVALID_REQUEST", "unit이 잘못되었습니다.")

    as_of = get_as_of()

    start, end, prev_start, prev_end = period_bounds(
        period, as_of
    )

    with db_connection() as conn:
        existing = has_records(conn, start, end)

        if not existing:
            return jsonify({
                "summary": None,
                "distribution": None,
                "trend": {
                    "turtle": [],
                    "shrimp": []
                },
                "records": []
            }), 200

        current = calculate_metrics(conn, start, end)

        previous_exists = has_records(
            conn, prev_start, prev_end
        )

        previous = (
            calculate_metrics(conn, prev_start, prev_end)
            if previous_exists
            else None
        )

    metric_names = [
        "measuredSec",
        "turtleCount",
        "shrimpCount",
        "goodRatio",
        "avgDurationSec"
    ]

    summary = {}

    for name in metric_names:
        summary[name] = {
            "value": current[name],
            "prev": previous[name] if previous else None
        }

    total_ms = sum(current["durations"].values())

    if total_ms > 0:
        items = []

        for key in ["good", "turtle", "shrimp", "other"]:
            duration = current["durations"][key]

            items.append({
                "type": key,
                "sec": seconds(duration),
                "ratio": round(duration / total_ms * 100, 2)
            })

        distribution = {
            "totalSec": seconds(total_ms),
            "items": items
        }

    else:
        distribution = None

    trend = make_trend(
        start,
        end,
        current["started"],
        period,
        unit
    )

    records = sorted(
        current["records"],
        key=lambda item: item["startedAt"],
        reverse=True
    )[:100]

    return jsonify({
        "summary": summary,
        "distribution": distribution,
        "trend": trend,
        "records": records
    }), 200


# ============================================================
# 13. 서버 실행
# ============================================================

if __name__ == "__main__":
    try:
        init_db()
        print("MariaDB 연결 및 테이블 확인 완료", flush=True)

    except Exception:
        print("\nDB 초기화 중 오류 발생", flush=True)
        traceback.print_exc()
        raise

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )
