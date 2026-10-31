import {
  POSE_LANDMARKS,
  type Handedness,
  type Landmark,
  type SwingFrame,
} from '../types';
import type { DtlPostureMetrics } from '../capture/poseTracker';

export type SetupPerspective = 'face-on' | 'dtl';

export type SetupIssue =
  | 'narrow_stance'
  | 'wide_stance'
  | 'hands_high'
  | 'hands_low'
  | 'hands_off_center'
  | 'head_off_center'
  | 'reverse_shoulder_tilt'
  | 'flat_shoulders'
  | 'upright_spine'
  | 'hunched_spine'
  | 'locked_knees'
  | 'excess_knee_flex';

export interface SetupEvaluation {
  /** Whether the golfer's initial posture was already very close to tour target */
  looksGood: boolean;
  /** Single highest-priority setup adjustment for this shot (always 1 per shot) */
  issue: SetupIssue;
  /** Short HUD headline for the top bar / overlay */
  headline: string;
  /** Spoken setup correction cue (strictly ONE piece of advice per shot, forgiving & tells when to swing) */
  spoken: string;
  /** Short spoken confirmation once the golfer makes a small adjustment or settles in */
  confirmSpoken: string;
  /** Initial measured value for live progress tracking at address */
  initialMetricValue: number;
  /** Ideal tour target value for live progress tracking at address */
  targetMetricValue: number;
}

interface SetupCandidate {
  issue: SetupIssue;
  severity: number;
  headline: string;
  spoken: string;
  initialMetricValue: number;
  targetMetricValue: number;
}

function midpoint2D(a: Landmark, b: Landmark): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

const CONFIRM_PHRASES = [
  'Setup looks good, swing whenever you are ready.',
  'Posture looks good there, go ahead and swing when ready.',
  'That setup looks solid, pull the trigger whenever you are ready.',
];

/**
 * Evaluates the golfer's address posture and returns strictly ONE piece of setup
 * correction advice for EVERY shot, comparing against tour setup targets so every shot
 * gets a helpful, forgiving setup refinement cue plus clear direction on when to swing.
 */
