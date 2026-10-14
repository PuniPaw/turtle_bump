
"""
app.py
NeckCare API v0.3.2

D 담당
- Flask API
- MariaDB 저장
- 이벤트 중복 검증
- 기간별 통계 계산

실행:
    pip install flask mysqlclient python-dotenv
    python app.py
"""

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


# ==========================================
# 1. 기본 환경 설정
# ==========================================

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

app = Flask(__name__)

KST = ZoneInfo("Asia/Seoul")
UTC = timezone.utc

ALLOWED_ORIGINS = {
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

VALID_STATES = {row[0] for row in STATES}

COUNTED_STATES = {
    "GOOD", "TURTLE", "WAIST", "CLOSE"
}

BAD_STATES = {"TURTLE", "WAIST"}

TYPE_MAP = {
    "GOOD": "good",
    "TURTLE": "turtle",
    "WAIST": "shrimp",
    "CLOSE": "other"
}


# ==========================================
# 2. DB 연결
# ==========================================

def get_db():
    """MariaDB 연결 후 시간대를 UTC로 고정한다."""

    password = os.getenv("DB_PASSWORD")

    if not password:
        raise RuntimeError(
            ".env 파일의 DB_PASSWORD를 확인하세요."
        )

    db = MySQLdb.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        passwd=password,
        db=os.getenv("DB_NAME", "turtle_bump"),
        charset="utf8mb4",
        cursorclass=MySQLdb.cursors.DictCursor,
        autocommit=False
    )

    with db.cursor() as cur:
        cur.execute("SET time_zone = '+00:00'")

    return db


def init_db():
    """
    없는 테이블만 생성한다.
    기존 테이블 및 데이터는 삭제하지 않는다.

    주의:
    CREATE TABLE IF NOT EXISTS는
    기존 테이블의 컬럼 구조를 변경하지 않는다.
    """

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
                ) ENGINE=InnoDB
                DEFAULT CHARSET=utf8mb4
            """)

            cur.execute("""
                CREATE TABLE IF NOT EXISTS posture_states (
                    state VARCHAR(32) PRIMARY KEY,
                    label VARCHAR(32) NOT NULL,
                    is_counted BOOLEAN NOT NULL,
                    is_alert BOOLEAN NOT NULL
                ) ENGINE=InnoDB
                DEFAULT CHARSET=utf8mb4
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
                ) ENGINE=InnoDB
                DEFAULT CHARSET=utf8mb4
            """)

            # 이미 존재하는 자세 코드는 변경하지 않음
            cur.executemany("""
                INSERT IGNORE INTO posture_states
                (state, label, is_counted, is_alert)
                VALUES (%s, %s, %s, %s)
            """, STATES)

        db.commit()

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# ==========================================
# 3. 시간 변환
# ==========================================

def now_ms():
    """현재 Unix 밀리초."""
    return int(time.time() * 1000)


def parse_ms(value, field):
    """밀리초 값의 형식을 검사한다."""

    if (
        type(value) is not int
        or value < 0
        or value > 32503680000000
    ):
        raise ValueError(
            f"{field}은 유효한 밀리초 정수여야 합니다."
        )

    return value


def utc_dt(ms):
    """epoch ms -> MariaDB UTC DATETIME."""

    return datetime.fromtimestamp(
        ms / 1000, UTC
    ).replace(tzinfo=None)


def epoch_ms(dt):
    """MariaDB UTC DATETIME -> epoch ms."""

    return int(
        dt.replace(tzinfo=UTC).timestamp() * 1000
    )


def to_kst(ms):
    """epoch ms -> 한국 시간."""

    return datetime.fromtimestamp(ms / 1000, KST)


# ==========================================
# 4. 공통 요청 및 오류 처리
# ==========================================

class ApiError(Exception):
    def __init__(self, reason, message, status=400):
        self.reason = reason
        self.message = message
        self.status = status
        super().__init__(message)


def invalid(message):
    raise ApiError("INVALID_REQUEST", message, 400)


def conflict(reason, message):
    raise ApiError(reason, message, 409)


def body_json():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        invalid("JSON 객체를 보내야 합니다.")

    return data


def error_response(error):
    return jsonify({
        "ok": False,
        "error": {
            "code": error.status,
            "message": error.message,
            "reason": error.reason
        }
    }), error.status


@app.errorhandler(ApiError)
def handle_api_error(error):
    return error_response(error)


@app.errorhandler(500)
def handle_internal_error(error):
    # 내부 SQL 오류 등을 사용자에게 노출하지 않음
    app.logger.exception("서버 내부 오류")

    return jsonify({
        "ok": False,
        "error": {
            "code": 500,
            "message": "서버 내부 오류가 발생했습니다.",
            "reason": "INTERNAL_ERROR"
        }
    }), 500


# C 프론트엔드에서 Flask를 호출할 수 있도록 설정
@app.after_request
def cors(response):
    origin = request.headers.get("Origin")

    if origin in ALLOWED_ORIGINS:
        response.headers[
            "Access-Control-Allow-Origin"
        ] = origin

        response.headers["Vary"] = "Origin"
        response.headers[
            "Access-Control-Allow-Methods"
        ] = "GET,POST,OPTIONS"

        response.headers[
            "Access-Control-Allow-Headers"
        ] = "Content-Type"

    return response


@app.before_request
def preflight():
    if request.method == "OPTIONS":
        return "", 204


# ==========================================
# 5. API 1: 세션 생성
# ==========================================

@app.post("/api/sessions")
def create_session():

    data = body_json()

    started = parse_ms(
        data.get("started_at_ms", now_ms()),
        "started_at_ms"
    )

    if started > now_ms() + 60000:
        invalid("시작 시각이 너무 미래입니다.")

    db = get_db()

    try:
        with db.cursor() as cur:
            cur.execute("""
                INSERT INTO sessions (started_at)
                VALUES (%s)
            """, (utc_dt(started),))

            session_id = cur.lastrowid

        db.commit()

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()

    return jsonify({
        "session_id": session_id,
        "started_at_ms": started
    }), 201


# ==========================================
# 6. 이벤트 데이터 검증
# ==========================================

def prepare_events(raw_events):
    """프론트에서 받은 이벤트를 검증한다."""

    if (
        not isinstance(raw_events, list)
        or len(raw_events) > 500
    ):
        invalid("events는 최대 500개 배열이어야 합니다.")

    prepared = []

    for event in raw_events:

        if not isinstance(event, dict):
            invalid("각 이벤트는 JSON 객체여야 합니다.")

        try:
            event_id = str(uuid.UUID(event["event_id"]))
            state = event["state"]

            started = parse_ms(
                event["started_at_ms"],
                "started_at_ms"
            )

        except (KeyError, ValueError, TypeError, AttributeError):
            invalid("이벤트 필수 항목이 올바르지 않습니다.")

        if not isinstance(state, str) or state not in VALID_STATES:
            invalid("허용되지 않은 자세 상태입니다.")

        raw_end = event.get("ended_at_ms")

        ended = (
            None if raw_end is None
            else parse_ms(raw_end, "ended_at_ms")
        )

        if ended is not None and ended < started:
            invalid("이벤트 종료가 시작보다 빠릅니다.")

        alert = event.get("alert_triggered")

        if type(alert) is not bool:
            invalid("alert_triggered는 Boolean이어야 합니다.")

        prepared.append({
            "id": event_id,
            "state": state,
            "start": started,
            "end": ended,
            "alert": int(alert)
        })

    return prepared


# ==========================================
# 7. 이벤트 시간 중복 검증
# ==========================================

def validate_overlaps(cur, session_id):
    """
    동일 세션의 서로 다른 이벤트가
    같은 시간에 겹치는지 확인한다.

    NULL은 아직 끝이 확정되지 않은 상태다.
    확정된 구간과 다음 시작 시각을 비교한다.
    """

    cur.execute("""
        SELECT event_id, started_at, ended_at
        FROM posture_events
        WHERE session_id = %s
        ORDER BY started_at, event_id
    """, (session_id,))

    rows = cur.fetchall()

    previous_start = None
    previous_end = None

    for row in rows:
        start = epoch_ms(row["started_at"])

        end = (
            epoch_ms(row["ended_at"])
            if row["ended_at"] is not None
            else None
        )

        # 서로 다른 이벤트의 시작 시각이 같으면 충돌
        if previous_start is not None and start == previous_start:
            conflict(
                "EVENT_OVERLAP",
                "서로 다른 이벤트의 시작 시각이 같습니다."
            )

        # 이전 확정 구간이 현재 시작 시각과 겹치는 경우
        if previous_end is not None and start < previous_end:
            conflict(
                "EVENT_OVERLAP",
                "자세 이벤트 시간이 겹칩니다."
            )

        previous_start = start
        previous_end = end


# ==========================================
# 8. UUID 기준 INSERT / UPDATE
# ==========================================

def upsert_events(
    cur,
    session_id,
    session_start,
    session_end,
    events
):
    """
    동일 UUID는 새 행을 만들지 않는다.

    - 종료 시각은 더 늦은 값 유지
    - 경고 true는 유지
    - 다른 state/start/session이면 409
    """

    saved = 0
    updated = 0
    ignored = 0

    for event in events:

        start = event["start"]
        end = event["end"]

        if start < session_start:
            conflict(
                "EVENT_OUT_OF_RANGE",
                "이벤트가 세션 시작보다 빠릅니다."
            )

        if session_end is not None:
            if (
                start > session_end
                or (end is not None and end > session_end)
            ):
                conflict(
                    "EVENT_OUT_OF_RANGE",
                    "이벤트가 세션 종료 이후입니다."
                )

        cur.execute("""
            SELECT *
            FROM posture_events
            WHERE event_id = %s
            FOR UPDATE
        """, (event["id"],))

        old = cur.fetchone()

        if old is None:
            # 새로운 UUID: INSERT
            cur.execute("""
                INSERT INTO posture_events
                (
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

        else:
            # 기존 UUID의 고정 정보 확인
            if (
                old["session_id"] != session_id
                or old["state"] != event["state"]
                or epoch_ms(old["started_at"]) != start
            ):
                conflict(
                    "EVENT_ID_CONFLICT",
                    "동일 UUID가 다른 자세 구간에 사용됐습니다."
                )

            old_end = (
                epoch_ms(old["ended_at"])
                if old["ended_at"] is not None
                else None
            )

            # NULL 재전송으로 기존 종료 시각을 지우지 않음
            if old_end is None:
                new_end = end
            elif end is None:
                new_end = old_end
            else:
                new_end = max(old_end, end)

            # 실제 경고 발생 이력은 OR 처리
            new_alert = int(
                bool(old["alert_triggered"] or event["alert"])
            )

            if (
                new_end != old_end
                or new_alert != int(old["alert_triggered"])
            ):
                cur.execute("""
                    UPDATE posture_events
                    SET
                        ended_at = %s,
                        duration_sec = %s,
                        alert_triggered = %s
                    WHERE event_id = %s
                """, (
                    utc_dt(new_end)
                        if new_end is not None else None,
                    round((new_end - start) / 1000, 3)
                        if new_end is not None else 0,
                    new_alert,
                    event["id"]
                ))

                updated += 1
            else:
                ignored += 1

    validate_overlaps(cur, session_id)

    return saved, updated, ignored


# ==========================================
# 9. API 2: 이벤트 저장
# ==========================================

@app.post("/api/sessions/<int:session_id>/events")
def save_events_api(session_id):

    data = body_json()
    events = prepare_events(data.get("events"))

    db = get_db()

    try:
        with db.cursor() as cur:

            # 세션 행 잠금: /end와 충돌 방지
            cur.execute("""
                SELECT *
                FROM sessions
                WHERE session_id = %s
                FOR UPDATE
            """, (session_id,))

            session = cur.fetchone()

            if session is None:
                raise ApiError(
                    "SESSION_NOT_FOUND",
                    "세션이 존재하지 않습니다.",
                    404
                )

            if session["ended_at"] is not None:
                conflict(
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

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()

    return jsonify({
        "ok": True,
        "received_count": len(events),
        "saved": saved,
        "updated": updated,
        "ignored": ignored
    })


# ==========================================
# 10. API 3: 세션 종료
# ==========================================

@app.post("/api/sessions/<int:session_id>/end")
def end_session_api(session_id):

    data = body_json()

    ended = parse_ms(
        data.get("ended_at_ms"),
        "ended_at_ms"
    )

    reason = data.get("reason")

    if reason not in {
        "camera_off", "pagehide", "input_ended"
    }:
        invalid("종료 사유가 올바르지 않습니다.")

    db = get_db()

    try:
        with db.cursor() as cur:

            cur.execute("""
                SELECT *
                FROM sessions
                WHERE session_id = %s
                FOR UPDATE
            """, (session_id,))

            session = cur.fetchone()

            if session is None:
                raise ApiError(
                    "SESSION_NOT_FOUND",
                    "세션이 존재하지 않습니다.",
                    404
                )

            # 이미 종료됐다면 기존 결과만 반환
            if session["ended_at"] is None:

                events = prepare_events(
                    data.get("events", [])
                )

                started = epoch_ms(session["started_at"])

                if ended < started:
                    invalid("종료 시각이 시작보다 빠릅니다.")

                # 종료 요청에 동봉한 마지막 이벤트 저장
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
                    WHERE session_id = %s
                    ORDER BY started_at, event_id
                    FOR UPDATE
                """, (session_id,))

                rows = cur.fetchall()

                for i, row in enumerate(rows):

                    event_start = epoch_ms(
                        row["started_at"]
                    )

                    # 다음 이벤트가 있으면 다음 시작 시각,
                    # 마지막 이벤트면 세션 종료 시각을 상한으로 사용
                    if i + 1 < len(rows):
                        limit = epoch_ms(
                            rows[i + 1]["started_at"]
                        )
                    else:
                        limit = ended

                    limit = min(limit, ended)

                    if event_start > ended:
                        conflict(
                            "EVENT_OUT_OF_RANGE",
                            "세션 종료 이후 시작한 이벤트입니다."
                        )

                    if row["ended_at"] is None:
                        # NULL 이벤트의 종료 시각 확정
                        if limit < event_start:
                            conflict(
                                "EVENT_OUT_OF_RANGE",
                                "이벤트 시간 범위가 잘못됐습니다."
                            )

                        cur.execute("""
                            UPDATE posture_events
                            SET
                                ended_at = %s,
                                duration_sec = %s
                            WHERE event_id = %s
                        """, (
                            utc_dt(limit),
                            round(
                                (limit - event_start) / 1000,
                                3
                            ),
                            row["event_id"]
                        ))

                    elif epoch_ms(row["ended_at"]) > ended:
                        conflict(
                            "EVENT_OUT_OF_RANGE",
                            "이벤트 종료가 세션 종료보다 늦습니다."
                        )

                # 최종 종료 시각으로 다시 중복 검사
                validate_overlaps(cur, session_id)

                # 유효 자세 시간 합산
                cur.execute("""
                    SELECT
                        COALESCE(SUM(e.duration_sec), 0)
                            AS valid_seconds
                    FROM posture_events e
                    JOIN posture_states s
                      ON s.state = e.state
                    WHERE e.session_id = %s
                      AND s.is_counted = 1
                """, (session_id,))

                valid_seconds = float(
                    cur.fetchone()["valid_seconds"]
                )

                total_seconds = (ended - started) // 1000

                cur.execute("""
                    UPDATE sessions
                    SET
                        ended_at = %s,
                        total_duration_sec = %s,
                        valid_duration_sec = %s
                    WHERE session_id = %s
                """, (
                    utc_dt(ended),
                    total_seconds,
                    round(valid_seconds),
                    session_id
                ))

            # 최초 종료 결과를 다시 조회
            cur.execute("""
                SELECT *
                FROM sessions
                WHERE session_id = %s
            """, (session_id,))

            result = cur.fetchone()

        db.commit()

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()

    return jsonify({
        "ok": True,
        "session_id": session_id,
        "ended_at_ms": epoch_ms(result["ended_at"]),
        "total_duration_sec": result["total_duration_sec"],
        "valid_duration_sec": result["valid_duration_sec"]
    })


# ==========================================
# 11. 기간 계산
# ==========================================

def period_bounds(period, as_of):
    """
    조회 기간과 이전 비교 기간을 계산한다.

    today:
        오늘 00:00 ~ 현재
        전날 00:00 ~ 전날 같은 시각

    week:
        오늘 포함 최근 7일
        직전 7일

    month:
        오늘 포함 최근 30일
        직전 30일
    """

    current = to_kst(as_of)

    midnight = current.replace(
        hour=0,
        minute=0,
        second=0,
        microsecond=0
    )

    if period == "today":
        start = midnight
        prev_start = start - timedelta(days=1)
        prev_end = current - timedelta(days=1)

    elif period == "week":
        start = midnight - timedelta(days=6)
        prev_start = start - timedelta(days=7)
        prev_end = start

    elif period == "month":
        start = midnight - timedelta(days=29)
        prev_start = start - timedelta(days=30)
        prev_end = start

    else:
        invalid("period는 today, week, month만 가능합니다.")

    return (
        int(start.timestamp() * 1000),
        int(prev_start.timestamp() * 1000),
        int(prev_end.timestamp() * 1000)
    )


# ==========================================
# 12. DB에서 이벤트 조회
# ==========================================

def load_events(db, start, end):
    """
    조회 기간과 겹치는 확정 관측 구간을 가져온다.

    진행 중 자세도 C가 스냅샷을 저장했다면
    ended_at 값이 존재하므로 조회할 수 있다.
    """

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
        event_start = epoch_ms(row["started_at"])
        event_end = epoch_ms(row["ended_at"])

        # 조회 기간과 겹치는 부분만 계산
        overlap_ms = max(
            0,
            min(event_end, end) -
            max(event_start, start)
        )

        if overlap_ms <= 0:
            continue

        result.append({
            "id": row["event_id"],
            "state": row["state"],
            "started_ms": event_start,
            "ended_ms": event_end,
            "duration_sec": overlap_ms / 1000
        })

    return result


def load_started_events(db, start, end):
    """
    발생 횟수용 조회.

    측정 시간과 달리 이벤트 시작 시각으로 판단한다.
    종료 시각이 NULL이어도 시작 기록은 존재할 수 있다.
    """

    with db.cursor() as cur:
        cur.execute("""
            SELECT event_id, state, started_at
            FROM posture_events
            WHERE started_at >= %s
              AND started_at < %s
              AND state IN ('TURTLE', 'WAIST')
            ORDER BY started_at, event_id
        """, (
            utc_dt(start),
            utc_dt(end)
        ))

        rows = cur.fetchall()

    return [
        {
            "id": row["event_id"],
            "state": row["state"],
            "started_ms": epoch_ms(row["started_at"])
        }
        for row in rows
    ]


# ==========================================
# 13. 통계 집계
# ==========================================

def aggregate(events, started_events):
    """
    측정 시간은 기간과 겹치는 부분으로 계산.
    발생 횟수는 이벤트 시작 시각으로 계산.
    """

    seconds = {
        state: 0.0
        for state in VALID_STATES
    }

    bad_durations = []

    for event in events:
        state = event["state"]
        duration = event["duration_sec"]

        seconds[state] += duration

        if state in BAD_STATES:
            bad_durations.append(duration)

    measured = sum(
        seconds[state]
        for state in COUNTED_STATES
    )

    turtle_count = sum(
        1 for event in started_events
        if event["state"] == "TURTLE"
    )

    shrimp_count = sum(
        1 for event in started_events
        if event["state"] == "WAIST"
    )

    good_ratio = (
        seconds["GOOD"] / measured * 100
        if measured > 0 else None
    )

    avg_duration = (
        sum(bad_durations) / len(bad_durations)
        if bad_durations else None
    )

    return {
        "seconds": seconds,
        "measuredSec": measured,
        "turtleCount": turtle_count,
        "shrimpCount": shrimp_count,
        "goodRatio": good_ratio,
        "avgDurationSec": avg_duration
    }


def round_or_none(value):
    if value is None:
        return None

    return round(float(value), 2)


def as_of_arg():
    raw = request.args.get("as_of_ms")

    if raw is None:
        return now_ms()

    try:
        return parse_ms(int(raw), "as_of_ms")
    except (ValueError, TypeError):
        invalid("as_of_ms는 밀리초 정수여야 합니다.")


# ==========================================
# 14. API 4: 홈 누적 측정 시간
# ==========================================

@app.get("/api/summary/home")
def home_summary():

    as_of = as_of_arg()

    db = get_db()

    try:
        events = load_events(db, 0, as_of)
    finally:
        db.close()

    valid_events = [
        event for event in events
        if event["state"] in COUNTED_STATES
    ]

    if not valid_events:
        return jsonify({
            "measured_sec": None
        })

    measured = sum(
        event["duration_sec"]
        for event in valid_events
    )

    return jsonify({
        "measured_sec": round(measured)
    })


# ==========================================
# 15. 추이 데이터 생성
# ==========================================

def build_trend(
    started_events,
    start,
    as_of,
    unit
):
    """
    TURTLE / WAIST 발생 횟수를
    날짜 또는 주 단위로 묶는다.
    """

    buckets = {}

    for event in started_events:
        date = to_kst(
            event["started_ms"]
        ).date()

        if unit == "week":
            date -= timedelta(days=date.weekday())

        key = date.isoformat()

        if key not in buckets:
            buckets[key] = {
                "turtle": 0,
                "shrimp": 0
            }

        kind = (
            "turtle"
            if event["state"] == "TURTLE"
            else "shrimp"
        )

        buckets[key][kind] += 1

    # 기록이 없는 날짜도 0으로 채움
    cursor = to_kst(start).date()
    last_date = to_kst(as_of).date()

    keys = []

    while cursor <= last_date:
        date = cursor

        if unit == "week":
            date -= timedelta(days=date.weekday())

        key = date.isoformat()

        if key not in keys:
            keys.append(key)

        cursor += timedelta(days=1)

    return {
        kind: [
            {
                "label": key[5:].replace("-", "/"),
                "count": buckets.get(key, {}).get(kind, 0)
            }
            for key in keys
        ]
        for kind in ("turtle", "shrimp")
    }


# ==========================================
# 16. API 5: 기간별 통계
# ==========================================

@app.get("/api/stats")
def stats_api():

    period = request.args.get("period", "today")
    unit = request.args.get("unit", "day")

    if unit not in {"day", "week"}:
        invalid("unit은 day 또는 week여야 합니다.")

    as_of = as_of_arg()

    start, prev_start, prev_end = period_bounds(
        period, as_of
    )

    db = get_db()

    try:
        # 현재 기간
        current_events = load_events(
            db, start, as_of
        )

        current_started = load_started_events(
            db, start, as_of
        )

        # 이전 비교 기간
        previous_events = load_events(
            db, prev_start, prev_end
        )

        previous_started = load_started_events(
            db, prev_start, prev_end
        )

    finally:
        db.close()

    # 유효 측정 기록이 전혀 없을 경우
    has_current_data = any(
        event["state"] in COUNTED_STATES
        for event in current_events
    )

    if not has_current_data:
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
        current_events,
        current_started
    )

    previous = aggregate(
        previous_events,
        previous_started
    )

    has_previous_data = any(
        event["state"] in COUNTED_STATES
        for event in previous_events
    )

    # 각 지표의 현재값과 이전값 구성
    def metric(key):
        return {
            "value": round_or_none(current[key]),
            "prev": (
                round_or_none(previous[key])
                if has_previous_data else None
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

    trend = build_trend(
        current_started,
        start,
        as_of,
        unit
    )

    # 자세별 측정 시간 분포
    total = current["measuredSec"]

    distribution = {
        "totalSec": round_or_none(total),
        "items": [
            {
                "type": TYPE_MAP[state],
                "sec": round_or_none(
                    current["seconds"][state]
                ),
                "ratio": round_or_none(
                    current["seconds"][state] / total * 100
                )
            }
            for state in (
                "GOOD",
                "TURTLE",
                "WAIST",
                "CLOSE"
            )
        ]
    }

    # 최근 자세 기록
    records = []

    for event in current_events:

        if event["state"] not in {
            "GOOD", "TURTLE", "WAIST"
        }:
            continue

        if not (
            start <= event["started_ms"] < as_of
        ):
            continue

        records.append({
            "id": event["id"],
            "startedAt": event["started_ms"],
            "type": TYPE_MAP[event["state"]],
            "durationSec": round_or_none(
                event["duration_sec"]
            )
        })

    records.sort(
        key=lambda x: (-x["startedAt"], x["id"])
    )

    records = records[:100]

    return jsonify({
        "summary": summary,
        "trend": trend,
        "distribution": distribution,
        "records": records
    })


# ==========================================
# 17. Flask 실행
# ==========================================

if __name__ == "__main__":
    # 없는 테이블만 생성
    init_db()

    # 로컬 개발 환경
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )
