import requests
import time
import uuid

BASE_URL = "http://127.0.0.1:5000/api"

# 1. 세션 생성
print("===== 1. 세션 생성 =====")

start = int(time.time() * 1000)

response = requests.post(
    f"{BASE_URL}/sessions",
    json={"started_at_ms": start}
)

print(response.status_code, response.json())
response.raise_for_status()

session_id = response.json()["session_id"]


# 2. 거북목 이벤트 저장
print("\n===== 2. 자세 이벤트 저장 =====")

response = requests.post(
    f"{BASE_URL}/sessions/{session_id}/events",
    json={
        "events": [
            {
                "event_id": str(uuid.uuid4()),
                "state": "TURTLE",
                "started_at_ms": start,
                "ended_at_ms": start + 10000,
                "duration_sec": 10,
                "alert_triggered": True
            }
        ]
    }
)

print(response.status_code, response.json())
response.raise_for_status()


# 3. 세션 종료
print("\n===== 3. 세션 종료 =====")

response = requests.post(
    f"{BASE_URL}/sessions/{session_id}/end",
    json={
        "ended_at_ms": start + 10000,
        "reason": "camera_off"
    }
)

print(response.status_code, response.json())
response.raise_for_status()


# 4. 통계 조회
print("\n===== 4. 통계 조회 =====")

response = requests.get(
    f"{BASE_URL}/stats",
    params={"period": "today", "unit": "day"}
)

print(response.status_code, response.json())
response.raise_for_status()

print("\n===== API 테스트 완료 =====")