
import {
  startSession,
  saveEvents,
  endSession,
  sendEndBeacon
} from "./storage.js";

import {
  createStatsProvider,
  updateHomeMeasuredSec
} from "./stats.js";

const VALID_STATES = new Set([
  "GOOD",
  "TURTLE",
  "WAIST",
  "CLOSE",
  "NOVIS",
  "CALIB",
  "IDLE"
]);

const MAX_BATCH = 500;

let currentSessionId = null;
let pendingEvents = new Map();

let startingPromise = null;
let savingPromise = null;
let stoppingPromise = null;

let lastError = null;
let closing = false;

// 동일 UUID의 이벤트 정보를 병합
function mergeEvent(oldEvent, newEvent) {
  if (
    oldEvent.state !== newEvent.state ||
    oldEvent.started_at_ms !== newEvent.started_at_ms
  ) {
    throw new Error(
      "동일 UUID의 상태 또는 시작 시각이 다릅니다."
    );
  }

  const oldEnd = oldEvent.ended_at_ms;
  const newEnd = newEvent.ended_at_ms;

  let endedAt = null;

  if (oldEnd !== null && newEnd !== null) {
    endedAt = Math.max(oldEnd, newEnd);
  } else {
    endedAt = oldEnd ?? newEnd;
  }

  return {
    ...oldEvent,
    ended_at_ms: endedAt,
    alert_triggered:
      oldEvent.alert_triggered ||
      newEvent.alert_triggered
  };
}

// 이벤트 데이터 검증
function normalizeEvent(event) {
  if (!event || !VALID_STATES.has(event.state)) {
    throw new Error("올바르지 않은 자세 상태입니다.");
  }

  if (
    typeof event.event_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(event.event_id)
  ) {
    throw new Error("유효한 event_id UUID가 필요합니다.");
  }

  if (!Number.isInteger(event.started_at_ms)) {
    throw new Error("started_at_ms는 정수여야 합니다.");
  }

  if (
    event.ended_at_ms != null &&
    (
      !Number.isInteger(event.ended_at_ms) ||
      event.ended_at_ms < event.started_at_ms
    )
  ) {
    throw new Error("ended_at_ms가 올바르지 않습니다.");
  }

  return {
    event_id: event.event_id.toLowerCase(),
    state: event.state,
    started_at_ms: event.started_at_ms,
    ended_at_ms: event.ended_at_ms ?? null,
    alert_triggered: event.alert_triggered === true
  };
}

