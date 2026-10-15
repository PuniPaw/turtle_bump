# NeckCare (거북이 방지턱)
웹캠 기반 실시간 자세 모니터링 및 자세 기록·통계 시스템

## 1. 프로젝트 소개

NeckCare는 웹캠 영상과 MediaPipe를 활용하여 사용자의 자세를 분석하고, 거북목 등 잘못된 자세를 확인할 수 있도록 지원하는 프로그램이다.

Flask와 MariaDB를 연동하여 측정 세션과 자세 이벤트를 저장하고, 저장된 데이터를 바탕으로 자세별 측정시간과 발생 횟수 등의 통계를 제공하도록 설계하였다.

### 주요 기능
- 웹캠 연결 및 실시간 영상 표시
- MediaPipe를 이용한 자세 랜드마크 추출
- 자세 상태 표시 및 경고 알림 UI
- 측정 세션 생성 및 종료
- 자세 이벤트 저장 및 최종화
- 일별·주별·월별 통계 조회
- WebRTC 기반 원격 영상 연결 관련 코드

※ 실제 통합 실행 및 일부 기능의 정상 동작 여부는 별도 테스트가 필요하다.

---

## 2. 개발 환경

### 개발 도구
- Visual Studio Code
- Python / Anaconda
- MariaDB Server
- HeidiSQL
- 웹 브라우저 (Chrome 등)

### 사용 기술
- Frontend: HTML, CSS, JavaScript (ES Modules)
- Backend: Python, Flask
- Database: MariaDB
- 영상 분석: MediaPipe Pose Landmarker
- 통신: REST API, Fetch API, WebRTC 관련 코드

### Python 외부 라이브러리

Flask: REST API 서버 구현  
Flask-CORS: 브라우저와 API 서버 간 CORS 처리  
mysqlclient: MariaDB 연결 (MySQLdb)  
python-dotenv: 환경변수 로드  
requests: API 테스트  
opencv-python: Python 영상 처리 실험 코드  
mediapipe: Python 자세·얼굴 랜드마크 분석  
numpy: 수치 연산  

Python 기본 제공 모듈인 os, math, datetime, traceback, logging, uuid, time, contextlib 등은 별도 설치하지 않는다.

---

## 3. 프로젝트 폴더 구조

turtle_bump/
- app.py : Flask REST API 및 DB 처리
- index.html : 웹페이지 진입점
- .env : MariaDB 연결 환경변수
- testapi.py : API 테스트 코드
- checkdb.py : DB 연결 확인 코드
- turtleneck.py : 별도 Python 자세 판정 실험 코드
- css/
  - base.css
  - component.css
  - styles.css
- js/
  - main.js : 프론트엔드 실행 및 기능 연결
  - pose.js : 웹캠 및 MediaPipe 랜드마크 표시
  - webrtc.js : WebRTC 연결 기능
  - state.js : 프론트엔드 상태 관리
  - notify.js : 알림 기능
  - storage.js : Flask API 요청
  - bcintegration.js : 이벤트 저장 및 세션 연결
  - stats.js : 통계 API 조회
  - phone.js : 모바일 관련 기능
  - icons.js : 아이콘
  - components/ : 화면별 UI 컴포넌트
  - ui/ : 알림 메시지 UI
  - utils/ : 공통 포맷 함수
- turtle_bump.erd : 데이터베이스 ERD 자료
- neckcare_erd.sqlite3 : ERD 관련 SQLite 파일
- posture.db : SQLite 파일

※ .git 폴더는 Git 버전 관리용이며 실행에 필요한 소스 파일이 아니다.
※ .env에는 실제 DB 비밀번호가 포함될 수 있으므로 공개 저장소에 업로드하지 않는다.

---

## 4. 프로그램 설치 방법

### 4-1. Python 환경 활성화

Anaconda Prompt 또는 VS Code 터미널 실행

conda activate myproject

※ myproject는 개발 환경에서 사용한 Conda 환경명이며, 다른 환경에서는 해당 이름으로 변경한다.

### 4-2. Python 라이브러리 설치

python -m pip install flask flask-cors mysqlclient python-dotenv requests

별도 Python 자세 판정 프로그램(turtleneck.py)을 실행하려면 다음 패키지도 필요하다.

python -m pip install opencv-python mediapipe numpy

### 4-3. 설치 확인

python -c "import flask, flask_cors, MySQLdb, dotenv, requests; print('설치 확인 완료')"

---

## 5. MariaDB 데이터베이스 생성

### 5-1. 데이터베이스 생성

HeidiSQL에서 MariaDB 서버에 접속한 후 다음 SQL 실행

CREATE DATABASE IF NOT EXISTS turtle_bump
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;

