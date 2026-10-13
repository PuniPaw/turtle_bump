# 거북목 거북이 (Chrome 확장 프로그램)

NeckCare 웹페이지에서 실제 거북목 알림이 켜지면, 다른 웹사이트(Google, Naver 등)에도
화면 중앙 상단 경고창과 거북이(중간 1마리 / 강함 10마리)를 표시한다. 정상 자세로 돌아오면 사라진다.

## 설치

1. Chrome 주소창에 `chrome://extensions` 입력
2. 오른쪽 위 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** → 이 `turtle-extension` 폴더 선택
4. 설치 전에 열려 있던 탭(NeckCare 포함)은 새로고침

## 동작

- NeckCare 페이지(`localhost` / `127.0.0.1`, `<meta name="neckcare-app">`가 있는 페이지)가
  `window.postMessage`로 알림 상태·강도를 보내면 content.js가 background로 넘기고,
  background가 `chrome.storage`에 저장 → 모든 탭의 content.js가 표시/제거한다.
- NeckCare 탭을 닫거나 새로고침하면 알림이 꺼진다. NeckCare 탭에서 30초 동안 소식이 없어도 꺼진다.
- 팝업의 **현재 탭에서 미리보기**: 지금 보고 있는 탭에만 약 3초 표시한다. 실제 알림 상태는 바꾸지 않는다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `overlay.js` | 경고창 + 거북이 오버레이. `neckcare_webpage/js/alert-overlay.js`와 **같은 파일**(한쪽을 고치면 다른 쪽에 복사) |
| `content.js` | 모든 페이지에 주입. 알림 표시, NeckCare 페이지 → background 중계, 팝업 미리보기 |
| `background.js` | 알림 상태 저장, NeckCare 탭이 닫히면 해제 |
| `popup.html`, `popup.js` | 상태·강도 표시, 현재 탭 미리보기 |

## 작동하지 않는 곳

`chrome://` 페이지, 새 탭 페이지, Chrome 웹스토어, 다른 확장 프로그램 페이지, 내장 PDF 뷰어,
`file://`(확장 프로그램 설정에서 "파일 URL에 대한 액세스 허용" 필요), 시크릿 창(별도 허용 필요),
전체화면 영상 재생 중.