// 1. 카메라 연결 후 세션 생성
export async function beginMonitoring(
  startedAtMs = Date.now()
) {
  if (stoppingPromise) {
    await stoppingPromise;
  }

  if (closing) {
    throw new Error(
      "이전 세션 종료가 완료되지 않았습니다."
    );
  }

  if (currentSessionId !== null) {
    return currentSessionId;
  }

  if (startingPromise) {
    return startingPromise;
  }

  startingPromise = (async () => {
    const id = await startSession(startedAtMs);

    currentSessionId = id;
    pendingEvents.clear();
    lastError = null;

    return id;
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

// 2. C 담당이 자세 이벤트 전달
export async function receivePostureEvent(
  event,
  { flush = false } = {}
) {
  if (startingPromise) {
    await startingPromise;
  }

  if (currentSessionId === null || closing) {
    throw new Error(
      "측정 세션이 없거나 종료 중입니다."
    );
  }

  const normalized = normalizeEvent(event);
  const old = pendingEvents.get(normalized.event_id);

  pendingEvents.set(
    normalized.event_id,
    old
      ? mergeEvent(old, normalized)
      : normalized
  );

  // 기본은 대기열 저장
  // 통계 조회 전이나 명시적 요청 시 서버로 전송
  if (flush) {
    await flushEvents();
  }
}

// 3. 대기 중인 이벤트를 서버로 전송
export async function flushEvents() {
  if (startingPromise) {
    await startingPromise;
  }

  if (savingPromise) {
    return savingPromise;
  }

  if (
    currentSessionId === null ||
    pendingEvents.size === 0
  ) {
    return null;
  }

  const sessionId = currentSessionId;

  savingPromise = (async () => {
    while (pendingEvents.size > 0) {
      const batch = [...pendingEvents.values()]
        .slice(0, MAX_BATCH);

      try {
        await saveEvents(sessionId, batch);

        // 저장 중 새 스냅샷이 들어왔으면
        // 새로운 값은 삭제하지 않고 남긴다.
        for (const sent of batch) {
          const current = pendingEvents.get(sent.event_id);

          if (current === sent) {
            pendingEvents.delete(sent.event_id);
          }
        }

        lastError = null;
      } catch (error) {
        lastError = error;
        throw error;
      }
    }

    return true;
  })();

  try {
    return await savingPromise;
  } finally {
    savingPromise = null;
  }
}

// 4. 통계 조회 전 저장
export async function flushBeforeStats() {
  await flushEvents();
}

// 5. 카메라 OFF 후 세션 종료
export async function finishMonitoring(
  reason = "camera_off",
  endedAtMs = Date.now()
) {
  if (stoppingPromise) {
    return stoppingPromise;
  }

  if (startingPromise) {
    await startingPromise;
  }

  if (currentSessionId === null) {
    return null;
  }

  closing = true;

  stoppingPromise = (async () => {
    // 이미 진행 중인 저장 요청이 있다면 기다림
    if (savingPromise) {
      try {
        await savingPromise;
      } catch {
        // 실패 이벤트는 pendingEvents에 유지됨
      }
    }

    // 가능한 이벤트는 먼저 일반 API로 저장
    try {
      await flushEvents();
    } catch (error) {
      console.warn(
        "[D] 이벤트 저장 실패, 종료 API에서 재시도:",
        error
      );
    }

    const remaining = [...pendingEvents.values()];

    if (remaining.length > MAX_BATCH) {
      throw new Error(
        "미저장 이벤트가 500개를 초과합니다."
      );
    }

    // 남은 이벤트를 종료 요청에 함께 전달
    const result = await endSession(
      currentSessionId,
      reason,
      endedAtMs,
      remaining
    );

    // 서버가 종료 성공을 응답한 뒤에만 초기화
    currentSessionId = null;
    pendingEvents.clear();
    lastError = null;
    closing = false;

    return result;
  })();

  try {
    return await stoppingPromise;
  } catch (error) {
    lastError = error;

    // 실패 시 세션 ID와 이벤트를 보존
    // closing 상태를 유지해 새 세션 시작 방지
    throw error;
  } finally {
    stoppingPromise = null;
  }
}

// 6. 종료 실패 후 다시 시도
export async function retryFinishMonitoring(
  reason = "camera_off",
  endedAtMs = Date.now()
) {
  if (currentSessionId === null) {
    return null;
  }

  // 종료 재시도는 허용
  return finishMonitoring(reason, endedAtMs);
}

// 7. 페이지 종료 시 Beacon 전송 시도
export function finishOnPageHide() {
  if (currentSessionId === null) {
    return false;
  }

  const events = [...pendingEvents.values()];

  return sendEndBeacon(
    currentSessionId,
    "pagehide",
    events,
    Date.now()
  );
}

// 8. 통계 Provider
export function getStatsProvider() {
  return createStatsProvider({
    beforeQuery: flushBeforeStats
  });
}

// 9. 홈 누적 시간
export async function refreshHomeStats(store) {
  const asOf = Date.now();

  await flushBeforeStats();

  return updateHomeMeasuredSec(
    store,
    asOf
  );
}

// 10. 현재 세션 ID
export function getCurrentSessionId() {
  return currentSessionId;
}

// 11. 저장 상태 확인
export function getSaveStatus() {
  return {
    sessionId: currentSessionId,
    pendingCount: pendingEvents.size,
    saving: savingPromise !== null,
    stopping: stoppingPromise !== null,
    closing,
    error: lastError?.message ?? null
  };
}
