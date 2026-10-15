# NeckCare (거북이 방지턱) — 실행 가이드

정면 웹캠 영상을 브라우저 안에서 MediaPipe로 분석해 거북목·허리 굽음을 판정합니다. 나쁜 자세가 약 5초 이어지면 알림을 주고, 측정 기록을 MariaDB에 저장해 통계를 보여 줍니다.

**카메라 입력은 PC에 직접 연결된 웹캠(노트북 내장 카메라 또는 USB 웹캠)만 사용합니다.**

이 폴더에는 **서비스 실행에 필요한 파일만** 들어 있습니다(38개, 테스트·미사용 코드 제외).

---

## 1. 폴더 구조

```
neckcare_final\
├─ README.md                  이 문서
├─ neckcare_webpage\          웹페이지 (화면 서버 포함)
│  ├─ index.html              메인 화면
│  ├─ favicon.svg             아이콘 (Windows 알림 아이콘으로도 사용)
│  ├─ server.py               화면 서버, 정적 파일 제공 (파이썬 표준 라이브러리만 사용)
│  ├─ start.bat               화면 서버 실행 (5173 포트)
│  ├─ css\styles.css
│  └─ js\
│     ├─ main.js              진입점 (모든 모듈 연결)
│     ├─ b\                   B 자세 판정 모듈 (MediaPipe Pose + Face Landmarker)
│     ├─ components\          화면 부품
│     ├─ ui\, utils\          안내 문구, 형식 변환
│     └─ (그 밖)              카메라, 초기 설정, 알림, 저장 연동, 통계 조회
├─ backend\                   Flask REST API (MariaDB)
│  ├─ app.py                  서버 (127.0.0.1:5000)
│  ├─ requirements.txt        파이썬 패키지 목록
│  └─ .env                    DB 접속 정보 (비공개. 공유·업로드 금지)
└─ turtle-extension\          Chrome 확장 프로그램 (다른 사이트에도 알림 표시)
```

---

## 2. 다른 PC로 옮길 때 필요한 것

| 구분 | 내용 | 이 폴더에 포함? |
|---|---|---|
| **설치 필요** | Python 3 (3.12, 3.14에서 동작 확인) | ✗ |
| **설치 필요** | 파이썬 패키지: flask, flask-cors, mysqlclient, python-dotenv | ✗ → `requirements.txt`로 설치 |
| **설치 필요** | MariaDB 서버 + `turtle_bump` 데이터베이스 | ✗ → 4장 |
| **설치 필요** | Chrome 브라우저 | ✗ |
| **설정 필요** | `backend\.env`의 DB 접속 정보를 그 PC의 MariaDB에 맞게 변경 | 파일은 있음(값은 현재 PC 기준) |
| **인터넷 필요** | MediaPipe 라이브러리·wasm (`cdn.jsdelivr.net`) | ✗ (실행할 때 내려받음) |
| **인터넷 필요** | MediaPipe 모델 파일 3개 (`storage.googleapis.com`) | ✗ (첫 카메라 연결 때 내려받음, 약 10초) |
| **인터넷 필요** | Pretendard 글꼴 (`cdn.jsdelivr.net`) | ✗ (없으면 기본 글꼴로 표시) |
| 포함됨 | 웹페이지·판정 모듈·백엔드 코드·확장 프로그램 | ✅ |
| 옮기지 않음 | 측정 기록(DB 데이터) | ✗ (MariaDB에 저장됨) |

> 판정은 브라우저 안에서만 합니다. 카메라 영상은 서버로 보내지 않습니다.

---

## 3. 파이썬 패키지 설치 (처음 한 번)

```bash
cd neckcare_final\backend
python -m pip install -r requirements.txt
```

- 꼭 `python -m pip`을 쓰세요. `pip`만 쓰면 다른 파이썬(예: Anaconda)에 설치될 수 있습니다.
- 가상환경을 쓴다면 먼저 활성화한 뒤 설치합니다.
  - 이 PC에서는 `C:\works\myproject\projects\turtle_project\.venv`에 이미 설치되어 있습니다.

---

## 4. MariaDB 준비 (처음 한 번)