USE turtle_bump;

※ 기존 DB를 유지해야 하는 환경에서는 삭제하거나 초기화하지 않는다. 초기화 전 반드시 백업한다.

### 5-2. 테이블 생성

현재 app.py의 init_db() 함수는 데이터베이스가 이미 존재하는 상태에서 필요한 테이블을 생성하도록 작성되어 있다.

따라서 turtle_bump 데이터베이스를 먼저 생성하고 app.py를 실행하면 된다.

수동으로 생성할 경우 다음 SQL을 사용할 수 있다.

CREATE TABLE IF NOT EXISTS sessions (
    session_id BIGINT AUTO_INCREMENT PRIMARY KEY,
    started_at DATETIME(3) NOT NULL,
    ended_at DATETIME(3) NULL,
    total_duration_sec DOUBLE NULL,
    valid_duration_sec DOUBLE NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS posture_states (
    state VARCHAR(20) PRIMARY KEY,
    label VARCHAR(50) NOT NULL,
    is_counted BOOLEAN NOT NULL,
    is_alert BOOLEAN NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS posture_events (
    event_id VARCHAR(36) PRIMARY KEY,
    session_id BIGINT NOT NULL,
    state VARCHAR(20) NOT NULL,
    started_at DATETIME(3) NOT NULL,
    ended_at DATETIME(3) NULL,
    duration_sec DOUBLE NULL,
    alert_triggered BOOLEAN NOT NULL DEFAULT FALSE,
    is_final BOOLEAN NOT NULL DEFAULT FALSE,

    INDEX idx_session_start (session_id, started_at),

    CONSTRAINT fk_event_session
        FOREIGN KEY (session_id)
        REFERENCES sessions(session_id),

    CONSTRAINT fk_event_state
        FOREIGN KEY (state)
        REFERENCES posture_states(state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

### 5-3. 자세 상태 초기 데이터

INSERT IGNORE INTO posture_states
(state, label, is_counted, is_alert)
VALUES
('GOOD', '바른 자세', 1, 0),
('TURTLE', '거북목', 1, 1),
('WAIST', '허리 자세 불량', 1, 1),
('CLOSE', '카메라 근접', 1, 0),
('NOVIS', '인식 불가', 0, 0),
('CALIB', '보정 중', 0, 0),
('IDLE', '대기 중', 0, 0);

### 5-4. 테이블 생성 확인

SHOW TABLES;

SELECT * FROM posture_states;

SHOW COLUMNS FROM posture_events;

정상 구성:
- sessions
- posture_states
- posture_events

posture_states에는 총 7개의 자세 상태가 등록되어야 한다.

---

## 6. 환경변수 설정

프로젝트 최상위 폴더에 .env 파일을 생성한다.

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=실제_DB_비밀번호
DB_NAME=turtle_bump

DB_HOST, DB_PORT, DB_USER는 실제 MariaDB 서버의 접속 설정과 일치해야 한다.

※ 위 비밀번호는 예시 문자열이며 실제 비밀번호로 변경한다.
※ .env 파일은 외부에 공개하지 않는다.

---

## 7. 프로그램 실행 방법

### 7-1. Flask 서버 실행

VS Code에서 프로젝트 폴더를 열고 터미널 실행

conda activate myproject

python app.py

정상 실행 예시:

MariaDB 연결 및 테이블 확인 완료
Running on http://127.0.0.1:5000

Flask 서버는 종료하지 않고 실행 상태로 유지한다.

### 7-2. 프론트엔드 실행

새 터미널에서 프로젝트 최상위 폴더로 이동한다.

python -m http.server 5173

브라우저 접속 주소:

http://localhost:5173

※ 현재 프론트엔드는 HTML 및 JavaScript ES Module 구조이며, 별도의 package.json은 첨부 파일에서 확인되지 않았다.
※ 위 방법은 정적 파일 제공 방식이다. WebRTC 시그널링 등 별도 서버 API가 필요한 기능은 추가 구성이 필요할 수 있다.

### 7-3. 카메라 실행

브라우저에서 페이지를 열고 카메라 접근 권한을 허용한다.

MediaPipe 모델과 WASM 리소스는 외부 주소에서 불러오므로 최초 실행 시 인터넷 연결이 필요하다.

카메라 접근은 localhost 또는 HTTPS와 같은 브라우저 보안 조건의 영향을 받는다.

---

## 8. Flask REST API

API 기본 주소:

http://127.0.0.1:5000/api

### API 목록

1) POST /api/sessions
- 측정 세션 생성
- 입력: started_at_ms
- 출력: session_id, started_at_ms

2) POST /api/sessions/{session_id}/events
- 자세 이벤트 저장 및 갱신
- 입력: events 배열
- 이벤트 최대 500개
- 이벤트 ID 중복, 시간 겹침, 최종화 상태 검증

3) POST /api/sessions/{session_id}/end
- 측정 세션 종료
- 입력: ended_at_ms, reason, events(선택)
- 측정시간 및 유효 측정시간 저장

4) GET /api/summary/home
- 홈 화면의 누적 유효 측정시간 조회

