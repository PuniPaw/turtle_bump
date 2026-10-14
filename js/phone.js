import { startBroadcaster } from './webrtc.js';

// 폰 쪽 페이지. 카메라를 켜서 PC로 영상만 보낸다(좌표 추출/분석 없음).

const $ = (role) => document.querySelector(`[data-role="${role}"]`);
const status = $('status');
const video = $('video');
const form = $('room-form');
const input = $('room-input');
const submit = $('room-submit');

let session = null;

function setStatus(text) {
  status.textContent = text;
}

async function connect(room) {
  if (session || !room) return;
  submit.disabled = true;
  input.disabled = true;
  setStatus('카메라 권한을 확인하는 중...');
  try {
    session = await startBroadcaster(room, video, {
      onConnected() {
        setStatus('PC로 전송 중입니다.');
      },
      onError(err) {
        console.error(err);
        setStatus(`연결 실패: ${err.message}`);
        submit.disabled = false;
        input.disabled = false;
        session = null;
      },
    });
    setStatus('PC가 연결을 받아들이길 기다리는 중...');
  } catch (err) {
    console.error(err);
    if (err.name === 'NotAllowedError') {
      setStatus('카메라 권한이 거부됐어요. 브라우저 설정에서 허용해 주세요.');
    } else if (err.name === 'NotFoundError') {
      setStatus('이 기기에서 카메라를 찾을 수 없어요.');
    } else {
      setStatus(`연결 실패: ${err.message}`);
    }
    submit.disabled = false;
    input.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  connect(input.value.trim().toUpperCase());
});

const roomFromUrl = new URLSearchParams(location.search).get('room');
if (roomFromUrl) {
  input.value = roomFromUrl.toUpperCase();
  connect(roomFromUrl.toUpperCase());
}