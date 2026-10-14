
import requests
import uuid
import time

BASE = "http://127.0.0.1:5000/api"

# 테스트 시각 생성
start = int(time.time() * 1000) - 30000
event_id = str(uuid.uuid4())

# 1. 세션 생성
res = requests.post(
    f"{BASE}/sessions",
    json={"started_at_ms": start}
)
print("1. 세션 생성:", res.status_code, res.json())
res.raise_for_status()

session_id = res.json()["session_id"]

# 2. 미확정 이벤트 저장 (10초)
event = {
    "event_id": event_id,
    "state": "TURTLE",
    "started_at_ms": start,
    "ended_at_ms": start + 10000,
    "is_final": False,
    "alert_triggered": False
}

res = requests.post(
    f"{BASE}/sessions/{session_id}/events",
    json={"events": [event]}
)
print("2. 미확정 저장:", res.status_code, res.json())

# 3. 이벤트 최종화 (20초)
final_event = {
    **event,
    "ended_at_ms": start + 20000,
    "is_final": True,
    "alert_triggered": True
}

res = requests.post(
    f"{BASE}/sessions/{session_id}/events",
    json={"events": [final_event]}
)
print("3. 최종화:", res.status_code, res.json())

# 4. 동일 최종 이벤트 재전송
res = requests.post(
    f"{BASE}/sessions/{session_id}/events",
    json={"events": [final_event]}
)
print("4. 동일 재전송:", res.status_code, res.json())

# 5. 최종화 후 경고값 변경 시도
changed_event = {
    **final_event,
    "alert_triggered": False
}

res = requests.post(
    f"{BASE}/sessions/{session_id}/events",
    json={"events": [changed_event]}
)
print("5. 경고값 변경 시도:", res.status_code, res.json())

# 6. 세션 종료
res = requests.post(
    f"{BASE}/sessions/{session_id}/end",
    json={
        "ended_at_ms": start + 30000,
        "reason": "camera_off",
        "events": []
    }
)
print("6. 세션 종료:", res.status_code, res.json())

# 7. 홈 통계 조회
res = requests.get(f"{BASE}/summary/home")
print("7. 홈 통계:", res.status_code, res.json())

# 8. 기간별 통계 조회
res = requests.get(
    f"{BASE}/stats",
    params={"period": "today", "unit": "day"}
)
print("8. 기간별 통계:", res.status_code, res.json())
