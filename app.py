
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import MySQLdb
import MySQLdb.cursors
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv(Path(__file__).resolve().parent / ".env")

app = Flask(__name__)

KST = ZoneInfo("Asia/Seoul")
UTC = timezone.utc

ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173"
}

STATES = [
    ("GOOD", "바른 자세", 1, 0),
    ("TURTLE", "거북목", 1, 1),
    ("WAIST", "새우등", 1, 1),
    ("CLOSE", "화면에 가까움", 1, 0),
    ("NOVIS", "인식 불가", 0, 0),
    ("CALIB", "초기 자세 설정", 0, 0),
    ("IDLE", "대기", 0, 0)
]

VALID_STATES = {x[0] for x in STATES}
COUNTED = {"GOOD", "TURTLE", "WAIST", "CLOSE"}


# -------------------------------------------
# 1. MariaDB 연결 및 초기화
# -------------------------------------------

def get_db():
    db = MySQLdb.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        passwd=os.getenv("DB_PASSWORD", ""),
        db=os.getenv("DB_NAME", "turtle_bump"),
        charset="utf8mb4",
        cursorclass=MySQLdb.cursors.DictCursor,
        autocommit=False
    )

    with db.cursor() as cur:
        cur.execute("SET time_zone = '+00:00'")

    return db


