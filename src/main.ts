import './style.css';
import { CameraManager, CameraDevice } from './capture/cameraManager';
import { Handedness } from './types';

type CameraAngleMode = 'face-on' | 'dtl' | 'dual';

// UI Elements
const videoPanel = document.getElementById('video-panel') as HTMLElement;
const videoEl = document.getElementById('webcam-video') as HTMLVideoElement;
const canvasEl = document.getElementById('overlay-canvas') as HTMLCanvasElement;
const ctx = canvasEl.getContext('2d')!;

const videoContainerDtl = document.getElementById('video-container-dtl') as HTMLDivElement;
const videoElDtl = document.getElementById('webcam-video-dtl') as HTMLVideoElement;
const canvasElDtl = document.getElementById('overlay-canvas-dtl') as HTMLCanvasElement;
const ctxDtl = canvasElDtl.getContext('2d')!;

const angleToggle = document.getElementById('angle-toggle') as HTMLDivElement;
const primaryCamLabel = document.getElementById('primary-cam-label') as HTMLLabelElement;
const secondaryCamGroup = document.getElementById('secondary-cam-group') as HTMLDivElement;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const cameraSelectDtl = document.getElementById('camera-select-dtl') as HTMLSelectElement;
const refreshCamerasBtn = document.getElementById('refresh-cameras-btn') as HTMLButtonElement;
const fpsSelect = document.getElementById('fps-select') as HTMLSelectElement;
const mirrorBtn = document.getElementById('mirror-btn') as HTMLButtonElement;
const guideBtn = document.getElementById('guide-btn') as HTMLButtonElement;
const videoUpload = document.getElementById('video-upload') as HTMLInputElement;
const handednessToggle = document.getElementById('handedness-toggle') as HTMLDivElement;

const camStatusPill = document.getElementById('cam-status-pill') as HTMLSpanElement;
const camAnglePill = document.getElementById('cam-angle-pill') as HTMLSpanElement;
const camResPill = document.getElementById('cam-res-pill') as HTMLSpanElement;
const camFpsPill = document.getElementById('cam-fps-pill') as HTMLSpanElement;
const targetIndicator = document.getElementById('target-indicator') as HTMLDivElement;

const phoneDetectBanner = document.getElementById('phone-detect-banner') as HTMLDivElement;
const statDevice = document.getElementById('stat-device') as HTMLSpanElement;
const statRes = document.getElementById('stat-res') as HTMLSpanElement;
const statFps = document.getElementById('stat-fps') as HTMLSpanElement;
const statAngle = document.getElementById('stat-angle') as HTMLSpanElement;
const checklistTitle = document.getElementById('checklist-title') as HTMLHeadingElement;
const checklistItems = document.getElementById('checklist-items') as HTMLUListElement;

// App State
const primaryCamManager = new CameraManager(videoEl);
const dtlCamManager = new CameraManager(videoElDtl);

let angleMode: CameraAngleMode = 'face-on';
let isMirrored = true;
let showFramingGuide = true;
let handedness: Handedness = 'right';
let availableDevices: CameraDevice[] = [];

videoEl.classList.toggle('mirrored', isMirrored);

/**
 * Updates the UI labels, target arrows, and sidebar explanation for the active camera angle.
 */
