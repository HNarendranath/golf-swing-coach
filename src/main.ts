import './style.css';
import { CameraManager, CameraDevice } from './capture/cameraManager';
import { PoseTracker } from './capture/poseTracker';
import { SwingCaptureFSM, CaptureTelemetry } from './capture/swingCaptureFSM';
import {
  computePhaseTempo,
  detectSwingPhases,
  getHandMidpoint2D,
  Point2D,
} from './analysis/phaseDetector';
import { drawPoseSkeletonOverlay } from './visuals/canvasOverlay';
import { SpeechCoach, MOCK_SWING_SCENARIOS } from './coaching/speechCoach';
import {
  ClubState,
  ClubTrackingMode,
  Handedness,
  PoseModelVariant,
  SwingFrame,
  SwingPhases,
  SwingRecording,
} from './types';

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
const poseModelSelect = document.getElementById('pose-model-select') as HTMLSelectElement;
const fpsSelect = document.getElementById('fps-select') as HTMLSelectElement;
const skeletonBtn = document.getElementById('skeleton-btn') as HTMLButtonElement;
const clubTrackBtn = document.getElementById('club-track-btn') as HTMLButtonElement;
const mirrorBtn = document.getElementById('mirror-btn') as HTMLButtonElement;
const guideBtn = document.getElementById('guide-btn') as HTMLButtonElement;
const uploadVideoBtn = document.getElementById('upload-video-btn') as HTMLButtonElement;
const uploadVideoInput = document.getElementById('upload-video-input') as HTMLInputElement;
const handednessToggle = document.getElementById('handedness-toggle') as HTMLDivElement;

// HUD Pills — Laptop & Pose
const laptopStatusPill = document.getElementById('laptop-status-pill') as HTMLSpanElement;
const poseStatusPill = document.getElementById('pose-status-pill') as HTMLSpanElement;
const laptopResPill = document.getElementById('laptop-res-pill') as HTMLSpanElement;
const laptopFpsPill = document.getElementById('laptop-fps-pill') as HTMLSpanElement;
const laptopTargetIndicator = document.getElementById('laptop-target-indicator') as HTMLDivElement;

// Bottom HUD Capture Bar
const hudFsmBadge = document.getElementById('hud-fsm-badge') as HTMLSpanElement;
const hudFsmMsg = document.getElementById('hud-fsm-msg') as HTMLSpanElement;
const hudHoldProgress = document.getElementById('hud-hold-progress') as HTMLDivElement;

// HUD Pills — Phone (DroidCam)
const phoneStatusPill = document.getElementById('phone-status-pill') as HTMLSpanElement;
const phonePosePill = document.getElementById('phone-pose-pill') as HTMLSpanElement;
const phoneFpsPill = document.getElementById('phone-fps-pill') as HTMLSpanElement;

// Sidebar — Swing Capture FSM & Phase Detection
const sidebarFsmBadge = document.getElementById('sidebar-fsm-badge') as HTMLSpanElement;
const statVisibility = document.getElementById('stat-visibility') as HTMLSpanElement;
const statHandSpeed = document.getElementById('stat-hand-speed') as HTMLSpanElement;
const statAddressCheck = document.getElementById('stat-address-check') as HTMLSpanElement;
const statFrameCount = document.getElementById('stat-frame-count') as HTMLSpanElement;
const statClubStatus = document.getElementById('stat-club-status') as HTMLSpanElement;
const statDtlPosture = document.getElementById('stat-dtl-posture') as HTMLSpanElement;
const forceCaptureBtn = document.getElementById('force-capture-btn') as HTMLButtonElement;
const clearTrailBtn = document.getElementById('clear-trail-btn') as HTMLButtonElement;
const setReferenceBtn = document.getElementById('set-reference-btn') as HTMLButtonElement;
const downloadJsonBtn = document.getElementById('download-json-btn') as HTMLButtonElement;
const saveStatusBanner = document.getElementById('save-status-banner') as HTMLDivElement;

