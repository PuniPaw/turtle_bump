import { PoseLandmarker, FilesetResolver, DrawingUtils }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

// 카메라 연결 + MediaPipe Pose 뼈대 표시까지만 담당한다.
// 각도 계산, 거북목 판정, 통계, 알림 등 수치/로직은 아직 연결하지 않는다(요청 시 별도 추가).

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// 노트북 내장 카메라처럼 이 기기에 카메라가 있으면 true.
export async function hasCamera() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === 'videoinput');
  } catch {
    return false;
  }
}

// video: CameraPreview.getElements()의 <video>. 스트림을 연결해 재생만 한다.
export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
  video.srcObject = stream;
  await video.play();

  return {
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

// 이미 재생 중인 video 위의 overlay 캔버스에 MediaPipe Pose 랜드마크(점·연결선)만 그린다.
// [연결 위치] 좌표를 이용한 분석이 필요해지면 result.landmarks[0]을 여기서 넘겨주면 된다.
export async function startPoseOverlay(video, overlay) {
  const landmarker = await createLandmarker();
  const ctx = overlay.getContext('2d');
  const drawer = new DrawingUtils(ctx);
  let running = true;
  let lastVideoTime = -1;

  function loop() {
    if (!running) return;
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;
      }
      const result = landmarker.detectForVideo(video, performance.now());
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (result.landmarks.length) {
        const lm = result.landmarks[0];
        drawer.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#ffffff88', lineWidth: 2 });
        drawer.drawLandmarks(lm, { color: '#a99cff', radius: 3 });
      }
    }
    requestAnimationFrame(loop);
  }
  loop();

  return {
    stop() {
      running = false;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      landmarker.close();
    },
  };
}
