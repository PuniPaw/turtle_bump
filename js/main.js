import { PoseLandmarker, FilesetResolver, DrawingUtils }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const video  = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx    = canvas.getContext("2d");
const drawer = new DrawingUtils(ctx);
const $ = (id) => document.getElementById(id);

// ---- 팀원용 인터페이스 -------------------------------------------------
// 다른 파트(각도 판정, UI, 통계)는 이 함수만 구독하면 됩니다.
// callback(landmarks, { width, height }) : landmarks는 33개 관절(정규화 좌표 0~1)
const listeners = [];
export function onLandmarks(callback) { listeners.push(callback); }
window.onLandmarks = onLandmarks; // 콘솔/다른 스크립트에서도 쓸 수 있게

// ---- 귀-어깨 기울기 ------------------
// 랜드마크 번호: 귀 L7 R8 / 어깨 L11 R12
function pickSide(lm) {
  const left  = lm[7].visibility + lm[11].visibility;
  const right = lm[8].visibility + lm[12].visibility;
  return left >= right
    ? { side: "왼쪽", ear: lm[7], shoulder: lm[11] }
    : { side: "오른쪽", ear: lm[8], shoulder: lm[12] };
}

// 어깨→귀 선이 수직선과 이루는 각도(도). 0이면 곧게 선 상태, 클수록 머리가 앞으로 나옴.
function headTilt(ear, shoulder, w, h) {
  const dx = Math.abs(ear.x - shoulder.x) * w;
  const dy = (shoulder.y - ear.y) * h;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

// ---- 화면 표시 ----------------------------------------------------------
onLandmarks((lm, { width, height }) => {
  const { side, ear, shoulder } = pickSide(lm);
  const tilt = headTilt(ear, shoulder, width, height);
  $("side").textContent     = side;
  $("ear").textContent      = `${ear.x.toFixed(3)}, ${ear.y.toFixed(3)}`;
  $("shoulder").textContent = `${shoulder.x.toFixed(3)}, ${shoulder.y.toFixed(3)}`;
  const el = $("angle");
  el.textContent = `${tilt.toFixed(1)}°`;
  el.className = tilt > 25 ? "bad" : "ok"; // 임시 기준값, 보정 기능으로 대체 예정
});

// ---- 초기화 + 루프 ------------------------------------------------------
let landmarker, lastVideoTime = -1;

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: "VIDEO",
    numPoses: 1,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    return await PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

function loop() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = landmarker.detectForVideo(video, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (result.landmarks.length) {
      const lm = result.landmarks[0];
      drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: "#ffffff88", lineWidth: 2 });
      drawer.drawLandmarks(lm, { color: "#2a6df4", radius: 3 });
      const size = { width: video.videoWidth, height: video.videoHeight };
      listeners.forEach((fn) => fn(lm, size));
    }
  }
  requestAnimationFrame(loop);
}

$("start").addEventListener("click", async () => {
  const btn = $("start"), status = $("status");
  btn.disabled = true;
  try {
    status.textContent = "모델을 불러오는 중...";
    landmarker = await createLandmarker();
    status.textContent = "카메라 권한을 확인하는 중...";
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    status.textContent = "분석 중입니다. 측면으로 앉아 귀와 어깨가 보이게 해주세요.";
    loop();
  } catch (err) {
    console.error(err);
    status.textContent = `시작하지 못했습니다: ${err.message}. localhost 또는 HTTPS에서 열었는지 확인해주세요.`;
    btn.disabled = false;
  }
});