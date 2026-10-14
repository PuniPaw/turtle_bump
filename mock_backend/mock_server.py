"""NeckCare Mock Backend — API 명세서 v0.3.3 테스트 전용 서버.

실제 D 백엔드(Flask + MariaDB, 127.0.0.1:5000)를 대신해 프론트엔드 통합 테스트에만 쓴다.
  - 저장소: 메모리(서버를 끄면 사라짐). 실제 DB·실제 사용자 데이터와 섞이지 않는다.
  - 포트: 5050 (실제 D 서버 5000과 분리)
  - 표준 라이브러리만 사용 (pip 설치 불필요)

실행:  python mock_backend/mock_server.py          (기본 127.0.0.1:5050)
       python mock_backend/mock_server.py 5051     (포트 지정)

API (명세 6장):
  POST /api/sessions
  POST /api/sessions/{session_id}/events
  POST /api/sessions/{session_id}/end
  GET  /api/summary/home?as_of_ms=
  GET  /api/stats?period=today|week|month&unit=day|week&as_of_ms=
테스트 보조(명세 밖, /__mock/ 아래):
  POST /__mock/reset   메모리 초기화
  GET  /__mock/dump    저장 내용 확인
"""
import json
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

KST = timezone(timedelta(hours=9))
DAY_MS = 24 * 60 * 60 * 1000
MAX_EVENTS = 500
MAX_MS = 32503680000000

# 명세 3장
STATES = {
    'GOOD': {'counted': True, 'alert': False},
    'TURTLE': {'counted': True, 'alert': True},
    'WAIST': {'counted': True, 'alert': True},
    'CLOSE': {'counted': True, 'alert': False},
    'NOVIS': {'counted': False, 'alert': False},
    'CALIB': {'counted': False, 'alert': False},
    'IDLE': {'counted': False, 'alert': False},
}
COUNTED = {s for s, v in STATES.items() if v['counted']}

ALLOWED_ORIGINS = {
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://localhost:5174', 'http://127.0.0.1:5174',
}

LOCK = threading.Lock()
DB = {'sessions': {}, 'events': {}, 'next_id': 1}


class ApiError(Exception):
    def __init__(self, status, reason, message):
        super().__init__(message)
        self.status, self.reason, self.message = status, reason, message


def now_ms():
    return int(time.time() * 1000)


def is_ms(v):
    return type(v) is int and 0 <= v <= MAX_MS


def r2(v):
    return None if v is None else round(float(v), 2)


# ---------------------------------------------------------------- 이벤트 검증·upsert (명세 5장)

def parse_event(raw):
    if not isinstance(raw, dict):
        raise ApiError(400, 'INVALID_REQUEST', '이벤트는 JSON 객체여야 합니다.')
    try:
        eid = str(uuid.UUID(str(raw['event_id'])))
    except (KeyError, ValueError):
        raise ApiError(400, 'INVALID_REQUEST', 'event_id는 UUID여야 합니다.')
    state = raw.get('state')
    if state not in STATES:
        raise ApiError(400, 'INVALID_REQUEST', f'허용되지 않은 상태: {state}')
    start = raw.get('started_at_ms')
    if not is_ms(start):
        raise ApiError(400, 'INVALID_REQUEST', 'started_at_ms는 epoch 밀리초 정수여야 합니다.')
    if 'ended_at_ms' not in raw:
        raise ApiError(400, 'INVALID_REQUEST', 'ended_at_ms(정수 또는 null)가 필요합니다.')
    end = raw['ended_at_ms']
    if end is not None and not is_ms(end):
        raise ApiError(400, 'INVALID_REQUEST', 'ended_at_ms는 정수 또는 null이어야 합니다.')
    if type(raw.get('is_final')) is not bool:
        raise ApiError(400, 'INVALID_REQUEST', 'is_final(boolean)이 필요합니다.')
    final = raw['is_final']
    alert = raw.get('alert_triggered', False)
    if type(alert) is not bool:
        raise ApiError(400, 'INVALID_REQUEST', 'alert_triggered는 boolean이어야 합니다.')
    if final and end is None:
        raise ApiError(400, 'INVALID_REQUEST', 'is_final=true이면 ended_at_ms가 필요합니다.')
    if end is not None and not end > start:
        raise ApiError(400, 'INVALID_REQUEST', 'ended_at_ms는 started_at_ms보다 커야 합니다(0초·역행 금지).')
    return {'event_id': eid, 'state': state, 'started_at_ms': start, 'ended_at_ms': end,
            'is_final': final, 'alert_triggered': alert}


