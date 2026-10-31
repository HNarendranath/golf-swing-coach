import './style.css';
import { CameraManager, CameraDevice } from './capture/cameraManager';
import { SpeechCoach, MOCK_SWING_SCENARIOS } from './coaching/speechCoach';
import { Handedness } from './types';

type ViewMode = 'face-on' | 'dtl' | 'dual';

// Stages & Video Elements (strictly separated: Laptop vs Phone/DroidCam)
const laptopStage = document.getElementById('laptop-stage') as HTMLDivElement;
const laptopVideo = document.getElementById('laptop-video') as HTMLVideoElement;
const laptopCanvas = document.getElementById('laptop-canvas') as HTMLCanvasElement;
const laptopCtx = laptopCanvas.getContext('2d')!;

const phoneStage = document.getElementById('phone-stage') as HTMLDivElement;
const phoneContainer = document.getElementById('phone-container') as HTMLDivElement;
const phoneVideo = document.getElementById('phone-video') as HTMLVideoElement;
const phoneCanvas = document.getElementById('phone-canvas') as HTMLCanvasElement;
const phoneCtx = phoneCanvas.getContext('2d')!;
const phoneRotateBtn = document.getElementById('phone-rotate-btn') as HTMLButtonElement;

// Top Bar Controls
const angleToggle = document.getElementById('angle-toggle') as HTMLDivElement;
const laptopCameraSelect = document.getElementById('laptop-camera-select') as HTMLSelectElement;
const phoneCameraSelect = document.getElementById('phone-camera-select') as HTMLSelectElement;
const refreshCamerasBtn = document.getElementById('refresh-cameras-btn') as HTMLButtonElement;
const fpsSelect = document.getElementById('fps-select') as HTMLSelectElement;
const mirrorBtn = document.getElementById('mirror-btn') as HTMLButtonElement;
const guideBtn = document.getElementById('guide-btn') as HTMLButtonElement;
const handednessToggle = document.getElementById('handedness-toggle') as HTMLDivElement;

// HUD Pills — Laptop
const laptopStatusPill = document.getElementById('laptop-status-pill') as HTMLSpanElement;
const laptopResPill = document.getElementById('laptop-res-pill') as HTMLSpanElement;
const laptopFpsPill = document.getElementById('laptop-fps-pill') as HTMLSpanElement;
const laptopTargetIndicator = document.getElementById('laptop-target-indicator') as HTMLDivElement;

// HUD Pills — Phone (DroidCam)
const phoneStatusPill = document.getElementById('phone-status-pill') as HTMLSpanElement;
const phoneFpsPill = document.getElementById('phone-fps-pill') as HTMLSpanElement;

// Sidebar Diagnostics
const phoneDetectBanner = document.getElementById('phone-detect-banner') as HTMLDivElement;
const statLaptopDevice = document.getElementById('stat-laptop-device') as HTMLSpanElement;
const statPhoneDevice = document.getElementById('stat-phone-device') as HTMLSpanElement;
const statLaptopFps = document.getElementById('stat-laptop-fps') as HTMLSpanElement;
const statPhoneFps = document.getElementById('stat-phone-fps') as HTMLSpanElement;
const checklistTitle = document.getElementById('checklist-title') as HTMLHeadingElement;
const checklistItems = document.getElementById('checklist-items') as HTMLUListElement;

// AI Speech Coach UI Elements
const coachSourceBadge = document.getElementById('coach-source-badge') as HTMLSpanElement;
const coachMuteBtn = document.getElementById('coach-mute-btn') as HTMLButtonElement;
const coachReplayBtn = document.getElementById('coach-replay-btn') as HTMLButtonElement;
const coachMatchScore = document.getElementById('coach-match-score') as HTMLSpanElement;
const coachFaultTag = document.getElementById('coach-fault-tag') as HTMLSpanElement;
const coachDrillName = document.getElementById('coach-drill-name') as HTMLSpanElement;
const coachStatusDot = document.getElementById('coach-status-dot') as HTMLSpanElement;
const coachStatusText = document.getElementById('coach-status-text') as HTMLSpanElement;
const coachLatencyTag = document.getElementById('coach-latency-tag') as HTMLSpanElement;
const coachQuote = document.getElementById('coach-quote') as HTMLParagraphElement;
const pttBtn = document.getElementById('ptt-btn') as HTMLButtonElement;
const sttTranscriptPreview = document.getElementById('stt-transcript-preview') as HTMLDivElement;
const qaForm = document.getElementById('qa-form') as HTMLFormElement;
const qaTextInput = document.getElementById('qa-text-input') as HTMLInputElement;

