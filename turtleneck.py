"""
거북목 / 허리굽힘 / 의자 당김 판정 v4 (MediaPipe Pose + Face Landmarker, 학습 모델 없음)

v3와 차이: 머리 쪽 측정을 Pose 귀(7, 8) 대신 Face Landmarker의 facial transformation matrix로 바꿈
  - 머리까지 거리 z_head (cm), yaw / pitch (도)를 얼굴 478점 전체로 계산 -> 귀 2점보다 훨씬 안정적
  - 고개를 돌려도(yaw) 거리 값이 변하지 않음 (v3는 귀 간격이 줄어 head 값이 떨어짐)
  - 어깨폭(Pose)으로 어깨까지 거리 z_sh를 추정해서 '머리가 어깨보다 몇 cm 앞인가'를 직접 계산

흐름 / 키는 v3와 같음: 바른 자세로 's' -> 3초 측정 -> 판정,  q = 종료

판정에 쓰는 값 (모두 cm, + 방향):
  fwd   : 머리 전진량 = (z_sh - z_head) - 초기값          -> 거북목 (의자 당김에는 0으로 유지됨)
  appr  : 어깨가 카메라 쪽으로 온 거리 (현재 기준 대비)   -> 상체 숙임 / 의자 당김
  drop  : 어깨가 내려간 거리 (현재 기준 대비, 카메라 기울기 보정) -> 상체 숙임
  dist  : 어깨가 카메라 쪽으로 온 거리 ('s' 측정 대비)   -> 화면에 너무 가까움 안내
  yaw   : 고개 좌우 회전 (초기값 대비) -> 크면 판정 보류
  * 현재 기준: 's'로 잡고, 의자를 옮긴 뒤 REANCHOR_SEC 동안 가만히 있으면 그 위치로 자동 갱신

판정 순서:
  허리굽힘 : appr > LEAN_TH and (fwd > LEAN_FWD_TH or drop > DROP_TH)   or   drop > DROP_STRONG_TH
  거북목   : fwd > FWD_TH
  의자 당김: dist > CLOSE_TH and |fwd| < CLOSE_FWD_TH (안내만)
  나머지   : 바른 자세
자세한 방법론은 README.md
"""
import math
import pathlib
import statistics
import time

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

mp_drawing = mp.solutions.drawing_utils
mp_pose = mp.solutions.pose

MODEL_PATH = pathlib.Path(__file__).resolve().parent / "face_landmarker.task"

# ================= 설정값 (여기만 조정) =================
CALIB_SEC = 3.0     # 초기 자세 측정 시간(초)
VIS_TH = 0.5        # 어깨 랜드마크 신뢰도 기준
EMA_ALPHA = 0.3     # 스무딩
HOLD_SEC = 0.5      # 같은 판정이 이 시간 이상 유지돼야 화면에 표시
FOV_V_DEG = 63.0    # Face Landmarker가 가정하는 카메라 세로 화각 (matrix와 같은 가정으로 어깨 거리 계산)

FWD_TH = 3.0        # 거북목: 머리가 어깨보다 초기 대비 이 cm 이상 앞으로
LEAN_TH = 6.0       # 허리굽힘: 어깨가 카메라 쪽으로 이 cm 이상 다가옴 (현재 기준 대비)
LEAN_FWD_TH = 2.0   #   + 머리도 같이 이 cm 이상 앞으로 (상체가 통째로 기울면 머리가 어깨보다 더 나옴)
DROP_TH = 3.0       #   또는 어깨가 이 cm 이상 내려감
DROP_STRONG_TH = 5.0  # 어깨가 이 cm 이상 내려가면 다가옴과 상관없이 허리굽힘
CLOSE_TH = 10.0     # 의자 당김 안내: 어깨가 처음 측정 대비 이 cm 이상 다가옴
CLOSE_FWD_TH = 2.0  #   그리고 |fwd|가 이 cm 미만 (머리·어깨가 같이 다가옴)
YAW_TH = 25.0       # 고개를 이 각도 이상 돌리면 판정 보류 (직전 판정 유지)

