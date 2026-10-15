// 팝업: 현재 알림 상태와 강도를 보여주고, 현재 탭에서만 약 3초 미리보기를 실행한다.
// 실제 거북목 알림 상태는 바꾸지 않는다(NeckCare 판정 결과로만 바뀜).
const LABELS = { weak: '약함', medium: '중간', strong: '강함' };
const STALE_MS = 30000;

const pill = document.getElementById('pill');
const levelEl = document.getElementById('level');
const btn = document.getElementById('preview');
const result = document.getElementById('result');
let level = 'medium';

chrome.storage.local.get(['neckcareAlert', 'neckcareLevel', 'neckcareHeartbeat'], (s) => {
  level = LABELS[s.neckcareLevel] ? s.neckcareLevel : 'medium';
  levelEl.textContent = LABELS[level];
  const alert = s.neckcareAlert || {};
  const active = alert.active && Date.now() - (s.neckcareHeartbeat || 0) < STALE_MS;
  pill.textContent = active ? '거북목 알림 표시 중' : '알림 대기 중';
  pill.classList.toggle('bad', Boolean(active));
});

btn.addEventListener('click', async () => {
  result.textContent = '';
  if (level === 'weak') {
    result.textContent = '약함은 Windows 알림만 사용해서 웹페이지에는 거북이가 나타나지 않아요.';
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  btn.disabled = true;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'preview', level });
    result.textContent = '현재 탭에 약 3초 동안 표시돼요.';
  } catch {
    result.textContent = '이 페이지에서는 표시할 수 없어요. (Chrome 내부 페이지이거나, 확장 프로그램 설치 전에 열린 탭이면 새로고침해 주세요)';
  } finally {
    btn.disabled = false;
  }
});