// Dedicated Camera Managers
const laptopCamManager = new CameraManager(laptopVideo);
const phoneCamManager = new CameraManager(phoneVideo);

let viewMode: ViewMode = 'dual';
let isMirrored = true;
let showFramingGuide = true;
let handedness: Handedness = 'right';
let phoneRotationDeg: 90 | -90 | 0 = 90;
let availableDevices: CameraDevice[] = [];

laptopVideo.classList.toggle('mirrored', isMirrored);

// Initialize SpeechCoach
const speechCoach = new SpeechCoach({
  onStatusChange: (status) => {
    coachStatusDot.className = `status-dot ${status}`;
    pttBtn.classList.toggle('listening', status === 'listening');

    if (status === 'listening') {
      coachStatusText.textContent = 'Listening to microphone... (release Spacebar to send)';
      pttBtn.innerHTML = '🔴 Listening... Release <strong>SPACEBAR</strong> to Send';
    } else if (status === 'thinking') {
      coachStatusText.textContent = 'Coach is thinking...';
      pttBtn.innerHTML = '🎤 Hold <strong>SPACEBAR</strong> to Ask Coach';
    } else if (status === 'speaking') {
      coachStatusText.textContent = 'Coach is speaking aloud...';
      pttBtn.innerHTML = '🎤 Hold <strong>SPACEBAR</strong> to Ask Coach';
    } else {
      coachStatusText.textContent = 'Ready — hold Spacebar to ask a question';
      pttBtn.innerHTML = '🎤 Hold <strong>SPACEBAR</strong> to Ask Coach';
    }
  },
  onTranscriptUpdate: (transcript) => {
    sttTranscriptPreview.textContent = transcript || 'Listening...';
  },
  onCoachResponse: (res, payload) => {
    coachMatchScore.textContent = `${payload.match_score}%`;
    coachFaultTag.textContent = res.fault === 'none' ? 'Pure Swing' : res.fault.replace(/_/g, ' ');
    coachFaultTag.classList.toggle('none', res.fault === 'none');
    coachDrillName.textContent = res.drill;
    coachQuote.textContent = `"${res.spoken}"`;
    coachLatencyTag.textContent = `${res.latencyMs}ms`;

    if (res.source === 'gemini') {
      coachSourceBadge.textContent = '● Gemini 2.5';
      coachSourceBadge.className = 'coach-badge gemini';
    } else {
      coachSourceBadge.textContent = '● Fallback Template';
      coachSourceBadge.className = 'coach-badge fallback';
    }
  },
  onQAResponse: (question, res) => {
    sttTranscriptPreview.textContent = `You asked: "${question}"`;
    coachQuote.textContent = `"${res.spoken}"`;
    coachLatencyTag.textContent = `${res.latencyMs}ms`;

    if (res.source === 'gemini') {
      coachSourceBadge.textContent = '● Gemini 2.5';
      coachSourceBadge.className = 'coach-badge gemini';
    } else {
      coachSourceBadge.textContent = '● Fallback Template';
      coachSourceBadge.className = 'coach-badge fallback';
    }
  },
  onError: (err) => {
    sttTranscriptPreview.textContent = err;
  },
});

/**
 * Checks backend /api/health to show whether GEMINI_API_KEY is configured in .env.
 */
async function checkBackendHealth(): Promise<void> {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.geminiConfigured) {
      coachSourceBadge.textContent = '● Gemini Ready';
      coachSourceBadge.className = 'coach-badge gemini';
    } else {
      coachSourceBadge.textContent = 'Key needed (.env)';
      coachSourceBadge.className = 'coach-badge fallback';
    }
  } catch (_err) {
    coachSourceBadge.textContent = 'Server Offline';
    coachSourceBadge.className = 'coach-badge fallback';
  }
}

