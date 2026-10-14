// 테스트 모드 전환. 주소에 ?mock=1 이 있을 때만 Mock Backend(테스트 전용)로 요청한다.
//   일반 모드: 실제 D 백엔드 http://127.0.0.1:5000/api (backend-api.js 기본값)
//   테스트 모드: http://127.0.0.1:5050/api (mock_backend/mock_server.py)
// 저장해 두지 않으므로 ?mock=1 없이 열면 항상 일반 모드다(자동 활성화 없음).
// main.js의 첫 import여야 한다(backend-api.js가 주소를 읽기 전에 설정).
const params = new URLSearchParams(location.search);

export const TEST_MODE = params.get('mock') === '1';
export const MOCK_API_BASE = 'http://127.0.0.1:5050/api';

if (TEST_MODE) {
  globalThis.NECKCARE_API_BASE = MOCK_API_BASE;

  // 화면의 값이 실제 측정이 아니라는 표시(항상 위에 고정)
  const showBadge = () => {
    const badge = document.createElement('div');
    badge.setAttribute('role', 'status');
    badge.textContent = '테스트 모드 · Mock 서버 데이터 (실제 측정 아님)';
    badge.style.cssText = [
      'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483646',
      'padding:6px 14px', 'border-radius:999px', 'background:#f0a020', 'color:#1f1d2b',
      'font:700 13px/1.4 "Pretendard Variable",Pretendard,"Malgun Gothic",sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,.18)', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(badge);
    document.title = `[테스트] ${document.title}`;
  };
  if (document.body) showBadge();
  else document.addEventListener('DOMContentLoaded', showBadge, { once: true });
}
