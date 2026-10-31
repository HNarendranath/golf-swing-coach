/**
 * Deterministic Biomechanical Metrics Calculator & Fault Ranker.
 *
 * Principle: "Code measures, LLM talks."
 * All 9 biomechanical metrics and fault rankings are computed deterministically
 * from MediaPipe landmarks so Gemini only translates verified numbers into
 * natural spoken coaching.
 *
 * Coordinate System Architecture:
 * - MediaPipe's `worldLandmarks` re-centers `(0, 0, 0)` at the pelvis on EVERY frame,
 *   which erases global body translation across frames.
 * - Therefore, Translation Metrics (`head_movement_cm`, `hip_sway_cm`, `weight_shift_cm`)
 *   are computed from normalized 2D image `landmarks` anchored to the Address frame
 *   and converted to centimetres using the golfer's 2D torso length at address
 *   (`shoulder_mid <-> hip_mid` = 50 cm physical reference).
 * - Rotational & Angular Metrics (`shoulder_turn_deg`, `hip_turn_deg`, `x_factor_deg`,
 *   `lead_arm_deg`, `spine_angle_*`) blend 3D `worldLandmarks` vectors with 2D
 *   foreshortening / projection geometry to suppress single-camera depth (Z) noise.
 */

import {
  Handedness,
  Landmark,
  POSE_LANDMARKS,
  SwingFault,
  SwingFrame,
  SwingMetrics,
  SwingPhases,
} from '../types';
import { computePhaseTempo } from './phaseDetector';

/** Reference physical length (in cm) of an adult human torso (hip midpoint to shoulder midpoint). */
const REFERENCE_TORSO_LENGTH_CM = 50.0;

export type MetricStatus = 'good' | 'warn' | 'bad';

export interface FaultEvaluation {
  fault: SwingFault;
  label: string;
  severity: number;
  measuredText: string;
  targetText: string;
}

export interface MetricDisplayItem {
  key: keyof SwingMetrics;
  label: string;
  formattedValue: string;
  targetLabel: string;
  status: MetricStatus;
}