// Wire up simulated swing buttons
document.querySelectorAll('.btn-sim').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = (btn as HTMLButtonElement).dataset.sim as 'bad' | 'improved' | 'pure';
    const scenario = MOCK_SWING_SCENARIOS[key];
    if (scenario) {
      speechCoach.requestSwingCoaching(scenario);
    }
  });
});

// Wire up Push-to-Talk button mouse/touch hold
pttBtn.addEventListener('mousedown', () => speechCoach.startListening());
pttBtn.addEventListener('mouseup', () => speechCoach.stopListening());
pttBtn.addEventListener('mouseleave', () => speechCoach.stopListening());

// Wire up Text Q&A form
qaForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = qaTextInput.value.trim();
  if (!q) return;
  qaTextInput.value = '';
  speechCoach.askCoachQuestion(q);
});

coachMuteBtn.addEventListener('click', () => {
  const nextMuted = !speechCoach.getMuted();
  speechCoach.setMuted(nextMuted);
  coachMuteBtn.textContent = nextMuted ? '🔇 Muted' : '🔊 TTS';
});

coachReplayBtn.addEventListener('click', () => {
  speechCoach.replayLastSpoken();
});

/**
 * Sizes and rotates the #phone-video inside #phone-container by swapping width & height
 * before rotating 90deg. This guarantees ZERO zoom, ZERO cropping, and a full portrait frame.
 */
function syncPhonePortraitRotation(): void {
  const rect = phoneContainer.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  if (phoneRotationDeg === 90 || phoneRotationDeg === -90) {
    phoneVideo.style.width = `${rect.height}px`;
    phoneVideo.style.height = `${rect.width}px`;
    phoneVideo.style.transform = `translate(-50%, -50%) rotate(${phoneRotationDeg}deg)`;
  } else {
    phoneVideo.style.width = `${rect.width}px`;
    phoneVideo.style.height = `${rect.height}px`;
    phoneVideo.style.transform = `translate(-50%, -50%) rotate(0deg)`;
  }
}

/**
 * Updates which stage(s) are visible and refreshes the sidebar explanation.
 */
function updateViewLayout(): void {
  const showLaptop = viewMode === 'face-on' || viewMode === 'dual';
  const showPhone = viewMode === 'dtl' || viewMode === 'dual';

  laptopStage.classList.toggle('hidden', !showLaptop);
  phoneStage.classList.toggle('hidden', !showPhone);

  const targetIsLeftOnScreen =
    (handedness === 'right' && isMirrored) || (handedness === 'left' && !isMirrored);
  laptopTargetIndicator.textContent = targetIsLeftOnScreen
    ? '⬅ Target Direction (Lead Side)'
    : 'Target Direction (Lead Side) ➔';

  if (viewMode === 'face-on') {
    checklistTitle.textContent = '💻 Laptop Face-On (Landscape)';
    checklistItems.innerHTML = `
      <li><strong>Head Zone (Blue Circle):</strong> Keep your head inside this circle from takeaway to impact (&lt; 5 cm drift).</li>
      <li><strong>Hip Sway Corridor (Green):</strong> Wide landscape frame captures lateral hip sway and weight shift toward target.</li>
      <li><strong>Address Hands (Amber Box):</strong> Hold hands steady below hips for ~1s to auto-start swing capture.</li>
    `;
  } else if (viewMode === 'dtl') {
    checklistTitle.textContent = '📱 Phone DroidCam (Portrait)';
    checklistItems.innerHTML = `
      <li><strong>Full Uncropped Portrait:</strong> Rotated 90° with exact swapped dimensions so zero pixels are cropped or zoomed.</li>
      <li><strong>Tush Line (Green Vertical Wall):</strong> Glutes touch this line at address. Moving forward toward ball = <em>Early Extension</em>.</li>
      <li><strong>Spine Tilt (Blue Line):</strong> ~35–45° forward tilt from hips to shoulders.</li>
      <li><strong>Swing Plane Corridor (Amber):</strong> Hands/club travel up &amp; down inside this diagonal slot.</li>
    `;
  } else {
    checklistTitle.textContent = '⚡ 90° Dual View (Laptop + DroidCam)';
    checklistItems.innerHTML = `
      <li><strong>Left (Laptop Landscape):</strong> Integrated webcam facing your chest for Head Movement, Hip Sway &amp; Turn.</li>
      <li><strong>Right (Phone Portrait):</strong> Linked exclusively to <strong>DroidCam</strong> (rotated 90° uncropped) for Swing Plane &amp; Spine Angle.</li>
    `;
  }

  requestAnimationFrame(() => {
    syncPhonePortraitRotation();
    redrawOverlays();
  });
}

