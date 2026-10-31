/**
 * Reference Swing Spatial Normalization & Piecewise Phase Aligner.
 *
 * Aligns a user's captured swing against a saved `ReferenceSwing` (`data/reference.json`):
 * 1. Spatial Normalization: Centers 3D landmarks at the hip midpoint `(0, 0, 0)` and
 *    scales by torso length (`hip_mid -> shoulder_mid = 1.0`) so body size and camera
 *    distance differences cancel out.
 * 2. Piecewise Phase Alignment: Resamples both swings across key phase segments
 *    (`address -> top` [0..50], `top -> impact` [50..75], `impact -> finish` [75..99])
 *    into `N = 100` canonical frames (`t in [0..99]`).
 * 3. Per-Joint & Overall Match Score: Computes Euclidean joint errors across key golf
 *    landmarks and maps to a 0–100 similarity score: `100 * exp(-k * meanJointError)`.
 */

import {
  Landmark,
  POSE_LANDMARKS,
  SwingFrame,
  SwingMetrics,
  SwingPhases,
  SwingRecording,
} from '../types';
import { estimateMatchScoreFromMetrics } from './metricsCalculator';

const CANONICAL_FRAME_COUNT = 100;

/** Key upper/lower body joints weighted for golf swing similarity scoring. */
const SCORED_JOINTS: number[] = [
  POSE_LANDMARKS.LEFT_SHOULDER,
  POSE_LANDMARKS.RIGHT_SHOULDER,
  POSE_LANDMARKS.LEFT_ELBOW,
  POSE_LANDMARKS.RIGHT_ELBOW,
  POSE_LANDMARKS.LEFT_WRIST,
  POSE_LANDMARKS.RIGHT_WRIST,
  POSE_LANDMARKS.LEFT_HIP,
  POSE_LANDMARKS.RIGHT_HIP,
  POSE_LANDMARKS.LEFT_KNEE,
  POSE_LANDMARKS.RIGHT_KNEE,
];