// Sidebar — Phase Detection & Tempo
const tempoBadge = document.getElementById('tempo-badge') as HTMLSpanElement;
const phaseAddressEl = document.getElementById('phase-address') as HTMLSpanElement;
const phaseTakeawayEl = document.getElementById('phase-takeaway') as HTMLSpanElement;
const phaseTopEl = document.getElementById('phase-top') as HTMLSpanElement;
const phaseImpactEl = document.getElementById('phase-impact') as HTMLSpanElement;
const phaseFinishEl = document.getElementById('phase-finish') as HTMLSpanElement;
const statBackswingMs = document.getElementById('stat-backswing-ms') as HTMLElement;
const statDownswingMs = document.getElementById('stat-downswing-ms') as HTMLElement;

// Sidebar — Camera Diagnostics
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

// Dedicated Camera Managers + Dedicated PoseTrackers (so Face-On and DTL Portrait track simultaneously in Dual View!)
const laptopCamManager = new CameraManager(laptopVideo);
const phoneCamManager = new CameraManager(phoneVideo);
const laptopPoseTracker = new PoseTracker(1.2, 0.08, 1.0);
const phonePoseTracker = new PoseTracker(1.2, 0.08, 1.0);
const captureFSM = new SwingCaptureFSM('right');

let viewMode: ViewMode = 'dual';
let isMirrored = true;
let showFramingGuide = true;
let showSkeleton = true;
let clubTrackingMode: ClubTrackingMode = 'auto';
let handedness: Handedness = 'right';
let phoneRotationDeg: 90 | -90 | 0 = 90;
let availableDevices: CameraDevice[] = [];
let currentMeasuredFps = 60;

// Active & last-captured swing state (Face-On & DTL)
let liveHandTrail: Point2D[] = [];
let liveClubTrail: Point2D[] = [];
let dtlHandTrail: Point2D[] = [];
let dtlClubTrail: Point2D[] = [];
let dtlAddressHipX: number | null = null;
let lastCapturedFrames: SwingFrame[] = [];
let lastCapturedPhases: SwingPhases | null = null;
let lastRecording: SwingRecording | null = null;
let referenceHandPath: Point2D[] = [];

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
    coachLatencyTag.textContent = `${res.latencyMs ?? 0}ms`;

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
    coachLatencyTag.textContent = `${res.latencyMs ?? 0}ms`;

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
 * Initializes both MediaPipe PoseLandmarker instances (`laptopPoseTracker` & `phonePoseTracker`).
 */
async function initPoseModels(variant: PoseModelVariant): Promise<void> {
  poseStatusPill.textContent = `Pose (${variant}): Loading...`;
  phonePosePill.textContent = `DTL Pose: Loading...`;
  try {
    await Promise.all([
      laptopPoseTracker.init(variant),
      phonePoseTracker.init(variant),
    ]);
    poseStatusPill.textContent = `Pose (${variant.toUpperCase()}): Ready`;
    phonePosePill.textContent = `DTL Pose: Ready`;
  } catch (err) {
    console.error('Failed to initialize MediaPipe PoseLandmarker:', err);
    poseStatusPill.textContent = 'Pose: Load Error';
    phonePosePill.textContent = 'DTL Pose: Error';
  }
}

/**
 * Loads existing reference swing hand path if one is saved on the server.
 */
async function loadSavedReference(): Promise<void> {
  try {
    const res = await fetch('/api/reference');
    if (!res.ok) return;
    const ref: SwingRecording = await res.json();
    if (Array.isArray(ref.frames) && ref.frames.length > 1) {
      referenceHandPath = ref.frames.map((f) => getHandMidpoint2D(f.landmarks));
    }
  } catch {
    // Reference swing is optional in Step 2
  }
}

/**
 * Callback fired by SwingCaptureFSM when a full swing has been captured.
 * Runs phase detection, updates UI, and persists keypoints JSON to backend (`POST /api/swings`).
 */