function drawFaceOnGuide(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!showFramingGuide || canvas.width === 0) return;

  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const hipY = h * 0.54;

  context.save();

  context.strokeStyle = 'rgba(148, 163, 184, 0.35)';
  context.lineWidth = 1.5;
  context.setLineDash([6, 6]);
  context.beginPath();
  context.moveTo(cx, h * 0.12);
  context.lineTo(cx, h * 0.92);
  context.stroke();

  const swayHalfW = w * 0.11;
  context.strokeStyle = 'rgba(16, 185, 129, 0.5)';
  context.beginPath();
  context.moveTo(cx - swayHalfW * 1.8, hipY);
  context.lineTo(cx + swayHalfW * 1.8, hipY);
  context.stroke();

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

  const headRadius = Math.min(w, h) * 0.055;
  const headY = h * 0.24;
  context.strokeStyle = 'rgba(59, 130, 246, 0.75)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(cx, headY, headRadius, 0, Math.PI * 2);
  context.stroke();

  context.fillStyle = 'rgba(147, 197, 253, 0.9)';
  context.fillText('HEAD ZONE (<5cm)', cx, headY - headRadius - 8);

  const handBoxW = w * 0.12;
  const handBoxH = h * 0.11;
  const handBoxY = hipY + h * 0.03;
  context.strokeStyle = 'rgba(245, 158, 11, 0.7)';
  context.strokeRect(cx - handBoxW / 2, handBoxY, handBoxW, handBoxH);
  context.fillStyle = 'rgba(253, 230, 138, 0.9)';
  context.fillText('ADDRESS HANDS', cx, handBoxY + handBoxH + 15);

  context.restore();
}

function drawDownTheLineGuide(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!showFramingGuide || canvas.width === 0) return;

  const w = canvas.width;
  const h = canvas.height;

  const flip = handedness === 'left';
  const xCoord = (normX: number) => (flip ? w * (1 - normX) : w * normX);

  const hipX = xCoord(0.24);
  const hipY = h * 0.56;
  const shoulderX = xCoord(0.46);
  const shoulderY = h * 0.37;
  const ballX = xCoord(0.76);
  const ballY = h * 0.84;
  const handsX = xCoord(0.54);
  const handsY = h * 0.60;

  context.save();
  context.font = '600 10.5px Inter, system-ui, sans-serif';

  const targetVanishX = xCoord(0.73);
  const targetVanishY = h * 0.24;
  context.strokeStyle = 'rgba(59, 130, 246, 0.65)';
  context.lineWidth = 2;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(ballX, h * 0.93);
  context.lineTo(targetVanishX, targetVanishY);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#93c5fd';
  context.textAlign = flip ? 'left' : 'right';
  context.fillText('⬆ TARGET LINE', targetVanishX + (flip ? 6 : -6), targetVanishY + 12);

  context.fillStyle = '#f8fafc';
  context.beginPath();
  context.arc(ballX, ballY, 5, 0, Math.PI * 2);
  context.fill();
  context.fillText('BALL', ballX + (flip ? 10 : -10), ballY + 4);

  context.strokeStyle = 'rgba(16, 185, 129, 0.85)';
  context.lineWidth = 2;
  context.setLineDash([5, 4]);
  context.beginPath();
  context.moveTo(hipX, h * 0.34);
  context.lineTo(hipX, h * 0.86);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#6ee7b7';
  context.textAlign = flip ? 'right' : 'left';
  context.fillText('TUSH LINE', hipX + (flip ? -6 : 6), h * 0.33);

  context.strokeStyle = 'rgba(59, 130, 246, 0.9)';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(hipX, hipY);
  context.lineTo(shoulderX, shoulderY);
  context.stroke();

  context.fillStyle = '#93c5fd';
  context.fillText('SPINE (~40°)', shoulderX + (flip ? -65 : 6), shoulderY - 6);

  const planeTopX = xCoord(0.18);
  const planeTopY = h * 0.14;
  context.strokeStyle = 'rgba(245, 158, 11, 0.85)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(ballX, ballY);
  context.lineTo(planeTopX, planeTopY);
  context.stroke();

  context.strokeStyle = 'rgba(245, 158, 11, 0.45)';
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(ballX, ballY - 26);
  context.lineTo(planeTopX + (flip ? -28 : 28), planeTopY - 24);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#fde68a';
  context.fillText('SWING PLANE', planeTopX + (flip ? -70 : 6), planeTopY - 6);

  context.strokeStyle = 'rgba(245, 158, 11, 0.8)';
  context.strokeRect(handsX - 22, handsY - 18, 44, 36);
  context.textAlign = 'center';
  context.fillText('HANDS', handsX, handsY + 30);

  context.restore();
}

