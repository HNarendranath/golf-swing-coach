import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { Landmark, POSE_LANDMARKS, PoseModelVariant, SwingFrame } from '../types';
import { PoseOneEuroFilter } from './oneEuroFilter';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';

const MODEL_URLS: Record<PoseModelVariant, string> = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
  heavy:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
};

/**
 * Key body landmarks required for golf swing tracking:
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

export interface PoseDetectionResult {
  frame: SwingFrame;
  /** True if key landmarks (shoulders, wrists, hips) have visibility >= 0.5 */
  isReliable: boolean;
  /** Mean visibility across key swing landmarks (0..1) */
  keyVisibility: number;
}

export class PoseTracker {
  private landmarker: PoseLandmarker | null = null;
  private filter: PoseOneEuroFilter;
  private currentVariant: PoseModelVariant = 'full';
  private isInitializing = false;
  private lastTimestampMs = 0;

  // Offscreen canvas used only when rotating a portrait phone stream (+90 / -90 deg) before inference
  private rotCanvas: HTMLCanvasElement | null = null;
  private rotCtx: CanvasRenderingContext2D | null = null;

  constructor(minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.filter = new PoseOneEuroFilter(33, minCutoff, beta, dCutoff);
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
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
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
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      }

      this.currentVariant = variant;
      this.filter.reset();
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

  resetFilter(): void {
    this.filter.reset();
  }

  /**
   * Runs pose detection on a video frame, smooths 2D & 3D landmarks through the One Euro Filter,
   * and evaluates key landmark visibility (>= 0.5 threshold).
   *
   * @param video HTMLVideoElement to analyze
   * @param timestampMs Current performance.now() timestamp in ms
   * @param rotationDeg Optional 90 / -90 rotation for portrait DroidCam feeds
   */
  detect(
    video: HTMLVideoElement,
    timestampMs: number,
    rotationDeg: 0 | 90 | -90 = 0
  ): PoseDetectionResult | null {
    if (!this.landmarker || this.isInitializing) return null;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return null;
    }

    // MediaPipe VIDEO mode strictly requires monotonically increasing integer/float timestamps
    const safeTimestamp = Math.max(Math.floor(timestampMs), this.lastTimestampMs + 1);
    this.lastTimestampMs = safeTimestamp;

    let inputSource: TexImageSource = video;
    if (rotationDeg === 90 || rotationDeg === -90) {
      inputSource = this.getRotatedCanvas(video, rotationDeg);
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

    // Evaluate visibility of key golf swing landmarks (wrists, shoulders, hips)
    const visValues = KEY_SWING_LANDMARKS.map((idx) => smoothed2D[idx]?.visibility ?? 0);
    const keyVisibility =
      visValues.reduce((acc, v) => acc + v, 0) / KEY_SWING_LANDMARKS.length;
    const minKeyVis = Math.min(...visValues);

    // Per HACKATHON_PLAN.md: "Drop frames where key landmark visibility is < 0.5"
    const isReliable = keyVisibility >= 0.5 && minKeyVis >= 0.4;

    return {
      frame: {
        t: safeTimestamp,
        landmarks: smoothed2D,
        worldLandmarks: smoothed3D,
      },
      isReliable,
      keyVisibility,
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
