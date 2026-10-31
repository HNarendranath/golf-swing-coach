import { ClubState, ClubTrackingMode, Landmark, POSE_LANDMARKS } from '../types';
import { OneEuroFilter } from './oneEuroFilter';

const PATCH_SIZE = 144;
const HALF_PATCH = PATCH_SIZE / 2;

/**
 * Optional real-time Golf Club Shaft & Clubhead Tracker.
 *
 * - Never required for swing capture, phase detection, or coaching.
 * - In 'auto' mode (default): uses radial edge-gradient ray casting anchored at the
 *   MediaPipe hand grip midpoint (excluding the forearm/torso cones) to detect a physical
 *   golf club shaft and clubhead. If the golfer is swinging empty-handed, `detected` is
 *   gracefully `false`.
 * - In 'virtual' mode: projects a kinematic virtual club shaft from the forearm/wrist
 *   vectors for empty-handed indoor shadow swings.
 */
export class ClubTracker {
  private mode: ClubTrackingMode = 'auto';
  private patchCanvas: HTMLCanvasElement;
  private patchCtx: CanvasRenderingContext2D;

  private tipXFilter = new OneEuroFilter(1.8, 0.15, 1.0);
  private tipYFilter = new OneEuroFilter(1.8, 0.15, 1.0);
  private lastAngleRad: number | null = null;
  private lockStreak = 0;