5) GET /api/stats
- 기간별 통계 조회
- period: today, week, month
- unit: day, week
- as_of_ms: 선택적 기준 시각

### 이벤트 주요 필드

event_id: 이벤트 고유 식별자  
state: 자세 상태  
started_at_ms: 시작 시각(밀리초)  
ended_at_ms: 종료 시각(밀리초 또는 NULL)  
is_final: 최종화 여부  
alert_triggered: 자세 경고 발생 여부  

동일 자세 이벤트는 동일한 event_id를 사용하며, 중간 측정값은 갱신하고 최종 이벤트는 확정하여 중복 합산을 방지하도록 설계하였다.

---

## 9. API 테스트 방법

Flask 서버가 실행 중인 상태에서 별도 터미널을 열어 다음 명령어 실행

python testapi.py

테스트 내용:
1. 세션 생성
2. 미확정 이벤트 저장
3. 이벤트 최종화
4. 동일 최종 이벤트 재전송
5. 최종 이벤트 변경 차단
6. 세션 종료
7. 홈 통계 조회
8. 기간별 통계 조회

예상 HTTP 상태:
- 세션 생성: 201
- 이벤트 저장: 200
- 최종화: 200
- 동일 이벤트 재전송: 200
- 최종 이벤트 변경 시도: 409
- 세션 종료: 200
- 홈 통계: 200
- 기간별 통계: 200

409 EVENT_FINALIZED는 최종 이벤트 변경을 거부하는 정상적인 검증 결과이다.

테스트는 실제 DB에 세션과 이벤트 데이터를 생성하므로 운영용 DB가 아닌 개발·테스트 환경에서 실행하는 것을 권장한다.

### MariaDB 저장 결과 확인

USE turtle_bump;

SELECT *
FROM sessions
ORDER BY session_id DESC;

SELECT *
FROM posture_events
ORDER BY started_at DESC;

SELECT *
FROM posture_states;

---

## 10. 통계 처리 방식

Flask 서버는 저장된 이벤트를 바탕으로 다음 지표를 계산한다.

- measuredSec: 유효 측정시간
- turtleCount: 거북목 이벤트 발생 횟수
- shrimpCount: 허리 자세 불량 이벤트 발생 횟수
- goodRatio: 바른 자세 시간 비율
- avgDurationSec: 잘못된 자세의 평균 지속시간

자세별 시간 분포:
- good: 바른 자세
- turtle: 거북목
- shrimp: 허리 자세 불량
- other: 카메라 근접

통계 조회 시 한국 표준시(KST)를 기준으로 날짜를 구분하며, DB의 날짜·시간은 UTC 기준으로 저장하도록 설계하였다.

종료 시각이 NULL인 이벤트의 미확정 지속시간은 임의로 계산하지 않는다.

---

## 11. 소스 파일 역할 및 담당 구분

### 프론트엔드
index.html: 웹페이지 기본 구조  
css/: 페이지 스타일  
js/main.js: 프론트엔드 실행 및 기능 연결  
js/components/: 화면별 UI 컴포넌트  
js/state.js: 상태 관리  
js/notify.js: 경고 및 알림  
js/pose.js: 카메라 및 MediaPipe 랜드마크 처리  
js/webrtc.js: 원격 영상 연결 관련 기능  

### 백엔드 및 DB (D 담당)
app.py: Flask REST API, MariaDB 연동, 데이터 검증, 통계 계산  
js/storage.js: REST API 통신  
js/bcintegration.js: 자세 이벤트 저장 연결 및 재시도  
js/stats.js: 서버 통계 조회 연결  
testapi.py: API 기능 테스트  
checkdb.py: MariaDB 접속 확인  

### 별도 실험 코드
turtleneck.py: Python 기반 MediaPipe Pose 및 Face Landmarker 자세 판정 실험 코드

※ 팀원별 최종 작업 범위와 공동 수정 사항은 Git 기록 및 팀원 확인 후 확정한다.

---

## 12. 외부 라이브러리 및 소스 출처

### MediaPipe Tasks Vision
제공: Google

용도: 웹캠 영상에서 인체 자세 랜드마크 추출

프로젝트 내 사용 버전:
@mediapipe/tasks-vision@0.10.14

라이브러리:
https://developers.google.com/mediapipe

JavaScript CDN:
https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs

