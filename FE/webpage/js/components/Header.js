// 홈 화면 상단 머리글: "홈 화면" 라벨 + 설명.
export function mountHeader(el) {
  el.innerHTML = `
    <h1 class="page-head__pill">홈 화면</h1>
    <p class="page-head__sub">실시간 모니터링 및 현재 상태 중심</p>
  `;

  return {
    update() {},
  };
}