  constructor(mode: ClubTrackingMode = 'auto') {
    this.mode = mode;
    this.patchCanvas = document.createElement('canvas');
    this.patchCanvas.width = PATCH_SIZE;
    this.patchCanvas.height = PATCH_SIZE;
    this.patchCtx = this.patchCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  setMode(mode: ClubTrackingMode): void {
    this.mode = mode;
    this.reset();
  }

  getMode(): ClubTrackingMode {
    return this.mode;
  }

  reset(): void {
    this.tipXFilter.reset();
    this.tipYFilter.reset();
    this.lastAngleRad = null;
    this.lockStreak = 0;
  }

  /**
   * Tracks the golf club from the current frame source and smoothed 2D pose landmarks.
   *
   * @param source Video or rotated offscreen canvas matching the normalized landmark space
   * @param sourceWidth Pixel width of `source`
   * @param sourceHeight Pixel height of `source`
   * @param landmarks Smoothed 33 MediaPipe 2D landmarks
   * @param timestampMs Monotonic timestamp in ms
   */
  track(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    landmarks: Landmark[],
    timestampMs: number
  ): ClubState {
    const emptyState: ClubState = {
      detected: false,
      source: 'none',
      confidence: 0,
      grip: { x: 0.5, y: 0.5 },
      clubhead: { x: 0.5, y: 0.5 },
      shaftAngleDeg: 0,
    };

    if (this.mode === 'off' || sourceWidth === 0 || sourceHeight === 0) {
      return emptyState;
    }

    const gripInfo = this.computeGripAndForearmVectors(landmarks);
    if (!gripInfo) {
      this.lockStreak = 0;
      return emptyState;
    }

    const { grip, forearmAngleRad, exclusionAngles } = gripInfo;

    // If user explicitly selected 'virtual' club mode for empty-handed shadow swings
    if (this.mode === 'virtual') {
      return this.computeVirtualClub(
        grip,
        forearmAngleRad,
        sourceWidth,
        sourceHeight,
        timestampMs
      );
    }

    // 'auto' mode: run radial edge-collinearity shaft detection around the grip
    const cvDetection = this.detectPhysicalShaft(
      source,
      sourceWidth,
      sourceHeight,
      grip,
      exclusionAngles
    );

    const threshold = this.lockStreak >= 2 ? 0.44 : 0.54;
    if (cvDetection && cvDetection.confidence >= threshold) {
      this.lockStreak = Math.min(10, this.lockStreak + 1);
      this.lastAngleRad = cvDetection.angleRad;

      const smoothedTipX = this.tipXFilter.filter(cvDetection.clubhead.x, timestampMs);
      const smoothedTipY = this.tipYFilter.filter(cvDetection.clubhead.y, timestampMs);

      const dx = (smoothedTipX - grip.x) * sourceWidth;
      const dy = (smoothedTipY - grip.y) * sourceHeight;
      const angleDeg = Math.round((Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI);

      return {
        detected: true,
        source: 'cv',
        confidence: Number(cvDetection.confidence.toFixed(2)),
        grip,
        clubhead: {
          x: Math.max(0.01, Math.min(0.99, smoothedTipX)),
          y: Math.max(0.01, Math.min(0.99, smoothedTipY)),
        },
        shaftAngleDeg: angleDeg,
      };
    }

    // Decay lock streak if club is not seen in this frame
    this.lockStreak = Math.max(0, this.lockStreak - 1);
    if (this.lockStreak === 0) {
      this.lastAngleRad = null;
    }

    return {
      ...emptyState,
      grip,
      confidence: cvDetection ? Number(cvDetection.confidence.toFixed(2)) : 0,
    };
  }

  /**
   * Computes the grip center (normalized 0..1) and the forearm direction angles to exclude
   * when searching for a club shaft.
   */
  private computeGripAndForearmVectors(landmarks: Landmark[]): {
    grip: { x: number; y: number };
    forearmAngleRad: number;
    exclusionAngles: number[];
  } | null {
    const lw = landmarks[POSE_LANDMARKS.LEFT_WRIST];
    const rw = landmarks[POSE_LANDMARKS.RIGHT_WRIST];
    const li = landmarks[POSE_LANDMARKS.LEFT_INDEX];
    const ri = landmarks[POSE_LANDMARKS.RIGHT_INDEX];
    const le = landmarks[POSE_LANDMARKS.LEFT_ELBOW];
    const re = landmarks[POSE_LANDMARKS.RIGHT_ELBOW];
    const ls = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
    const rs = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];

    const lVis = lw?.visibility ?? 0;
    const rVis = rw?.visibility ?? 0;

    if (lVis < 0.35 && rVis < 0.35) {
      return null;
    }

    // Weight grip slightly toward index knuckles where the club handle sits
    let sumX = 0;
    let sumY = 0;
    let weightSum = 0;

    const addPt = (lm: Landmark | undefined, w: number) => {
      if (lm && (lm.visibility ?? 0) >= 0.35) {
        sumX += lm.x * w;
        sumY += lm.y * w;
        weightSum += w;
      }
    };

    addPt(lw, 1.0);
    addPt(rw, 1.0);
    addPt(li, 1.35);
    addPt(ri, 1.35);

    if (weightSum === 0) return null;
    const grip = { x: sumX / weightSum, y: sumY / weightSum };

    const exclusionAngles: number[] = [];
    const forearmVectors: Array<{ dx: number; dy: number }> = [];

    if (le && (le.visibility ?? 0) >= 0.3 && lVis >= 0.35) {
      // Angle from grip back toward left elbow (exclude this arm cone)
      exclusionAngles.push(Math.atan2(le.y - grip.y, le.x - grip.x));
      forearmVectors.push({ dx: grip.x - le.x, dy: grip.y - le.y });
    }
    if (re && (re.visibility ?? 0) >= 0.3 && rVis >= 0.35) {
      // Angle from grip back toward right elbow (exclude this arm cone)
      exclusionAngles.push(Math.atan2(re.y - grip.y, re.x - grip.x));
      forearmVectors.push({ dx: grip.x - re.x, dy: grip.y - re.y });
    }
    if (ls && (ls.visibility ?? 0) >= 0.3) {
      exclusionAngles.push(Math.atan2(ls.y - grip.y, ls.x - grip.x));
    }
    if (rs && (rs.visibility ?? 0) >= 0.3) {
      exclusionAngles.push(Math.atan2(rs.y - grip.y, rs.x - grip.x));
    }

    let forearmAngleRad = Math.PI / 2; // default downward
    if (forearmVectors.length > 0) {
      const avgDx =
        forearmVectors.reduce((acc, v) => acc + v.dx, 0) / forearmVectors.length;
      const avgDy =
        forearmVectors.reduce((acc, v) => acc + v.dy, 0) / forearmVectors.length;
      forearmAngleRad = Math.atan2(avgDy, avgDx);
    }

    return { grip, forearmAngleRad, exclusionAngles };
  }

  /**
   * Radial Sobel edge-collinearity detector around the grip center.
   * Looks for a straight, high-contrast shaft line extending outward from the hands.
   */
  private detectPhysicalShaft(
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    grip: { x: number; y: number },
    exclusionAngles: number[]
  ): {
    angleRad: number;
    clubhead: { x: number; y: number };
    confidence: number;
  } | null {
    // Define ROI radius in source pixels (~36% of min dimension)
    const roiRadiusPx = Math.max(80, Math.min(sourceWidth, sourceHeight) * 0.36);
    const gripPxX = grip.x * sourceWidth;
    const gripPxY = grip.y * sourceHeight;

    const sx = gripPxX - roiRadiusPx;
    const sy = gripPxY - roiRadiusPx;
    const sw = roiRadiusPx * 2;
    const sh = roiRadiusPx * 2;

    this.patchCtx.clearRect(0, 0, PATCH_SIZE, PATCH_SIZE);
    try {
      this.patchCtx.drawImage(source, sx, sy, sw, sh, 0, 0, PATCH_SIZE, PATCH_SIZE);
    } catch {
      return null;
    }

    const imgData = this.patchCtx.getImageData(0, 0, PATCH_SIZE, PATCH_SIZE).data;

    // Convert RGBA to grayscale luma [0..255]
    const gray = new Float32Array(PATCH_SIZE * PATCH_SIZE);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * imgData[p] + 0.587 * imgData[p + 1] + 0.114 * imgData[p + 2];
    }

    const rMin = 15; // Skip palm/fingers immediately around grip
    const rMax = HALF_PATCH - 4; // 68px in patch coords
    const numAngles = 72; // 5-degree steps

    let bestScore = 0;
    let secondBestScore = 0;
    let bestAngle = 0;
    let bestTipR = rMax * 0.85;

    for (let aIdx = 0; aIdx < numAngles; aIdx++) {
      const theta = (aIdx * 2 * Math.PI) / numAngles - Math.PI;

      // Skip rays that point back along the forearms/shoulders
      let excluded = false;
      for (const exAngle of exclusionAngles) {
        if (this.angleDiff(theta, exAngle) < 0.52) {
          // Within ~30 deg of forearm/torso
          excluded = true;
          break;
        }
      }
      if (excluded) continue;

      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);

      let rayScore = 0;
      let alignedCount = 0;
      let sampleCount = 0;
      let furthestStrongR = rMin;

      for (let r = rMin; r <= rMax; r += 2) {
        const px = Math.round(HALF_PATCH + r * cosT);
        const py = Math.round(HALF_PATCH + r * sinT);
        if (px <= 1 || px >= PATCH_SIZE - 2 || py <= 1 || py >= PATCH_SIZE - 2) {
          break;
        }

        const idx = py * PATCH_SIZE + px;
        // Sobel 3x3 gradient
        const gx =
          -gray[idx - PATCH_SIZE - 1] +
          gray[idx - PATCH_SIZE + 1] -
          2 * gray[idx - 1] +
          2 * gray[idx + 1] -
          gray[idx + PATCH_SIZE - 1] +
          gray[idx + PATCH_SIZE + 1];

        const gy =
          -gray[idx - PATCH_SIZE - 1] -
          2 * gray[idx - PATCH_SIZE] -
          gray[idx - PATCH_SIZE + 1] +
          gray[idx + PATCH_SIZE - 1] +
          2 * gray[idx + PATCH_SIZE] +
          gray[idx + PATCH_SIZE + 1];

        const mag = Math.hypot(gx, gy);
        sampleCount++;

        if (mag > 42) {
          // For a thin shaft along (cosT, sinT), the image gradient (gx, gy) should be
          // perpendicular to the ray: |dot(grad, ray)| / mag should be small (< 0.36)
          const parallelComponent = Math.abs(gx * cosT + gy * sinT) / mag;
          if (parallelComponent < 0.36) {
            const perpStrength = Math.min(1.5, (mag - 42) / 95) * (1 - parallelComponent);
            rayScore += perpStrength;
            alignedCount++;
            if (mag > 58) {
              furthestStrongR = r;
            }
          } else {
            // Penalize noisy non-collinear texture (e.g. background clutter)
            rayScore -= 0.18;
          }
        }
      }

      if (sampleCount < 10) continue;

      const collinearRatio = alignedCount / sampleCount;
      let normalizedScore = (rayScore / sampleCount) * (0.65 + 0.7 * collinearRatio);

      // Small temporal continuity boost if close to previous frame's shaft angle
      if (this.lastAngleRad !== null && this.angleDiff(theta, this.lastAngleRad) < 0.42) {
        normalizedScore *= 1.14;
      }

      if (normalizedScore > bestScore) {
        secondBestScore = bestScore;
        bestScore = normalizedScore;
        bestAngle = theta;
        bestTipR = Math.max(rMin + 16, furthestStrongR);
      } else if (normalizedScore > secondBestScore) {
        secondBestScore = normalizedScore;
      }
    }