captureFSM.onSwingComplete(async (frames: SwingFrame[]) => {
  lastCapturedFrames = frames;
  liveHandTrail = [];
  liveClubTrail = [];
  dtlHandTrail = [];
  dtlClubTrail = [];

  // Run Phase Detection (Address, Takeaway, Top, Impact, Finish)
  const phases = detectSwingPhases(frames, handedness);
  lastCapturedPhases = phases;

  const { backswingMs, downswingMs, tempoRatio } = computePhaseTempo(phases);

  // Update Phase Detection UI Card
  phaseAddressEl.textContent = `#${phases.address} (${phases.timestamps.address} ms)`;
  phaseTakeawayEl.textContent = `#${phases.takeaway} (${phases.timestamps.takeaway} ms)`;
  phaseTopEl.textContent = `#${phases.top} (${phases.timestamps.top} ms)`;
  phaseImpactEl.textContent = `#${phases.impact} (${phases.timestamps.impact} ms)`;
  phaseFinishEl.textContent = `#${phases.finish} (${phases.timestamps.finish} ms)`;

  statBackswingMs.textContent = `${backswingMs} ms`;
  statDownswingMs.textContent = `${downswingMs} ms`;
  tempoBadge.textContent = `Tempo: ${tempoRatio} : 1`;

  const recordingId = `swing-${Date.now()}`;
  const recording: SwingRecording = {
    id: recordingId,
    createdAt: new Date().toISOString(),
    handedness,
    cameraAngle: viewMode === 'dtl' ? 'dtl' : 'face-on',
    fps: currentMeasuredFps || 60,
    frames,
    phases,
  };
  lastRecording = recording;

  setReferenceBtn.disabled = false;
  downloadJsonBtn.disabled = false;
  updateForceButtonUI('DONE');

  // Persist SwingRecording JSON to Express server (data/swings/swing-<timestamp>.json)
  try {
    const res = await fetch('/api/swings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recording),
    });
    if (res.ok) {
      const data = await res.json();
      saveStatusBanner.classList.remove('hidden');
      saveStatusBanner.textContent = `✓ Saved ${frames.length} frames to ${data.filename}`;
    }
  } catch (err) {
    console.warn('Could not persist swing to backend API (offline mode):', err);
    saveStatusBanner.classList.remove('hidden');
    saveStatusBanner.textContent = `✓ Captured ${frames.length} frames locally (Click ⬇ JSON to save)`;
  }
});

/**
 * Updates HUD and Sidebar telemetry from the SwingCaptureFSM and optional ClubTracker.
 */
function updateCaptureUI(
  telemetry: CaptureTelemetry,
  keyVisibility: number,
  club?: ClubState
): void {
  const stateClass = `fsm-badge state-${telemetry.state.toLowerCase()}`;
  hudFsmBadge.className = stateClass;
  hudFsmBadge.textContent = telemetry.state.replace('_', ' ');
  sidebarFsmBadge.className = stateClass;
  sidebarFsmBadge.textContent = telemetry.state.replace('_', ' ');

  hudFsmMsg.textContent = telemetry.message;
  hudHoldProgress.style.width = `${Math.round(telemetry.holdProgress * 100)}%`;

  statVisibility.textContent = `${Math.round(keyVisibility * 100)}%`;
  statVisibility.style.color = keyVisibility >= 0.5 ? '#34d399' : '#fbbf24';

  statHandSpeed.textContent = `${telemetry.handSpeed.toFixed(2)} /s`;

  if (telemetry.wristsBelowHips && telemetry.isStill) {
    statAddressCheck.textContent = '✓ Ready (Still)';
    statAddressCheck.style.color = '#34d399';
  } else if (telemetry.wristsBelowHips) {
    statAddressCheck.textContent = 'Moving...';
    statAddressCheck.style.color = '#fbbf24';
  } else {
    statAddressCheck.textContent = 'Hands High';
    statAddressCheck.style.color = '#94a3b8';
  }

  statFrameCount.textContent =
    telemetry.recordedFrames > 0
      ? `${telemetry.recordedFrames}`
      : `${lastCapturedFrames.length}`;

  if (club) {
    updateClubTelemetryUI(club);
  }

  updateForceButtonUI(telemetry.state);
}

function updateClubTelemetryUI(club: ClubState): void {
  if (clubTrackingMode === 'off') {
    statClubStatus.textContent = 'OFF (Hands Only)';
    statClubStatus.style.color = '#94a3b8';
  } else if (club.detected && club.source === 'cv') {
    statClubStatus.textContent = `🏌️ Club ${club.shaftAngleDeg}°`;
    statClubStatus.style.color = '#f0abfc';
  } else if (club.detected && club.source === 'virtual') {
    statClubStatus.textContent = `✨ Virtual ${club.shaftAngleDeg}°`;
    statClubStatus.style.color = '#c4b5fd';
  } else {
    statClubStatus.textContent = '✋ Hands Only';
    statClubStatus.style.color = '#38bdf8';
  }
}