/** Human-readable titles for each SwingFault identifier. */
export const FAULT_LABELS: Record<SwingFault, string> = {
  bent_lead_arm: 'Bent Lead Arm at Top',
  head_movement: 'Excessive Head Movement',
  hip_sway: 'Lateral Hip Sway',
  fast_tempo: 'Rushed Tempo',
  slow_tempo: 'Slow Backswing Tempo',
  early_extension: 'Early Extension (Spine Rise)',
  poor_shoulder_turn: 'Restricted Shoulder Turn',
  low_x_factor: 'Low X-Factor Separation',
  no_weight_shift: 'Insufficient Weight Shift',
  poor_weight_shift: 'Incomplete Weight Transfer',
  over_the_top: 'Over-the-Top Transition',
};

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function midpoint(a: Landmark, b: Landmark): Landmark {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

function dist2D(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Computes the interior 2D angle (in degrees, [0..180]) at vertex `b` formed by `a - b - c`.
 */
function angle2DDeg(a: Landmark, b: Landmark, c: Landmark): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 < 1e-6 || mag2 < 1e-6) return 180;
  const cos = clamp((v1x * v2x + v1y * v2y) / (mag1 * mag2), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Computes the interior 3D angle (in degrees, [0..180]) at vertex `b` formed by `a - b - c`.
 */
function angle3DDeg(a: Landmark, b: Landmark, c: Landmark): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v1z = a.z - b.z;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const v2z = c.z - b.z;
  const mag1 = Math.hypot(v1x, v1y, v1z);
  const mag2 = Math.hypot(v2x, v2y, v2z);
  if (mag1 < 1e-6 || mag2 < 1e-6) return 180;
  const cos = clamp((v1x * v2x + v1y * v2y + v1z * v2z) / (mag1 * mag2), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Computes torso axial rotation (turn) in degrees between `address` and `top` frames
 * for a given pair of left/right anatomical landmarks (shoulders or hips).
 *
 * Blends 2D horizontal width foreshortening `arccos(dx_top / dx_addr)` with
 * 3D `worldLandmarks` XZ-plane yaw rotation so single-camera depth jitter never
 * produces erratic rotation values. Also handles Down-The-Line (DTL) views gracefully.
 */
function computeSegmentTurnDeg(
  addr2DLeft: Landmark,
  addr2DRight: Landmark,
  top2DLeft: Landmark,
  top2DRight: Landmark,
  addr3DLeft: Landmark,
  addr3DRight: Landmark,
  top3DLeft: Landmark,
  top3DRight: Landmark,
  minDeg: number,
  maxDeg: number
): number {
  // 1. 3D XZ-plane yaw angle between address segment vector and top segment vector
  const vAddrX = addr3DRight.x - addr3DLeft.x;
  const vAddrZ = addr3DRight.z - addr3DLeft.z;
  const vTopX = top3DRight.x - top3DLeft.x;
  const vTopZ = top3DRight.z - top3DLeft.z;

  const magAddr3D = Math.hypot(vAddrX, vAddrZ);
  const magTop3D = Math.hypot(vTopX, vTopZ);

  let angle3D = 0;
  if (magAddr3D > 1e-5 && magTop3D > 1e-5) {
    const cos3D = clamp((vAddrX * vTopX + vAddrZ * vTopZ) / (magAddr3D * magTop3D), -1, 1);
    angle3D = (Math.acos(cos3D) * 180) / Math.PI;
  }

  // 2. 2D horizontal width foreshortening (Face-On view primary signal)
  const dxAddr = addr2DRight.x - addr2DLeft.x;
  const dxTop = top2DRight.x - top2DLeft.x;
  const widthAddr = Math.abs(dxAddr);

  if (widthAddr > 0.05) {
    // Signed ratio allows slight >90 deg turn when shoulders cross horizontal midpoint
    const signedRatio = clamp(dxTop / dxAddr, -0.25, 1.0);
    const angle2D = (Math.acos(signedRatio) * 180) / Math.PI;
    const blended = 0.65 * angle2D + 0.35 * angle3D;
    return clamp(blended, minDeg, maxDeg);
  }

  // Fallback when viewing Down-The-Line (where address width is narrow and top width is wide)
  const widthTop = Math.abs(dxTop);
  if (widthTop > 0.05) {
    const dtlRatio = clamp(widthAddr / widthTop, 0, 1);
    const angleDtl2D = (Math.acos(dtlRatio) * 180) / Math.PI;
    return clamp(0.5 * angleDtl2D + 0.5 * angle3D, minDeg, maxDeg);
  }

  return clamp(angle3D, minDeg, maxDeg);
}

/**
 * Computes torso spine tilt angle in degrees relative to vertical (0 deg = upright).
 * Combines 3D world torso vector with 2D torso inclination for stability.
 */
function computeSpineTiltDeg(
  lm2D: Landmark[],
  lm3D: Landmark[]
): number {
  const sMid2D = midpoint(
    lm2D[POSE_LANDMARKS.LEFT_SHOULDER],
    lm2D[POSE_LANDMARKS.RIGHT_SHOULDER]
  );
  const hMid2D = midpoint(
    lm2D[POSE_LANDMARKS.LEFT_HIP],
    lm2D[POSE_LANDMARKS.RIGHT_HIP]
  );
  const sMid3D = midpoint(
    lm3D[POSE_LANDMARKS.LEFT_SHOULDER],
    lm3D[POSE_LANDMARKS.RIGHT_SHOULDER]
  );
  const hMid3D = midpoint(
    lm3D[POSE_LANDMARKS.LEFT_HIP],
    lm3D[POSE_LANDMARKS.RIGHT_HIP]
  );

  // Vector from hip midpoint up to shoulder midpoint (upward vertical is (0, -1, 0) in MediaPipe)
  const vx3 = sMid3D.x - hMid3D.x;
  const vy3 = sMid3D.y - hMid3D.y;
  const vz3 = sMid3D.z - hMid3D.z;
  const mag3 = Math.hypot(vx3, vy3, vz3);
  const tilt3D =
    mag3 > 1e-5 ? (Math.acos(clamp(-vy3 / mag3, -1, 1)) * 180) / Math.PI : 0;

  const vx2 = sMid2D.x - hMid2D.x;
  const vy2 = sMid2D.y - hMid2D.y;
  const mag2 = Math.hypot(vx2, vy2);
  const tilt2D =
    mag2 > 1e-5 ? (Math.acos(clamp(-vy2 / mag2, -1, 1)) * 180) / Math.PI : 0;

  return 0.6 * tilt3D + 0.4 * tilt2D;
}

/**
 * Computes all 9 core biomechanical metrics from a captured swing's frames and detected phases.
 */
export function calculateSwingMetrics(
  frames: SwingFrame[],
  phases: SwingPhases,
  handedness: Handedness = 'right'
): SwingMetrics {
  if (frames.length === 0) {
    return {
      tempo_ratio: 3.0,
      backswing_ms: 750,
      downswing_ms: 250,
      shoulder_turn_deg: 85,
      hip_turn_deg: 45,
      x_factor_deg: 40,
      lead_arm_deg: 170,
      spine_angle_address_deg: 32,
      spine_angle_impact_deg: 32,
      spine_angle_change_deg: 0,
      head_movement_cm: 2.0,
      hip_sway_cm: 2.0,
      weight_shift_cm: 4.0,
    };
  }

  const safeIdx = (idx: number) => clamp(idx, 0, frames.length - 1);
  const addrIdx = safeIdx(phases.address);
  const topIdx = safeIdx(phases.top);
  const impactIdx = safeIdx(phases.impact);

  const addrFrame = frames[addrIdx];
  const topFrame = frames[topIdx];
  const impactFrame = frames[impactIdx];

  // ── 1. Tempo Ratio (Backswing : Downswing) ────────────────────────────────
  const { backswingMs, downswingMs, tempoRatio } = computePhaseTempo(phases);

  // ── Scale Factor: 2D Normalized Units -> Centimetres (cm) ─────────────────
  const addrShoulderMid2D = midpoint(
    addrFrame.landmarks[POSE_LANDMARKS.LEFT_SHOULDER],
    addrFrame.landmarks[POSE_LANDMARKS.RIGHT_SHOULDER]
  );
  const addrHipMid2D = midpoint(
    addrFrame.landmarks[POSE_LANDMARKS.LEFT_HIP],
    addrFrame.landmarks[POSE_LANDMARKS.RIGHT_HIP]
  );
  const addrTorsoLen2D = Math.max(dist2D(addrShoulderMid2D, addrHipMid2D), 0.08);
  const cmPerNormUnit = REFERENCE_TORSO_LENGTH_CM / addrTorsoLen2D;

  // Determine anatomical lead (target) vs trail (away from target) direction in 2D image X
  const leadHipIdx =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_HIP : POSE_LANDMARKS.RIGHT_HIP;
  const trailHipIdx =
    handedness === 'right' ? POSE_LANDMARKS.RIGHT_HIP : POSE_LANDMARKS.LEFT_HIP;

  const addrLeadHip2D = addrFrame.landmarks[leadHipIdx];
  const addrTrailHip2D = addrFrame.landmarks[trailHipIdx];
  const rawTrailDeltaX = addrTrailHip2D.x - addrLeadHip2D.x;
  // Sign in image X that points toward the trail foot (away from target)
  const trailSignX =
    Math.abs(rawTrailDeltaX) > 0.005
      ? Math.sign(rawTrailDeltaX)
      : handedness === 'right'
        ? 1
        : -1;
  // Sign in image X that points toward the lead foot (target direction)
  const leadSignX = -trailSignX;

  // ── 2. Head Stability (head_movement_cm) ──────────────────────────────────
  const addrNose2D = addrFrame.landmarks[POSE_LANDMARKS.NOSE];
  let maxHeadDispNorm = 0;
  const startCheckIdx = Math.min(addrIdx, safeIdx(phases.takeaway));
  const endCheckIdx = Math.max(topIdx, impactIdx);
  for (let i = startCheckIdx; i <= endCheckIdx; i++) {
    const nose = frames[i].landmarks[POSE_LANDMARKS.NOSE];
    const disp = dist2D(nose, addrNose2D);
    if (disp > maxHeadDispNorm) {
      maxHeadDispNorm = disp;
    }
  }
  const headMovementCm = round1(clamp(maxHeadDispNorm * cmPerNormUnit, 0, 35));

  // ── 3. Hip Sway (hip_sway_cm) ─────────────────────────────────────────────
  // Max lateral shift of 2D hip midpoint in the trail direction (away from target)
  // between address and top of backswing.
  let maxTrailHipShiftNorm = 0;
  for (let i = addrIdx; i <= topIdx; i++) {
    const hipMid = midpoint(
      frames[i].landmarks[POSE_LANDMARKS.LEFT_HIP],
      frames[i].landmarks[POSE_LANDMARKS.RIGHT_HIP]
    );
    const trailDelta = (hipMid.x - addrHipMid2D.x) * trailSignX;
    if (trailDelta > maxTrailHipShiftNorm) {
      maxTrailHipShiftNorm = trailDelta;
    }
  }
  const hipSwayCm = round1(clamp(maxTrailHipShiftNorm * cmPerNormUnit, 0, 30));

  // ── 4. Weight Shift (weight_shift_cm) ─────────────────────────────────────
  // Lateral shift of 2D hip midpoint toward the target (lead direction) around impact.
  const impactWinStart = Math.max(topIdx, impactIdx - 1);
  const impactWinEnd = Math.min(frames.length - 1, impactIdx + 1);
  let bestLeadShiftNorm = -Infinity;
  for (let i = impactWinStart; i <= impactWinEnd; i++) {
    const hipMid = midpoint(
      frames[i].landmarks[POSE_LANDMARKS.LEFT_HIP],
      frames[i].landmarks[POSE_LANDMARKS.RIGHT_HIP]
    );
    const leadDelta = (hipMid.x - addrHipMid2D.x) * leadSignX;
    if (leadDelta > bestLeadShiftNorm) {
      bestLeadShiftNorm = leadDelta;
    }
  }
  if (!Number.isFinite(bestLeadShiftNorm)) {
    const impactHipMid = midpoint(
      impactFrame.landmarks[POSE_LANDMARKS.LEFT_HIP],
      impactFrame.landmarks[POSE_LANDMARKS.RIGHT_HIP]
    );
    bestLeadShiftNorm = (impactHipMid.x - addrHipMid2D.x) * leadSignX;
  }
  const weightShiftCm = round1(clamp(bestLeadShiftNorm * cmPerNormUnit, -10, 25));

  // ── 5, 6, 7. Shoulder Turn, Hip Turn & X-Factor at Top ────────────────────
  const rawShoulderTurn = computeSegmentTurnDeg(
    addrFrame.landmarks[POSE_LANDMARKS.LEFT_SHOULDER],
    addrFrame.landmarks[POSE_LANDMARKS.RIGHT_SHOULDER],
    topFrame.landmarks[POSE_LANDMARKS.LEFT_SHOULDER],
    topFrame.landmarks[POSE_LANDMARKS.RIGHT_SHOULDER],
    addrFrame.worldLandmarks[POSE_LANDMARKS.LEFT_SHOULDER],
    addrFrame.worldLandmarks[POSE_LANDMARKS.RIGHT_SHOULDER],
    topFrame.worldLandmarks[POSE_LANDMARKS.LEFT_SHOULDER],
    topFrame.worldLandmarks[POSE_LANDMARKS.RIGHT_SHOULDER],
    15,
    115
  );

  const rawHipTurn = computeSegmentTurnDeg(
    addrFrame.landmarks[POSE_LANDMARKS.LEFT_HIP],
    addrFrame.landmarks[POSE_LANDMARKS.RIGHT_HIP],
    topFrame.landmarks[POSE_LANDMARKS.LEFT_HIP],
    topFrame.landmarks[POSE_LANDMARKS.RIGHT_HIP],
    addrFrame.worldLandmarks[POSE_LANDMARKS.LEFT_HIP],
    addrFrame.worldLandmarks[POSE_LANDMARKS.RIGHT_HIP],
    topFrame.worldLandmarks[POSE_LANDMARKS.LEFT_HIP],
    topFrame.worldLandmarks[POSE_LANDMARKS.RIGHT_HIP],
    5,
    70
  );

  const shoulderTurnDeg = round1(rawShoulderTurn);
  // Biomechanically, pelvis rotation at top cannot exceed ribcage/shoulder rotation
  const hipTurnDeg = round1(Math.min(rawHipTurn, shoulderTurnDeg - 5));
  const xFactorDeg = round1(Math.max(0, shoulderTurnDeg - hipTurnDeg));

  // ── 8. Lead Arm Angle at Top (lead_arm_deg) ───────────────────────────────
  const leadShoulderIdx =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_SHOULDER : POSE_LANDMARKS.RIGHT_SHOULDER;
  const leadElbowIdx =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_ELBOW : POSE_LANDMARKS.RIGHT_ELBOW;
  const leadWristIdx =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_WRIST : POSE_LANDMARKS.RIGHT_WRIST;

  const arm2D = angle2DDeg(
    topFrame.landmarks[leadShoulderIdx],
    topFrame.landmarks[leadElbowIdx],
    topFrame.landmarks[leadWristIdx]
  );
  const arm3D = angle3DDeg(
    topFrame.worldLandmarks[leadShoulderIdx],
    topFrame.worldLandmarks[leadElbowIdx],
    topFrame.worldLandmarks[leadWristIdx]
  );
  const leadArmDeg = round1(clamp(0.6 * arm2D + 0.4 * arm3D, 75, 180));

  // ── 9. Spine Angle Maintenance (Address vs Impact) ────────────────────────
  const spineAddrDeg = round1(
    computeSpineTiltDeg(addrFrame.landmarks, addrFrame.worldLandmarks)
  );
  const spineImpactDeg = round1(
    computeSpineTiltDeg(impactFrame.landmarks, impactFrame.worldLandmarks)
  );
  const spineChangeDeg = round1(Math.abs(spineImpactDeg - spineAddrDeg));

  return {
    tempo_ratio: tempoRatio,
    backswing_ms: backswingMs,
    downswing_ms: downswingMs,
    shoulder_turn_deg: shoulderTurnDeg,
    hip_turn_deg: hipTurnDeg,
    x_factor_deg: xFactorDeg,
    lead_arm_deg: leadArmDeg,
    spine_angle_address_deg: spineAddrDeg,
    spine_angle_impact_deg: spineImpactDeg,
    spine_angle_change_deg: spineChangeDeg,
    head_movement_cm: headMovementCm,
    hip_sway_cm: hipSwayCm,
    weight_shift_cm: weightShiftCm,
  };
}

/**
 * Evaluates all fault rules against `SwingMetrics` and returns fault details
 * sorted from highest normalized severity to lowest.
 */
export function evaluateSwingFaultDetails(metrics: SwingMetrics): FaultEvaluation[] {
  const evaluations: FaultEvaluation[] = [];

  // 1. Bent Lead Arm at Top (Target: > 160°, Fault threshold: < 155°)
  if (metrics.lead_arm_deg < 155) {
    const severity = (160 - metrics.lead_arm_deg) / 15;
    evaluations.push({
      fault: 'bent_lead_arm',
      label: FAULT_LABELS.bent_lead_arm,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.lead_arm_deg.toFixed(0)}°`,
      targetText: '> 160°',
    });
  }

  // 2. Head Movement (Target: < 5 cm, Fault threshold: > 5.5 cm)
  if (metrics.head_movement_cm > 5.5) {
    const severity = (metrics.head_movement_cm - 5.0) / 4.0;
    evaluations.push({
      fault: 'head_movement',
      label: FAULT_LABELS.head_movement,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.head_movement_cm.toFixed(1)} cm`,
      targetText: '< 5.0 cm',
    });
  }

  // 3. Hip Sway (Target: < 5 cm, Fault threshold: > 5.0 cm)
  if (metrics.hip_sway_cm > 5.0) {
    const severity = (metrics.hip_sway_cm - 5.0) / 4.0;
    evaluations.push({
      fault: 'hip_sway',
      label: FAULT_LABELS.hip_sway,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.hip_sway_cm.toFixed(1)} cm`,
      targetText: '< 5.0 cm',
    });
  }

  // 4. Early Extension / Spine Angle Change (Target: < 5°, Fault threshold: > 5.5°)
  if (metrics.spine_angle_change_deg > 5.5) {
    const severity = (metrics.spine_angle_change_deg - 5.0) / 4.0;
    evaluations.push({
      fault: 'early_extension',
      label: FAULT_LABELS.early_extension,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.spine_angle_change_deg.toFixed(1)}°`,
      targetText: '< 5.0°',
    });
  }

  // 5. Fast / Slow Tempo (Target: ~3.0 : 1, Fault thresholds: < 2.3 or > 3.8)
  if (metrics.tempo_ratio < 2.3) {
    const severity = (2.5 - metrics.tempo_ratio) / 0.6;
    evaluations.push({
      fault: 'fast_tempo',
      label: FAULT_LABELS.fast_tempo,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.tempo_ratio.toFixed(1)}:1`,
      targetText: '3.0:1',
    });
  } else if (metrics.tempo_ratio > 3.8) {
    const severity = (metrics.tempo_ratio - 3.6) / 0.8;
    evaluations.push({
      fault: 'slow_tempo',
      label: FAULT_LABELS.slow_tempo,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.tempo_ratio.toFixed(1)}:1`,
      targetText: '3.0:1',
    });
  }

  // 6. Poor Shoulder Turn (Target: 80–90°, Fault threshold: < 65°)
  if (metrics.shoulder_turn_deg < 65) {
    const severity = (75 - metrics.shoulder_turn_deg) / 18;
    evaluations.push({
      fault: 'poor_shoulder_turn',
      label: FAULT_LABELS.poor_shoulder_turn,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.shoulder_turn_deg.toFixed(0)}°`,
      targetText: '80–90°',
    });
  }

  // 7. Low X-Factor (Target: ~40°, Fault threshold: < 25°)
  if (metrics.x_factor_deg < 25) {
    const severity = (32 - metrics.x_factor_deg) / 12;
    evaluations.push({
      fault: 'low_x_factor',
      label: FAULT_LABELS.low_x_factor,
      severity: round1(severity * 10) / 10,
      measuredText: `${metrics.x_factor_deg.toFixed(0)}°`,
      targetText: '35–45°',
    });
  }

  // 8. Insufficient Weight Shift (Target: >= 3 cm toward target, Fault threshold: < 1.5 cm)
  const weightShiftCm = metrics.weight_shift_cm ?? 3.5;
  if (weightShiftCm < 1.5) {
    const severity = (2.5 - weightShiftCm) / 2.0;
    evaluations.push({
      fault: 'no_weight_shift',
      label: FAULT_LABELS.no_weight_shift,
      severity: round1(severity * 10) / 10,
      measuredText: `${weightShiftCm.toFixed(1)} cm`,
      targetText: '≥ 3.0 cm',
    });
  }

  evaluations.sort((a, b) => b.severity - a.severity);
  return evaluations;
}

/**
 * Returns the ranked array of `SwingFault` identifiers ordered by severity (highest first).
 */
export function rankSwingFaults(metrics: SwingMetrics): SwingFault[] {
  return evaluateSwingFaultDetails(metrics).map((item) => item.fault);
}

/**
 * Determines which faults from the previous swing have been resolved in the current swing.
 */
export function computeImprovedFaults(
  previousFaults: SwingFault[],
  currentFaults: SwingFault[],
  previousFocus?: SwingFault | null
): SwingFault[] {
  const currentSet = new Set(currentFaults);
  const improved: SwingFault[] = [];

  if (previousFocus && !currentSet.has(previousFocus)) {
    improved.push(previousFocus);
  }
  for (const fault of previousFaults) {
    if (!currentSet.has(fault) && !improved.includes(fault)) {
      improved.push(fault);
    }
  }
  return improved;
}

/**
 * Computes a deterministic 0–100 biomechanical quality score directly from `SwingMetrics`.
 * Used when no saved reference swing is loaded or blended with reference alignment score.
 */
export function estimateMatchScoreFromMetrics(metrics: SwingMetrics): number {
  const evaluations = evaluateSwingFaultDetails(metrics);
  let penalty = 0;
  for (const ev of evaluations) {
    penalty += clamp(ev.severity * 11, 4, 22);
  }
  // Small additional penalty for minor deviations inside fault thresholds
  const tempoDiff = Math.abs(metrics.tempo_ratio - 3.0);
  penalty += clamp(tempoDiff * 3, 0, 6);

  return Math.round(clamp(96 - penalty, 35, 99));
}

/**
 * Formats all 9 biomechanical metrics into structured display items with status badges
 * (`good` | `warn` | `bad`) for rendering in the UI sidebar.
 */
export function formatMetricsForDisplay(metrics: SwingMetrics): MetricDisplayItem[] {
  const tempoStatus: MetricStatus =
    metrics.tempo_ratio >= 2.5 && metrics.tempo_ratio <= 3.5
      ? 'good'
      : metrics.tempo_ratio >= 2.3 && metrics.tempo_ratio <= 3.8
        ? 'warn'
        : 'bad';

  const leadArmStatus: MetricStatus =
    metrics.lead_arm_deg >= 162 ? 'good' : metrics.lead_arm_deg >= 155 ? 'warn' : 'bad';

  const shoulderStatus: MetricStatus =
    metrics.shoulder_turn_deg >= 75
      ? 'good'
      : metrics.shoulder_turn_deg >= 65
        ? 'warn'
        : 'bad';

  const hipTurnDeg =
    metrics.hip_turn_deg ?? Math.max(10, metrics.shoulder_turn_deg - metrics.x_factor_deg);
  const weightShiftCm = metrics.weight_shift_cm ?? 3.5;

  const hipTurnStatus: MetricStatus =
    hipTurnDeg >= 35 && hipTurnDeg <= 55
      ? 'good'
      : hipTurnDeg >= 25 && hipTurnDeg <= 62
        ? 'warn'
        : 'bad';

  const xFactorStatus: MetricStatus =
    metrics.x_factor_deg >= 32 ? 'good' : metrics.x_factor_deg >= 25 ? 'warn' : 'bad';

  const spineStatus: MetricStatus =
    metrics.spine_angle_change_deg <= 4.0
      ? 'good'
      : metrics.spine_angle_change_deg <= 5.5
        ? 'warn'
        : 'bad';

  const headStatus: MetricStatus =
    metrics.head_movement_cm <= 4.5
      ? 'good'
      : metrics.head_movement_cm <= 5.5
        ? 'warn'
        : 'bad';

  const swayStatus: MetricStatus =
    metrics.hip_sway_cm <= 4.0 ? 'good' : metrics.hip_sway_cm <= 5.0 ? 'warn' : 'bad';

  const shiftStatus: MetricStatus =
    weightShiftCm >= 3.0
      ? 'good'
      : weightShiftCm >= 1.5
        ? 'warn'
        : 'bad';

  return [
    {
      key: 'tempo_ratio',
      label: 'Tempo Ratio',
      formattedValue: `${metrics.tempo_ratio.toFixed(1)} : 1`,
      targetLabel: 'Target ~3.0:1',
      status: tempoStatus,
    },
    {
      key: 'lead_arm_deg',
      label: 'Lead Arm (Top)',
      formattedValue: `${metrics.lead_arm_deg.toFixed(0)}°`,
      targetLabel: 'Target >160°',
      status: leadArmStatus,
    },
    {
      key: 'shoulder_turn_deg',
      label: 'Shoulder Turn',
      formattedValue: `${metrics.shoulder_turn_deg.toFixed(0)}°`,
      targetLabel: 'Target 80–90°',
      status: shoulderStatus,
    },
    {
      key: 'hip_turn_deg',
      label: 'Hip Turn',
      formattedValue: `${hipTurnDeg.toFixed(0)}°`,
      targetLabel: 'Target 40–50°',
      status: hipTurnStatus,
    },
    {
      key: 'x_factor_deg',
      label: 'X-Factor',
      formattedValue: `${metrics.x_factor_deg.toFixed(0)}°`,
      targetLabel: 'Target ~40°',
      status: xFactorStatus,
    },
    {
      key: 'spine_angle_change_deg',
      label: 'Spine Δ (Impact)',
      formattedValue: `${metrics.spine_angle_change_deg.toFixed(1)}°`,
      targetLabel: 'Target <5.0°',
      status: spineStatus,
    },
    {
      key: 'head_movement_cm',
      label: 'Head Movement',
      formattedValue: `${metrics.head_movement_cm.toFixed(1)} cm`,
      targetLabel: 'Target <5.0 cm',
      status: headStatus,
    },
    {
      key: 'hip_sway_cm',
      label: 'Hip Sway',
      formattedValue: `${metrics.hip_sway_cm.toFixed(1)} cm`,
      targetLabel: 'Target <5.0 cm',
      status: swayStatus,
    },
    {
      key: 'weight_shift_cm',
      label: 'Weight Shift',
      formattedValue: `${weightShiftCm.toFixed(1)} cm`,
      targetLabel: 'Target ≥3.0 cm',
      status: shiftStatus,
    },
  ];
}
