
"""NeckCare D backend - MariaDB / Flask.

Run: python -m pip install flask mysqlclient python-dotenv
     python app.py
C frontend: http://localhost:5173 ; API: http://127.0.0.1:5000
"""
import os
import math
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import MySQLdb
import MySQLdb.cursors
from dotenv import load_dotenv
from flask import Flask, jsonify, request

# app.py와 같은 폴더의 .env를 정확히 읽는다.
# 이미 터미널에 같은 환경변수가 있어도 .env 값을 우선 적용한다.
ENV_PATH = Path(__file__).resolve().parent / '.env'
load_dotenv(dotenv_path=ENV_PATH, override=True)

app = Flask(__name__)
KST = ZoneInfo('Asia/Seoul')

ALLOWED_ORIGINS = {
    'http://localhost:5173',
    'http://127.0.0.1:5173'
}

STATES = [
    ('GOOD', '바른 자세', 1, 0),
    ('TURTLE', '거북목', 1, 1),
    ('WAIST', '새우등', 1, 1),
    ('CLOSE', '화면에 가까움', 1, 0),
    ('NOVIS', '인식 불가', 0, 0),
    ('CALIB', '초기 자세 설정', 0, 0),
    ('IDLE', '대기', 0, 0),
]

VALID = {x[0] for x in STATES}
COUNTED = {'GOOD', 'TURTLE', 'WAIST', 'CLOSE'}


# ==================================================
# 1. MariaDB 연결
# ==================================================

def get_db():
    """DictCursor로 결과를 dict처럼 사용한다. 연결별 UTC 세션 설정."""

    password = os.getenv('DB_PASSWORD', '')

    if not password:
        raise RuntimeError(
            f'MariaDB 비밀번호가 설정되지 않았습니다. {ENV_PATH} 파일의 '
            'DB_PASSWORD 값을 확인하세요. (비밀번호 자체는 출력하지 않습니다.)'
        )

    db = MySQLdb.connect(
        host=os.getenv('DB_HOST', '127.0.0.1'),
        port=int(os.getenv('DB_PORT', '3306')),
        user=os.getenv('DB_USER', 'root'),
        passwd=password,
        db=os.getenv('DB_NAME', 'turtle_bump'),
        charset='utf8mb4',
        cursorclass=MySQLdb.cursors.DictCursor,
        autocommit=False,
    )

    with db.cursor() as cur:
        cur.execute("SET time_zone = '+00:00'")

    return db


# ==================================================
# 2. 테이블 생성 및 초기 상태 저장
# ==================================================

def init_db():
    """ERD 컬럼 그대로 생성. 기존 테이블은 삭제하지 않는다."""

    db = get_db()

    try:
        with db.cursor() as cur:

            cur.execute('''
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id INT AUTO_INCREMENT PRIMARY KEY,
                    started_at DATETIME(3) NOT NULL,
                    ended_at DATETIME(3) NULL,
                    total_duration_sec INT NOT NULL DEFAULT 0,
                    valid_duration_sec INT NOT NULL DEFAULT 0
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ''')

            cur.execute('''
                CREATE TABLE IF NOT EXISTS posture_states (
                    state VARCHAR(32) PRIMARY KEY,
                    label VARCHAR(32) NOT NULL,
                    is_counted BOOLEAN NOT NULL DEFAULT 1,
                    is_alert BOOLEAN NOT NULL DEFAULT 0
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ''')

            cur.execute('''
                CREATE TABLE IF NOT EXISTS posture_events (
                    event_id CHAR(36) PRIMARY KEY,
                    session_id INT NOT NULL,
                    state VARCHAR(32) NOT NULL,
                    started_at DATETIME(3) NOT NULL,
                    ended_at DATETIME(3) NULL,
                    duration_sec FLOAT NOT NULL DEFAULT 0,
                    alert_triggered BOOLEAN NOT NULL DEFAULT 0,

                    INDEX idx_events_session (session_id),

                    CONSTRAINT fk_events_session
                        FOREIGN KEY (session_id)
                        REFERENCES sessions(session_id),

                    CONSTRAINT fk_events_state
                        FOREIGN KEY (state)
                        REFERENCES posture_states(state)

                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            ''')

            # 상태 데이터가 없을 때만 삽입
            cur.executemany('''
                INSERT IGNORE INTO posture_states
                (state, label, is_counted, is_alert)
                VALUES (%s, %s, %s, %s)
            ''', STATES)

        db.commit()

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# ==================================================
# 3. 시간 처리
# ==================================================