function updateForceButtonUI(state: string): void {
  if (state === 'RECORDING' || state === 'FOLLOW_THROUGH') {
    forceCaptureBtn.textContent = '⏹ Force Stop Capture';
    forceCaptureBtn.className = 'btn btn-danger';
  } else {
    forceCaptureBtn.textContent = '▶ Force Start Capture';
    forceCaptureBtn.className = 'btn btn-primary';
  }
}

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
      <li><strong>Bilateral Skeleton:</strong> Tracks shoulders, hips, lead arm angle, head stability, and lateral sway.</li>
      <li><strong>Optional Club Tracking:</strong> Automatically tracks your golf club shaft &amp; clubhead when held, or works hands-only without a club.</li>
      <li><strong>Address Trigger:</strong> Hold wrists below hips steady for ~1.0s to auto-start capture.</li>
    `;
  } else if (viewMode === 'dtl') {
    checklistTitle.textContent = '📱 Phone DroidCam (Portrait DTL)';
    checklistItems.innerHTML = `
      <li><strong>Side-Profile Posture Chain:</strong> Tracks <em>Spine Tilt (°)</em>, <em>Knee Flex (°)</em>, <em>Dynamic Tush Line</em>, and <em>Arm/Hand Plane Slot</em>.</li>
      <li><strong>Optional Club Plane:</strong> Tracks shaft plane angle &amp; clubhead arc when holding a club (not required).</li>
    `;
  } else {
    checklistTitle.textContent = '⚡ 90° Dual View (Face-On + DTL)';
    checklistItems.innerHTML = `
      <li><strong>Laptop (Front-On):</strong> Tracks full bilateral body rotation, sway, lead arm, and triggers auto-capture.</li>
      <li><strong>Phone (Portrait DTL):</strong> Simultaneously tracks side-profile <em>Spine Tilt</em>, <em>Knee Flex</em>, <em>Tush Line</em>, and <em>Swing Plane</em>.</li>
      <li><strong>Golf Club (Optional):</strong> Tracks club shaft &amp; clubhead arc automatically if held; works 100% hands-only if swinging without a club.</li>
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
  const handsY = h * 0.6;

  context.save();
  context.font = '600 10.5px Inter, system-ui, sans-serif';

  // 1. Target Line on ground
  const targetVanishX = xCoord(0.73);
  const targetVanishY = h * 0.24;
  context.strokeStyle = 'rgba(59, 130, 246, 0.55)';
  context.lineWidth = 1.8;
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

  // 2. Static Guide Tush Line (subtle when live skeleton is active)
  context.strokeStyle = 'rgba(16, 185, 129, 0.45)';
  context.lineWidth = 1.5;
  context.setLineDash([5, 4]);
  context.beginPath();
  context.moveTo(hipX, h * 0.34);
  context.lineTo(hipX, h * 0.86);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = 'rgba(110, 231, 183, 0.75)';
  context.textAlign = flip ? 'right' : 'left';
  context.fillText('TUSH LINE', hipX + (flip ? -6 : 6), h * 0.33);

  // 3. Static Guide Spine Tilt Line
  context.strokeStyle = 'rgba(59, 130, 246, 0.4)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(hipX, hipY);
  context.lineTo(shoulderX, shoulderY);
  context.stroke();

  // 4. Swing Plane Corridor
  const planeTopX = xCoord(0.18);
  const planeTopY = h * 0.14;
  context.strokeStyle = 'rgba(245, 158, 11, 0.75)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(ballX, ballY);
  context.lineTo(planeTopX, planeTopY);
  context.stroke();

  context.strokeStyle = 'rgba(245, 158, 11, 0.38)';
  context.setLineDash([5, 5]);
  context.beginPath();
  context.moveTo(ballX, ballY - 26);
  context.lineTo(planeTopX + (flip ? -28 : 28), planeTopY - 24);
  context.stroke();

  context.setLineDash([]);
  context.fillStyle = '#fde68a';
  context.fillText('SWING PLANE', planeTopX + (flip ? -70 : 6), planeTopY - 6);

  context.strokeStyle = 'rgba(245, 158, 11, 0.55)';
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