function redrawOverlays(): void {
  drawFaceOnGuide(laptopCanvas, laptopCtx);
  drawDownTheLineGuide(phoneCanvas, phoneCtx);
}

async function populateCameras(autoStart = true): Promise<void> {
  availableDevices = await CameraManager.listDevices();
  laptopCameraSelect.innerHTML = '';
  phoneCameraSelect.innerHTML = '';

  if (availableDevices.length === 0) {
    phoneDetectBanner.className = 'banner banner-warn';
    phoneDetectBanner.textContent =
      'No cameras detected. Start DroidCam and make sure your laptop webcam is enabled, then click ↻.';
    return;
  }

  availableDevices.forEach((device) => {
    const label = device.isPhoneCam ? `📱 ${device.label}` : `💻 ${device.label}`;

    const optLaptop = document.createElement('option');
    optLaptop.value = device.deviceId;
    optLaptop.textContent = label;
    laptopCameraSelect.appendChild(optLaptop);

    const optPhone = document.createElement('option');
    optPhone.value = device.deviceId;
    optPhone.textContent = label;
    phoneCameraSelect.appendChild(optPhone);
  });

  const laptopCam = availableDevices.find((d) => !d.isPhoneCam) || availableDevices[0];
  const phoneCam =
    availableDevices.find((d) => d.isPhoneCam) ||
    availableDevices.find((d) => d.deviceId !== laptopCam.deviceId) ||
    availableDevices[0];

  laptopCameraSelect.value = laptopCam.deviceId;
  phoneCameraSelect.value = phoneCam.deviceId;

  if (phoneCam.isPhoneCam && !laptopCam.isPhoneCam) {
    phoneDetectBanner.className = 'banner banner-success';
    phoneDetectBanner.innerHTML = `<strong>💻 Laptop:</strong> ${laptopCam.label}<br/><strong>📱 Phone (DroidCam):</strong> ${phoneCam.label}`;
  } else {
    phoneDetectBanner.className = 'banner banner-info';
    phoneDetectBanner.innerHTML = `<strong>💻 Laptop:</strong> ${laptopCam.label}<br/><strong>📱 Phone:</strong> ${phoneCam.label}`;
  }

  if (autoStart) {
    await syncActiveStreams();
  }
}