def now_ms():
    return int(time.time() * 1000)


def parse_ms(value, field):
    if type(value) is not int or not 0 <= value <= 32503680000000:
        raise ValueError(
            f'{field}은 유효한 epoch 밀리초 정수여야 합니다.'
        )
    return value


def utc_dt(ms):
    """epoch 밀리초를 UTC DATETIME으로 변환"""
    return datetime.fromtimestamp(
        ms / 1000,
        timezone.utc
    ).replace(tzinfo=None)


def epoch_ms(dt):
    """UTC DATETIME을 epoch 밀리초로 변환"""
    return int(
        dt.replace(tzinfo=timezone.utc).timestamp() * 1000
    )


# ==================================================
# 4. JSON 및 오류 처리
# ==================================================

def body_json():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        raise ValueError('JSON 객체를 보내야 합니다.')

    return data


def fail(message, status=400):
    return jsonify({
        'ok': False,
        'error': {
            'code': status,
            'message': str(message)
        }
    }), status


# ==================================================
# 5. CORS 설정
# ==================================================

@app.after_request
def cors(resp):
    origin = request.headers.get('Origin')

    if origin in ALLOWED_ORIGINS:
        resp.headers['Access-Control-Allow-Origin'] = origin
        resp.headers['Vary'] = 'Origin'
        resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'

    return resp


@app.before_request
def preflight():
    if request.method == 'OPTIONS':
        return '', 204


# ==================================================
# 6. 세션 생성 API
# POST /api/sessions
# ==================================================

@app.post('/api/sessions')
def create_session():

    try:
        data = body_json()

        started = parse_ms(
            data.get('started_at_ms', now_ms()),
            'started_at_ms'
        )

        if started > now_ms() + 60000:
            raise ValueError('시작 시각이 미래입니다.')

        db = get_db()

        try:
            with db.cursor() as cur:
                cur.execute(
                    'INSERT INTO sessions (started_at) VALUES (%s)',
                    (utc_dt(started),)
                )

                sid = cur.lastrowid

            db.commit()

        except Exception:
            db.rollback()
            raise

        finally:
            db.close()

        return jsonify({
            'session_id': sid,
            'started_at_ms': started
        }), 201

    except ValueError as exc:
        return fail(exc)


# ==================================================
# 7. 자세 이벤트 저장 API
# POST /api/sessions/<session_id>/events
# ==================================================

