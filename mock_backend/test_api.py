"""Mock Backend API 테스트 — 명세 v0.3.3의 저장·검증·집계 규칙 확인용.

실행(Mock 서버를 먼저 켠 뒤):  python mock_backend/test_api.py [base_url]
기본 base_url = http://127.0.0.1:5050
※ 시작할 때 /__mock/reset 으로 Mock 메모리를 비운다. 실제 D 서버에는 실행하지 말 것.
테스트 데이터는 이 스크립트 안에서만 만든다(실측값 아님).
"""
import json
import sys
import uuid
import urllib.request
import urllib.error

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:5050').rstrip('/')
results = []


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def check(tid, name, cond, detail=''):
    results.append((tid, name, bool(cond), detail))


def ev(eid, state, start, end, final, alert=False):
    return {'event_id': eid, 'state': state, 'started_at_ms': start, 'ended_at_ms': end, 'is_final': final, 'alert_triggered': alert}


def U():
    return str(uuid.uuid4())


call('POST', '/__mock/reset', {})

# 기준 시각: 지금보다 1시간 전(오늘 범위 안에 들어가도록 KST 자정 이후라고 가정하지 않고 as_of를 넉넉히 둔다)
import time
NOW = int(time.time() * 1000)
T0 = NOW - 60 * 60 * 1000

# T17 기록 전혀 없음 → null
s, b = call('GET', f'/api/summary/home?as_of_ms={NOW}')
check('T17a', '기록 없음 홈 measured_sec=null', s == 200 and b == {'measured_sec': None}, b)
s, b = call('GET', f'/api/stats?period=today&unit=day&as_of_ms={NOW}')
check('T17b', '기록 없음 stats 빈 응답', s == 200 and b['summary'] is None and b['distribution'] is None and b['records'] == [] and b['trend'] == {'turtle': [], 'shrimp': []}, b)

# 6.1 세션 생성
s, b = call('POST', '/api/sessions', {'started_at_ms': T0})
check('API-1', 'POST /sessions 201 + session_id', s == 201 and b['session_id'] == 1 and b['started_at_ms'] == T0, (s, b))
SID = b['session_id']

# T03/T17 CALIB만 있을 때: 홈 0, stats 유효 0
calib = U()
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(calib, 'CALIB', T0, T0 + 3000, True)]})
check('API-2', 'POST /events 200 saved=1', s == 200 and b == {'ok': True, 'received_count': 1, 'saved': 1, 'updated': 0, 'ignored': 0}, b)
s, b = call('GET', f'/api/summary/home?as_of_ms={NOW}')
check('T17c', 'CALIB만 → measured_sec=0', b == {'measured_sec': 0}, b)

# T05 스냅샷 10→20초, T06 최종 30초, T07 연장 시도, T08 멱등·경고값 변경, T09 오래된 스냅샷
tur = U(); ts = T0 + 3000
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 10000, False, True)]})
check('T05a', '스냅샷 10초 저장', b.get('saved') == 1, b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 20000, False, False)]})
check('T05b', '같은 UUID 20초 스냅샷 → updated', b.get('updated') == 1, b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 15000, False, False)]})
check('T05c', '더 짧은 스냅샷 → ignored', b.get('ignored') == 1, b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 30000, True, True)]})
check('T06', '최종 30초 → updated', b.get('updated') == 1, b)
dump = call('GET', '/__mock/dump')[1]
e = [x for x in dump['events'] if x['event_id'] == tur][0]
check('T06b', 'DB 1건·is_final=true·30초·alert=true(OR)', len([x for x in dump['events'] if x['event_id'] == tur]) == 1 and e['is_final'] and e['ended_at_ms'] == ts + 30000 and e['alert_triggered'], e)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 40000, True, True)]})
check('T07', '최종화 후 연장 → 409 EVENT_FINALIZED', s == 409 and b['error']['reason'] == 'EVENT_FINALIZED', b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 30000, True, True)]})
check('T08a', '동일 최종 재전송 → 멱등 200 ignored', s == 200 and b.get('ignored') == 1, b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 30000, True, False)]})
check('T08b', '최종화 후 경고값 변경 → 409 EVENT_FINALIZED', s == 409 and b['error']['reason'] == 'EVENT_FINALIZED', b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'TURTLE', ts, ts + 20000, False, True)]})
check('T09', '최종화 후 오래된 스냅샷 → ignored, 변경 없음', s == 200 and b.get('ignored') == 1, b)