function updateAngleAndHandUI(): void {
  if (angleMode === 'face-on') {
    primaryCamLabel.textContent = 'Laptop Camera (Face-On)';
    camAnglePill.textContent = '💻 Face-On (Front)';
    statAngle.textContent = 'Face-On (Front)';
    secondaryCamGroup.classList.add('hidden');
    videoContainerDtl.classList.add('hidden');
    videoPanel.classList.remove('dual-mode');

    const targetIsLeftOnScreen =
      (handedness === 'right' && isMirrored) || (handedness === 'left' && !isMirrored);
    targetIndicator.textContent = targetIsLeftOnScreen
      ? '⬅ Target Direction (Lead Side)'
      : 'Target Direction (Lead Side) ➔';

    checklistTitle.textContent = '💻 Face-On Guide (Laptop)';
    checklistItems.innerHTML = `
      <li><strong>Head Zone (Blue Circle):</strong> Keep your head inside this circle from takeaway to impact (&lt; 5 cm drift).</li>
      <li><strong>Hip Level &amp; Sway Corridor (Green):</strong> Tracks lateral hip sway away from target at the top, and weight shift toward target at impact.</li>
      <li><strong>Address Hands (Amber Box):</strong> Hold hands steady below hips for ~1s to auto-start swing capture.</li>
    `;
  } else if (angleMode === 'dtl') {
    primaryCamLabel.textContent = 'Phone Camera (Behind Swing)';
    camAnglePill.textContent = '📱 Down-The-Line (90° Behind)';
    statAngle.textContent = 'Down-The-Line (90°)';
    secondaryCamGroup.classList.add('hidden');
    videoContainerDtl.classList.add('hidden');
    videoPanel.classList.remove('dual-mode');

    // Down-the-line looks straight down the target line into the screen
    targetIndicator.textContent = '⬆ Target Line (Into Screen)';

    checklistTitle.textContent = '📱 Down-The-Line Guide (Phone)';
    checklistItems.innerHTML = `
      <li><strong>Tush Line (Vertical Green Wall):</strong> Glutes touch this line at address. Moving forward toward the ball = <em>Early Extension</em>.</li>
      <li><strong>Spine Tilt (Blue Angle):</strong> ~35–45° forward tilt from hips to shoulders. Maintain through impact.</li>
      <li><strong>Swing Plane Corridor (Amber Diagonal):</strong> Club/hands should travel inside this corridor (under = in-to-out draw; over = out-to-in slice).</li>
      <li><strong>Target Line (Bottom Arrow):</strong> Align phone behind your hands/heels pointing straight at the target.</li>
    `;
  } else {
    // Dual mode: Left = Laptop Face-On, Right = Phone Down-The-Line
    primaryCamLabel.textContent = 'Laptop (Face-On)';
    camAnglePill.textContent = '💻 Face-On (Front)';
    statAngle.textContent = 'Dual (90° Split)';
    secondaryCamGroup.classList.remove('hidden');
    videoContainerDtl.classList.remove('hidden');
    videoPanel.classList.add('dual-mode');

    const targetIsLeftOnScreen =
      (handedness === 'right' && isMirrored) || (handedness === 'left' && !isMirrored);
    targetIndicator.textContent = targetIsLeftOnScreen
      ? '⬅ Target (Lead Side)'
      : 'Target (Lead Side) ➔';

    checklistTitle.textContent = '⚡ 90° Dual-Camera Setup';
    checklistItems.innerHTML = `
      <li><strong>Left Feed (Laptop Face-On):</strong> Faces your chest for Head Movement, Hip Sway, Turn &amp; Lead Arm.</li>
      <li><strong>Right Feed (Phone Behind Swing):</strong> 90° perpendicular behind your hands for Spine Angle, Tush Line &amp; Swing Plane.</li>
    `;
  }

  redrawOverlays();
}

/**
 * Face-On (Front-On Laptop) Framing Guide:
 * Symmetric chest view with Head stability box, Hip sway corridor, and Address hands trigger box.
 */
function drawFaceOnGuide(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!showFramingGuide) return;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const hipY = h * 0.54;

  context.save();

  // 1. Center spine / stance line
  context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  context.lineWidth = 1.5;
  context.setLineDash([6, 6]);
  context.beginPath();
  context.moveTo(cx, h * 0.12);
  context.lineTo(cx, h * 0.92);
  context.stroke();

  // 2. Hip-height horizontal line + sway boundaries
  const swayHalfW = w * 0.11;
  context.strokeStyle = 'rgba(16, 185, 129, 0.5)';
  context.beginPath();
  context.moveTo(cx - swayHalfW * 1.8, hipY);
  context.lineTo(cx + swayHalfW * 1.8, hipY);
  context.stroke();

  // Left & Right Hip Sway limit markers
  context.setLineDash([]);
  context.strokeStyle = 'rgba(16, 185, 129, 0.75)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(cx - swayHalfW, hipY - 28);
  context.lineTo(cx - swayHalfW, hipY + 28);
  context.moveTo(cx + swayHalfW, hipY - 28);
  context.lineTo(cx + swayHalfW, hipY + 28);
  context.stroke();

  context.fillStyle = 'rgba(16, 185, 129, 0.9)';
  context.font = '600 11px Inter, system-ui, sans-serif';
  context.textAlign = 'center';
  context.fillText('HIP SWAY CORRIDOR', cx, hipY - 34);

  // 3. Head Zone Circle
  const headRadius = Math.min(w, h) * 0.055;
  const headY = h * 0.24;
  context.strokeStyle = 'rgba(59, 130, 246, 0.75)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(cx, headY, headRadius, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = 'rgba(147, 197, 253, 0.9)';
  context.fillText('HEAD ZONE (<5cm)', cx, headY - headRadius - 8);

  // 4. Address Hand Trigger Zone (below hips)
  const handBoxW = w * 0.12;
  const handBoxH = h * 0.11;
  const handBoxY = hipY + h * 0.03;
  context.strokeStyle = 'rgba(245, 158, 11, 0.7)';
  context.strokeRect(cx - handBoxW / 2, handBoxY, handBoxW, handBoxH);
  context.fillStyle = 'rgba(253, 230, 138, 0.9)';
  context.fillText('ADDRESS HANDS', cx, handBoxY + handBoxH + 15);

  context.restore();
}