# ---- 기준 자동 갱신 (v3와 같은 구조, 단위만 cm) ----
REANCHOR_SEC = 1.8
REANCHOR_MOVE_TH = 8.0     # 어깨 거리가 현재 기준 대비 이 cm 이상 달라짐 = 의자를 옮김
REANCHOR_STABLE = 3.0      # 대기 중 어깨 거리 변동(하위10%~상위10%) cm
REANCHOR_FWD_TH = 2.0      # 대기 중 |fwd| 허용 cm (거북목 기준 FWD_TH보다 작게)
REANCHOR_FWD_RANGE = 1.5   # 대기 중 fwd 변동(하위10%~상위10%) cm. 거북목이 진행 중이면 계속 올라 거부됨
TILT_MAX = 0.5             # 카메라 기울기 보정 기울기(dY/dZ) 한계
# ======================================================

NAN = float("nan")
LM_CHIN = 152


def focal_px(h):
    return (h / 2) / math.tan(math.radians(FOV_V_DEG / 2))


def euler_deg(mat):
    """4x4 facial transformation matrix -> (yaw, pitch) 도"""
    r = np.asarray(mat, dtype=float)[:3, :3]
    r = r / np.linalg.norm(r, axis=0)
    yaw = math.degrees(math.asin(max(-1.0, min(1.0, -r[2, 0]))))
    pitch = math.degrees(math.atan2(r[2, 1], r[2, 2]))
    return yaw, pitch


def measure(pose_lm, face_lm, face_mat, w, h):
    """한 프레임의 원시 측정값. 어깨 또는 얼굴이 안 보이면 None
    pose_lm : Pose 랜드마크 목록 (11, 12 어깨만 사용)
    face_lm : Face Landmarker 478점 (152 턱만 표시용으로 사용)
    face_mat: facial transformation matrix (4x4)"""
    if pose_lm is None or face_mat is None:
        return None
    a, b = pose_lm[11], pose_lm[12]
    if a.visibility < VIS_TH or b.visibility < VIS_TH:
        return None
    sh = math.hypot((a.x - b.x) * w, (a.y - b.y) * h)
    if sh < 1:
        return None
    mat = np.asarray(face_mat, dtype=float)
    yaw, pitch = euler_deg(mat)
    return {
        "z_head": -mat[2, 3],                       # 카메라 -> 머리 거리(cm), 카메라는 -Z를 바라봄
        "yaw": yaw,
        "pitch": pitch,
        "sh": sh,                                    # 어깨폭(px)
        "sh_y": (a.y + b.y) / 2 * h - h / 2,          # 화면 중앙 기준 어깨 높이(px, 아래가 +)
        "chin_y": face_lm[LM_CHIN].y * h - h / 2 if face_lm else NAN,
        "f": focal_px(h),
    }


def shoulder_3d(sh, sh_y, f, k):
    """어깨 깊이 z_sh(cm)와 높이 Y_sh(cm). k = (어깨 깊이 x 어깨폭 px) 상수"""
    z_sh = k / sh
    return z_sh, sh_y * z_sh / f


def make_base(samples):
    """3초 동안 모은 측정값으로 초기값 계산 (중앙값)"""
    if len(samples) < 10:
        return None
    med = lambda key: statistics.median(s[key] for s in samples)
    # 바른 자세에서 머리와 어깨가 같은 깊이라고 보고 k를 정함 (의자를 옮기면 refine_k로 보정)
    k = statistics.median(s["z_head"] * s["sh"] for s in samples)
    base = {"k": k, "sh": med("sh"), "sh_y": med("sh_y"), "z_head": med("z_head"),
            "yaw": med("yaw"), "pitch": med("pitch"), "f": samples[0]["f"]}
    base["offset"] = statistics.median(k / s["sh"] - s["z_head"] for s in samples)
    necks = [shoulder_3d(s["sh"], s["sh_y"], s["f"], k)[1] - s["chin_y"] * s["z_head"] / s["f"]
             for s in samples if not math.isnan(s["chin_y"])]
    base["neck"] = statistics.median(necks) if necks else NAN
    return base