# T11 경계 일치 정상, T10 겹침, T12 0초
good = U(); g0 = ts + 30000
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(good, 'GOOD', g0, g0 + 60000, True)]})
check('T11', 'TURTLE 종료 = GOOD 시작 → 정상', s == 200 and b.get('saved') == 1, b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(U(), 'WAIST', g0 + 1000, g0 + 5000, True)]})
check('T10', '다른 UUID 겹침 → 409 EVENT_OVERLAP', s == 409 and b['error']['reason'] == 'EVENT_OVERLAP', b)
before = len(call('GET', '/__mock/dump')[1]['events'])
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(U(), 'CLOSE', g0 + 60000, g0 + 70000, True), ev(U(), 'WAIST', g0 + 1000, g0 + 2000, True)]})
after = len(call('GET', '/__mock/dump')[1]['events'])
check('T10b', '요청 일부 실패 → 전체 롤백', s == 409 and before == after, (s, before, after))
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(U(), 'CLOSE', g0 + 60000, g0 + 60000, True)]})
check('T12', '0초 이벤트 → 400 INVALID_REQUEST', s == 400 and b['error']['reason'] == 'INVALID_REQUEST', b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(U(), 'GOOD', T0 - 5000, T0 - 1000, True)]})
check('T-RANGE', '세션 시작 이전 → 409 EVENT_OUT_OF_RANGE', s == 409 and b['error']['reason'] == 'EVENT_OUT_OF_RANGE', b)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(tur, 'WAIST', ts, ts + 30000, True)]})
check('T-UUID', '같은 UUID·다른 상태 → 409 EVENT_ID_CONFLICT', s == 409 and b['error']['reason'] == 'EVENT_ID_CONFLICT', b)
s, b = call('POST', '/api/sessions/999/events', {'events': []})
check('T-404', '없는 세션 → 404 SESSION_NOT_FOUND', s == 404 and b['error']['reason'] == 'SESSION_NOT_FOUND', b)

# T21 경고 이어지는 WAIST(false) + CLOSE + 마지막 구간을 /end에 동봉, T14 종료 재전송
w0 = g0 + 60000
waist = U(); close = U()
end_body = {'ended_at_ms': w0 + 30000, 'reason': 'camera_off', 'events': [
    ev(waist, 'WAIST', w0, w0 + 20000, True, False), ev(close, 'CLOSE', w0 + 20000, w0 + 30000, True)]}
s, b = call('POST', f'/api/sessions/{SID}/end', end_body)
total_expect = round((w0 + 30000 - T0) / 1000)
valid_expect = round(30 + 60 + 20 + 10)
check('API-3', 'POST /end 200 + total/valid 계산', s == 200 and b['total_duration_sec'] == total_expect and b['valid_duration_sec'] == valid_expect, (b, total_expect, valid_expect))
s2, b2 = call('POST', f'/api/sessions/{SID}/end', {'ended_at_ms': w0 + 99999, 'reason': 'camera_off'})
check('T14', '종료 재전송 → 200 기존 결과(본문 무시)', s2 == 200 and b2 == b, b2)
s, b = call('POST', f'/api/sessions/{SID}/events', {'events': [ev(U(), 'GOOD', w0 + 40000, w0 + 50000, True)]})
check('T15', '종료 후 /events → 409 SESSION_CLOSED', s == 409 and b['error']['reason'] == 'SESSION_CLOSED', b)

# 홈·통계 집계 (명세 7장): GOOD 60 + TURTLE 30 + WAIST 20 + CLOSE 10 = 120초
s, b = call('GET', f'/api/summary/home?as_of_ms={NOW}')
check('API-4', '홈 measured_sec = 120', b == {'measured_sec': 120}, b)
s, st = call('GET', f'/api/stats?period=today&unit=day&as_of_ms={NOW}')
sm = st['summary'] if s == 200 else {}
check('API-5a', 'stats measuredSec=120', sm.get('measuredSec', {}).get('value') == 120, sm)
check('API-5b', 'turtleCount=1, shrimpCount=1', sm.get('turtleCount', {}).get('value') == 1 and sm.get('shrimpCount', {}).get('value') == 1, sm)
check('API-5c', 'goodRatio = 60/120 = 50 (CLOSE는 분모만)', sm.get('goodRatio', {}).get('value') == 50, sm)
check('API-5d', 'avgDurationSec = (30+20)/2 = 25', sm.get('avgDurationSec', {}).get('value') == 25, sm)
items = {i['type']: i for i in (st.get('distribution') or {}).get('items', [])}
check('API-5e', '분포 good50/turtle25/shrimp16.67/other8.33', items and items['good']['ratio'] == 50 and items['turtle']['ratio'] == 25 and items['shrimp']['ratio'] == 16.67 and items['other']['ratio'] == 8.33, items)
recs = st.get('records', [])
check('API-5f', 'records: GOOD/TURTLE/WAIST만, 최신순', [r['type'] for r in recs] == ['shrimp', 'good', 'turtle'] and recs[0]['startedAt'] >= recs[-1]['startedAt'], recs)
tr = st.get('trend', {})
check('API-5g', 'trend today 버킷 1개(turtle 1, shrimp 1)', len(tr.get('turtle', [])) == 1 and tr['turtle'][0]['count'] == 1 and tr['shrimp'][0]['count'] == 1, tr)
check('API-5h', 'prev(어제)는 기록 없음 → null', sm.get('measuredSec', {}).get('prev') is None, sm)
s, b = call('GET', '/api/stats?period=year&unit=day')
check('T-PERIOD', '잘못된 period → 400', s == 400, b)

ok = sum(1 for r in results if r[2])
for tid, name, passed, detail in results:
    print(('PASS' if passed else 'FAIL'), tid, name, '' if passed else f'  -> {detail}')
print(f'\n{ok}/{len(results)} passed')
sys.exit(0 if ok == len(results) else 1)