/**
 * Down-The-Line (Perpendicular Phone Behind Swing) Framing Guide:
 * Side profile view showing Tush Line (hip depth), Spine Tilt angle, Swing Plane corridor, and Target Line.
 */
function drawDownTheLineGuide(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!showFramingGuide) return;

  const w = canvas.width;
  const h = canvas.height;

  // In Down-the-Line view behind a right-handed golfer:
  // Golfer stands on the left side of the frame, bending toward the ball on the right.
  // Flip horizontally if left-handed.
  const flip = handedness === 'left';
  const xCoord = (normX: number) => (flip ? w * (1 - normX) : w * normX);

  const hipX = xCoord(0.34);
  const hipY = h * 0.54;
  const shoulderX = xCoord(0.47);
  const shoulderY = h * 0.30;
  const ballX = xCoord(0.66);
  const ballY = h * 0.86;
  const handsX = xCoord(0.51);
  const handsY = h * 0.58;

  context.save();
  context.font = '600 11px Inter, system-ui, sans-serif';

  // 1. Target Line on ground (from ball straight into the screen)
  const targetVanishX = xCoord(0.64);
  const targetVanishY = h * 0.18;
  context.strokeStyle = 'rgba(59, 130, 246, 0.6)';
  context.lineWidth = 2;
  context.setLineDash([7, 5]);
  context.beginPath();
  context.moveTo(ballX, h * 0.94);
  context.lineTo(targetVanishX, targetVanishY);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#93c5fd';
  context.fillText('⬆ TARGET LINE', targetVanishX + (flip ? -75 : 8), targetVanishY + 14);

  // Ball marker
  context.fillStyle = '#f8fafc';
  context.beginPath();
  context.arc(ballX, ballY, 6, 0, Math.PI * 2);
  context.fill();
  context.fillText('BALL', ballX + (flip ? -36 : 10), ballY + 4);

  // 2. Tush Line (Vertical Hip Depth Wall — detects Early Extension)
  context.strokeStyle = 'rgba(16, 185, 129, 0.8)';
  context.lineWidth = 2.5;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(hipX, h * 0.32);
  context.lineTo(hipX, h * 0.88);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#6ee7b7';
  context.fillText('TUSH LINE (HIP DEPTH)', hipX + (flip ? 8 : -130), h * 0.36);

  // 3. Spine Tilt Line (Hip to Shoulder ~40 deg forward bend)
  context.strokeStyle = 'rgba(59, 130, 246, 0.85)';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(hipX, hipY);
  context.lineTo(shoulderX, shoulderY);
  context.stroke();

  context.fillStyle = '#93c5fd';
  context.fillText('SPINE ANGLE (~40°)', shoulderX + (flip ? 10 : -115), shoulderY - 8);

  // 4. Swing Plane Corridor (Ball -> Hands -> Through Shoulder)
  const planeTopX = xCoord(0.26);
  const planeTopY = h * 0.16;
  context.strokeStyle = 'rgba(245, 158, 11, 0.8)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(ballX, ballY);
  context.lineTo(planeTopX, planeTopY);
  context.stroke();

  // Upper parallel bound of swing plane corridor
  context.strokeStyle = 'rgba(245, 158, 11, 0.4)';
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(ballX, ballY - 22);
  context.lineTo(planeTopX + (flip ? -35 : 35), planeTopY - 22);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#fde68a';
  context.fillText('SWING PLANE CORRIDOR', planeTopX + (flip ? -10 : 10), planeTopY - 6);

  // 5. Address Hands Box
  context.strokeStyle = 'rgba(245, 158, 11, 0.75)';
  context.strokeRect(handsX - 28, handsY - 22, 56, 44);
  context.fillText('HANDS', handsX - 18, handsY + 36);

  context.restore();
}

function redrawOverlays(): void {
  if (angleMode === 'face-on') {
    drawFaceOnGuide(canvasEl, ctx);
  } else if (angleMode === 'dtl') {
    drawDownTheLineGuide(canvasEl, ctx);
  } else {
    drawFaceOnGuide(canvasEl, ctx);
    drawDownTheLineGuide(canvasElDtl, ctxDtl);
  }
}

/**
 * Enumerates cameras and auto-assigns Laptop webcam vs Phone (DroidCam/Iriun).
 */
async function populateCameras(autoStart = true): Promise<void> {
  availableDevices = await cameraManagerListDevices();
  cameraSelect.innerHTML = '';
  cameraSelectDtl.innerHTML = '';

  if (availableDevices.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No camera detected';
    cameraSelect.appendChild(opt);
    phoneDetectBanner.className = 'banner banner-warn';
    phoneDetectBanner.textContent =
      'No cameras detected. Start DroidCam or Iriun Webcam on your PC & phone, then click ↻.';
    return;
  }

  const phoneCam = availableDevices.find((d) => d.isPhoneCam);
  const laptopCam = availableDevices.find((d) => !d.isPhoneCam) || availableDevices[0];

  availableDevices.forEach((device) => {
    const label = device.isPhoneCam ? `📱 ${device.label}` : `💻 ${device.label}`;
    const opt1 = document.createElement('option');
    opt1.value = device.deviceId;
    opt1.textContent = label;
    cameraSelect.appendChild(opt1);

    const opt2 = document.createElement('option');
    opt2.value = device.deviceId;
    opt2.textContent = label;
    cameraSelectDtl.appendChild(opt2);
  });

  // Smart default assignment based on mode:
  // Face-On defaults to Laptop webcam; DTL defaults to Phone cam if available
  if (angleMode === 'dtl' && phoneCam) {
    cameraSelect.value = phoneCam.deviceId;
  } else {
    cameraSelect.value = laptopCam.deviceId;
  }

  if (phoneCam) {
    cameraSelectDtl.value = phoneCam.deviceId;
    phoneDetectBanner.className = 'banner banner-success';
    phoneDetectBanner.innerHTML = `<strong>Phone Detected (Behind Swing):</strong> ${phoneCam.label}<br/><strong>Laptop (Front-On):</strong> ${laptopCam.label}`;
  } else if (availableDevices.length > 1) {
    cameraSelectDtl.value = availableDevices[1].deviceId;
    phoneDetectBanner.className = 'banner banner-info';
    phoneDetectBanner.innerHTML = `<strong>${availableDevices.length} Cameras Ready.</strong> Select which is Front-On vs Behind Swing above.`;
  } else {
    cameraSelectDtl.value = availableDevices[0].deviceId;
    phoneDetectBanner.className = 'banner banner-info';
    phoneDetectBanner.innerHTML = `<strong>1 Camera Connected:</strong> ${availableDevices[0].label}.<br/>Open DroidCam/Iriun and click <strong>↻</strong> to add your phone as the 90° Behind-Swing camera.`;
  }

  if (autoStart) {
    await startSelectedCameras();
  }
}

async function cameraManagerListDevices(): Promise<CameraDevice[]> {
  return primaryCamManager.listDevices();
}

async function startSelectedCameras(): Promise<void> {
  const deviceId = cameraSelect.value || undefined;
  const targetFps = Number(fpsSelect.value) || 60;

  camStatusPill.textContent = 'Connecting...';
  camStatusPill.className = 'hud-pill status-pill';

  try {
    const stats = await primaryCamManager.startCamera(deviceId, targetFps);
    camStatusPill.textContent = '● LIVE';
    camStatusPill.className = 'hud-pill status-pill connected';
    camResPill.textContent = `${stats.width} × ${stats.height}`;
    statDevice.textContent = stats.deviceLabel;
    statRes.textContent = `${stats.width}×${stats.height}`;
  } catch (err: any) {
    console.error('Primary camera start failed:', err);
    camStatusPill.textContent = 'Camera Error';
    camStatusPill.className = 'hud-pill status-pill error';
  }

  if (angleMode === 'dual') {
    const dtlDeviceId = cameraSelectDtl.value || undefined;
    if (dtlDeviceId && dtlDeviceId !== deviceId) {
      try {
        await dtlCamManager.startCamera(dtlDeviceId, targetFps);
      } catch (err) {
        console.warn('Secondary DTL camera start failed:', err);
      }
    }
  } else {
    dtlCamManager.stop();
  }
}

