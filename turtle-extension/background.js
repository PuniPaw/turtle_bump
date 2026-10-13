// NeckCare 페이지에서 온 알림 상태를 chrome.storage에 저장하면 모든 탭의 content.js가 반응한다.
//
// 저장 키
//   neckcareAlert     { active, level }  실제 거북목 알림 상태 (NeckCare 판정 결과로만 바뀜)
//   neckcareLevel     'weak' | 'medium' | 'strong'  NeckCare에서 선택한 알림 강도
//   neckcareHeartbeat 마지막으로 NeckCare 탭이 살아 있다고 알린 시각(ms)
//
// NeckCare 탭이 닫히거나 새로고침되면 알림을 끈다. 그렇지 않으면 모든 사이트에 거북이가 남는다.

const LEVELS = ['weak', 'medium', 'strong'];
const OFF = { active: false, level: null };

function clearAlert() {
  return chrome.storage.local.set({ neckcareAlert: OFF });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'neckcare-app' || !port.sender || !port.sender.tab) return;
  chrome.storage.session.set({ appTabId: port.sender.tab.id });

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'alert') {
      const level = LEVELS.includes(msg.level) ? msg.level : null;
      chrome.storage.local.set({
        neckcareAlert: msg.active ? { active: true, level } : OFF,
        neckcareHeartbeat: Date.now(),
      });
    } else if (msg.type === 'level' && LEVELS.includes(msg.level)) {
      chrome.storage.local.set({ neckcareLevel: msg.level });
    } else if (msg.type === 'heartbeat') {
      chrome.storage.local.set({ neckcareHeartbeat: Date.now() });
    }
  });

  // NeckCare 페이지를 닫거나 새로고침·이동하면 연결이 끊긴다.
  port.onDisconnect.addListener(() => clearAlert());
});

// 서비스 워커가 잠든 사이에 NeckCare 탭이 닫혀도 정리되도록
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { appTabId } = await chrome.storage.session.get('appTabId');
  if (tabId === appTabId) clearAlert();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ neckcareAlert: OFF, neckcareHeartbeat: 0 });
});

chrome.runtime.onStartup.addListener(() => clearAlert());