@app.post('/api/sessions/<int:session_id>/events')
def save_events(session_id):

    try:
        data = body_json()
        events = data.get('events')

        if not isinstance(events, list) or len(events) > 500:
            raise ValueError(
                'events는 최대 500개까지의 배열이어야 합니다.'
            )

        prepared = []

        # 전송된 자세 이벤트 검증
        for event in events:

            if not isinstance(event, dict):
                raise ValueError('이벤트는 JSON 객체여야 합니다.')

            try:
                eid = str(uuid.UUID(event['event_id']))
                state = event['state']

                start = parse_ms(
                    event['started_at_ms'],
                    'started_at_ms'
                )

            except (
                KeyError,
                TypeError,
                AttributeError,
                ValueError
            ) as exc:
                raise ValueError(
                    f'잘못된 이벤트 필드: {exc}'
                ) from exc

            if state not in VALID:
                raise ValueError(
                    f'허용되지 않은 상태: {state}'
                )

            raw_end = event.get('ended_at_ms')

            end = (
                None if raw_end is None
                else parse_ms(raw_end, 'ended_at_ms')
            )

            if end is not None and end < start:
                raise ValueError(
                    '종료 시각은 시작 시각보다 빠를 수 없습니다.'
                )

            # 서버에서 지속 시간 계산
            duration = (
                0.0 if end is None
                else (end - start) / 1000
            )

            supplied = event.get('duration_sec')

            if supplied is not None and (
                type(supplied) not in (int, float)
                or not math.isfinite(supplied)
                or abs(supplied - duration) > 0.02
            ):
                raise ValueError(
                    'duration_sec 값이 시각 차이와 일치하지 않습니다.'
                )

            alert = event.get('alert_triggered', False)

            if type(alert) is not bool:
                raise ValueError(
                    'alert_triggered는 boolean이어야 합니다.'
                )

            prepared.append((
                eid,
                session_id,
                state,
                utc_dt(start),
                utc_dt(end) if end is not None else None,
                duration,
                int(alert)
            ))

        db = get_db()

        try:
            with db.cursor() as cur:

                # 세션 존재 여부와 종료 여부 확인
                cur.execute(
                    '''
                    SELECT ended_at
                    FROM sessions
                    WHERE session_id=%s
                    FOR UPDATE
                    ''',
                    (session_id,)
                )

                session = cur.fetchone()

                if session is None:
                    db.rollback()
                    return fail('세션이 없습니다.', 404)

                if session['ended_at'] is not None:
                    db.rollback()
                    return fail(
                        '종료된 세션에는 이벤트를 추가할 수 없습니다.',
                        409
                    )

                # 자세 이벤트 INSERT / UPDATE
                for row in prepared:

                    cur.execute(
                        '''
                        SELECT *
                        FROM posture_events
                        WHERE event_id=%s
                        FOR UPDATE
                        ''',
                        (row[0],)
                    )

                    old = cur.fetchone()

                    if old is None:
                        # 새 이벤트 저장
                        cur.execute(
                            '''
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
                            ''',
                            row
                        )

                    else:
                        # 같은 UUID가 다른 이벤트에 사용됐는지 확인
                        if (
                            old['session_id'] != session_id
                            or old['state'] != row[2]
                            or old['started_at'] != row[3]
                        ):
                            db.rollback()
                            return fail(
                                'event_id가 다른 구간에 이미 사용됐습니다.',
                                409
                            )

                        if old['ended_at'] is None:
                            # 진행 중인 구간을 같은 UUID로 갱신
                            cur.execute(
                                '''
                                UPDATE posture_events
                                SET ended_at=%s,
                                    duration_sec=%s,
                                    alert_triggered=GREATEST(
                                        alert_triggered, %s
                                    )
                                WHERE event_id=%s
                                ''',
                                (
                                    row[4],
                                    row[5],
                                    row[6],
                                    row[0]
                                )
                            )

                        elif (
                            row[4] is not None
                            and old['ended_at'] != row[4]
                        ):
                            db.rollback()
                            return fail(
                                '이미 완료된 이벤트의 종료 시각이 다릅니다.',
                                409
                            )

                        elif row[6] and not old['alert_triggered']:
                            cur.execute(
                                '''
                                UPDATE posture_events
                                SET alert_triggered=1
                                WHERE event_id=%s
                                ''',
                                (row[0],)
                            )

            db.commit()

        except Exception:
            db.rollback()
            raise

        finally:
            db.close()

        return jsonify({
            'ok': True,
            'received_count': len(prepared)
        })

    except ValueError as exc:
        return fail(exc)


# ==================================================
# 8. 세션 종료 API
# POST /api/sessions/<session_id>/end
# ==================================================

@app.post('/api/sessions/<int:session_id>/end')
def end_session(session_id):

    try:
        data = body_json()

        ended = parse_ms(
            data.get('ended_at_ms', now_ms()),
            'ended_at_ms'
        )

        reason = data.get('reason', 'camera_off')

        if not isinstance(reason, str) or len(reason) > 100:
            raise ValueError(
                'reason은 100자 이하 문자열이어야 합니다.'
            )

        db = get_db()

        try:
            with db.cursor() as cur:

                cur.execute(
                    '''
                    SELECT *
                    FROM sessions
                    WHERE session_id=%s
                    FOR UPDATE
                    ''',
                    (session_id,)
                )

                session = cur.fetchone()

                if session is None:
                    db.rollback()
                    return fail('세션이 없습니다.', 404)

                if session['ended_at'] is None:

                    started = epoch_ms(session['started_at'])

                    if ended < started:
                        db.rollback()
                        return fail(
                            '종료 시각이 시작 시각보다 빠릅니다.'
                        )

                    # 아직 종료되지 않은 자세 이벤트 마감
                    cur.execute(
                        '''
                        SELECT event_id, started_at
                        FROM posture_events
                        WHERE session_id=%s
                        AND ended_at IS NULL
                        FOR UPDATE
                        ''',
                        (session_id,)
                    )

                    for event in cur.fetchall():

                        ev_start = epoch_ms(event['started_at'])
                        ev_end = max(ev_start, ended)

                        cur.execute(
                            '''
                            UPDATE posture_events
                            SET ended_at=%s,
                                duration_sec=%s
                            WHERE event_id=%s
                            ''',
                            (
                                utc_dt(ev_end),
                                (ev_end - ev_start) / 1000,
                                event['event_id']
                            )
                        )

                    # 유효 측정 시간 계산
                    cur.execute(
                        '''
                        SELECT
                            COALESCE(SUM(e.duration_sec),0) AS valid
                        FROM posture_events e
                        JOIN posture_states s
                            ON s.state=e.state
                        WHERE e.session_id=%s
                        AND s.is_counted=1
                        ''',
                        (session_id,)
                    )

                    valid = cur.fetchone()['valid']

                    # 전체 세션 시간 계산
                    total = (ended - started) // 1000

                    cur.execute(
                        '''
                        UPDATE sessions
                        SET ended_at=%s,
                            total_duration_sec=%s,
                            valid_duration_sec=%s
                        WHERE session_id=%s
                        ''',
                        (
                            utc_dt(ended),
                            total,
                            round(float(valid)),
                            session_id
                        )
                    )

                # 최종 세션 정보 조회
                cur.execute(
                    '''
                    SELECT *
                    FROM sessions
                    WHERE session_id=%s
                    ''',
                    (session_id,)
                )

                result = cur.fetchone()

            db.commit()

        except Exception:
            db.rollback()
            raise

        finally:
            db.close()

        return jsonify({
            'ok': True,
            'session_id': session_id,
            'ended_at_ms': epoch_ms(result['ended_at']),
            'total_duration_sec': result['total_duration_sec'],
            'valid_duration_sec': result['valid_duration_sec']
        })

    except ValueError as exc:
        return fail(exc)