def refine_k(base, old, new):
    """의자 이동(수평 평행 이동) 전후 두 위치에서 '머리~어깨 깊이 차는 그대로'라는 조건으로 k를 다시 풂
    k/sh1 - z1 = k/sh2 - z2  ->  k = (z1 - z2) / (1/sh1 - 1/sh2)"""
    den = 1 / old["sh"] - 1 / new["sh"]
    if abs(den) < 1e-9:
        return
    k = (old["z_head"] - new["z_head"]) / den
    if 0.7 * base["k"] < k < 1.3 * base["k"]:       # 이상값이면 무시
        base["k"] = k
        base["offset"] = k / new["sh"] - new["z_head"]


def features(m, base, ref):
    k = base["k"]
    z_sh, y_sh = shoulder_3d(m["sh"], m["sh_y"], m["f"], k)
    ref_z, ref_y = shoulder_3d(ref["sh"], ref["sh_y"], m["f"], k)
    dz = z_sh - ref_z
    neck = y_sh - m["chin_y"] * m["z_head"] / m["f"]
    return {
        "fwd": (z_sh - m["z_head"]) - base["offset"],
        "appr": -dz,
        "drop": (y_sh - ref_y) - ref["tilt"] * dz,          # 카메라가 기울어 있으면 앞뒤 이동이 상하로 보이는 것 보정
        "dist": k / base["sh"] - z_sh,
        "yaw": m["yaw"] - base["yaw"],
        "pitch": m["pitch"] - base["pitch"],
        "neck": neck - base["neck"],                           # 표시용: 턱~어깨 세로 거리 변화(cm)
        "z_head": m["z_head"],
        "z_sh": z_sh,
        "Y_sh": y_sh,
    }