def conflicts(a, b):
    """반열린 구간 [start, end). 종료 미상(null)은 시작 시점 하나로 본다."""
    a1, a2 = a['started_at_ms'], a['ended_at_ms']
    b1, b2 = b['started_at_ms'], b['ended_at_ms']
    if a1 == b1:
        return True
    if a2 is None and b2 is None:
        return False
    if a2 is None:
        return b1 <= a1 < b2
    if b2 is None:
        return a1 <= b1 < a2
    return a1 < b2 and b1 < a2


def upsert_all(events_db, session, raws, end_limit=None):
    """요청 이벤트 전부를 검증한 뒤 events_db(사본)에 반영. 실패하면 예외(호출자가 롤백)."""
    if not isinstance(raws, list) or len(raws) > MAX_EVENTS:
        raise ApiError(400, 'INVALID_REQUEST', f'events는 최대 {MAX_EVENTS}개 배열이어야 합니다.')
    parsed = [parse_event(r) for r in raws]
    sid = session['session_id']
    saved = updated = ignored = 0
    for ev in parsed:
        if ev['started_at_ms'] < session['started_at_ms']:
            raise ApiError(409, 'EVENT_OUT_OF_RANGE', '이벤트가 세션 시작보다 빠릅니다.')
        limit = end_limit if end_limit is not None else session['ended_at_ms']
        if limit is not None and ((ev['ended_at_ms'] or ev['started_at_ms']) > limit):
            raise ApiError(409, 'EVENT_OUT_OF_RANGE', '이벤트가 세션 종료보다 늦습니다.')

        old = events_db.get(ev['event_id'])
        if old is not None and (old['session_id'] != sid or old['state'] != ev['state']
                                or old['started_at_ms'] != ev['started_at_ms']):
            raise ApiError(409, 'EVENT_ID_CONFLICT', '같은 event_id가 다른 구간에 이미 사용됐습니다.')

        if old is None:
            new = {**ev, 'session_id': sid}
            kind = 'saved'
        elif old['is_final']:
            same = (ev['is_final'] and ev['ended_at_ms'] == old['ended_at_ms']
                    and ev['alert_triggered'] == old['alert_triggered'])
            stale = (not ev['is_final'] and ev['ended_at_ms'] is not None
                     and ev['ended_at_ms'] <= old['ended_at_ms'])
            stale_open = not ev['is_final'] and ev['ended_at_ms'] is None
            if same or stale or stale_open:
                ignored += 1          # 멱등 재전송 / 늦게 도착한 예전 스냅샷: 변경 없음
                continue
            raise ApiError(409, 'EVENT_FINALIZED', '이미 최종화된 이벤트는 변경할 수 없습니다.')
        else:
            new = dict(old)
            if ev['is_final']:
                if old['ended_at_ms'] is not None and ev['ended_at_ms'] < old['ended_at_ms']:
                    raise ApiError(409, 'EVENT_TIME_REGRESSION', '스냅샷보다 이른 최종 종료 시각입니다.')
                new['ended_at_ms'] = ev['ended_at_ms']
                new['is_final'] = True
            elif ev['ended_at_ms'] is not None and (old['ended_at_ms'] is None or ev['ended_at_ms'] > old['ended_at_ms']):
                new['ended_at_ms'] = ev['ended_at_ms']
            new['alert_triggered'] = old['alert_triggered'] or ev['alert_triggered']
            if new == old:
                ignored += 1
                continue
            kind = 'updated'

        for other in events_db.values():
            if other['session_id'] == sid and other['event_id'] != new['event_id'] and conflicts(new, other):
                raise ApiError(409, 'EVENT_OVERLAP', '이벤트 시간이 겹칩니다.')
        events_db[new['event_id']] = new
        if kind == 'saved':
            saved += 1
        else:
            updated += 1
    return {'ok': True, 'received_count': saved + updated + ignored,
            'saved': saved, 'updated': updated, 'ignored': ignored}