1. MariaDB를 설치합니다. 포트 3306, "Install as service"를 선택하면 PC를 켤 때 자동으로 실행됩니다.
2. `turtle_bump` 데이터베이스를 만듭니다(MariaDB 클라이언트에서).
   ```sql
   CREATE DATABASE IF NOT EXISTS turtle_bump CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
3. `backend\.env`에 다음 항목이 있어야 합니다. 값은 그 PC의 MariaDB에 맞게 직접 넣습니다.
   ```
   DB_HOST=
   DB_PORT=
   DB_USER=
   DB_PASSWORD=
   DB_NAME=
   ```
4. 테이블은 `app.py`가 처음 실행될 때 자동으로 만듭니다.
   - `CREATE TABLE IF NOT EXISTS`를 쓰므로 이미 있으면 그대로 둡니다.
   - 상태 코드 7개는 `INSERT IGNORE`로 넣습니다.
   - 기존 데이터는 바꾸지 않습니다.

---

## 5. 실행 순서

| 순서 | 할 일 | 명령 | 주소 |
|---|---|---|---|
| 1 | MariaDB 실행 확인 | (서비스로 자동 실행) | 3306 |
| 2 | 백엔드 실행 | `cd neckcare_final\backend` → `python app.py` | http://127.0.0.1:5000 |
| 3 | 웹페이지 서버 실행 | `neckcare_webpage\start.bat` 더블클릭 (또는 `cd neckcare_final\neckcare_webpage` → `python server.py 5173`) | **http://localhost:5173** |
| 4 | Chrome으로 접속 | — | http://localhost:5173 |

- 백엔드 창에 `MariaDB 연결 및 테이블 확인 완료`가 나오면 정상입니다.
- 백엔드나 웹페이지 서버 창을 닫으면 그 서버가 꺼집니다. 사용하는 동안 열어 두세요.
- 백엔드 없이도 카메라, 판정, 알림은 동작합니다. 저장과 통계만 안 됩니다(화면에 안내 문구가 표시됨).
- **주의**
  - 웹페이지는 백엔드 주소를 `http://127.0.0.1:5000/api`로 고정해 씁니다. 백엔드 포트를 바꾸면 저장이 되지 않습니다.
  - 웹페이지 포트는 바꿔도 됩니다. 예: `python server.py 5175`

---

## 6. 웹캠 사용 방법

PC에 웹캠이 연결되어 있어야 합니다. 노트북 내장 카메라와 USB 웹캠을 쓸 수 있습니다.

1. **카메라 연결**을 누르고 카메라 권한을 허용합니다.
2. "자세 분석을 준비하는 중이에요"가 나옵니다(첫 연결은 모델 로딩으로 약 10초).
3. **3·2·1** 동안 바른 자세를 유지합니다. 얼굴과 양쪽 어깨가 화면에 보여야 합니다.
4. "거북목 판정 시작!"이 나오면 판정이 시작됩니다.
   - 실패하면 "기준 자세를 설정하지 못했어요"가 나옵니다. 카메라를 다시 연결하세요.
5. 거북목이나 허리 굽음이 약 5초 이어지면 알림이 뜹니다. 강도는 홈 화면의 **알림 강도 설정**에서 고릅니다.
   - 약함: Windows 알림
   - 중간: Windows 알림 + 경고창 + 거북이 1마리
   - 세게: Windows 알림 + 경고창 + 거북이 10마리
6. 끝낼 때는 카메라 영역 왼쪽 위의 **카메라 ON** 배지를 클릭합니다. 측정이 끝나고 기록이 저장됩니다.
7. **통계** 메뉴에서 **분석 결과 불러오기**를 누르면 저장된 기록이 표시됩니다.

> Windows 알림은 처음에 브라우저 알림 권한을 허용해야 합니다. 홈 화면의 **미리보기** 버튼을 한 번 누르면 권한 요청이 뜹니다.

---

## 7. Chrome 확장 프로그램 설치 (다른 사이트에도 알림 표시)