/**
 * Runs Face-On MediaPipe Pose + Optional Club Tracker + SwingCaptureFSM on the Laptop stream.
 */
function processLaptopPoseOnFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  timestampMs: number,
  mirrored: boolean
): void {
  const detection = laptopPoseTracker.detect(video, timestampMs, 0, 'face-on');
  if (!detection) {
    if (showSkeleton && lastCapturedFrames.length > 0) {
      drawPoseSkeletonOverlay(canvas, ctx, null, {
        perspective: 'face-on',
        mirrored,
        capturedFrames: lastCapturedFrames,
        capturedPhases: lastCapturedPhases,
        referenceHandPath,
      });
    }
    return;
  }

  const { frame, isReliable, keyVisibility, club } = detection;
  const telemetry = captureFSM.update(frame, isReliable);
  updateCaptureUI(telemetry, keyVisibility, club);

  if (telemetry.state === 'RECORDING' || telemetry.state === 'FOLLOW_THROUGH') {
    liveHandTrail.push(getHandMidpoint2D(frame.landmarks));
    if (liveHandTrail.length > 180) liveHandTrail.shift();

    if (club.detected) {
      liveClubTrail.push({ ...club.clubhead });
      if (liveClubTrail.length > 180) liveClubTrail.shift();
    }
  } else if (telemetry.state === 'IDLE') {
    liveHandTrail = [];
    liveClubTrail = [];
  }

  if (showSkeleton) {
    drawPoseSkeletonOverlay(canvas, ctx, frame.landmarks, {
      perspective: 'face-on',
      mirrored,
      isReliable,
      liveHandTrail,
      liveClubTrail,
      club,
      capturedFrames: lastCapturedFrames,
      capturedPhases: lastCapturedPhases,
      referenceHandPath,
    });
  }
}

/**
 * Runs Down-The-Line (Portrait Phone) Side-Profile Pose + Posture Chain + Optional Club Tracker.
 * Runs in BOTH Dual View and DTL-only View!
 */
function processPhoneDtlPoseOnFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  timestampMs: number,
  rotationDeg: 0 | 90 | -90,
  drivesCaptureFSM: boolean
): void {
  const detection = phonePoseTracker.detect(video, timestampMs, rotationDeg, 'dtl');
  if (!detection) {
    phonePosePill.textContent = 'DTL: Searching for golfer...';
    return;
  }

  const { frame, isReliable, keyVisibility, club, dtlMetrics } = detection;

  // Update DTL HUD & Sidebar posture readouts
  if (dtlMetrics) {
    const clubLabel = club.detected ? ` | 🏌️ ${club.shaftAngleDeg}°` : '';
    phonePosePill.textContent = `Spine ${dtlMetrics.spineTiltDeg}° | Knee ${dtlMetrics.kneeFlexDeg}°${clubLabel}`;
    statDtlPosture.textContent = `Spine ${dtlMetrics.spineTiltDeg}° / Knee ${dtlMetrics.kneeFlexDeg}°`;
    statDtlPosture.style.color =
      dtlMetrics.spineTiltDeg >= 25 && dtlMetrics.spineTiltDeg <= 52 ? '#38bdf8' : '#fbbf24';
  }

  let fsmState = captureFSM.getState();

  // If in DTL-only view mode, the phone camera also drives the SwingCaptureFSM
  if (drivesCaptureFSM) {
    const telemetry = captureFSM.update(frame, isReliable);
    fsmState = telemetry.state;
    updateCaptureUI(telemetry, keyVisibility, club);
  } else if (club.detected) {
    // In Dual View, if the phone camera detects the club clearly, show it in the sidebar too
    updateClubTelemetryUI(club);
  }

  // Lock reference Tush Line hip X at address
  if (fsmState === 'ADDRESS_HOLD' && dtlMetrics) {
    dtlAddressHipX = dtlMetrics.hipRearX;
  } else if (fsmState === 'IDLE' && dtlMetrics) {
    dtlAddressHipX = dtlMetrics.hipRearX;
  }

  // Maintain a rolling DTL hand & club plane trail so you can see the swing plane arc on the phone
  const handPt = getHandMidpoint2D(frame.landmarks);
  if (fsmState === 'RECORDING' || fsmState === 'FOLLOW_THROUGH') {
    dtlHandTrail.push(handPt);
    if (dtlHandTrail.length > 160) dtlHandTrail.shift();
    if (club.detected) {
      dtlClubTrail.push({ ...club.clubhead });
      if (dtlClubTrail.length > 160) dtlClubTrail.shift();
    }
  } else {
    // Keep a short 25-frame live plane ribbon in IDLE/ADDRESS so DTL plane tracking is immediately visible
    dtlHandTrail.push(handPt);
    if (dtlHandTrail.length > 25) dtlHandTrail.shift();
    if (club.detected) {
      dtlClubTrail.push({ ...club.clubhead });
      if (dtlClubTrail.length > 25) dtlClubTrail.shift();
    } else {
      dtlClubTrail = [];
    }
  }

  if (showSkeleton) {
    drawPoseSkeletonOverlay(canvas, ctx, frame.landmarks, {
      perspective: 'dtl',
      mirrored: false,
      isReliable,
      liveHandTrail: dtlHandTrail,
      liveClubTrail: dtlClubTrail,
      club,
      dtlMetrics,
      addressHipX: dtlAddressHipX,
      capturedFrames: drivesCaptureFSM ? lastCapturedFrames : undefined,
      capturedPhases: drivesCaptureFSM ? lastCapturedPhases : null,
    });
  }
}

