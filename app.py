# 거북이 방지턱 프로젝트 - Flask 백엔드
# 역할: 웹페이지 제공 + 측정 세션 관리 + SQLite 데이터 저장/조회 + 통계 계산

from flask import Flask, jsonify, request, send_from_directory
import sqlite3                    # Python 내장 SQLite 데이터베이스 라이브러리
import uuid                       # 세션마다 고유한 ID를 만들기 위한 라이브러리
import math                       # 숫자가 정상적인 값인지 검사할 때 사용
from pathlib import Path
from datetime import datetime, timezone

# app.py 파일이 위치한 폴더를 기준으로 파일 경로를 설정한다.
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / 'posture.db'   # 측정 기록을 보관할 SQLite 파일
app = Flask(__name__)              # Flask 웹 애플리케이션 생성


def now_ms():
    """현재 시각을 밀리초 단위의 타임스탬프로 반환한다."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def get_db():
    """SQLite에 연결하고, SQL 조회 결과를 컬럼명으로 읽을 수 있게 설정한다."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')  # 세션과 측정 데이터 간 관계 검사
    return conn


def init_db():
    """프로그램 실행 시 필요한 테이블이 없으면 자동 생성한다."""
    with get_db() as conn:
        # sessions: 한 번의 측정을 하나의 세션으로 관리
        conn.execute('''CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            start_time INTEGER NOT NULL,
            end_time INTEGER
        )''')

        # events: 세션별 측정 시각, 자세 각도, 판정 상태를 저장
        conn.execute('''CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            ts INTEGER NOT NULL,
            angle REAL NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('good', 'warn', 'bad')),
            FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
        )''')

        # 특정 세션의 측정 기록을 더 빠르게 조회하기 위한 인덱스
        conn.execute('CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)')


def get_session(conn, session_id):
    """세션 ID로 해당 세션을 한 건 조회한다. 없으면 None을 반환한다."""
    return conn.execute('SELECT * FROM sessions WHERE session_id = ?', (session_id,)).fetchone()


# ───────────────────── 1. 웹페이지 파일 제공 ─────────────────────

@app.get('/')
def home():
    # http://127.0.0.1:5000/ 접속 시 index.html을 보여준다.
    return send_from_directory(BASE_DIR, 'index.html')


@app.get('/css/<path:filename>')
def css(filename):
    # 브라우저가 요청하는 CSS 파일을 전달한다.
    return send_from_directory(BASE_DIR / 'css', filename)


@app.get('/js/<path:filename>')
def js(filename):
    # 브라우저가 요청하는 JavaScript 파일을 전달한다.
    return send_from_directory(BASE_DIR / 'js', filename)


# ───────────────────── 2. 측정 세션 시작 ─────────────────────

@app.post('/api/sessions')
def start_session():
    # UUID를 사용해 측정마다 중복 가능성이 매우 낮은 고유 ID 생성
    session_id = str(uuid.uuid4())
    start_time = now_ms()

    # sessions 테이블에 새 측정 세션을 저장한다.
    with get_db() as conn:
        conn.execute('INSERT INTO sessions (session_id, start_time) VALUES (?, ?)', (session_id, start_time))

    # 생성된 세션 ID와 시작 시간을 JSON으로 반환 (201: 생성 성공)
    return jsonify({'sessionId': session_id, 'startTime': start_time}), 201


# ───────────────────── 3. 자세 측정 데이터 저장 ─────────────────────

@app.post('/api/sessions/<session_id>/events')
def save_events(session_id):
    # 브라우저에서 보낸 JSON 요청 본문을 읽는다.
    payload = request.get_json(silent=True)

    # {"events": [...]} 형태의 배열이 있는지 확인한다.
    if not isinstance(payload, dict) or not isinstance(payload.get('events'), list):
        return jsonify({'error': 'events 배열이 필요합니다.'}), 400

    events = payload['events']

    # 한 번에 너무 많은 데이터를 저장하지 못하도록 제한한다.
    if len(events) > 1000:
        return jsonify({'error': '한 번에 최대 1000건까지 저장할 수 있습니다.'}), 400

    # 각 측정 데이터의 시각(ts), 각도(angle), 상태(status)를 검사한다.
    for event in events:
        if not isinstance(event, dict):
            return jsonify({'error': '측정 데이터 형식이 잘못되었습니다.'}), 400

        ts, angle, status = event.get('ts'), event.get('angle'), event.get('status')
        if (type(ts) is not int or ts < 0 or type(angle) not in (int, float)
                or not math.isfinite(angle) or not 0 <= angle <= 180
                or status not in ('good', 'warn', 'bad')):
            return jsonify({'error': 'ts, angle, status 값을 확인하세요.'}), 400

    with get_db() as conn:
        session = get_session(conn, session_id)

        # 존재하지 않는 세션에는 저장할 수 없다 (404).
        if session is None:
            return jsonify({'error': '세션을 찾을 수 없습니다.'}), 404

        # 이미 종료된 세션에는 데이터를 추가하지 않는다 (409).
        if session['end_time'] is not None:
            return jsonify({'error': '이미 종료된 세션입니다.'}), 409

        # 여러 측정 결과를 events 테이블에 한 번에 저장한다.
        # SQL의 ?는 값을 안전하게 전달하기 위한 자리 표시자다.
        conn.executemany(
            'INSERT INTO events (session_id, ts, angle, status) VALUES (?, ?, ?, ?)',
            [(session_id, e['ts'], e['angle'], e['status']) for e in events]
        )

    # 저장한 측정 건수를 브라우저에 알려준다.
    return jsonify({'savedCount': len(events)}), 201