def p10_p90(vals):
    """하위 10% ~ 상위 10% 범위 (한두 프레임 튀는 값 무시)"""
    v = sorted(vals)
    return v[len(v) * 9 // 10] - v[len(v) // 10]


def judge(f):
    leaning = f["appr"] > LEAN_TH and (f["fwd"] > LEAN_FWD_TH or f["drop"] > DROP_TH)
    if leaning or f["drop"] > DROP_STRONG_TH:
        return "WAIST"
    if f["fwd"] > FWD_TH:
        return "TURTLE"
    if f["dist"] > CLOSE_TH and abs(f["fwd"]) < CLOSE_FWD_TH:
        return "CLOSE"
    return "GOOD"


BANNER = {
    "GOOD":   ("GOOD POSTURE", (0, 150, 0)),
    "TURTLE": ("WARNING: TURTLE NECK", (0, 0, 255)),
    "WAIST":  ("WARNING: LEANING FORWARD (WAIST)", (0, 120, 255)),
    "CLOSE":  ("TOO CLOSE TO SCREEN (chair)", (0, 170, 200)),
    "NOVIS":  ("FACE / SHOULDERS NOT VISIBLE", (90, 90, 90)),
    "CALIB":  ("CALIBRATING - sit straight", (0, 140, 140)),
    "IDLE":   ("press 's' to calibrate", (60, 60, 60)),
}


class V4Tracker:
    """v3 메인 루프와 같은 구조(calib -> live, EMA, HOLD, 기준 자동 갱신)"""

    def __init__(self):
        self.phase = "idle"
        self.calib = []
        self.base = self.ref = None
        self.ema = {}
        self.cand, self.cand_since, self.shown = "GOOD", 0.0, "GOOD"
        self.calm_since, self.calm_buf = None, []
        self.msg = ""
        self.reanchors = 0
        self.gated = False

    def start_calib(self, now):
        self.phase, self.phase_start, self.calib = "calib", now, []

    def update(self, m, now):
        self.msg, self.gated = "", False
        if self.phase == "idle":
            return "IDLE"
        if self.phase == "calib":
            if m:
                self.calib.append(m)
            if now - self.phase_start >= CALIB_SEC:
                self.base = make_base(self.calib)
                if self.base is None:
                    self.phase, self.calib = "idle", []
                    return "IDLE"
                self.phase, self.ema = "live", {}
                self.ref = {k: self.base[k] for k in ("sh", "sh_y", "z_head")}
                self.ref["tilt"] = 0.0
                self.calm_since, self.calm_buf = None, []
                self.cand, self.cand_since, self.shown = "GOOD", now, "GOOD"
            return "CALIB"

        if m is None:
            return "NOVIS"
        f = features(m, self.base, self.ref)
        if abs(f["yaw"]) > YAW_TH:                  # 고개를 많이 돌림 -> 직전 판정 유지
            self.gated = True
            self.msg = f"head turned ({f['yaw']:+.0f} deg) - holding"
            self.calm_since, self.calm_buf = None, []
            return self.shown
        ema = self.ema
        for k, v in f.items():
            ema[k] = v if k not in ema else EMA_ALPHA * v + (1 - EMA_ALPHA) * ema[k]
        state = judge(ema)
        if state != self.cand:
            self.cand, self.cand_since = state, now
        if now - self.cand_since >= HOLD_SEC:
            self.shown = self.cand
        shown = self.shown
        self.last_ema = dict(ema)

        # ---- 기준 자동 갱신: 어깨 거리는 크게 변했는데 머리 전진(fwd)은 그대로 = 의자를 옮김 ----
        moved = abs(f["appr"]) > REANCHOR_MOVE_TH
        fwd_ok = abs(ema["fwd"]) < REANCHOR_FWD_TH
        drop_ok = f["appr"] < 0 or ema["drop"] < DROP_TH
        if not (moved and fwd_ok and drop_ok):
            self.calm_since, self.calm_buf = None, []
        else:
            if self.calm_since is None:
                self.calm_since, self.calm_buf = now, []
            self.calm_buf.append({**m, "z_sh": f["z_sh"], "fwd": ema["fwd"]})
            if now - self.calm_since >= REANCHOR_SEC:
                buf = self.calm_buf
                spread = p10_p90(s["z_sh"] for s in buf)
                if spread < REANCHOR_STABLE and p10_p90(s["fwd"] for s in buf) < REANCHOR_FWD_RANGE:
                    new = {k: statistics.median(s[k] for s in buf) for k in ("sh", "sh_y", "z_head")}
                    refine_k(self.base, self.ref, new)
                    f_ = m["f"]
                    oz, oy = shoulder_3d(self.ref["sh"], self.ref["sh_y"], f_, self.base["k"])
                    nz, ny = shoulder_3d(new["sh"], new["sh_y"], f_, self.base["k"])
                    # 의자 이동은 수평 이동 -> 이때 보인 상하 변화(dY/dZ)가 카메라 기울기
                    new["tilt"] = max(-TILT_MAX, min(TILT_MAX, (ny - oy) / (nz - oz)))
                    self.ref = new
                    self.ema = {}
                    self.reanchors += 1
                    self.msg = "REFERENCE UPDATED"
                self.calm_since, self.calm_buf = None, []
        if self.calm_since is not None:
            self.msg = "chair moved - hold still"
        return shown

    def lines(self):
        e = getattr(self, "last_ema", None)
        if self.phase != "live" or not e:
            return []
        return [
            f"fwd   {e['fwd']:+6.1f}cm (turtle > {FWD_TH})",
            f"appr  {e['appr']:+6.1f}cm (lean > {LEAN_TH})",
            f"drop  {e['drop']:+6.1f}cm (waist > {DROP_TH})",
            f"dist  {e['dist']:+6.1f}cm (close > {CLOSE_TH})",
            f"yaw {e['yaw']:+4.0f}  pitch {e['pitch']:+4.0f}  neck {e['neck']:+5.1f}cm",
            f"head {e['z_head']:5.1f}cm  shoulder {e['z_sh']:5.1f}cm  tilt {self.ref['tilt']:+.2f}",
        ]


def create_face_landmarker():
    """경로에 '[1]' 같은 문자가 있어도 되도록 모델을 바이트로 읽어서 넘김"""
    opts = vision.FaceLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_buffer=MODEL_PATH.read_bytes()),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=True,
    )
    return vision.FaceLandmarker.create_from_options(opts)