// Per-frame telemetry callbacks
laptopCamManager.onFrame((video, timestampMs, measuredFps) => {
  currentMeasuredFps = measuredFps || 60;
  laptopFpsPill.textContent = `${measuredFps} FPS`;
  laptopFpsPill.className = `hud-pill fps-pill ${measuredFps >= 45 ? 'good' : 'warn'}`;
  const stats = laptopCamManager.getStreamStats();
  if (stats.width && stats.height) {
    laptopResPill.textContent = `${stats.width} × ${stats.height}`;
    statLaptopFps.textContent = `${stats.width}×${stats.height} @ ${measuredFps}fps`;
  }
  drawFaceOnGuide(laptopCanvas, laptopCtx);

  if (viewMode === 'face-on' || viewMode === 'dual') {
    processLaptopPoseOnFrame(video, laptopCanvas, laptopCtx, timestampMs, isMirrored);
  }
});

phoneCamManager.onFrame((video, timestampMs, measuredFps) => {
  phoneFpsPill.textContent = `${measuredFps} FPS`;
  phoneFpsPill.className = `hud-pill fps-pill ${measuredFps >= 45 ? 'good' : 'warn'}`;
  const stats = phoneCamManager.getStreamStats();
  if (stats.width && stats.height) {
    statPhoneFps.textContent = `${stats.height}×${stats.width} @ ${measuredFps}fps`;
  }
  syncPhonePortraitRotation();
  drawDownTheLineGuide(phoneCanvas, phoneCtx);

  // Run DTL side-profile posture & optional club tracking in BOTH 'dtl' and 'dual' modes!
  if (viewMode === 'dtl' || viewMode === 'dual') {
    if (viewMode === 'dtl') {
      currentMeasuredFps = measuredFps || 60;
    }
    processPhoneDtlPoseOnFrame(
      video,
      phoneCanvas,
      phoneCtx,
      timestampMs,
      phoneRotationDeg,
      viewMode === 'dtl'
    );
  }
});