# ==================================================
# 9. 통계 기간 계산
# ==================================================

def period_bounds(period, as_of):

    current = datetime.fromtimestamp(
        as_of / 1000,
        KST
    )

    if period == 'today':
        start = current.replace(
            hour=0,
            minute=0,
            second=0,
            microsecond=0
        )

        previous = start - timedelta(days=1)

    elif period in ('week', 'month'):
        days = 7 if period == 'week' else 30

        start = current - timedelta(days=days)
        previous = start - timedelta(days=days)

    else:
        raise ValueError(
            'period는 today, week, month 중 하나여야 합니다.'
        )

    return (
        int(start.timestamp() * 1000),
        int(previous.timestamp() * 1000)
    )


# ==================================================
# 10. DB 이벤트 조회
# ==================================================

def load_events(db, start, end):

    if end <= start:
        return []

    with db.cursor() as cur:
        cur.execute(
            '''
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
            ''',
            (
                utc_dt(end),
                utc_dt(start)
            )
        )

        rows = cur.fetchall()

    output = []

    for row in rows:

        a = epoch_ms(row['started_at'])
        b = epoch_ms(row['ended_at'])

        # 조회 기간에 겹치는 시간만 계산
        overlap = max(
            0,
            min(b, end) - max(a, start)
        ) / 1000

        if overlap > 0:
            output.append({
                'id': row['event_id'],
                'state': row['state'],
                'started_ms': a,
                'ended_ms': b,
                'duration_sec': overlap
            })

    return output


# ==================================================
# 11. 통계 집계
# ==================================================

def aggregate(events, start, end):

    seconds = {
        state: 0.0
        for state in VALID
    }

    counts = {
        'TURTLE': 0,
        'WAIST': 0
    }

    bad_durations = []

    for event in events:

        state = event['state']
        seconds[state] += event['duration_sec']

        # 해당 기간에 시작한 자세 구간만 횟수 집계
        if (
            start <= event['started_ms'] < end
            and state in counts
        ):
            counts[state] += 1
            bad_durations.append(event['duration_sec'])

    valid = sum(
        seconds[s]
        for s in COUNTED
    )

    return {
        'seconds': seconds,
        'measuredSec': valid,
        'turtleCount': counts['TURTLE'],
        'shrimpCount': counts['WAIST'],

        'goodRatio': (
            seconds['GOOD'] / valid * 100
            if valid else None
        ),

        'avgDurationSec': (
            sum(bad_durations) / len(bad_durations)
            if bad_durations else None
        )
    }


def round_or_none(value):
    return (
        None if value is None
        else round(float(value), 2)
    )


# ==================================================
# 12. 통계 조회 시각 처리
# ==================================================

def as_of_arg():

    raw = request.args.get('as_of_ms')

    try:
        return parse_ms(
            now_ms() if raw is None else int(raw),
            'as_of_ms'
        )

    except (ValueError, TypeError) as exc:
        raise ValueError(
            'as_of_ms는 epoch 밀리초 정수여야 합니다.'
        ) from exc


# ==================================================
# 13. 홈 누적 측정 시간 API
# GET /api/summary/home
# ==================================================