def init_db():
    db = get_db()

    try:
        with db.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id INT AUTO_INCREMENT PRIMARY KEY,
                    started_at DATETIME(3) NOT NULL,
                    ended_at DATETIME(3) NULL,
                    total_duration_sec INT NOT NULL DEFAULT 0,
                    valid_duration_sec INT NOT NULL DEFAULT 0
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS posture_states (
                    state VARCHAR(32) PRIMARY KEY,
                    label VARCHAR(32) NOT NULL,
                    is_counted BOOLEAN NOT NULL,
                    is_alert BOOLEAN NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS posture_events (
                    event_id CHAR(36) PRIMARY KEY,
                    session_id INT NOT NULL,
                    state VARCHAR(32) NOT NULL,
                    started_at DATETIME(3) NOT NULL,
                    ended_at DATETIME(3) NULL,
                    duration_sec FLOAT NOT NULL DEFAULT 0,
                    alert_triggered BOOLEAN NOT NULL DEFAULT 0,
                    INDEX idx_events_session (session_id),
                    FOREIGN KEY (session_id)
                        REFERENCES sessions(session_id),
                    FOREIGN KEY (state)
                        REFERENCES posture_states(state)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            cur.executemany("""
                INSERT INTO posture_states
                (state, label, is_counted, is_alert)
                VALUES (%s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    label=VALUES(label),
                    is_counted=VALUES(is_counted),
                    is_alert=VALUES(is_alert)
            """, STATES)

        db.commit()

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# -------------------------------------------
# 2. 공통 시간 및 오류 처리
# -------------------------------------------

def now_ms():
    return int(time.time() * 1000)


def parse_ms(value, name):
    if (
        type(value) is not int
        or value < 0
        or value > 32503680000000
    ):
        raise ValueError(
            f"{name}은 epoch 밀리초 정수여야 합니다."
        )

    return value


def utc_dt(ms):
    return datetime.fromtimestamp(
        ms / 1000, UTC
    ).replace(tzinfo=None)


def epoch_ms(dt):
    return int(
        dt.replace(tzinfo=UTC).timestamp() * 1000
    )


def body_json():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        raise ValueError("JSON 객체가 필요합니다.")

    return data


class APIError(Exception):
    def __init__(self, status, reason, message):
        super().__init__(message)
        self.status = status
        self.reason = reason


@app.errorhandler(APIError)
def handle_api_error(error):
    return jsonify({
        "ok": False,
        "error": {
            "code": error.status,
            "reason": error.reason,
            "message": str(error)
        }
    }), error.status


@app.errorhandler(ValueError)
def handle_value_error(error):
    return jsonify({
        "ok": False,
        "error": {
            "code": 400,
            "reason": "INVALID_REQUEST",
            "message": str(error)
        }
    }), 400


@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin")

    if origin in ORIGINS:
        response.headers[
            "Access-Control-Allow-Origin"
        ] = origin

        response.headers["Vary"] = "Origin"

        response.headers[
            "Access-Control-Allow-Headers"
        ] = "Content-Type"

        response.headers[
            "Access-Control-Allow-Methods"
        ] = "GET,POST,OPTIONS"

    return response


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        return "", 204


# -------------------------------------------
# 3. 이벤트 입력 검증
# -------------------------------------------

def prepare_events(raw):
    if not isinstance(raw, list) or len(raw) > 500:
        raise ValueError(
            "events는 최대 500개 배열이어야 합니다."
        )

    events = []

    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("이벤트는 객체여야 합니다.")

        try:
            event_id = str(uuid.UUID(item["event_id"]))
            state = item["state"]
            start = parse_ms(
                item["started_at_ms"],
                "started_at_ms"
            )
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError(
                "필수 이벤트 필드가 올바르지 않습니다."
            ) from exc

        if state not in VALID_STATES:
            raise ValueError("허용되지 않은 자세 상태입니다.")

        raw_end = item.get("ended_at_ms")

        end = (
            None if raw_end is None
            else parse_ms(raw_end, "ended_at_ms")
        )

        if end is not None and end < start:
            raise ValueError(
                "종료 시각이 시작 시각보다 빠릅니다."
            )

        alert = item.get("alert_triggered", False)

        if type(alert) is not bool:
            raise ValueError(
                "alert_triggered는 boolean이어야 합니다."
            )

        events.append({
            "id": event_id,
            "state": state,
            "start": start,
            "end": end,
            "alert": int(alert)
        })

    return events


# -------------------------------------------
# 4. 이벤트 구간 겹침 검사
# -------------------------------------------

def validate_overlaps(cur, session_id):
    cur.execute("""
        SELECT event_id, started_at, ended_at
        FROM posture_events
        WHERE session_id=%s
        ORDER BY started_at, event_id
    """, (session_id,))

    rows = cur.fetchall()

    previous_end = None

    for row in rows:
        start = epoch_ms(row["started_at"])
        end = (
            epoch_ms(row["ended_at"])
            if row["ended_at"] is not None
            else None
        )

        if previous_end is not None:
            if start < previous_end:
                raise APIError(
                    409,
                    "EVENT_OVERLAP",
                    "자세 이벤트 시간이 서로 겹칩니다."
                )

        # 열린 이벤트는 아직 관측된 시간이 없으므로
        # 이후 구간의 겹침은 종료 시 다시 검증한다.
        if end is not None:
            previous_end = end


# -------------------------------------------
# 5. UUID 기준 INSERT / UPDATE
# -------------------------------------------

def upsert_events(
    cur,
    session_id,
    session_start,
    session_end,
    events
):
    saved = 0
    updated = 0
    ignored = 0

    for event in events:
        start = event["start"]
        end = event["end"]

        if (
            start < session_start
            or (
                session_end is not None
                and (
                    start > session_end
                    or (
                        end is not None
                        and end > session_end
                    )
                )
            )
        ):
            raise APIError(
                409,
                "EVENT_OUT_OF_RANGE",
                "이벤트가 세션 범위를 벗어났습니다."
            )

        cur.execute("""
            SELECT *
            FROM posture_events
            WHERE event_id=%s
            FOR UPDATE
        """, (event["id"],))

        old = cur.fetchone()

        if old is None:
            cur.execute("""
                INSERT INTO posture_events (
                    event_id,
                    session_id,
                    state,
                    started_at,
                    ended_at,
                    duration_sec,
                    alert_triggered
                )
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (
                event["id"],
                session_id,
                event["state"],
                utc_dt(start),
                utc_dt(end) if end is not None else None,
                round((end - start) / 1000, 3)
                    if end is not None else 0,
                event["alert"]
            ))

            saved += 1
            continue

        if (
            old["session_id"] != session_id
            or old["state"] != event["state"]
            or epoch_ms(old["started_at"]) != start
        ):
            raise APIError(
                409,
                "EVENT_ID_CONFLICT",
                "UUID가 다른 자세 구간에 사용됐습니다."
            )

        old_end = (
            epoch_ms(old["ended_at"])
            if old["ended_at"] is not None
            else None
        )

        if old_end is None:
            new_end = end
        elif end is None:
            new_end = old_end
        else:
            new_end = max(old_end, end)

        new_alert = int(
            bool(old["alert_triggered"] or event["alert"])
        )

        if (
            new_end == old_end
            and new_alert == int(old["alert_triggered"])
        ):
            ignored += 1
            continue

        cur.execute("""
            UPDATE posture_events
            SET
                ended_at=%s,
                duration_sec=%s,
                alert_triggered=%s
            WHERE event_id=%s
        """, (
            utc_dt(new_end)
                if new_end is not None else None,
            round((new_end - start) / 1000, 3)
                if new_end is not None else 0,
            new_alert,
            event["id"]
        ))

        updated += 1

    validate_overlaps(cur, session_id)

    return saved, updated, ignored


# -------------------------------------------
# 6. API 1 : 세션 생성
# -------------------------------------------

@app.post("/api/sessions")
def create_session():
    data = body_json()

    started = parse_ms(
        data.get("started_at_ms", now_ms()),
        "started_at_ms"
    )

    if started > now_ms() + 60000:
        raise ValueError("시작 시각이 미래입니다.")

    db = get_db()

    try:
        with db.cursor() as cur:
            cur.execute("""
                INSERT INTO sessions (started_at)
                VALUES (%s)
            """, (utc_dt(started),))

            session_id = cur.lastrowid

        db.commit()

        return jsonify({
            "session_id": session_id,
            "started_at_ms": started
        }), 201

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# -------------------------------------------
# 7. API 2 : 자세 이벤트 저장
# -------------------------------------------

@app.post("/api/sessions/<int:session_id>/events")
def save_posture_events(session_id):
    data = body_json()
    events = prepare_events(data.get("events"))

    db = get_db()

    try:
        with db.cursor() as cur:
            # 같은 세션에 대한 동시 요청 잠금
            cur.execute("""
                SELECT *
                FROM sessions
                WHERE session_id=%s
                FOR UPDATE
            """, (session_id,))

            session = cur.fetchone()

            if session is None:
                raise APIError(
                    404,
                    "SESSION_NOT_FOUND",
                    "세션이 존재하지 않습니다."
                )

            if session["ended_at"] is not None:
                raise APIError(
                    409,
                    "SESSION_CLOSED",
                    "이미 종료된 세션입니다."
                )

            saved, updated, ignored = upsert_events(
                cur,
                session_id,
                epoch_ms(session["started_at"]),
                None,
                events
            )

        db.commit()

        return jsonify({
            "ok": True,
            "received_count": len(events),
            "saved": saved,
            "updated": updated,
            "ignored": ignored
        })

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# -------------------------------------------
# 8. API 3 : 세션 종료
# -------------------------------------------

@app.post("/api/sessions/<int:session_id>/end")
def end_monitoring(session_id):
    data = body_json()

    ended = parse_ms(
        data.get("ended_at_ms", now_ms()),
        "ended_at_ms"
    )

    reason = data.get("reason", "camera_off")

    if reason not in {
        "camera_off",
        "pagehide",
        "input_ended"
    }:
        raise ValueError("종료 사유가 올바르지 않습니다.")

    db = get_db()

    try:
        with db.cursor() as cur:
            cur.execute("""
                SELECT *
                FROM sessions
                WHERE session_id=%s
                FOR UPDATE
            """, (session_id,))

            session = cur.fetchone()

            if session is None:
                raise APIError(
                    404,
                    "SESSION_NOT_FOUND",
                    "세션이 존재하지 않습니다."
                )

            # 이미 종료됐다면 기존 결과 그대로 반환
            if session["ended_at"] is None:
                started = epoch_ms(session["started_at"])

                if ended < started:
                    raise ValueError(
                        "종료 시각이 시작보다 빠릅니다."
                    )

                events = prepare_events(
                    data.get("events", [])
                )

                upsert_events(
                    cur,
                    session_id,
                    started,
                    ended,
                    events
                )

                cur.execute("""
                    SELECT event_id, started_at, ended_at
                    FROM posture_events
                    WHERE session_id=%s
                    ORDER BY started_at, event_id
                    FOR UPDATE
                """, (session_id,))

                rows = cur.fetchall()

                # NULL 이벤트는 다음 이벤트 시작 시각,
                # 마지막 이벤트는 세션 종료 시각에 마감
                for i, row in enumerate(rows):
                    start = epoch_ms(row["started_at"])

                    next_start = (
                        epoch_ms(rows[i + 1]["started_at"])
                        if i + 1 < len(rows)
                        else ended
                    )

                    if row["ended_at"] is None:
                        if next_start < start:
                            raise APIError(
                                409,
                                "EVENT_OVERLAP",
                                "이벤트 시간 순서가 잘못됐습니다."
                            )

                        cur.execute("""
                            UPDATE posture_events
                            SET ended_at=%s, duration_sec=%s
                            WHERE event_id=%s
                        """, (
                            utc_dt(next_start),
                            round((next_start - start) / 1000, 3),
                            row["event_id"]
                        ))

                    elif epoch_ms(row["ended_at"]) > ended:
                        raise APIError(
                            409,
                            "EVENT_OUT_OF_RANGE",
                            "세션 종료 이후의 이벤트입니다."
                        )

                validate_overlaps(cur, session_id)

                cur.execute("""
                    SELECT COALESCE(
                        SUM(e.duration_sec), 0
                    ) AS valid
                    FROM posture_events e
                    JOIN posture_states s
                        ON e.state=s.state
                    WHERE e.session_id=%s
                    AND s.is_counted=1
                """, (session_id,))

                valid = float(cur.fetchone()["valid"])
                total = (ended - started) // 1000

                cur.execute("""
                    UPDATE sessions
                    SET
                        ended_at=%s,
                        total_duration_sec=%s,
                        valid_duration_sec=%s
                    WHERE session_id=%s
                """, (
                    utc_dt(ended),
                    total,
                    round(valid),
                    session_id
                ))

            cur.execute("""
                SELECT *
                FROM sessions
                WHERE session_id=%s
            """, (session_id,))

            result = cur.fetchone()

        db.commit()

        return jsonify({
            "ok": True,
            "session_id": session_id,
            "ended_at_ms": epoch_ms(result["ended_at"]),
            "total_duration_sec": result["total_duration_sec"],
            "valid_duration_sec": result["valid_duration_sec"]
        })

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# -------------------------------------------
# 9. 통계 기간 계산
# -------------------------------------------

def period_bounds(period, as_of):
    current = datetime.fromtimestamp(
        as_of / 1000, KST
    )

    midnight = current.replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    if period == "today":
        start = midnight
        previous = start - timedelta(days=1)

    elif period in ("week", "month"):
        days = 7 if period == "week" else 30
        start = midnight - timedelta(days=days - 1)
        previous = start - timedelta(days=days)

    else:
        raise ValueError(
            "period는 today, week, month만 허용합니다."
        )

    return (
        int(start.timestamp() * 1000),
        int(previous.timestamp() * 1000)
    )


def get_as_of():
    raw = request.args.get("as_of_ms")

    if raw is None:
        return now_ms()

    try:
        value = int(raw)
    except ValueError:
        raise ValueError(
            "as_of_ms는 밀리초 정수여야 합니다."
        )

    return parse_ms(value, "as_of_ms")


# -------------------------------------------
# 10. 기간에 걸친 이벤트 조회
# -------------------------------------------

def load_events(db, start, end):
    if end <= start:
        return []

    with db.cursor() as cur:
        cur.execute("""
            SELECT
                event_id,
                state,
                started_at,
                ended_at
            FROM posture_events
            WHERE ended_at IS NOT NULL
              AND started_at < %s
              AND ended_at > %s
            ORDER BY started_at, event_id
        """, (
            utc_dt(end),
            utc_dt(start)
        ))

        rows = cur.fetchall()

    result = []

    for row in rows:
        a = epoch_ms(row["started_at"])
        b = epoch_ms(row["ended_at"])

        overlap = max(
            0,
            min(b, end) - max(a, start)
        ) / 1000

        if overlap > 0:
            result.append({
                "id": row["event_id"],
                "state": row["state"],
                "started_ms": a,
                "ended_ms": b,
                "duration_sec": overlap
            })

    return result


def aggregate(events, start, end):
    seconds = {
        state: 0.0 for state in VALID_STATES
    }

    turtle_count = 0
    shrimp_count = 0
    bad_durations = []

    for event in events:
        state = event["state"]
        seconds[state] += event["duration_sec"]

        if start <= event["started_ms"] < end:
            if state == "TURTLE":
                turtle_count += 1
                bad_durations.append(
                    event["duration_sec"]
                )

            elif state == "WAIST":
                shrimp_count += 1
                bad_durations.append(
                    event["duration_sec"]
                )

    measured = sum(
        seconds[state] for state in COUNTED
    )

    return {
        "seconds": seconds,
        "measuredSec": measured,
        "turtleCount": turtle_count,
        "shrimpCount": shrimp_count,
        "goodRatio": (
            seconds["GOOD"] / measured * 100
            if measured > 0 else None
        ),
        "avgDurationSec": (
            sum(bad_durations) / len(bad_durations)
            if bad_durations else None
        )
    }


def round_value(value):
    if value is None:
        return None

    return round(float(value), 2)


# -------------------------------------------
# 11. API 4 : 홈 누적 측정 시간
# -------------------------------------------

@app.get("/api/summary/home")
def home_summary():
    as_of = get_as_of()
    db = get_db()

    try:
        events = load_events(db, 0, as_of)
    finally:
        db.close()

    counted = [
        e for e in events
        if e["state"] in COUNTED
    ]

    measured = (
        round(sum(e["duration_sec"] for e in counted))
        if counted else None
    )

    return jsonify({
        "measured_sec": measured
    })


# -------------------------------------------
# 12. API 5 : 기간별 통계
# -------------------------------------------

@app.get("/api/stats")
def get_statistics():
    period = request.args.get("period", "today")
    unit = request.args.get("unit", "day")

    if unit not in ("day", "week"):
        raise ValueError(
            "unit은 day 또는 week만 허용합니다."
        )

    as_of = get_as_of()
    start, previous_start = period_bounds(
        period, as_of
    )

    db = get_db()

    try:
        current_events = load_events(
            db, start, as_of
        )

        previous_events = load_events(
            db, previous_start, start
        )
    finally:
        db.close()

    if not any(
        e["state"] in COUNTED
        for e in current_events
    ):
        return jsonify({
            "summary": None,
            "trend": {
                "turtle": [],
                "shrimp": []
            },
            "distribution": None,
            "records": []
        })

    current = aggregate(
        current_events, start, as_of
    )

    previous = aggregate(
        previous_events, previous_start, start
    )

    def metric(key):
        return {
            "value": round_value(current[key]),
            "prev": (
                round_value(previous[key])
                if previous_events else None
            )
        }

    summary = {
        key: metric(key)
        for key in (
            "measuredSec",
            "turtleCount",
            "shrimpCount",
            "goodRatio",
            "avgDurationSec"
        )
    }

    # 일별/주별 거북목 및 새우등 횟수
    buckets = {}

    for event in current_events:
        if event["state"] not in ("TURTLE", "WAIST"):
            continue

        if not start <= event["started_ms"] < as_of:
            continue

        dt = datetime.fromtimestamp(
            event["started_ms"] / 1000, KST
        )

        if unit == "day":
            key = dt.date().isoformat()
        else:
            key = (
                dt.date() -
                timedelta(days=dt.weekday())
            ).isoformat()

        bucket = buckets.setdefault(
            key, {"turtle": 0, "shrimp": 0}
        )

        kind = (
            "turtle"
            if event["state"] == "TURTLE"
            else "shrimp"
        )

        bucket[kind] += 1

    # 기록이 없는 날짜도 0으로 채움
    trend_keys = []

    cursor = datetime.fromtimestamp(
        start / 1000, KST
    ).date()

    last = datetime.fromtimestamp(
        as_of / 1000, KST
    ).date()

    while cursor <= last:
        if unit == "day":
            key = cursor.isoformat()
        else:
            key = (
                cursor -
                timedelta(days=cursor.weekday())
            ).isoformat()

        if key not in trend_keys:
            trend_keys.append(key)

        cursor += timedelta(days=1)

    trend = {
        kind: [
            {
                "label": key[5:].replace("-", "/"),
                "count": buckets.get(
                    key, {}
                ).get(kind, 0)
            }
            for key in trend_keys
        ]
        for kind in ("turtle", "shrimp")
    }

    total = current["measuredSec"]

    mapping = [
        ("good", "GOOD"),
        ("turtle", "TURTLE"),
        ("shrimp", "WAIST"),
        ("other", "CLOSE")
    ]

    distribution = {
        "totalSec": round_value(total),
        "items": [
            {
                "type": label,
                "sec": round_value(
                    current["seconds"][state]
                ),
                "ratio": round_value(
                    current["seconds"][state] / total * 100
                )
            }
            for label, state in mapping
        ]
    }

    type_map = {
        "GOOD": "good",
        "TURTLE": "turtle",
        "WAIST": "shrimp"
    }

    records = [
        {
            "id": e["id"],
            "startedAt": e["started_ms"],
            "type": type_map[e["state"]],
            "durationSec": round_value(
                e["duration_sec"]
            )
        }
        for e in sorted(
            current_events,
            key=lambda x: (
                -x["started_ms"], x["id"]
            )
        )
        if (
            e["state"] in type_map
            and start <= e["started_ms"] < as_of
        )
    ][:100]

    return jsonify({
        "summary": summary,
        "trend": trend,
        "distribution": distribution,
        "records": records
    })


# -------------------------------------------
# 13. 서버 실행
# -------------------------------------------

if __name__ == "__main__":
    init_db()

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )
