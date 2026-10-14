"""
app.py
NeckCare API v0.3.3 최종 보완본

D 담당
- Flask API
- MariaDB
- 이벤트 최종화 검증
- 자세별 통계 집계

필요 패키지:
pip install flask mysqlclient python-dotenv

실행:
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

UTC = timezone.utc
KST = ZoneInfo("Asia/Seoul")

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
# 2. MariaDB 연결
# ==========================================

def get_db():
    """DB에 연결하고 시간대를 UTC로 고정한다."""

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
    """
    신규 환경에서 필요한 테이블을 생성한다.

    이미 존재하는 테이블은 삭제하거나 변경하지 않는다.
    기존 DB의 is_final 추가는 별도 마이그레이션 필요.
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
                    alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
                    is_final BOOLEAN NOT NULL DEFAULT FALSE,

                    INDEX idx_events_session (session_id),
                    INDEX idx_events_start (started_at),

                    FOREIGN KEY (session_id)
                        REFERENCES sessions(session_id),

                    FOREIGN KEY (state)
                        REFERENCES posture_states(state)
                ) ENGINE=InnoDB
                DEFAULT CHARSET=utf8mb4
            """)

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
# 3. 시간 관련 함수
# ==========================================

def now_ms():
    return int(time.time() * 1000)


def parse_ms(value, name):
    """Unix epoch 밀리초 정수인지 검사한다."""

    if (
        type(value) is not int
        or value < 0
        or value > 32503680000000
    ):
        raise ApiError(
            "INVALID_REQUEST",
            f"{name}은 유효한 밀리초 정수여야 합니다.",
            400
        )

    return value


def utc_dt(ms):
    """epoch ms를 DB용 UTC DATETIME으로 변환한다."""

    return datetime.fromtimestamp(
        ms / 1000,
        UTC
    ).replace(tzinfo=None)


def epoch_ms(value):
    """DB의 UTC DATETIME을 epoch ms로 변환한다."""

    return int(
        value.replace(tzinfo=UTC).timestamp() * 1000
    )


def kst_dt(ms):
    return datetime.fromtimestamp(ms / 1000, KST)


def ms_from_dt(value):
    return int(value.timestamp() * 1000)


# ==========================================
# 4. API 오류 처리
# ==========================================

class ApiError(Exception):
    def __init__(self, reason, message, status=400):
        self.reason = reason
        self.message = message
        self.status = status

        super().__init__(message)


def invalid(message):
    raise ApiError(
        "INVALID_REQUEST",
        message,
        400
    )


def conflict(reason, message):
    raise ApiError(reason, message, 409)


@app.errorhandler(ApiError)
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
def handle_unexpected_error(error):
    if isinstance(error, ApiError):
        return handle_api_error(error)

    app.logger.exception("서버 내부 오류")

    return jsonify({
        "ok": False,
        "error": {
            "code": 500,
            "reason": "INTERNAL_ERROR",
            "message": "서버 내부 오류가 발생했습니다."
        }
    }), 500


# ==========================================
# 5. CORS
# ==========================================

@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin")

    if origin in ALLOWED_ORIGINS:
        response.headers[
            "Access-Control-Allow-Origin"
        ] = origin

        response.headers["Vary"] = "Origin"

        response.headers[
            "Access-Control-Allow-Methods"
        ] = "GET, POST, OPTIONS"

        response.headers[
            "Access-Control-Allow-Headers"
        ] = "Content-Type"

    return response


@app.before_request
def handle_options():
    if request.method == "OPTIONS":
        return "", 204


def get_json_body():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        invalid("JSON 객체를 보내야 합니다.")

    return data


# ==========================================
# 6. 세션 생성
# ==========================================

@app.post("/api/sessions")
def create_session():
    data = get_json_body()

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
# 7. 이벤트 요청 검증
# ==========================================

def prepare_events(raw_events):
    """
    v0.3.3 이벤트 필드 검사

    필수:
    event_id
    state
    started_at_ms
    ended_at_ms
    is_final
    alert_triggered
    """

    if (
        not isinstance(raw_events, list)
        or len(raw_events) > 500
    ):
        invalid("events는 최대 500개 배열이어야 합니다.")

    result = []

    required = {
        "event_id",
        "state",
        "started_at_ms",
        "ended_at_ms",
        "is_final",
        "alert_triggered"
    }

    for raw in raw_events:
        if not isinstance(raw, dict):
            invalid("이벤트는 JSON 객체여야 합니다.")

        if not required.issubset(raw):
            invalid("이벤트 필수 필드가 누락됐습니다.")

        try:
            event_id = str(uuid.UUID(raw["event_id"]))
        except (ValueError, TypeError, AttributeError):
            invalid("이벤트 UUID가 올바르지 않습니다.")

        state = raw["state"]

        if (
            not isinstance(state, str)
            or state not in VALID_STATES
        ):
            invalid("허용되지 않은 자세 상태입니다.")

        started = parse_ms(
            raw["started_at_ms"],
            "started_at_ms"
        )

        raw_end = raw["ended_at_ms"]

        ended = (
            None
            if raw_end is None
            else parse_ms(raw_end, "ended_at_ms")
        )

        is_final = raw["is_final"]
        alert = raw["alert_triggered"]

        if type(is_final) is not bool:
            invalid("is_final은 Boolean이어야 합니다.")

        if type(alert) is not bool:
            invalid("alert_triggered는 Boolean이어야 합니다.")

        # 최종화된 이벤트는 반드시 종료 시각이 있어야 한다.
        if is_final and ended is None:
            invalid(
                "is_final=true 이벤트에는 종료 시각이 필요합니다."
            )

        # 0초 및 역행 이벤트 금지
        if ended is not None and ended <= started:
            invalid(
                "ended_at_ms는 started_at_ms보다 커야 합니다."
            )

        result.append({
            "id": event_id,
            "state": state,
            "start": started,
            "end": ended,
            "is_final": is_final,
            "alert": alert
        })

    return result


# ==========================================
# 8. 이벤트 시간 중복 검사
# ==========================================

def validate_overlaps(cur, session_id):
    """
    서로 다른 UUID의 확정 관측 구간 중복 검사.

    A.end == B.start는 허용한다.
    NULL 종료 시각은 임의로 추정하지 않는다.

    같은 시작 시각을 가진 다른 UUID는 충돌이다.
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

        if (
            previous_start is not None
            and start == previous_start
        ):
            conflict(
                "EVENT_OVERLAP",
                "서로 다른 이벤트의 시작 시각이 같습니다."
            )

        if (
            previous_end is not None
            and start < previous_end
        ):
            conflict(
                "EVENT_OVERLAP",
                "자세 이벤트 시간이 겹칩니다."
            )

        previous_start = start
        previous_end = end


# ==========================================
# 9. 이벤트 INSERT / UPDATE
# ==========================================

def upsert_events(
    cur,
    session_id,
    session_start,
    session_end,
    events
):
    """
    v0.3.3 핵심 로직.

    신규 UUID -> INSERT

    기존 미확정 UUID:
        스냅샷 시간 연장
        false -> true 최종화

    기존 최종 UUID:
        동일 최종 요청만 멱등 허용
        모든 필드 변경 금지
        오래된 미확정 스냅샷은 ignored
    """

    saved = 0
    updated = 0
    ignored = 0

    for event in events:
        start = event["start"]
        end = event["end"]

        # 세션 시간 범위 검사
        if start < session_start:
            conflict(
                "EVENT_OUT_OF_RANGE",
                "이벤트 시작이 세션 시작보다 빠릅니다."
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

        # ----------------------------------
        # 9-1. 신규 이벤트
        # ----------------------------------
        if old is None:
            duration = (
                round((end - start) / 1000, 3)
                if end is not None else 0
            )

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
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            """, (
                event["id"],
                session_id,
                event["state"],
                utc_dt(start),
                utc_dt(end) if end is not None else None,
                duration,
                int(event["alert"]),
                int(event["is_final"])
            ))

            saved += 1
            continue

        # ----------------------------------
        # 9-2. 동일 UUID 고정 정보 검사
        # ----------------------------------
        if (
            old["session_id"] != session_id
            or old["state"] != event["state"]
            or epoch_ms(old["started_at"]) != start
        ):
            conflict(
                "EVENT_ID_CONFLICT",
                "동일 UUID의 세션·상태·시작 시각이 다릅니다."
            )

        old_end = (
            epoch_ms(old["ended_at"])
            if old["ended_at"] is not None
            else None
        )

        old_final = bool(old["is_final"])
        old_alert = bool(old["alert_triggered"])

        # ----------------------------------
        # 9-3. 이미 최종화된 이벤트
        # ----------------------------------
        if old_final:
            # 과거 미확정 스냅샷은 기록 변경 없이 무시
            if not event["is_final"]:
                ignored += 1
                continue

            # 최종화된 이벤트는 경고값까지 불변
            if (
                event["end"] != old_end
                or event["alert"] != old_alert
            ):
                conflict(
                    "EVENT_FINALIZED",
                    "최종화된 이벤트는 변경할 수 없습니다."
                )

            # 동일 최종 요청: 멱등 성공
            ignored += 1
            continue

        # ----------------------------------
        # 9-4. 미확정 -> 최종화
        # ----------------------------------
        if event["is_final"]:
            if (
                old_end is not None
                and end < old_end
            ):
                conflict(
                    "EVENT_TIME_REGRESSION",
                    "최종 종료 시각이 기존 스냅샷보다 빠릅니다."
                )

            # C가 최종 확정한 경고값을 저장한다.
            cur.execute("""
                UPDATE posture_events
                SET
                    ended_at = %s,
                    duration_sec = %s,
                    alert_triggered = %s,
                    is_final = TRUE
                WHERE event_id = %s
            """, (
                utc_dt(end),
                round((end - start) / 1000, 3),
                int(event["alert"]),
                event["id"]
            ))

            updated += 1
            continue

        # ----------------------------------
        # 9-5. 미확정 스냅샷 갱신
        # ----------------------------------
        if old_end is None:
            new_end = end
        elif end is None:
            new_end = old_end
        else:
            new_end = max(old_end, end)

        # 미확정 단계에서는 경고 시작 이력을 OR 처리
        new_alert = old_alert or event["alert"]

        if (
            new_end != old_end
            or new_alert != old_alert
        ):
            cur.execute("""
                UPDATE posture_events
                SET
                    ended_at = %s,
                    duration_sec = %s,
                    alert_triggered = %s
                WHERE event_id = %s
            """, (
                utc_dt(new_end) if new_end is not None else None,
                round((new_end - start) / 1000, 3)
                    if new_end is not None else 0,
                int(new_alert),
                event["id"]
            ))

            updated += 1
        else:
            ignored += 1

    # 모든 INSERT / UPDATE 이후 중복 검사
    validate_overlaps(cur, session_id)

    return saved, updated, ignored


# ==========================================
# 10. POST /api/sessions/{id}/events
# ==========================================

@app.post("/api/sessions/<int:session_id>/events")
def save_events_api(session_id):
    data = get_json_body()
    events = prepare_events(data.get("events"))

    db = get_db()

    try:
        with db.cursor() as cur:

            # 같은 세션의 /end와 저장 순서를 직렬화
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
# 11. POST /api/sessions/{id}/end
# ==========================================

@app.post("/api/sessions/<int:session_id>/end")
def end_session_api(session_id):
    data = get_json_body()

    ended = parse_ms(
        data.get("ended_at_ms"),
        "ended_at_ms"
    )

    reason = data.get("reason")

    if reason not in {
        "camera_off",
        "pagehide",
        "input_ended"
    }:
        invalid("종료 사유가 올바르지 않습니다.")

    events = prepare_events(data.get("events", []))

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

            # 이미 종료된 세션이면 기존 결과 반환
            # 중복 종료 요청으로 데이터를 변경하지 않는다.
            if session["ended_at"] is None:
                started = epoch_ms(session["started_at"])

                if ended < started:
                    invalid("세션 종료 시각이 시작보다 빠릅니다.")

                # C가 동봉한 최종 이벤트만 저장
                upsert_events(
                    cur,
                    session_id,
                    started,
                    ended,
                    events
                )

                # 중요:
                # NULL 이벤트를 다음 이벤트 시작이나
                # 세션 종료 시각으로 자동 보정하지 않는다.

                # 저장된 관측 시간만 합산
                cur.execute("""
                    SELECT
                        COALESCE(SUM(e.duration_sec), 0)
                            AS valid_seconds
                    FROM posture_events e
                    JOIN posture_states s
                      ON e.state = s.state
                    WHERE e.session_id = %s
                      AND s.is_counted = 1
                      AND e.ended_at IS NOT NULL
                """, (session_id,))

                valid_seconds = float(
                    cur.fetchone()["valid_seconds"]
                )

                # 세션 전체 시간과 유효 관측 시간은 다르다.
                total_seconds = round(
                    (ended - started) / 1000
                )

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
# 12. 조회 기준 시각
# ==========================================

def get_as_of():
    raw = request.args.get("as_of_ms")

    if raw is None:
        return now_ms()

    try:
        value = int(raw)
    except (ValueError, TypeError):
        invalid("as_of_ms는 밀리초 정수여야 합니다.")

    return parse_ms(value, "as_of_ms")


# ==========================================
# 13. 통계 기간 계산
# ==========================================

def period_bounds(period, as_of):
    """
    today:
      오늘 KST 00:00 ~ 조회 시각
      이전 기간은 전날 00:00 ~ 전날 같은 시각

    week:
      오늘 포함 최근 7일

    month:
      오늘 포함 최근 30일
    """

    current = kst_dt(as_of)

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
        ms_from_dt(start),
        ms_from_dt(prev_start),
        ms_from_dt(prev_end)
    )


# ==========================================
# 14. 기간 내 기록 존재 여부
# ==========================================

def has_records(db, start, end):
    """
    유효 자세가 없어도 세션 기록이 있으면
    '기록 있음'으로 판단한다.
    """

    with db.cursor() as cur:
        # 해당 기간에 존재한 세션
        cur.execute("""
            SELECT session_id
            FROM sessions
            WHERE started_at < %s
              AND (
                  ended_at IS NULL
                  OR ended_at >= %s
              )
            LIMIT 1
        """, (
            utc_dt(end),
            utc_dt(start)
        ))

        if cur.fetchone() is not None:
            return True

        # 해당 기간에 시작한 이벤트
        cur.execute("""
            SELECT event_id
            FROM posture_events
            WHERE started_at >= %s
              AND started_at < %s
            LIMIT 1
        """, (
            utc_dt(start),
            utc_dt(end)
        ))

        return cur.fetchone() is not None


# ==========================================
# 15. 실제 관측 구간 조회
# ==========================================

def load_events(db, start, end):
    """
    ended_at이 있는 관측 구간만 계산한다.

    is_final=false라도 종료 시각이 있는 스냅샷은
    해당 시각까지 실제 관측된 시간으로 계산한다.

    NULL 이벤트는 시간을 추정하지 않는다.
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
        started = epoch_ms(row["started_at"])
        ended = epoch_ms(row["ended_at"])

        # 조회 기간과 겹치는 시간만 합산
        clipped_start = max(started, start)
        clipped_end = min(ended, end)

        duration = max(
            0,
            (clipped_end - clipped_start) / 1000
        )

        if duration <= 0:
            continue

        result.append({
            "id": row["event_id"],
            "state": row["state"],
            "started_ms": started,
            "ended_ms": ended,
            "duration_sec": duration
        })

    return result


# ==========================================
# 16. 발생 횟수 조회
# ==========================================

def load_started_events(db, start, end):
    """
    TURTLE / WAIST 발생 횟수는
    이벤트 시작 시각을 기준으로 한다.
    """

    if end <= start:
        return []

    with db.cursor() as cur:
        cur.execute("""
            SELECT
                event_id,
                state,
                started_at
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
# 17. 통계 집계
# ==========================================

def aggregate(events, started_events):
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
        1
        for event in started_events
        if event["state"] == "TURTLE"
    )

    shrimp_count = sum(
        1
        for event in started_events
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


def round_value(value):
    if value is None:
        return None

    return round(float(value), 2)


# ==========================================
# 18. 홈 누적 측정 시간
# ==========================================

@app.get("/api/summary/home")
def home_summary():
    as_of = get_as_of()

    db = get_db()

    try:
        recorded = has_records(db, 0, as_of)
        events = load_events(db, 0, as_of)

    finally:
        db.close()

    # 세션과 이벤트가 전혀 없으면 null
    if not recorded:
        return jsonify({
            "measured_sec": None
        })

    # 기록이 있어도 유효 측정시간은 0일 수 있음
    measured = sum(
        event["duration_sec"]
        for event in events
        if event["state"] in COUNTED_STATES
    )

    return jsonify({
        "measured_sec": round(measured)
    })


# ==========================================
# 19. 추이 데이터 생성
# ==========================================

def build_trend(started_events, start, as_of, unit):
    buckets = {}

    for event in started_events:
        date = kst_dt(event["started_ms"]).date()

        if unit == "week":
            # 월요일을 주 시작으로 사용
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

    cursor = kst_dt(start).date()
    last = kst_dt(as_of).date()

    keys = []

    while cursor <= last:
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
# 20. 기간별 통계
# ==========================================

@app.get("/api/stats")
def stats_api():
    period = request.args.get("period", "today")
    unit = request.args.get("unit", "day")

    if unit not in {"day", "week"}:
        invalid("unit은 day 또는 week여야 합니다.")

    as_of = get_as_of()

    start, prev_start, prev_end = period_bounds(
        period,
        as_of
    )

    db = get_db()

    try:
        current_recorded = has_records(
            db, start, as_of
        )

        previous_recorded = has_records(
            db, prev_start, prev_end
        )

        current_events = load_events(
            db, start, as_of
        )

        current_started = load_started_events(
            db, start, as_of
        )

        previous_events = load_events(
            db, prev_start, prev_end
        )

        previous_started = load_started_events(
            db, prev_start, prev_end
        )

    finally:
        db.close()

    # 조회 기간에 기록 자체가 없을 경우
    if not current_recorded:
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

    # 현재 값과 이전 기간 값
    def metric(key):
        return {
            "value": round_value(current[key]),
            "prev": (
                round_value(previous[key])
                if previous_recorded else None
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

    # 발생 횟수 추이
    trend = build_trend(
        current_started,
        start,
        as_of,
        unit
    )

    # 자세별 시간 분포
    total = current["measuredSec"]

    if total > 0:
        distribution = {
            "totalSec": round_value(total),
            "items": [
                {
                    "type": TYPE_MAP[state],
                    "sec": round_value(
                        current["seconds"][state]
                    ),
                    "ratio": round_value(
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
    else:
        # 기록은 있으나 유효 분석 시간이 0초
        distribution = None

    # 자세 기록: GOOD / TURTLE / WAIST
    records = []

    for event in current_events:
        if event["state"] not in {
            "GOOD",
            "TURTLE",
            "WAIST"
        }:
            continue

        records.append({
            "id": event["id"],
            "startedAt": event["started_ms"],
            "type": TYPE_MAP[event["state"]],
            "durationSec": round_value(
                event["duration_sec"]
            )
        })

    records.sort(
        key=lambda row: (
            -row["startedAt"],
            row["id"]
        )
    )

    records = records[:100]

    return jsonify({
        "summary": summary,
        "trend": trend,
        "distribution": distribution,
        "records": records
    })


# ==========================================
# 21. 서버 실행
# ==========================================

if __name__ == "__main__":
    init_db()

    app.run(
        host="127.0.0.1",
        port=5000,
        debug=True
    )