async function syncActiveStreams(): Promise<void> {
  const targetFps = Number(fpsSelect.value) || 60;
  const needLaptop = viewMode === 'face-on' || viewMode === 'dual';
  const needPhone = viewMode === 'dtl' || viewMode === 'dual';

  if (needLaptop) {
    const laptopId = laptopCameraSelect.value || undefined;
    laptopStatusPill.textContent = 'Connecting...';
    laptopStatusPill.className = 'hud-pill status-pill';
    try {
      const stats = await laptopCamManager.startCamera(laptopId, targetFps);
      laptopStatusPill.textContent = '● LIVE';
      laptopStatusPill.className = 'hud-pill status-pill connected';
      laptopResPill.textContent = `${stats.width} × ${stats.height}`;
      statLaptopDevice.textContent = stats.deviceLabel;
    } catch (err) {
      console.error('Laptop camera start failed:', err);
      laptopStatusPill.textContent = 'Camera Error';
      laptopStatusPill.className = 'hud-pill status-pill error';
    }
  } else {
    laptopCamManager.stop();
  }

  if (needPhone) {
    const phoneId = phoneCameraSelect.value || undefined;
    phoneStatusPill.textContent = 'Connecting...';
    phoneStatusPill.className = 'hud-pill status-pill';
    try {
      const stats = await phoneCamManager.startCamera(phoneId, targetFps);
      phoneStatusPill.textContent = '● LIVE';
      phoneStatusPill.className = 'hud-pill status-pill connected';
      statPhoneDevice.textContent = stats.deviceLabel;
      syncPhonePortraitRotation();
    } catch (err) {
      console.error('Phone DroidCam start failed:', err);
      phoneStatusPill.textContent = 'Camera Error';
      phoneStatusPill.className = 'hud-pill status-pill error';
    }
  } else {
    phoneCamManager.stop();
  }
}

laptopCamManager.onFrame((_video, _timestampMs, measuredFps) => {
  laptopFpsPill.textContent = `${measuredFps} FPS`;
  laptopFpsPill.className = `hud-pill fps-pill ${measuredFps >= 45 ? 'good' : 'warn'}`;
  const stats = laptopCamManager.getStreamStats();
  if (stats.width && stats.height) {
    laptopResPill.textContent = `${stats.width} × ${stats.height}`;
    statLaptopFps.textContent = `${stats.width}×${stats.height} @ ${measuredFps}fps`;
  }
  drawFaceOnGuide(laptopCanvas, laptopCtx);
});

phoneCamManager.onFrame((_video, _timestampMs, measuredFps) => {
  phoneFpsPill.textContent = `${measuredFps} FPS`;
  phoneFpsPill.className = `hud-pill fps-pill ${measuredFps >= 45 ? 'good' : 'warn'}`;
  const stats = phoneCamManager.getStreamStats();
  if (stats.width && stats.height) {
    statPhoneFps.textContent = `${stats.height}×${stats.width} @ ${measuredFps}fps`;
  }
  syncPhonePortraitRotation();
  drawDownTheLineGuide(phoneCanvas, phoneCtx);
});

phoneRotateBtn.addEventListener('click', () => {
  if (phoneRotationDeg === 90) phoneRotationDeg = -90;
  else if (phoneRotationDeg === -90) phoneRotationDeg = 0;
  else phoneRotationDeg = 90;

  phoneRotateBtn.textContent = `⟳ ${phoneRotationDeg}°`;
  syncPhonePortraitRotation();
});

angleToggle.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const newMode = btn.dataset.angle as ViewMode;
  if (!newMode || newMode === viewMode) return;

  viewMode = newMode;
  angleToggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  updateViewLayout();
  syncActiveStreams();
});

laptopCameraSelect.addEventListener('change', () => {
  syncActiveStreams();
});

phoneCameraSelect.addEventListener('change', () => {
  syncActiveStreams();
});

refreshCamerasBtn.addEventListener('click', () => {
  populateCameras(true);
});

fpsSelect.addEventListener('change', () => {
  syncActiveStreams();
});

mirrorBtn.addEventListener('click', () => {
  isMirrored = !isMirrored;
  laptopVideo.classList.toggle('mirrored', isMirrored);
  mirrorBtn.classList.toggle('active', isMirrored);
  mirrorBtn.textContent = `Mirror: ${isMirrored ? 'ON' : 'OFF'}`;
  updateViewLayout();
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
  updateViewLayout();
});

window.addEventListener('resize', () => {
  syncPhonePortraitRotation();
  redrawOverlays();
});

// Initialize on load
updateViewLayout();
populateCameras(true);
checkBackendHealth();
setInterval(checkBackendHealth, 5000);