# ───────────────────── 4. 측정 세션 종료 ─────────────────────

@app.post('/api/sessions/<session_id>/end')
def end_session(session_id):
    with get_db() as conn:
        session = get_session(conn, session_id)
        if session is None:
            return jsonify({'error': '세션을 찾을 수 없습니다.'}), 404

        # 종료 시간이 없다면 현재 시각을 기록하고, 이미 있으면 기존 값을 유지한다.
        end_time = session['end_time'] if session['end_time'] is not None else now_ms()
        conn.execute('UPDATE sessions SET end_time = ? WHERE session_id = ?', (end_time, session_id))

    return jsonify({'sessionId': session_id, 'endTime': end_time})


# ───────────────────── 5. 전체 측정 기록 조회 ─────────────────────

@app.get('/api/sessions')
def list_sessions():
    with get_db() as conn:
        # LEFT JOIN으로 세션과 측정 데이터를 연결하고, COUNT로 측정 건수를 센다.
        # 측정 데이터가 없는 세션도 목록에 포함된다.
        rows = conn.execute('''SELECT s.session_id, s.start_time, s.end_time,
                            COUNT(e.id) AS total_events FROM sessions s
                            LEFT JOIN events e ON e.session_id = s.session_id
                            GROUP BY s.session_id ORDER BY s.start_time DESC''').fetchall()

    # DB 조회 결과를 브라우저가 사용할 수 있는 JSON 목록으로 변환한다.
    return jsonify([{'sessionId': r['session_id'], 'startTime': r['start_time'],
                    'endTime': r['end_time'], 'totalEvents': r['total_events']} for r in rows])


# ───────────────────── 6. 특정 세션의 상세 기록 조회 ─────────────────────

@app.get('/api/sessions/<session_id>')
def session_detail(session_id):
    with get_db() as conn:
        session = get_session(conn, session_id)
        if session is None:
            return jsonify({'error': '세션을 찾을 수 없습니다.'}), 404

        # 해당 세션의 모든 측정 결과를 측정 시각 순서대로 조회한다.
        events = conn.execute('SELECT ts, angle, status FROM events WHERE session_id = ? ORDER BY ts, id', (session_id,)).fetchall()

    return jsonify({'sessionId': session_id, 'startTime': session['start_time'],
                    'endTime': session['end_time'], 'events': [dict(e) for e in events]})


# ───────────────────── 7. 평균 각도 및 나쁜 자세 비율 계산 ─────────────────────

@app.get('/api/sessions/<session_id>/stats')
def session_stats(session_id):
    with get_db() as conn:
        if get_session(conn, session_id) is None:
            return jsonify({'error': '세션을 찾을 수 없습니다.'}), 404

        # COUNT: 전체 측정 건수 / AVG: 평균 각도
        # SUM(CASE ...): status가 bad인 측정 건수
        row = conn.execute('''SELECT COUNT(*) AS total_events, AVG(angle) AS average_angle,
                            SUM(CASE WHEN status = 'bad' THEN 1 ELSE 0 END) AS bad_count
                            FROM events WHERE session_id = ?''', (session_id,)).fetchone()

    total = row['total_events']

    # badRatio는 실제 지속 시간이 아닌 'bad 판정 건수의 비율'이다.
    # 데이터가 0건일 때 0으로 나누는 오류를 방지한다.
    return jsonify({'averageAngle': round(row['average_angle'], 1) if total else 0,
                    'badRatio': round(row['bad_count'] / total * 100, 1) if total else 0,
                    'totalEvents': total})


# 서버 시작 시 필요한 SQLite 테이블을 준비한다.
init_db()

# app.py를 직접 실행할 때만 개발용 Flask 서버를 시작한다.
if __name__ == '__main__':
    app.run(debug=True, port=5000)  # debug=True는 로컬 개발용으로만 사용