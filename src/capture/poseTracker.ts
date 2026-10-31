import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import {
  ClubState,
  ClubTrackingMode,
  Landmark,
  POSE_LANDMARKS,
  PoseModelVariant,
  SwingFrame,
} from '../types';
import { PoseOneEuroFilter } from './oneEuroFilter';
import { ClubTracker } from './clubTracker';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

const MODEL_URLS: Record<PoseModelVariant, string> = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  heavy:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
};

/**
 * Key body landmarks required for Face-On golf swing tracking:
 * Shoulders (11, 12), Wrists (15, 16), Hips (23, 24).
 */
export const KEY_SWING_LANDMARKS = [
  POSE_LANDMARKS.LEFT_SHOULDER,
  POSE_LANDMARKS.RIGHT_SHOULDER,
  POSE_LANDMARKS.LEFT_WRIST,
  POSE_LANDMARKS.RIGHT_WRIST,
  POSE_LANDMARKS.LEFT_HIP,
  POSE_LANDMARKS.RIGHT_HIP,
];

/**
 * Down-The-Line (side-profile) biomechanics telemetry computed per frame on the portrait phone view.
 */
export interface DtlPostureMetrics {
  /** Dominant camera-facing side ('right' or 'left') based on landmark visibility */
  visibleSide: 'right' | 'left';
  /** Side-profile spine tilt angle in degrees from vertical (ideal at address ~35°-45°) */
  spineTiltDeg: number;
  /** Knee flex angle in degrees from straight leg (ideal ~20°-30°) */
  kneeFlexDeg: number;
  /** Pelvis/glute normalized X coordinate for Tush Line tracking */
  hipRearX: number;
  /** Midpoint of visible shoulder in normalized 2D coordinates */
  shoulderPt: { x: number; y: number };
  /** Midpoint of visible hip in normalized 2D coordinates */
  hipPt: { x: number; y: number };
  /** Visible knee in normalized 2D coordinates */
  kneePt: { x: number; y: number };
  /** Visible ankle in normalized 2D coordinates */
  anklePt: { x: number; y: number };
  /** Visible elbow in normalized 2D coordinates */
  elbowPt: { x: number; y: number };
  /** Visible wrist/grip in normalized 2D coordinates */
  wristPt: { x: number; y: number };
  /** Head/ear anchor in normalized 2D coordinates */
  headPt: { x: number; y: number };
}