@app.get('/api/summary/home')
def home_summary():

    try:
        as_of = as_of_arg()
        db = get_db()

        try:
            events = load_events(db, 0, as_of)

        finally:
            db.close()

        counted = [
            e for e in events
            if e['state'] in COUNTED
        ]

        return jsonify({
            'measured_sec': (
                round(
                    sum(
                        e['duration_sec']
                        for e in counted
                    )
                )
                if counted else None
            )
        })

    except ValueError as exc:
        return fail(exc)


# ==================================================
# 14. 전체 통계 조회 API
# GET /api/stats
# ==================================================

@app.get('/api/stats')
def stats():

    try:
        period = request.args.get(
            'period',
            'today'
        )

        unit = request.args.get(
            'unit',
            'day'
        )

        if unit not in ('day', 'week'):
            raise ValueError(
                'unit은 day 또는 week여야 합니다.'
            )

        as_of = as_of_arg()

        start, previous_start = period_bounds(
            period,
            as_of
        )

        db = get_db()

        try:
            current_events = load_events(
                db,
                start,
                as_of
            )

            previous_events = load_events(
                db,
                previous_start,
                start
            )

        finally:
            db.close()

        # 현재 및 이전 기간에 기록이 없으면 빈 통계 반환
        if not current_events and not previous_events:
            return jsonify({
                'summary': None,
                'trend': {
                    'turtle': [],
                    'shrimp': []
                },
                'distribution': None,
                'records': []
            })

        current = aggregate(
            current_events,
            start,
            as_of
        )

        previous = aggregate(
            previous_events,
            previous_start,
            start
        )

        # 현재 기간과 이전 기간 비교
        def metric(key):
            return {
                'value': (
                    round_or_none(current[key])
                    if current_events else None
                ),
                'prev': (
                    round_or_none(previous[key])
                    if previous_events else None
                )
            }

        summary = {
            key: metric(key)
            for key in (
                'measuredSec',
                'turtleCount',
                'shrimpCount',
                'goodRatio',
                'avgDurationSec'
            )
        }

        # 일별 / 주별 자세 발생 횟수
        buckets = {}

        for event in current_events:

            if event['state'] not in (
                'TURTLE',
                'WAIST'
            ):
                continue

            if not (
                start <= event['started_ms'] < as_of
            ):
                continue

            dt = datetime.fromtimestamp(
                event['started_ms'] / 1000,
                KST
            )

            if unit == 'day':
                key = dt.date().isoformat()

            else:
                key = (
                    dt.date()
                    - timedelta(days=dt.weekday())
                ).isoformat()

            bucket = buckets.setdefault(
                key,
                {
                    'turtle': 0,
                    'shrimp': 0
                }
            )

            kind = (
                'turtle'
                if event['state'] == 'TURTLE'
                else 'shrimp'
            )

            bucket[kind] += 1

        trend = {
            kind: [
                {
                    'label': key[5:].replace('-', '/'),
                    'count': buckets[key][kind]
                }
                for key in sorted(buckets)
            ]
            for kind in ('turtle', 'shrimp')
        }

        # 자세별 시간 분포
        total = current['measuredSec']

        mapping = [
            ('good', 'GOOD'),
            ('turtle', 'TURTLE'),
            ('shrimp', 'WAIST'),
            ('other', 'CLOSE')
        ]

        distribution = (
            None if total == 0 else {
                'totalSec': round_or_none(total),

                'items': [
                    {
                        'type': label,

                        'sec': round_or_none(
                            current['seconds'][state]
                        ),

                        'ratio': round_or_none(
                            current['seconds'][state]
                            / total * 100
                        )
                    }
                    for label, state in mapping
                ]
            }
        )

        # 최근 자세 기록
        type_map = {
            'GOOD': 'good',
            'TURTLE': 'turtle',
            'WAIST': 'shrimp'
        }

        records = []

        for event in current_events:

            if event['state'] not in type_map:
                continue

            if not (
                start <= event['started_ms'] < as_of
            ):
                continue

            records.append({
                'id': event['id'],
                'startedAt': event['started_ms'],
                'type': type_map[event['state']],

                'durationSec': round_or_none(
                    event['duration_sec']
                )
            })

        return jsonify({
            'summary': summary,
            'trend': trend,
            'distribution': distribution,
            'records': records
        })

    except ValueError as exc:
        return fail(exc)


# ==================================================
# 15. Flask 서버 실행
# ==================================================

if __name__ == '__main__':

    # MariaDB 테이블 및 초기 상태 생성
    init_db()

    # C 담당 프론트: 5173
    # D 담당 Flask: 5000
    app.run(
        host='127.0.0.1',
        port=5000,
        debug=True
    )
