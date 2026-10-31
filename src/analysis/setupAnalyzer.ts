/**
 * Pre-Swing Address / Setup Posture Analyzer.
 *
 * Evaluates the golfer's setup posture when they settle into address (`ADDRESS_HOLD -> RECORDING`).
 * Design Principles:
 * 1. Only ONE piece of setup advice per shot (picks the single highest-priority adjustment,
 *    never overwhelms the player with multiple setup critiques).
 * 2. Forgiving tolerances ("don't get too picky"): minor natural stance variations are
 *    accepted as a good setup, and partial adjustments (or simply choosing to swing as-is)
 *    are never blocked.
 * 3. Always tells the player when to swing ("Setup looks good — swing when you're ready"
 *    or "<One concise setup tip> — then swing when you're ready").
 */

import { DtlPostureMetrics } from '../capture/poseTracker';
import { Handedness, POSE_LANDMARKS, SwingFrame } from '../types';
import {
  getHandMidpoint2D,
  getHipMidpoint2D,
  getTorsoLength2D,
} from './phaseDetector';

export type SetupIssueId =
  | 'none'
  | 'narrow_stance'
  | 'wide_stance'
  | 'upright_spine'
  | 'excessive_spine_tilt'
  | 'straight_knees'
  | 'excessive_knee_flex'
  | 'hands_off_center'
  | 'hands_too_high'
  | 'uneven_shoulders';

export interface SetupEvaluation {
  isGood: boolean;
  issue: SetupIssueId;
  headline: string;
  spokenAdvice: string;
  metricDetail: string;
}

interface SetupCandidate {
  issue: SetupIssueId;
  severity: number;
  headline: string;
  spokenAdvice: string;
  metricDetail: string;
}

/**
 * Evaluates the golfer's address posture and returns at most ONE piece of setup advice,
 * always including a clear cue to swing when ready.
 */