phoneRotateBtn.addEventListener('click', () => {
  if (phoneRotationDeg === 90) phoneRotationDeg = -90;
  else if (phoneRotationDeg === -90) phoneRotationDeg = 0;
  else phoneRotationDeg = 90;

  phoneRotateBtn.textContent = `⟳ ${phoneRotationDeg}°`;
  phonePoseTracker.resetFilter();
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

  laptopPoseTracker.resetFilter();
  phonePoseTracker.resetFilter();
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

poseModelSelect.addEventListener('change', () => {
  const variant = (poseModelSelect.value as PoseModelVariant) || 'full';
  initPoseModels(variant);
});

fpsSelect.addEventListener('change', () => {
  syncActiveStreams();
});

skeletonBtn.addEventListener('click', () => {
  showSkeleton = !showSkeleton;
  skeletonBtn.classList.toggle('active', showSkeleton);
  skeletonBtn.textContent = `Skeleton: ${showSkeleton ? 'ON' : 'OFF'}`;
  redrawOverlays();
});

clubTrackBtn.addEventListener('click', () => {
  if (clubTrackingMode === 'auto') {
    clubTrackingMode = 'virtual';
    clubTrackBtn.textContent = '✨ Club: Virtual';
    clubTrackBtn.classList.add('active');
  } else if (clubTrackingMode === 'virtual') {
    clubTrackingMode = 'off';
    clubTrackBtn.textContent = '✋ Club: OFF';
    clubTrackBtn.classList.remove('active');
  } else {
    clubTrackingMode = 'auto';
    clubTrackBtn.textContent = '🏌️ Club: Auto';
    clubTrackBtn.classList.add('active');
  }

  laptopPoseTracker.setClubTrackingMode(clubTrackingMode);
  phonePoseTracker.setClubTrackingMode(clubTrackingMode);
  liveClubTrail = [];
  dtlClubTrail = [];
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

uploadVideoBtn.addEventListener('click', () => {
  uploadVideoInput.click();
});

uploadVideoInput.addEventListener('change', async () => {
  const file = uploadVideoInput.files?.[0];
  if (!file) return;
  try {
    laptopPoseTracker.resetFilter();
    captureFSM.reset();
    // Unmirror uploaded video files by default so coordinates match natural playback
    isMirrored = false;
    laptopVideo.classList.toggle('mirrored', false);
    mirrorBtn.classList.toggle('active', false);
    mirrorBtn.textContent = 'Mirror: OFF';

    const stats = await laptopCamManager.startVideoFile(file);
    laptopStatusPill.textContent = '● VIDEO FILE';
    laptopStatusPill.className = 'hud-pill status-pill connected';
    laptopResPill.textContent = `${stats.width} × ${stats.height}`;
    statLaptopDevice.textContent = stats.deviceLabel;
  } catch (err) {
    console.error('Failed to load video file:', err);
  }
});

handednessToggle.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLButtonElement | null;
  if (!btn) return;
  const hand = btn.dataset.hand as Handedness;
  if (!hand) return;

  handedness = hand;
  captureFSM.setHandedness(hand);
  handednessToggle.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  updateViewLayout();
});

forceCaptureBtn.addEventListener('click', () => {
  const state = captureFSM.getState();
  if (state === 'RECORDING' || state === 'FOLLOW_THROUGH') {
    captureFSM.forceStop();
  } else {
    liveHandTrail = [];
    liveClubTrail = [];
    dtlHandTrail = [];
    dtlClubTrail = [];
    captureFSM.forceStart();
    updateForceButtonUI('RECORDING');
  }
});

clearTrailBtn.addEventListener('click', () => {
  captureFSM.reset();
  liveHandTrail = [];
  liveClubTrail = [];
  dtlHandTrail = [];
  dtlClubTrail = [];
  lastCapturedFrames = [];
  lastCapturedPhases = null;
  saveStatusBanner.classList.add('hidden');
  updateForceButtonUI('IDLE');
  redrawOverlays();
});

setReferenceBtn.addEventListener('click', async () => {
  if (!lastRecording) return;
  referenceHandPath = lastRecording.frames.map((f) => getHandMidpoint2D(f.landmarks));
  try {
    const res = await fetch('/api/reference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastRecording),
    });
    if (res.ok) {
      saveStatusBanner.classList.remove('hidden');
      saveStatusBanner.textContent = '⭐ Saved last swing as data/reference.json!';
    }
  } catch {
    saveStatusBanner.classList.remove('hidden');
    saveStatusBanner.textContent = '⭐ Set as active reference in memory!';
  }
});

downloadJsonBtn.addEventListener('click', () => {
  if (!lastRecording) return;
  const blob = new Blob([JSON.stringify(lastRecording, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${lastRecording.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

window.addEventListener('resize', () => {
  syncPhonePortraitRotation();
  redrawOverlays();
});

// Initialize on load
updateViewLayout();
initPoseModels('full');
loadSavedReference();
populateCameras(true);
checkBackendHealth();
setInterval(checkBackendHealth, 5000);