    if (bestScore <= 0.18) {
      return null;
    }

    // Peak distinctiveness: a real shaft creates a sharp directional peak vs background
    const peakRatio = secondBestScore > 0 ? bestScore / secondBestScore : 2.0;
    const rawConf = Math.min(1, bestScore * 1.45 * Math.min(1.3, peakRatio * 0.75));

    const scaleBack = roiRadiusPx / HALF_PATCH;
    const tipPxX = gripPxX + Math.cos(bestAngle) * bestTipR * scaleBack;
    const tipPxY = gripPxY + Math.sin(bestAngle) * bestTipR * scaleBack;

    return {
      angleRad: bestAngle,
      clubhead: {
        x: tipPxX / sourceWidth,
        y: tipPxY / sourceHeight,
      },
      confidence: rawConf,
    };
  }

  /**
   * Projects a virtual club shaft from the golfer's forearm/wrist vector when 'virtual' mode is active.
   */
  private computeVirtualClub(
    grip: { x: number; y: number },
    forearmAngleRad: number,
    sourceWidth: number,
    sourceHeight: number,
    timestampMs: number
  ): ClubState {
    const virtualLenNorm = 0.28;
    const aspect = sourceWidth / sourceHeight;
    const rawTipX = grip.x + (Math.cos(forearmAngleRad) * virtualLenNorm) / Math.max(0.7, aspect);
    const rawTipY = grip.y + Math.sin(forearmAngleRad) * virtualLenNorm;

    const tipX = this.tipXFilter.filter(rawTipX, timestampMs);
    const tipY = this.tipYFilter.filter(rawTipY, timestampMs);

    const dx = (tipX - grip.x) * sourceWidth;
    const dy = (tipY - grip.y) * sourceHeight;
    const angleDeg = Math.round((Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI);

    return {
      detected: true,
      source: 'virtual',
      confidence: 1,
      grip,
      clubhead: {
        x: Math.max(0.02, Math.min(0.98, tipX)),
        y: Math.max(0.02, Math.min(0.98, tipY)),
      },
      shaftAngleDeg: angleDeg,
    };
  }

  private angleDiff(a: number, b: number): number {
    let d = Math.abs(a - b) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }
}