def duration_sec(ev):
    return 0.0 if ev['ended_at_ms'] is None else round((ev['ended_at_ms'] - ev['started_at_ms']) / 1000, 3)


# ---------------------------------------------------------------- 통계 (명세 7장)

def kst_midnight(ms):
    d = datetime.fromtimestamp(ms / 1000, KST)
    return int(d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)


def period_bounds(period, as_of):
    mid = kst_midnight(as_of)
    if period == 'today':
        return (mid, as_of), (mid - DAY_MS, as_of - DAY_MS)
    if period == 'week':
        start = mid - 6 * DAY_MS
        return (start, as_of), (start - 7 * DAY_MS, start)
    if period == 'month':
        start = mid - 29 * DAY_MS
        return (start, as_of), (start - 30 * DAY_MS, start)
    raise ApiError(400, 'INVALID_REQUEST', 'period는 today, week, month 중 하나여야 합니다.')


def clipped(ev, a, b):
    if ev['ended_at_ms'] is None:
        return 0.0
    return max(0, min(ev['ended_at_ms'], b) - max(ev['started_at_ms'], a)) / 1000


def touches(ev, a, b):
    end = ev['ended_at_ms']
    if end is None:
        return a <= ev['started_at_ms'] < b
    return ev['started_at_ms'] < b and end > a


def any_record(sessions, events, a, b):
    for s in sessions:
        s_end = s['ended_at_ms'] if s['ended_at_ms'] is not None else MAX_MS
        if s['started_at_ms'] < b and s_end > a:
            return True
    return any(touches(e, a, b) for e in events)


def aggregate(events, a, b):
    sec = {s: 0.0 for s in STATES}
    bad = []
    for e in events:
        if not touches(e, a, b):
            continue
        c = clipped(e, a, b)
        sec[e['state']] += c
        if e['state'] in ('TURTLE', 'WAIST'):
            bad.append(c)
    valid = sum(sec[s] for s in COUNTED)
    counts = {k: sum(1 for e in events if e['state'] == k and a <= e['started_at_ms'] < b) for k in ('TURTLE', 'WAIST')}
    return {
        'sec': sec, 'valid': valid,
        'measuredSec': valid,
        'turtleCount': counts['TURTLE'],
        'shrimpCount': counts['WAIST'],
        'goodRatio': (sec['GOOD'] / valid * 100) if valid > 0 else None,
        'avgDurationSec': (sum(bad) / len(bad)) if bad else None,
    }


def bucket_key(ms, unit):
    d = datetime.fromtimestamp(ms / 1000, KST).date()
    if unit == 'week':
        d = d - timedelta(days=d.weekday())
    return d