// Per-frame callbacks
primaryCamManager.onFrame((_video, _timestampMs, measuredFps) => {
  camFpsPill.textContent = `${measuredFps} FPS`;
  camFpsPill.className = `hud-pill fps-pill ${measuredFps >= 45 ? 'good' : 'warn'}`;
  statFps.textContent = `${measuredFps} fps`;

  const stats = primaryCamManager.getStreamStats();
  if (stats.width && stats.height) {
    camResPill.textContent = `${stats.width} × ${stats.height}`;
    statRes.textContent = `${stats.width}×${stats.height}`;
  }

  if (angleMode === 'dtl') {
    drawDownTheLineGuide(canvasEl, ctx);
  } else {
    drawFaceOnGuide(canvasEl, ctx);
  }
});

dtlCamManager.onFrame(() => {
  if (angleMode === 'dual') {
    drawDownTheLineGuide(canvasElDtl, ctxDtl);
  }
});

// Event Listeners
angleToggle.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const newAngle = btn.dataset.angle as CameraAngleMode;
  if (!newAngle || newAngle === angleMode) return;

  angleMode = newAngle;
  angleToggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  // Auto-select phone camera when switching to DTL mode if one is available
  const phoneCam = availableDevices.find((d) => d.isPhoneCam);
  const laptopCam = availableDevices.find((d) => !d.isPhoneCam);
  if (angleMode === 'dtl' && phoneCam) {
    cameraSelect.value = phoneCam.deviceId;
    // DTL behind-the-golfer view shouldn't be mirrored by default so left/right path is true
    isMirrored = false;
  } else if (angleMode === 'face-on' && laptopCam) {
    cameraSelect.value = laptopCam.deviceId;
    isMirrored = true;
  }

  videoEl.classList.toggle('mirrored', isMirrored);
  mirrorBtn.classList.toggle('active', isMirrored);
  mirrorBtn.textContent = `Mirror: ${isMirrored ? 'ON' : 'OFF'}`;

  updateAngleAndHandUI();
  startSelectedCameras();
});

cameraSelect.addEventListener('change', () => {
  startSelectedCameras();
});

cameraSelectDtl.addEventListener('change', () => {
  startSelectedCameras();
});

refreshCamerasBtn.addEventListener('click', () => {
  populateCameras(true);
});

fpsSelect.addEventListener('change', () => {
  startSelectedCameras();
});

mirrorBtn.addEventListener('click', () => {
  isMirrored = !isMirrored;
  videoEl.classList.toggle('mirrored', isMirrored);
  mirrorBtn.classList.toggle('active', isMirrored);
  mirrorBtn.textContent = `Mirror: ${isMirrored ? 'ON' : 'OFF'}`;
  updateAngleAndHandUI();
});

guideBtn.addEventListener('click', () => {
  showFramingGuide = !showFramingGuide;
  guideBtn.classList.toggle('active', showFramingGuide);
  guideBtn.textContent = `Guide: ${showFramingGuide ? 'ON' : 'OFF'}`;
  redrawOverlays();
});

handednessToggle.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const hand = btn.dataset.hand as Handedness;
  if (!hand) return;

  handedness = hand;
  handednessToggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  updateAngleAndHandUI();
});

videoUpload.addEventListener('change', async () => {
  const file = videoUpload.files?.[0];
  if (!file) return;
  const stats = await primaryCamManager.startVideoFile(file);
  camStatusPill.textContent = '▶ VIDEO FILE';
  camStatusPill.className = 'hud-pill status-pill connected';
  statDevice.textContent = stats.deviceLabel;
  statRes.textContent = `${stats.width}×${stats.height}`;
});

// Initialize on load
updateAngleAndHandUI();
populateCameras(true);
