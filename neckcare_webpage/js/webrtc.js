// 아주 가벼운 WebRTC 연결 유틸.
// server.py의 /api/signal/<room>/<offer|answer>는 SDP를 방 코드별로 잠깐 들고
// 있다가 전달만 한다. 연결되면 영상은 두 브라우저가 직접(P2P) 주고받는다.
// 이 모듈은 "카메라 연결(송출/수신)"만 다루고, 좌표 추출·분석은 전혀 하지 않는다.

// STUN만으로는 폰과 PC가 서로 다른 네트워크(이동통신사, CGNAT 등)에 있을 때
// 직접 연결을 못 뚫는 경우가 많다. Open Relay Project의 무료 공개 TURN을 더해
// 그런 경우에도 중계를 통해 연결되게 한다(영상이 그 중계 서버를 거치긴 하지만,
// 계정 가입 없이 쓸 수 있는 공개 테스트용 서버다).
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const CONNECT_TIMEOUT_MS = 25000;

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

async function postSignal(room, role, description) {
  const res = await fetch(`/api/signal/${room}/${role}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(description),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`시그널링 서버에 연결 정보를 보내지 못했습니다(${res.status}).`), { name: 'SignalPostError' });
  }
}

async function getSignal(room, role) {
  const res = await fetch(`/api/signal/${room}/${role}`, { cache: 'no-store' });
  if (res.status !== 200) return null;
  return res.json();
}

async function pollSignal(room, role, { intervalMs = 1000, timeoutMs = 120000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await getSignal(room, role);
    if (data) return data;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw Object.assign(new Error('연결 대기 시간이 초과됐습니다.'), { name: 'SignalTimeoutError' });
}

function waitIceGatheringComplete(pc, timeoutMs = 3000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener('icegatheringstatechange', function onChange() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    });
  });
}

// signaling(offer/answer 교환)이 끝난 뒤 실제 P2P(ICE) 연결까지 맺어지는지 감시한다.
// 끊기거나(failed) 시간 안에 안 붙으면 onFailed를 부른다.
function watchConnection(pc, { onConnected, onFailed, timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled || pc.connectionState === 'connected') return;
    settled = true;
    onFailed?.(Object.assign(new Error('상대방과 연결하지 못했습니다(네트워크/방화벽 문제일 수 있어요).'), { name: 'ConnectTimeoutError' }));
  }, timeoutMs);

  pc.addEventListener('icegatheringstatechange', () => {
    console.log('[webrtc] iceGatheringState:', pc.iceGatheringState);
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    console.log('[webrtc] iceConnectionState:', pc.iceConnectionState);
  });
  pc.addEventListener('icecandidateerror', (e) => {
    console.warn('[webrtc] icecandidateerror:', e.errorCode, e.errorText, e.url);
  });
  pc.addEventListener('connectionstatechange', () => {
    console.log('[webrtc] connectionState:', pc.connectionState);
    if (settled) return;
    if (pc.connectionState === 'connected') {
      settled = true;
      clearTimeout(timer);
      onConnected?.();
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      settled = true;
      clearTimeout(timer);
      onFailed?.(Object.assign(new Error('연결이 끊어졌습니다.'), { name: 'ConnectFailedError' }));
    }
  });
}

// PC(수신) 쪽: 방 코드를 만들고 offer를 올린 뒤 폰의 answer를 기다린다.
// video 엘리먼트에 수신한 스트림을 바로 연결한다.
// onRoom(code): 방 코드가 정해지면 호출(화면에 코드/링크를 보여줄 때 사용).
// onConnected(): 영상 수신을 시작하면 호출. onError(err): 실패 시 호출.
export function startViewer(video, { onRoom, onConnected, onError } = {}) {
  const room = randomRoomCode();
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.addTransceiver('video', { direction: 'recvonly' });

  let errored = false;
  const fail = (err) => {
    if (errored) return;
    errored = true;
    console.error(err);
    onError?.(err);
  };

  pc.ontrack = (event) => {
    video.srcObject = event.streams[0];
    video.play().catch(() => {});
  };

  watchConnection(pc, { onConnected, onFailed: fail });

  let stopped = false;
  (async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceGatheringComplete(pc);
      await postSignal(room, 'offer', pc.localDescription);
      onRoom?.(room);
      const answer = await pollSignal(room, 'answer');
      if (stopped) return;
      await pc.setRemoteDescription(answer);
    } catch (err) {
      if (!stopped) fail(err);
    }
  })();

  return {
    room,
    stop() {
      stopped = true;
      pc.getSenders().forEach((s) => s.track?.stop());
      pc.close();
      video.srcObject = null;
    },
  };
}

// 폰(송신) 쪽: 주어진 방 코드로 PC의 offer를 기다렸다가, 카메라 스트림을 붙여 answer를 보낸다.
// localVideo가 주어지면 폰 화면에도 자기 카메라를 미리 보여준다(연결 확인용).
export async function startBroadcaster(room, localVideo, { onConnected, onError } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: 640, height: 480 },
    audio: false,
  });

  if (localVideo) {
    localVideo.srcObject = stream;
    await localVideo.play().catch(() => {});
  }

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));

  let errored = false;
  const fail = (err) => {
    if (errored) return;
    errored = true;
    console.error(err);
    onError?.(err);
  };

  watchConnection(pc, { onConnected, onFailed: fail });

  let stopped = false;
  (async () => {
    try {
      const offer = await pollSignal(room, 'offer');
      if (stopped) return;
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIceGatheringComplete(pc);
      await postSignal(room, 'answer', pc.localDescription);
    } catch (err) {
      if (!stopped) fail(err);
    }
  })();

  return {
    stop() {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      pc.close();
      if (localVideo) localVideo.srcObject = null;
    },
  };
}