export interface AlignedSwingResult {
  matchScore: number;
  alignedUserFrames: Landmark[][];
  alignedRefFrames: Landmark[][];
  perFrameJointErrors: Record<number, number>[];
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function lerpLandmark(a: Landmark, b: Landmark, t: number): Landmark {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

/**
 * Normalizes a single frame's 33 landmarks so that:
 * - Hip midpoint is at `(0, 0, 0)`
 * - Torso length (`hip_mid -> shoulder_mid`) equals `1.0`
 */
export function normalizePoseLandmarks(landmarks: Landmark[]): Landmark[] {
  if (landmarks.length < 25) return landmarks;

  const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  const lShoulder = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];

  const hipMidX = (lHip.x + rHip.x) * 0.5;
  const hipMidY = (lHip.y + rHip.y) * 0.5;
  const hipMidZ = (lHip.z + rHip.z) * 0.5;

  const shMidX = (lShoulder.x + rShoulder.x) * 0.5;
  const shMidY = (lShoulder.y + rShoulder.y) * 0.5;
  const shMidZ = (lShoulder.z + rShoulder.z) * 0.5;

  const torsoLen = Math.max(
    Math.hypot(shMidX - hipMidX, shMidY - hipMidY, shMidZ - hipMidZ),
    0.05
  );

  return landmarks.map((lm) => ({
    x: (lm.x - hipMidX) / torsoLen,
    y: (lm.y - hipMidY) / torsoLen,
    z: (lm.z - hipMidZ) / torsoLen,
    visibility: lm.visibility,
  }));
}

/**
 * Resamples a slice of frames `[startIdx .. endIdx]` into `targetCount` interpolated frames.
 */
function resampleSegment(
  frames: SwingFrame[],
  startIdx: number,
  endIdx: number,
  targetCount: number
): Landmark[][] {
  if (frames.length === 0 || targetCount <= 0) return [];
  const s = clamp(startIdx, 0, frames.length - 1);
  const e = clamp(Math.max(s, endIdx), 0, frames.length - 1);
  const span = e - s;

  const out: Landmark[][] = [];
  for (let i = 0; i < targetCount; i++) {
    const ratio = targetCount > 1 ? i / (targetCount - 1) : 0;
    const exactIdx = s + ratio * span;
    const idx0 = Math.floor(exactIdx);
    const idx1 = Math.min(frames.length - 1, Math.ceil(exactIdx));
    const frac = exactIdx - idx0;

    const norm0 = normalizePoseLandmarks(frames[idx0].worldLandmarks);
    const norm1 = normalizePoseLandmarks(frames[idx1].worldLandmarks);

    const interpolated = norm0.map((lm0, j) =>
      lerpLandmark(lm0, norm1[j] ?? lm0, frac)
    );
    out.push(interpolated);
  }
  return out;
}

/**
 * Piecewise linear phase resampling into `N = 100` canonical frames:
 * - Frames `[0..49]` (50 frames): `address -> top`
 * - Frames `[50..74]` (25 frames): `top -> impact`
 * - Frames `[75..99]` (25 frames): `impact -> finish`
 */
export function resampleSwingByPhases(
  frames: SwingFrame[],
  phases: SwingPhases
): Landmark[][] {
  if (frames.length === 0) return [];
  const seg1 = resampleSegment(frames, phases.address, phases.top, 50);
  const seg2 = resampleSegment(frames, phases.top, phases.impact, 25);
  const seg3 = resampleSegment(frames, phases.impact, phases.finish, 25);
  return [...seg1, ...seg2, ...seg3];
}

/**
 * Aligns a user swing against an optional reference swing and returns the 0–100 `matchScore`
 * plus aligned canonical trajectories for synchronized playback.
 */
export function alignAndScoreSwing(
  userFrames: SwingFrame[],
  userPhases: SwingPhases,
  userMetrics: SwingMetrics,
  referenceSwing?: SwingRecording | null
): AlignedSwingResult {
  const metricScore = estimateMatchScoreFromMetrics(userMetrics);
  const alignedUserFrames = resampleSwingByPhases(userFrames, userPhases);

  if (!referenceSwing || !referenceSwing.frames || referenceSwing.frames.length < 5) {
    return {
      matchScore: metricScore,
      alignedUserFrames,
      alignedRefFrames: [],
      perFrameJointErrors: [],
    };
  }

  const alignedRefFrames = resampleSwingByPhases(
    referenceSwing.frames,
    referenceSwing.phases
  );

  if (alignedUserFrames.length !== CANONICAL_FRAME_COUNT || alignedRefFrames.length !== CANONICAL_FRAME_COUNT) {
    return {
      matchScore: metricScore,
      alignedUserFrames,
      alignedRefFrames,
      perFrameJointErrors: [],
    };
  }

  let totalError = 0;
  let totalSamples = 0;
  const perFrameJointErrors: Record<number, number>[] = [];

  for (let f = 0; f < CANONICAL_FRAME_COUNT; f++) {
    const uFrame = alignedUserFrames[f];
    const rFrame = alignedRefFrames[f];
    const jointErrMap: Record<number, number> = {};

    for (const jointIdx of SCORED_JOINTS) {
      const u = uFrame[jointIdx];
      const r = rFrame[jointIdx];
      if (!u || !r) continue;
      // Weight X/Y higher than single-camera Z depth
      const err = Math.hypot(u.x - r.x, u.y - r.y, (u.z - r.z) * 0.5);
      jointErrMap[jointIdx] = err;
      totalError += err;
      totalSamples++;
    }
    perFrameJointErrors.push(jointErrMap);
  }

  const meanJointError = totalSamples > 0 ? totalError / totalSamples : 0.25;
  // Exponential similarity curve: meanJointError = 0 -> 100%, 0.15 -> ~80%, 0.35 -> ~59%
  const rawAlignmentScore = 100 * Math.exp(-1.5 * meanJointError);
  // Blend spatial alignment score with biomechanical metrics score for stability
  const combinedScore = Math.round(
    clamp(0.55 * rawAlignmentScore + 0.45 * metricScore, 35, 99)
  );

  return {
    matchScore: combinedScore,
    alignedUserFrames,
    alignedRefFrames,
    perFrameJointErrors,
  };
}