def build_stats(period, unit, as_of):
    if unit not in ('day', 'week'):
        raise ApiError(400, 'INVALID_REQUEST', 'unit은 day 또는 week여야 합니다.')
    (a, b), (pa, pb) = period_bounds(period, as_of)
    sessions = list(DB['sessions'].values())
    events = list(DB['events'].values())

    if not any_record(sessions, events, a, b):
        return {'summary': None, 'trend': {'turtle': [], 'shrimp': []}, 'distribution': None, 'records': []}

    cur = aggregate(events, a, b)
    prev = aggregate(events, pa, pb)
    prev_has = prev['valid'] > 0   # 이전 기간 유효 기록이 전혀 없으면 null

    def metric(key):
        return {'value': r2(cur[key]), 'prev': r2(prev[key]) if prev_has else None}

    summary = {k: metric(k) for k in ('measuredSec', 'turtleCount', 'shrimpCount', 'goodRatio', 'avgDurationSec')}
    for k in ('turtleCount', 'shrimpCount'):
        summary[k]['value'] = int(cur[k])
        summary[k]['prev'] = int(prev[k]) if prev_has else None

    if cur['valid'] <= 0:
        # 기록은 있으나 유효 0초(명세 6.5 예시): 추이·분포·기록은 비움
        return {'summary': summary, 'trend': {'turtle': [], 'shrimp': []}, 'distribution': None, 'records': []}

    # 추이: 기간 안 모든 버킷을 0으로 채운 뒤 TURTLE/WAIST 시작 시각으로 집계
    keys = []
    d = bucket_key(a, unit)
    last = bucket_key(b - 1, unit)
    step = timedelta(days=7 if unit == 'week' else 1)
    while d <= last:
        keys.append(d)
        d += step
    counts = {k: {'turtle': 0, 'shrimp': 0} for k in keys}
    for e in events:
        if e['state'] in ('TURTLE', 'WAIST') and a <= e['started_at_ms'] < b:
            k = bucket_key(e['started_at_ms'], unit)
            if k in counts:
                counts[k]['turtle' if e['state'] == 'TURTLE' else 'shrimp'] += 1
    trend = {kind: [{'label': k.strftime('%m/%d'), 'count': counts[k][kind]} for k in keys] for kind in ('turtle', 'shrimp')}

    total = cur['valid']
    distribution = {
        'totalSec': r2(total),
        'items': [{'type': t, 'sec': r2(cur['sec'][s]), 'ratio': r2(cur['sec'][s] / total * 100)}
                  for t, s in (('good', 'GOOD'), ('turtle', 'TURTLE'), ('shrimp', 'WAIST'), ('other', 'CLOSE'))],
    }

    type_map = {'GOOD': 'good', 'TURTLE': 'turtle', 'WAIST': 'shrimp'}
    rec = [e for e in events if e['state'] in type_map and a <= e['started_at_ms'] < b]
    rec.sort(key=lambda e: e['event_id'])
    rec.sort(key=lambda e: e['started_at_ms'], reverse=True)
    records = [{'id': e['event_id'], 'startedAt': e['started_at_ms'], 'type': type_map[e['state']],
                'durationSec': None if e['ended_at_ms'] is None else r2(clipped(e, a, b))} for e in rec[:100]]

    return {'summary': summary, 'trend': trend, 'distribution': distribution, 'records': records}


def home_summary(as_of):
    if not DB['sessions'] and not DB['events']:
        return {'measured_sec': None}
    total = sum(clipped(e, 0, as_of) for e in DB['events'].values() if e['state'] in COUNTED)
    return {'measured_sec': int(round(total))}


# ---------------------------------------------------------------- HTTP

def get_session(sid):
    s = DB['sessions'].get(sid)
    if s is None:
        raise ApiError(404, 'SESSION_NOT_FOUND', '세션이 없습니다.')
    return s