WASM:
https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm

Pose Landmarker Lite 모델:
https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task

### Flask
제공: Pallets Projects

https://flask.palletsprojects.com/

용도: REST API 서버

### Flask-CORS
https://flask-cors.readthedocs.io/

용도: 교차 출처 요청 처리

### MariaDB
https://mariadb.org/

용도: 측정 데이터 저장 및 SQL 조회

### mysqlclient
https://mysqlclient.readthedocs.io/

용도: Python과 MariaDB 연결

### python-dotenv
https://pypi.org/project/python-dotenv/

용도: 환경변수 관리

### OpenCV
https://opencv.org/

용도: 별도 Python 영상 분석 코드

### NumPy
https://numpy.org/

용도: 수치 연산

### WebRTC
https://webrtc.org/

용도: 브라우저 간 실시간 영상 통신

프로젝트의 webrtc.js에는 Google STUN 서버와 Open Relay Project의 공개 STUN/TURN 서버 주소가 포함되어 있다.

### 기타 소스
프로젝트 내부 UI 디자인, 아이콘, 코드 예제, 참고한 오픈소스 저장소 등의 원본 출처와 라이선스는 별도 확인이 필요하다.

외부 소스 코드를 직접 가져온 부분이 있다면 해당 저장소 주소, 저작권자 및 라이선스를 추가 기재한다.

---

## 13. 실행 전 확인 사항 및 알려진 제한

1. main.js는 NotifySettings.js를 import하지만 압축파일의 실제 파일명은 NotifySetting.js이다. import 경로를 수정해야 한다.

2. webrtc.js는 /api/signal/ 경로를 사용하지만 현재 app.py에서 해당 시그널링 API는 확인되지 않았다. 원격 영상 기능을 사용하려면 별도 서버 구현이 필요하다.

3. pose.js에는 랜드마크 표시 기능이 구현되어 있으며, 실제 자세 판정·경고·저장 연동은 통합 상태를 별도로 확인해야 한다.

4. turtleneck.py는 face_landmarker.task 파일을 참조하지만 해당 모델 파일은 첨부 압축파일에서 확인되지 않았다. 별도 Python 자세 판정 실행 전 모델 준비가 필요하다.

5. MariaDB 서버가 실행 중이어야 하며, .env의 접속 정보가 실제 DB 설정과 일치해야 한다.

6. 이벤트 저장과 통계 기능은 API 테스트 결과를 통해 정상 동작 여부를 검증해야 한다.

7. Flask 개발 서버(debug=True)는 개발용이며 외부 공개 운영 서버로 사용하지 않는다.

---

## 14. 오류 발생 시 확인 사항

### Unknown database 'turtle_bump'
원인: 데이터베이스가 없거나 다른 서버에 연결함

확인:
SHOW DATABASES;

해결:
MariaDB 접속 정보 확인 후 필요한 경우 데이터베이스 생성

### ModuleNotFoundError: flask_cors
해결:
python -m pip install flask-cors

### ModuleNotFoundError: MySQLdb
해결:
python -m pip install mysqlclient

### HTTP 500 INTERNAL_ERROR
Flask 실행 터미널에서 Traceback 확인

확인 항목:
- DB 접속 정보
- 테이블 및 컬럼 구조
- is_final 컬럼 존재 여부
- SQL 실행 오류

### 카메라가 실행되지 않는 경우
- 브라우저 카메라 권한 확인
- 다른 프로그램의 카메라 점유 여부 확인
- localhost 또는 HTTPS 접속 여부 확인
- MediaPipe 모델 다운로드 가능 여부 확인

---

## 15. 보안 및 배포 주의사항

- .env와 실제 DB 비밀번호는 공개하지 않는다.
- Git 업로드 시 .env, .git, 캐시 파일, 불필요한 DB 백업 파일을 제외한다.
- 사용자 카메라 사용 권한을 확인한다.
- 외부 CDN과 공개 TURN 서버 사용 시 네트워크 및 개인정보 관련 사항을 검토한다.
- 배포 전 디버그 모드를 비활성화한다.
- 개발용 테스트 데이터와 실제 측정 데이터를 구분한다.

---

## 16. 프로젝트 정보

프로젝트명: NeckCare (거북이 방지턱)  
개발 형태: 팀 프로젝트  
주요 기술: HTML, CSS, JavaScript, Python, Flask, MariaDB, MediaPipe  
백엔드 및 DB 담당: D  
API 설계 기준: NeckCare API v0.3.3  

최종 작성일: 2026-10-15

※ 팀원 실명, 실제 사용한 외부 템플릿 출처, 라이선스 및 최종 테스트 결과는 제출 전에 확인하여 보완한다.