1. Chrome 주소창에 `chrome://extensions`를 입력합니다.
2. 오른쪽 위 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다** → `neckcare_final\turtle-extension` 폴더를 선택합니다.
4. 설치 전에 열려 있던 탭은 새로고침합니다(NeckCare 탭 포함).
5. **다른 폴더의 같은 확장 프로그램("거북목 거북이")이 이미 설치되어 있다면 꺼 두세요.** 둘 다 켜져 있으면 거북이가 두 번 표시될 수 있습니다.

- NeckCare 탭을 닫거나 새로고침하면 다른 사이트의 알림도 꺼집니다.
- `chrome://` 페이지, 새 탭, 웹스토어, PDF 뷰어에는 표시되지 않습니다.
- 강도 "약함"은 거북이가 없어서 다른 사이트에는 표시되지 않습니다.

---

## 8. 종료 방법

1. 카메라 ON 배지를 클릭해 측정을 끝냅니다(기록 저장).
2. 웹페이지 서버 창에서 `Ctrl+C`를 누르거나 창을 닫습니다.
3. 백엔드 창에서 `Ctrl+C`를 누르거나 창을 닫습니다.
4. MariaDB는 서비스라서 계속 켜져 있어도 됩니다.

---

## 9. 자주 발생하는 오류와 해결 방법

| 증상 | 원인 | 해결 |
|---|---|---|
| `No module named 'MySQLdb'` | 패키지가 다른 파이썬에 설치됨 | 실행할 파이썬으로 `python -m pip install -r requirements.txt` |
| `(2002, "Can't connect to server on '127.0.0.1'")` | MariaDB가 꺼져 있거나 미설치 | Windows 서비스에서 MariaDB 시작 / 설치 |
| `(1049, "Unknown database 'turtle_bump'")` | 데이터베이스 없음 | 4장 2번 SQL 실행 |
| `(1045, "Access denied")` | `.env` 계정·비밀번호 불일치 | `backend\.env` 값 확인 |
| 화면에 "DB 서버에 연결하지 못해 이번 측정은 저장되지 않아요" | 백엔드가 꺼져 있음 | 5장 2번 실행 후 카메라 다시 연결 |
| 통계가 "불러오지 못했어요. 이전 결과를 유지합니다" | 백엔드가 꺼져 있음 | 백엔드 실행 후 다시 불러오기 |
| `localhost:5173` 접속 안 됨 | 웹페이지 서버가 꺼짐 | `start.bat` 실행, 창 닫지 않기 |
| `Address already in use` / 포트 사용 중 | 같은 포트에 다른 서버가 실행 중 | 기존 서버 창을 닫거나 다른 포트로 실행(웹페이지만 가능) |
| 화면이 예전 모습 | 브라우저 캐시 또는 다른 폴더의 서버 | `Ctrl+Shift+R`, 이 폴더의 `server.py`로 실행했는지 확인 |
| "연결된 웹캠을 찾을 수 없어요" | PC에 웹캠이 없거나 인식되지 않음 | 웹캠을 연결하고 Windows 카메라 앱으로 동작 확인 후 다시 시도 |
| "카메라 권한이 거부됐어요" | 브라우저 카메라 권한 차단 | 주소창 왼쪽 사이트 설정 → 카메라 허용 |
| "기준 자세를 설정하지 못했어요" | 얼굴·양쪽 어깨가 안 보임, 어두움 | 상체가 화면에 들어오게 앉고 카메라 다시 연결 |
| 첫 연결이 오래 걸림 | MediaPipe 모델 다운로드 | 인터넷 연결 확인, 두 번째부터 빨라짐 |
| Windows 알림이 안 뜸 | 브라우저 알림 차단, 방해 금지 모드 | 주소창 왼쪽 사이트 설정 → 알림 허용, Windows 알림 설정 확인 |
| 다른 사이트에 거북이가 안 뜸 | 확장 프로그램 미설치, 탭 새로고침 안 함, 강도 "약함" | 7장 확인, 탭 새로고침 |

---

## 10. 참고

- 접속 주소는 `http://localhost:5173` 하나입니다(테스트 모드 없음).
- 측정 기록은 MariaDB `turtle_bump` 데이터베이스의 `sessions`, `posture_events` 테이블에 저장됩니다.