def handle_post(path, body):
    parts = [p for p in path.split('/') if p]
    if parts == ['__mock', 'reset']:
        DB['sessions'].clear(); DB['events'].clear(); DB['next_id'] = 1
        return 200, {'ok': True}
    if not isinstance(body, dict):
        raise ApiError(400, 'INVALID_REQUEST', 'JSON 객체를 보내야 합니다.')

    if parts == ['api', 'sessions']:
        started = body.get('started_at_ms', now_ms())
        if not is_ms(started):
            raise ApiError(400, 'INVALID_REQUEST', 'started_at_ms는 epoch 밀리초 정수여야 합니다.')
        sid = DB['next_id']; DB['next_id'] += 1
        DB['sessions'][sid] = {'session_id': sid, 'started_at_ms': started, 'ended_at_ms': None,
                               'total_duration_sec': 0, 'valid_duration_sec': 0, 'end_result': None}
        return 201, {'session_id': sid, 'started_at_ms': started}

    if len(parts) == 4 and parts[:2] == ['api', 'sessions'] and parts[2].isdigit():
        sid = int(parts[2])
        session = get_session(sid)
        if parts[3] == 'events':
            if session['ended_at_ms'] is not None:
                raise ApiError(409, 'SESSION_CLOSED', '종료된 세션에는 이벤트를 쓸 수 없습니다.')
            copy = dict(DB['events'])
            result = upsert_all(copy, session, body.get('events'))
            DB['events'] = copy
            return 200, result
        if parts[3] == 'end':
            if session['ended_at_ms'] is not None:
                return 200, session['end_result']      # 종료 재전송: 기존 결과(본문 무시)
            ended = body.get('ended_at_ms', now_ms())
            if not is_ms(ended) or ended < session['started_at_ms']:
                raise ApiError(400, 'INVALID_REQUEST', 'ended_at_ms가 올바르지 않습니다.')
            reason = body.get('reason')
            if reason is not None and reason not in ('camera_off', 'pagehide', 'input_ended'):
                raise ApiError(400, 'INVALID_REQUEST', 'reason은 camera_off|pagehide|input_ended 중 하나입니다.')
            copy = dict(DB['events'])
            upsert_all(copy, session, body.get('events', []), end_limit=ended)
            DB['events'] = copy
            valid = sum(duration_sec(e) for e in copy.values() if e['session_id'] == sid and e['state'] in COUNTED)
            session['ended_at_ms'] = ended
            session['total_duration_sec'] = int(round((ended - session['started_at_ms']) / 1000))
            session['valid_duration_sec'] = int(round(valid))
            session['end_reason'] = reason
            session['end_result'] = {'ok': True, 'session_id': sid, 'ended_at_ms': ended,
                                     'total_duration_sec': session['total_duration_sec'],
                                     'valid_duration_sec': session['valid_duration_sec']}
            return 200, session['end_result']
    raise ApiError(404, 'NOT_FOUND', '경로가 없습니다.')


def handle_get(path, query):
    def as_of():
        raw = query.get('as_of_ms', [None])[0]
        try:
            v = now_ms() if raw is None else int(raw)
        except ValueError:
            raise ApiError(400, 'INVALID_REQUEST', 'as_of_ms는 epoch 밀리초 정수여야 합니다.')
        if not is_ms(v):
            raise ApiError(400, 'INVALID_REQUEST', 'as_of_ms는 epoch 밀리초 정수여야 합니다.')
        return v

    if path == '/__mock/dump':
        return 200, {'sessions': list(DB['sessions'].values()),
                     'events': sorted(DB['events'].values(), key=lambda e: e['started_at_ms'])}
    if path == '/api/summary/home':
        return 200, home_summary(as_of())
    if path == '/api/stats':
        return 200, build_stats(query.get('period', ['today'])[0], query.get('unit', ['day'])[0], as_of())
    raise ApiError(404, 'NOT_FOUND', '경로가 없습니다.')


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Credentials', 'true')   # sendBeacon(자격 증명 포함) 허용
            self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _run(self, fn):
        try:
            with LOCK:   # 세션 단위 직렬화(명세 6.3) — 테스트 서버라 전체 잠금으로 단순화
                status, obj = fn()
            self._send(status, obj)
        except ApiError as e:
            self._send(e.status, {'ok': False, 'error': {'code': e.status, 'reason': e.reason, 'message': e.message}})
        except Exception:
            self._send(500, {'ok': False, 'error': {'code': 500, 'reason': 'INTERNAL_ERROR', 'message': '내부 오류'}})

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urlsplit(self.path)
        self._run(lambda: handle_get(u.path, parse_qs(u.query)))

    def do_POST(self):
        u = urlsplit(self.path)
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            body = json.loads(raw.decode('utf-8')) if raw else {}
        except ValueError:
            body = None
        self._run(lambda: handle_post(u.path, body))

    def log_message(self, fmt, *args):
        sys.stderr.write('[mock] ' + (fmt % args) + '\n')


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5050
    print(f'NeckCare Mock Backend (테스트 전용, 메모리 저장): http://127.0.0.1:{port}/api')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