class FaceRunner:
    """detect_for_video에 단조 증가 타임스탬프를 넣어주는 래퍼"""

    def __init__(self):
        self.lm = create_face_landmarker()
        self.ts = -1

    def __call__(self, rgb, now):
        self.ts = max(self.ts + 1, int(now * 1000))
        res = self.lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), self.ts)
        if not res.face_landmarks or not res.facial_transformation_matrixes:
            return None, None
        return res.face_landmarks[0], res.facial_transformation_matrixes[0]

    def close(self):
        self.lm.close()


def draw_banner(frame, text, color):
    h, w = frame.shape[:2]
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, h - 60), (w, h), color, -1)
    cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)
    cv2.putText(frame, text, (15, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)


def draw_face_points(frame, face_lm):
    if not face_lm:
        return
    h, w = frame.shape[:2]
    for i in (1, 33, 263, 61, 291, LM_CHIN):     # 코끝, 눈꼬리, 입꼬리, 턱
        p = face_lm[i]
        cv2.circle(frame, (int(p.x * w), int(p.y * h)), 3, (255, 0, 255), -1)


def draw_panel(frame, tracker, state, lines, title=None):
    if title:
        cv2.putText(frame, title, (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    draw_banner(frame, *BANNER[state])
    y0 = 50 if title else 30
    for i, s in enumerate(lines):
        cv2.putText(frame, s, (10, y0 + 23 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
    if tracker.phase == "calib":
        cv2.putText(frame, "CALIB: sit straight", (10, y0), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    if tracker.msg:
        cv2.putText(frame, tracker.msg, (10, y0 + 23 * len(lines) + 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2)


def open_window(name, w=640, h=480):
    """창을 맨 앞에 띄움 (VS Code에서 실행하면 창이 VS Code 뒤에 숨는 경우가 있음)"""
    cv2.namedWindow(name, cv2.WINDOW_NORMAL | cv2.WINDOW_KEEPRATIO)
    cv2.resizeWindow(name, w, h)
    cv2.setWindowProperty(name, cv2.WND_PROP_TOPMOST, 1)
    print(f"카메라 창 '{name}'을 열었습니다. 바른 자세로 앉아 창을 클릭한 뒤 's'를 누르세요 (q = 종료).\n"
          "(터미널의 W0000 ... / UserWarning 메시지는 mediapipe 시작 로그라 무시해도 됩니다)", flush=True)


def main():
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("카메라를 열 수 없습니다. 다른 프로그램(다른 실행 창, Jupyter, 화상회의 등)이 카메라를 쓰고 있는지 확인하세요.")
        return
    tracker = V4Tracker()
    face = FaceRunner()
    open_window("Pose + Face (v4)")
    with mp_pose.Pose(min_detection_confidence=0.5, min_tracking_confidence=0.5) as pose:
        while cap.isOpened():
            ok, frame = cap.read()
            if not ok:
                print("카메라로부터 영상을 가져올 수 없습니다.")
                continue
            frame = cv2.flip(frame, 1)
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            now = time.perf_counter()
            h, w = frame.shape[:2]

            pres = pose.process(rgb)
            face_lm, face_mat = face(rgb, now)
            pose_lm = pres.pose_landmarks.landmark if pres.pose_landmarks else None
            if pres.pose_landmarks:
                mp_drawing.draw_landmarks(frame, pres.pose_landmarks, mp_pose.POSE_CONNECTIONS)
            draw_face_points(frame, face_lm)

            m = measure(pose_lm, face_lm, face_mat, w, h)
            prev_phase = tracker.phase
            state = tracker.update(m, now)
            if prev_phase == "calib" and tracker.phase == "live":
                print("초기값:", {k: round(v, 3) for k, v in tracker.base.items()})
            elif prev_phase == "calib" and tracker.phase == "idle":
                print("초기값 측정 실패: 얼굴과 양 어깨가 화면에 보이게 앉은 뒤 다시 's'를 눌러주세요.")
            if tracker.msg == "REFERENCE UPDATED":
                print("의자 위치 변경 -> 기준 갱신:", {k: round(v, 2) for k, v in tracker.ref.items()})
            draw_panel(frame, tracker, state, tracker.lines())
            cv2.imshow("Pose + Face (v4)", frame)

            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                break
            if key == ord('s'):
                tracker.start_calib(time.perf_counter())
    face.close()
    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()