export function evaluateSetupPosture(
  frame: SwingFrame,
  handedness: Handedness = 'right',
  perspective: 'face-on' | 'dtl' = 'face-on',
  dtlMetrics?: DtlPostureMetrics | null
): SetupEvaluation {
  const candidates: SetupCandidate[] = [];
  const lm = frame.landmarks;
  const torso = Math.max(getTorsoLength2D(lm), 0.08);
  const hands = getHandMidpoint2D(lm);
  const hips = getHipMidpoint2D(lm);

  const lShoulder = lm[POSE_LANDMARKS.LEFT_SHOULDER];
  const rShoulder = lm[POSE_LANDMARKS.RIGHT_SHOULDER];
  const lAnkle = lm[POSE_LANDMARKS.LEFT_ANKLE];
  const rAnkle = lm[POSE_LANDMARKS.RIGHT_ANKLE];

  // ── 1. Face-On Setup Checks (Stance Width, Hand Centering, Shoulder Level) ──
  if (perspective === 'face-on') {
    const shoulderWidth = Math.abs(rShoulder.x - lShoulder.x);
    const anklesVisible =
      (lAnkle?.visibility ?? 0) >= 0.45 && (rAnkle?.visibility ?? 0) >= 0.45;

    if (anklesVisible && shoulderWidth > 0.06) {
      const ankleWidth = Math.abs(rAnkle.x - lAnkle.x);
      const stanceRatio = ankleWidth / shoulderWidth;

      // Forgiving stance width range: 0.75x to 1.70x shoulder width
      if (stanceRatio < 0.75) {
        candidates.push({
          issue: 'narrow_stance',
          severity: (0.8 - stanceRatio) / 0.25,
          headline: 'Widen Stance Slightly',
          spokenAdvice:
            "Your stance looks a touch narrow — widen your feet to shoulder width, then swing when you're ready.",
          metricDetail: `Stance ${(stanceRatio * 100).toFixed(0)}% of shoulder width`,
        });
      } else if (stanceRatio > 1.7) {
        candidates.push({
          issue: 'wide_stance',
          severity: (stanceRatio - 1.65) / 0.35,
          headline: 'Narrow Stance Slightly',
          spokenAdvice:
            "Your feet are a bit wide — bring your stance in slightly, then swing when you're ready.",
          metricDetail: `Stance ${(stanceRatio * 100).toFixed(0)}% of shoulder width`,
        });
      }
    }

    // Hand centering in front of thighs/pelvis (forgiving threshold: 0.36 * torso)
    const handLateralOffset = Math.abs(hands.x - hips.x) / torso;
    if (handLateralOffset > 0.36) {
      candidates.push({
        issue: 'hands_off_center',
        severity: (handLateralOffset - 0.32) / 0.18,
        headline: 'Center Hands at Address',
        spokenAdvice:
          "Center your hands slightly more in front of your thighs, then swing when you're ready.",
        metricDetail: `Hands offset ${(handLateralOffset * 50).toFixed(0)} cm from center`,
      });
    } else if (hands.y < hips.y + 0.01 * torso) {
      // Hands held too high near waist instead of hanging naturally
      candidates.push({
        issue: 'hands_too_high',
        severity: (hips.y + 0.05 * torso - hands.y) / (0.15 * torso),
        headline: 'Let Arms Hang Naturally',
        spokenAdvice:
          "Let your arms hang down comfortably below your hips, then swing when you're ready.",
        metricDetail: 'Hands high at address',
      });
    }

    // Trail shoulder shrugged much higher than lead shoulder
    const leadShoulder = handedness === 'right' ? lShoulder : rShoulder;
    const trailShoulder = handedness === 'right' ? rShoulder : lShoulder;
    const trailHigherBy = (leadShoulder.y - trailShoulder.y) / torso; // positive when trail shoulder is higher (smaller y)
    const totalShoulderTilt = Math.abs(lShoulder.y - rShoulder.y) / torso;

    if (trailHigherBy > 0.14 || totalShoulderTilt > 0.28) {
      candidates.push({
        issue: 'uneven_shoulders',
        severity: Math.max(trailHigherBy - 0.1, totalShoulderTilt - 0.22) / 0.15,
        headline: 'Relax Trail Shoulder',
        spokenAdvice:
          "Relax your trail shoulder down slightly so your spine sets naturally, then swing when you're ready.",
        metricDetail: 'Shoulders uneven at setup',
      });
    }
  }

  // ── 2. Down-The-Line Posture Checks (Spine Tilt & Knee Flex when available) ──
  if (dtlMetrics) {
    // Forgiving spine tilt range: 20° to 54° (target ~30°–45°)
    if (dtlMetrics.spineTiltDeg < 20) {
      candidates.push({
        issue: 'upright_spine',
        severity: (24 - dtlMetrics.spineTiltDeg) / 10,
        headline: 'Hinge Forward from Hips',
        spokenAdvice:
          "You're standing a bit tall — hinge forward slightly from your hips, then swing when you're ready.",
        metricDetail: `Spine tilt ${dtlMetrics.spineTiltDeg}° (target 28–45°)`,
      });
    } else if (dtlMetrics.spineTiltDeg > 54) {
      candidates.push({
        issue: 'excessive_spine_tilt',
        severity: (dtlMetrics.spineTiltDeg - 50) / 12,
        headline: 'Stand Slightly Taller',
        spokenAdvice:
          "You're bent over a touch too much — stand slightly taller from your hips, then swing when you're ready.",
        metricDetail: `Spine tilt ${dtlMetrics.spineTiltDeg}° (target 28–45°)`,
      });
    }

    // Forgiving knee flex range: 8° to 42° (target ~15°–30°)
    if (dtlMetrics.kneeFlexDeg < 8) {
      candidates.push({
        issue: 'straight_knees',
        severity: (12 - dtlMetrics.kneeFlexDeg) / 8,
        headline: 'Soften Knee Flex',
        spokenAdvice:
          "Your legs look a little locked — add a soft athletic flex in your knees, then swing when you're ready.",
        metricDetail: `Knee flex ${dtlMetrics.kneeFlexDeg}° (target 15–30°)`,
      });
    } else if (dtlMetrics.kneeFlexDeg > 42) {
      candidates.push({
        issue: 'excessive_knee_flex',
        severity: (dtlMetrics.kneeFlexDeg - 38) / 12,
        headline: 'Ease Up Knee Squat',
        spokenAdvice:
          "Your knees are flexed a bit deep — stand just a touch taller, then swing when you're ready.",
        metricDetail: `Knee flex ${dtlMetrics.kneeFlexDeg}° (target 15–30°)`,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      isGood: true,
      issue: 'none',
      headline: 'Setup Looks Good — Swing When Ready',
      spokenAdvice: "Setup looks good — swing when you're ready!",
      metricDetail: 'Balanced athletic address posture',
    };
  }

  // Strictly pick ONLY ONE piece of advice per shot (highest severity first)
  candidates.sort((a, b) => b.severity - a.severity);
  const top = candidates[0];

  return {
    isGood: false,
    issue: top.issue,
    headline: top.headline,
    spokenAdvice: top.spokenAdvice,
    metricDetail: top.metricDetail,
  };
}