export function evaluateSetupPosture(
  frame: SwingFrame,
  handedness: Handedness,
  perspective: SetupPerspective = 'face-on',
  dtlMetrics: DtlPostureMetrics | null = null,
  shotNumber = 1,
  lastIssue: SetupIssue | null = null
): SetupEvaluation {
  const lm = frame.landmarks;
  const leadShoulderIdx =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_SHOULDER : POSE_LANDMARKS.RIGHT_SHOULDER;
  const trailShoulderIdx =
    handedness === 'right' ? POSE_LANDMARKS.RIGHT_SHOULDER : POSE_LANDMARKS.LEFT_SHOULDER;

  const lShoulder = lm[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = lm[POSE_LANDMARKS.RIGHT_SHOULDER];
  const lHip = lm[POSE_LANDMARKS.LEFT_HIP];
  const rHip = lm[POSE_LANDMARKS.RIGHT_HIP];
  const lAnkle = lm[POSE_LANDMARKS.LEFT_ANKLE];
  const rAnkle = lm[POSE_LANDMARKS.RIGHT_ANKLE];
  const lWrist = lm[POSE_LANDMARKS.LEFT_WRIST];
  const rWrist = lm[POSE_LANDMARKS.RIGHT_WRIST];
  const nose = lm[POSE_LANDMARKS.NOSE];

  const shoulderMid = midpoint2D(lShoulder, rShoulder);
  const hipMid = midpoint2D(lHip, rHip);
  const handsMid = midpoint2D(lWrist, rWrist);

  const shoulderWidth = Math.max(distance2D(lShoulder, rShoulder), 0.06);
  const torsoLen = Math.max(distance2D(shoulderMid, hipMid), 0.12);
  const stanceWidth = distance2D(lAnkle, rAnkle);

  const candidates: SetupCandidate[] = [];

  if (perspective === 'dtl' && dtlMetrics) {
    // 1. DTL Spine Tilt (ideal tour target ~36°)
    const targetSpine = 36;
    const spineDiff = dtlMetrics.spineTiltDeg - targetSpine;
    if (spineDiff < 0) {
      candidates.push({
        issue: 'upright_spine',
        severity: Math.abs(spineDiff) / 8,
        headline: 'Setup Tip: Hinge slightly more from your hips',
        spoken:
          'For this shot, bow slightly more from your hips so your chest tilts over the ball, then swing when you are ready.',
        initialMetricValue: dtlMetrics.spineTiltDeg,
        targetMetricValue: targetSpine,
      });
    } else {
      candidates.push({
        issue: 'hunched_spine',
        severity: Math.abs(spineDiff) / 10,
        headline: 'Setup Tip: Stand a touch taller with your chest',
        spoken:
          'For this shot, lift your sternum a touch so your back stays athletic, then swing whenever you are ready.',
        initialMetricValue: dtlMetrics.spineTiltDeg,
        targetMetricValue: targetSpine,
      });
    }

    // 2. DTL Knee Flex (ideal tour target ~22°)
    const targetKnee = 22;
    const kneeDiff = dtlMetrics.kneeFlexDeg - targetKnee;
    if (kneeDiff < 0) {
      candidates.push({
        issue: 'locked_knees',
        severity: Math.abs(kneeDiff) / 8,
        headline: 'Setup Tip: Soften your knees slightly',
        spoken:
          'Add a touch of athletic knee flex like you are sitting on the edge of a tall stool, then swing when ready.',
        initialMetricValue: dtlMetrics.kneeFlexDeg,
        targetMetricValue: targetKnee,
      });
    } else {
      candidates.push({
        issue: 'excess_knee_flex',
        severity: Math.abs(kneeDiff) / 10,
        headline: 'Setup Tip: Stand slightly taller in the knees',
        spoken:
          'Take out a little knee bend so your legs feel athletic rather than squatting, then swing when ready.',
        initialMetricValue: dtlMetrics.kneeFlexDeg,
        targetMetricValue: targetKnee,
      });
    }
  }

  // Face-On & Universal Setup Checks (evaluated against ideal tour targets so EVERY shot has a ranked #1 tip)
  // 1. Stance width relative to shoulder width (ideal ~1.18x shoulders)
  const anklesVisible =
    (lAnkle.visibility ?? 1) >= 0.35 && (rAnkle.visibility ?? 1) >= 0.35;
  const stanceRatio = anklesVisible ? stanceWidth / shoulderWidth : 1.18;
  const targetStanceRatio = 1.18;

  if (anklesVisible) {
    if (stanceRatio < targetStanceRatio) {
      candidates.push({
        issue: 'narrow_stance',
        severity: (targetStanceRatio - stanceRatio) / 0.22,
        headline: 'Setup Tip: Widen stance a touch for stability',
        spoken:
          'Try widening your feet a touch toward shoulder width for a solid base, then swing whenever you are ready.',
        initialMetricValue: stanceRatio,
        targetMetricValue: targetStanceRatio,
      });
    } else {
      candidates.push({
        issue: 'wide_stance',
        severity: (stanceRatio - targetStanceRatio) / 0.30,
        headline: 'Setup Tip: Narrow stance slightly for hip turn',
        spoken:
          'Bring your feet in just a touch so your hips can rotate freely, then swing when you are ready.',
        initialMetricValue: stanceRatio,
        targetMetricValue: targetStanceRatio,
      });
    }
  }

  // 2. Hand height / arm hang below hips (ideal: hands hang ~0.13 * torsoLen below hip line)
  const handDropNormalized = (handsMid.y - hipMid.y) / torsoLen;
  const targetHandDrop = 0.13;
  if (handDropNormalized < targetHandDrop) {
    candidates.push({
      issue: 'hands_high',
      severity: (targetHandDrop - handDropNormalized) / 0.08,
      headline: 'Setup Tip: Let your arms hang softly below your hips',
      spoken:
        'Let your arms and hands hang a little lower and softer under your chin, then swing when you are ready.',
      initialMetricValue: handDropNormalized,
      targetMetricValue: targetHandDrop,
    });
  } else {
    candidates.push({
      issue: 'hands_low',
      severity: (handDropNormalized - targetHandDrop) / 0.15,
      headline: 'Setup Tip: Stand a touch taller with your hands',
      spoken:
        'Bring your posture up just a touch so your hands are not reaching too low, then swing when ready.',
      initialMetricValue: handDropNormalized,
      targetMetricValue: targetHandDrop,
    });
  }

  // 3. Hand centering relative to pelvis/sternum (ideal: centered or slightly toward lead thigh)
  const leadShoulder = lm[leadShoulderIdx];
  const trailShoulder = lm[trailShoulderIdx];
  const leadDirX = leadShoulder.x >= trailShoulder.x ? 1 : -1;
  // Signed offset toward lead side in torso units (ideal is +0.04 toward lead thigh)
  const signedHandLeadOffset = ((handsMid.x - hipMid.x) * leadDirX) / torsoLen;
  const targetHandLeadOffset = 0.04;
  const handOffsetDiff = Math.abs(signedHandLeadOffset - targetHandLeadOffset);

  candidates.push({
    issue: 'hands_off_center',
    severity: handOffsetDiff / 0.12,
    headline:
      signedHandLeadOffset < targetHandLeadOffset
        ? 'Setup Tip: Press hands slightly toward your lead thigh'
        : 'Setup Tip: Center your hands under your sternum',
    spoken:
      signedHandLeadOffset < targetHandLeadOffset
        ? 'Set your hands just a fraction forward toward your lead thigh at address, then swing when ready.'
        : 'Center your hands a touch closer to your midline at address, then swing whenever you are ready.',
    initialMetricValue: signedHandLeadOffset,
    targetMetricValue: targetHandLeadOffset,
  });

  // 4. Shoulder tilt at address (trail shoulder should sit ~0.05 * torsoLen lower than lead shoulder)
  const trailShoulderDrop = (trailShoulder.y - leadShoulder.y) / torsoLen;
  const targetShoulderDrop = 0.05;
  if (trailShoulderDrop < targetShoulderDrop) {
    candidates.push({
      issue: trailShoulderDrop < -0.02 ? 'reverse_shoulder_tilt' : 'flat_shoulders',
      severity: (targetShoulderDrop - trailShoulderDrop) / 0.06,
      headline: 'Setup Tip: Soften your trail shoulder slightly lower',
      spoken:
        'Let your trail shoulder sit just a touch lower than your lead shoulder behind the ball, then swing when ready.',
      initialMetricValue: trailShoulderDrop,
      targetMetricValue: targetShoulderDrop,
    });
  }

  // 5. Head centering over pelvis
  const headLateralOffset = Math.abs(nose.x - hipMid.x) / torsoLen;
  candidates.push({
    issue: 'head_off_center',
    severity: headLateralOffset / 0.14,
    headline: 'Setup Tip: Balance your head tall over your belt buckle',
    spoken:
      'Keep your head balanced right over the center of your stance, then go ahead and swing when ready.',
    initialMetricValue: headLateralOffset,
    targetMetricValue: 0.0,
  });

  // Sort by highest priority (largest normalized deviation from ideal target)
  candidates.sort((a, b) => b.severity - a.severity);

  // If the top candidate is identical to the previous shot's issue and the second candidate is close in priority,
  // rotate to the second candidate so back-to-back shots get fresh, tailored setup advice.
  let top = candidates[0];
  if (
    candidates.length > 1 &&
    lastIssue &&
    top.issue === lastIssue &&
    candidates[1].severity >= top.severity * 0.65
  ) {
    top = candidates[1];
  }

  const confirmSpoken = CONFIRM_PHRASES[shotNumber % CONFIRM_PHRASES.length];

  return {
    looksGood: top.severity < 0.85,
    issue: top.issue,
    headline: top.headline,
    spoken: top.spoken,
    confirmSpoken,
    initialMetricValue: top.initialMetricValue,
    targetMetricValue: top.targetMetricValue,
  };
}

/**
 * Checks live at address whether the golfer has made a forgiving (~20%+) adjustment
 * toward the advised setup target (without getting too picky if it's not 100% corrected).
 */
export function checkSetupCorrectionProgress(
  frame: SwingFrame,
  initialEval: SetupEvaluation,
  handedness: Handedness,
  dtlMetrics: DtlPostureMetrics | null = null
): boolean {
  const lm = frame.landmarks;
  const leadShoulderIdx =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_SHOULDER : POSE_LANDMARKS.RIGHT_SHOULDER;
  const trailShoulderIdx =
    handedness === 'right' ? POSE_LANDMARKS.RIGHT_SHOULDER : POSE_LANDMARKS.LEFT_SHOULDER;

  const lShoulder = lm[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = lm[POSE_LANDMARKS.RIGHT_SHOULDER];
  const lHip = lm[POSE_LANDMARKS.LEFT_HIP];
  const rHip = lm[POSE_LANDMARKS.RIGHT_HIP];
  const lAnkle = lm[POSE_LANDMARKS.LEFT_ANKLE];
  const rAnkle = lm[POSE_LANDMARKS.RIGHT_ANKLE];
  const lWrist = lm[POSE_LANDMARKS.LEFT_WRIST];
  const rWrist = lm[POSE_LANDMARKS.RIGHT_WRIST];
  const nose = lm[POSE_LANDMARKS.NOSE];

  const shoulderMid = midpoint2D(lShoulder, rShoulder);
  const hipMid = midpoint2D(lHip, rHip);
  const handsMid = midpoint2D(lWrist, rWrist);

  const shoulderWidth = Math.max(distance2D(lShoulder, rShoulder), 0.06);
  const torsoLen = Math.max(distance2D(shoulderMid, hipMid), 0.12);
  const stanceWidth = distance2D(lAnkle, rAnkle);

  const leadShoulder = lm[leadShoulderIdx];
  const trailShoulder = lm[trailShoulderIdx];
  const leadDirX = leadShoulder.x >= trailShoulder.x ? 1 : -1;

  let currentVal = initialEval.initialMetricValue;

  switch (initialEval.issue) {
    case 'narrow_stance':
    case 'wide_stance':
      currentVal = stanceWidth / shoulderWidth;
      break;
    case 'hands_high':
    case 'hands_low':
      currentVal = (handsMid.y - hipMid.y) / torsoLen;
      break;
    case 'hands_off_center':
      currentVal = ((handsMid.x - hipMid.x) * leadDirX) / torsoLen;
      break;
    case 'reverse_shoulder_tilt':
    case 'flat_shoulders':
      currentVal = (trailShoulder.y - leadShoulder.y) / torsoLen;
      break;
    case 'head_off_center':
      currentVal = Math.abs(nose.x - hipMid.x) / torsoLen;
      break;
    case 'upright_spine':
    case 'hunched_spine':
      if (dtlMetrics) currentVal = dtlMetrics.spineTiltDeg;
      break;
    case 'locked_knees':
    case 'excess_knee_flex':
      if (dtlMetrics) currentVal = dtlMetrics.kneeFlexDeg;
      break;
  }

  const initialErr = Math.abs(initialEval.targetMetricValue - initialEval.initialMetricValue);
  const currentErr = Math.abs(initialEval.targetMetricValue - currentVal);

  // Forgiving check: if already close or moved at least 20% closer to the target, mark as good!
  if (initialErr < 0.02) return true;
  return currentErr <= initialErr * 0.80;
}