export interface PoseDetectionResult {
  frame: SwingFrame;
  /** True if key landmarks for the active camera perspective have sufficient visibility */
  isReliable: boolean;
  /** Mean visibility across key swing landmarks (0..1) */
  keyVisibility: number;
  /** Optional golf club tracking state (never required to be detected) */
  club: ClubState;
  /** Side-profile posture metrics when running in Down-The-Line ('dtl') perspective */
  dtlMetrics?: DtlPostureMetrics;
}

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null;
  private filter: PoseOneEuroFilter;
  private clubTracker: ClubTracker;
  private currentVariant: PoseModelVariant = 'full';
  private isInitializing = false;
  private lastTimestampMs = 0;

  // Offscreen canvas used only when rotating a portrait phone stream (+90 / -90 deg) before inference
  private rotCanvas: HTMLCanvasElement | null = null;
  private rotCtx: CanvasRenderingContext2D | null = null;

  constructor(minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.filter = new PoseOneEuroFilter(33, minCutoff, beta, dCutoff);
    this.clubTracker = new ClubTracker('auto');
  }

  /**
   * Initializes MediaPipe PoseLandmarker with GPU delegate (and CPU fallback).
   * Default variant is 'full' per docs/IMPLEMENTATION_PLAN.md.
   */
  async init(variant: PoseModelVariant = 'full'): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      if (this.landmarker) {
        this.landmarker.close();
        this.landmarker = null;
      }

      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
      const modelAssetPath = MODEL_URLS[variant];

      try {
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.45,
          minPosePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        });
      } catch (gpuErr) {
        console.warn('[PoseTracker] GPU delegate failed, falling back to CPU:', gpuErr);
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.45,
          minPosePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        });
      }

      this.currentVariant = variant;
      this.filter.reset();
      this.clubTracker.reset();
      this.lastTimestampMs = 0;
    } finally {
      this.isInitializing = false;
    }
  }

  isReady(): boolean {
    return this.landmarker !== null && !this.isInitializing;
  }

  getVariant(): PoseModelVariant {
    return this.currentVariant;
  }

  setClubTrackingMode(mode: ClubTrackingMode): void {
    this.clubTracker.setMode(mode);
  }

  getClubTrackingMode(): ClubTrackingMode {
    return this.clubTracker.getMode();
  }

  resetFilter(): void {
    this.filter.reset();
    this.clubTracker.reset();
  }

  /**
   * Runs pose detection on a video frame, smooths 2D & 3D landmarks through the One Euro Filter,
   * evaluates perspective-appropriate landmark visibility, and optionally tracks the golf club.
   *
   * @param video HTMLVideoElement to analyze
   * @param timestampMs Current performance.now() timestamp in ms
   * @param rotationDeg Optional 90 / -90 rotation for portrait DroidCam feeds
   * @param perspective 'face-on' (bilateral symmetry) or 'dtl' (side-profile posture chain)
   */
  detect(
    video: HTMLVideoElement,
    timestampMs: number,
    rotationDeg: 0 | 90 | -90 = 0,
    perspective: 'face-on' | 'dtl' = 'face-on'
  ): PoseDetectionResult | null {
    if (!this.landmarker || this.isInitializing) return null;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    // MediaPipe VIDEO mode strictly requires monotonically increasing timestamps
    const safeTimestamp = Math.max(Math.floor(timestampMs), this.lastTimestampMs + 1);
    this.lastTimestampMs = safeTimestamp;

    let inputSource: HTMLVideoElement | HTMLCanvasElement = video;
    let sourceW = video.videoWidth;
    let sourceH = video.videoHeight;

    if (rotationDeg === 90 || rotationDeg === -90) {
      const rotatedCanvas = this.getRotatedCanvas(video, rotationDeg);
      inputSource = rotatedCanvas;
      sourceW = rotatedCanvas.width;
      sourceH = rotatedCanvas.height;
    }

    const result = this.landmarker.detectForVideo(inputSource, safeTimestamp);
    if (
      !result.landmarks ||
      result.landmarks.length === 0 ||
      !result.worldLandmarks ||
      result.worldLandmarks.length === 0
    ) {
      return null;
    }

    const raw2D: Landmark[] = result.landmarks[0].map((lm) => ({
      x: lm.x,
      y: lm.y,
      z: lm.z ?? 0,
      visibility: lm.visibility ?? 1,
    }));

    const raw3D: Landmark[] = result.worldLandmarks[0].map((lm) => ({
      x: lm.x,
      y: lm.y,
      z: lm.z ?? 0,
      visibility: lm.visibility ?? 1,
    }));

    // Smooth both 2D image landmarks and 3D world landmarks through One Euro Filter
    const smoothed2D = this.filter.filterImageLandmarks(raw2D, safeTimestamp);
    const smoothed3D = this.filter.filterWorldLandmarks(raw3D, safeTimestamp);

    // Track golf club shaft & clubhead (completely optional — never blocks if no club in hand)
    const club = this.clubTracker.track(
      inputSource,
      sourceW,
      sourceH,
      smoothed2D,
      safeTimestamp
    );

    let keyVisibility = 0;
    let isReliable = false;
    let dtlMetrics: DtlPostureMetrics | undefined;

    const pairMaxVis = (lIdx: number, rIdx: number) =>
      Math.max(smoothed2D[lIdx]?.visibility ?? 0, smoothed2D[rIdx]?.visibility ?? 0);

    if (perspective === 'dtl') {
      // In Down-The-Line (side profile), the far side of the body is occluded behind the torso.
      // Evaluate visibility on the camera-facing side chain: Shoulder, Elbow, Wrist, Hip.
      const dtlVis = [
        pairMaxVis(POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.RIGHT_SHOULDER),
        pairMaxVis(POSE_LANDMARKS.LEFT_ELBOW, POSE_LANDMARKS.RIGHT_ELBOW),
        pairMaxVis(POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.RIGHT_WRIST),
        pairMaxVis(POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.RIGHT_HIP),
      ];
      keyVisibility = dtlVis.reduce((a, b) => a + b, 0) / dtlVis.length;
      isReliable = keyVisibility >= 0.42 && Math.min(...dtlVis) >= 0.28;
      dtlMetrics = this.computeDtlPostureMetrics(smoothed2D);
    } else {
      // Face-On: evaluate shoulders, wrists, hips.
      // Note: In the top of backswing and follow-through finish, the golfer rotates 90°
      // and wraps their hands around the shoulder, so one wrist or far-side hip/shoulder
      // can be partially occluded. Using pairMaxVis ensures follow-through frames stay reliable!
      const visValues = KEY_SWING_LANDMARKS.map((idx) => smoothed2D[idx]?.visibility ?? 0);
      keyVisibility =
        visValues.reduce((acc, v) => acc + v, 0) / KEY_SWING_LANDMARKS.length;
      const shoulderVis = pairMaxVis(
        POSE_LANDMARKS.LEFT_SHOULDER,
        POSE_LANDMARKS.RIGHT_SHOULDER
      );
      const wristVis = pairMaxVis(POSE_LANDMARKS.LEFT_WRIST, POSE_LANDMARKS.RIGHT_WRIST);
      const hipVis = pairMaxVis(POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.RIGHT_HIP);
      isReliable =
        keyVisibility >= 0.42 &&
        shoulderVis >= 0.4 &&
        hipVis >= 0.4 &&
        wristVis >= 0.32;
    }

    return {
      frame: {
        t: safeTimestamp,
        landmarks: smoothed2D,
        worldLandmarks: smoothed3D,
        club,
      },
      isReliable,
      keyVisibility,
      club,
      dtlMetrics,
    };
  }

  /**
   * Computes side-profile posture chain & angles specifically tailored for the Down-The-Line
   * (Portrait Phone) viewpoint:
   * - Spine Tilt Angle (Hip -> Shoulder relative to vertical)
   * - Knee Flex Angle
   * - Hip Depth ("Tush Line" anchor)
   * - Lead/Trail Arm & Hand Slot positions
   */
  private computeDtlPostureMetrics(landmarks: Landmark[]): DtlPostureMetrics {
    const ls = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rs = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
    const lh = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rh = landmarks[POSE_LANDMARKS.RIGHT_HIP];
    const le = landmarks[POSE_LANDMARKS.LEFT_ELBOW];
    const re = landmarks[POSE_LANDMARKS.RIGHT_ELBOW];
    const lw = landmarks[POSE_LANDMARKS.LEFT_WRIST];
    const rw = landmarks[POSE_LANDMARKS.RIGHT_WRIST];
    const lk = landmarks[POSE_LANDMARKS.LEFT_KNEE];
    const rk = landmarks[POSE_LANDMARKS.RIGHT_KNEE];
    const la = landmarks[POSE_LANDMARKS.LEFT_ANKLE];
    const ra = landmarks[POSE_LANDMARKS.RIGHT_ANKLE];
    const lEar = landmarks[POSE_LANDMARKS.LEFT_EAR];
    const rEar = landmarks[POSE_LANDMARKS.RIGHT_EAR];
    const nose = landmarks[POSE_LANDMARKS.NOSE];

    const rightVisScore =
      (rs?.visibility ?? 0) +
      (rh?.visibility ?? 0) +
      (re?.visibility ?? 0) +
      (rw?.visibility ?? 0);
    const leftVisScore =
      (ls?.visibility ?? 0) +
      (lh?.visibility ?? 0) +
      (le?.visibility ?? 0) +
      (lw?.visibility ?? 0);

    const visibleSide: 'right' | 'left' = rightVisScore >= leftVisScore ? 'right' : 'left';

    // Visibility-weighted midpoint helper so we smoothly blend or favor the visible camera-facing side
    const weightedPt = (a: Landmark | undefined, b: Landmark | undefined) => {
      const va = Math.max(0.05, a?.visibility ?? 0);
      const vb = Math.max(0.05, b?.visibility ?? 0);
      const ax = a?.x ?? 0.5;
      const ay = a?.y ?? 0.5;
      const bx = b?.x ?? ax;
      const by = b?.y ?? ay;
      return {
        x: (ax * va + bx * vb) / (va + vb),
        y: (ay * va + by * vb) / (va + vb),
      };
    };

    const shoulderPt = weightedPt(rs, ls);
    const hipPt = weightedPt(rh, lh);
    const elbowPt = visibleSide === 'right' ? weightedPt(re, le) : weightedPt(le, re);
    const wristPt = weightedPt(rw, lw);
    const kneePt = visibleSide === 'right' ? weightedPt(rk, lk) : weightedPt(lk, rk);
    const anklePt = visibleSide === 'right' ? weightedPt(ra, la) : weightedPt(la, ra);
    const earPt = weightedPt(rEar, lEar);
    const headPt = {
      x: earPt.x * 0.65 + (nose?.x ?? earPt.x) * 0.35,
      y: earPt.y * 0.65 + (nose?.y ?? earPt.y) * 0.35,
    };

    // Spine tilt angle relative to vertical (0 deg = standing straight up, ~38-42 deg = athletic golf posture)
    const spineDx = shoulderPt.x - hipPt.x;
    const spineDy = hipPt.y - shoulderPt.y; // positive upward
    const spineTiltDeg = Math.round(
      (Math.atan2(Math.abs(spineDx), Math.max(0.001, Math.abs(spineDy))) * 180) / Math.PI
    );

    // Knee flex angle: deviation from straight Hip->Knee->Ankle line
    const v1x = hipPt.x - kneePt.x;
    const v1y = hipPt.y - kneePt.y;
    const v2x = anklePt.x - kneePt.x;
    const v2y = anklePt.y - kneePt.y;
    const dot = v1x * v2x + v1y * v2y;
    const mag = Math.max(0.0001, Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y));
    const kneeInteriorDeg = (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
    const kneeFlexDeg = Math.max(0, Math.round(180 - kneeInteriorDeg));

    return {
      visibleSide,
      spineTiltDeg,
      kneeFlexDeg,
      hipRearX: hipPt.x,
      shoulderPt,
      hipPt,
      kneePt,
      anklePt,
      elbowPt,
      wristPt,
      headPt,
    };
  }

  private getRotatedCanvas(video: HTMLVideoElement, rotationDeg: 90 | -90): HTMLCanvasElement {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!this.rotCanvas) {
      this.rotCanvas = document.createElement('canvas');
      this.rotCtx = this.rotCanvas.getContext('2d');
    }
    // After 90deg rotation, width is vh and height is vw
    if (this.rotCanvas.width !== vh || this.rotCanvas.height !== vw) {
      this.rotCanvas.width = vh;
      this.rotCanvas.height = vw;
    }
    const ctx = this.rotCtx!;
    ctx.save();
    ctx.clearRect(0, 0, this.rotCanvas.width, this.rotCanvas.height);
    ctx.translate(this.rotCanvas.width / 2, this.rotCanvas.height / 2);
    ctx.rotate((rotationDeg * Math.PI) / 180);
    ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
    ctx.restore();
    return this.rotCanvas;
  }

  close(): void {
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}
