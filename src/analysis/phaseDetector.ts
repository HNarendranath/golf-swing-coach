import {
  Handedness,
  Landmark,
  POSE_LANDMARKS,
  SwingFrame,
  SwingPhases,
} from '../types';

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Returns the 2D midpoint of left and right wrists ("hands").
 */
export function getHandMidpoint2D(landmarks: Landmark[]): Point2D {
  const lw = landmarks[POSE_LANDMARKS.LEFT_WRIST];
  const rw = landmarks[POSE_LANDMARKS.RIGHT_WRIST];
  return {
    x: (lw.x + rw.x) * 0.5,
    y: (lw.y + rw.y) * 0.5,
  };
}

/**
 * Returns the 2D midpoint of left and right hips.
 */
export function getHipMidpoint2D(landmarks: Landmark[]): Point2D {
  const lh = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rh = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  return {
    x: (lh.x + rh.x) * 0.5,
    y: (lh.y + rh.y) * 0.5,
  };
}

/**
 * Returns the 2D midpoint of left and right shoulders.
 */
export function getShoulderMidpoint2D(landmarks: Landmark[]): Point2D {
  const ls = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rs = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
  return {
    x: (ls.x + rs.x) * 0.5,
    y: (ls.y + rs.y) * 0.5,
  };
}

/**
 * Returns the 2D torso length (shoulder midpoint <-> hip midpoint) in normalized image units.
 * Guarded with a minimum floor (0.08) to prevent division by zero.
 */
export function getTorsoLength2D(landmarks: Landmark[]): number {
  const s = getShoulderMidpoint2D(landmarks);
  const h = getHipMidpoint2D(landmarks);
  return Math.max(Math.hypot(s.x - h.x, s.y - h.y), 0.08);
}

/**
 * Computes torso-normalized 2D hand speeds (in torso-lengths per second) for each frame,
 * lightly smoothed with a 3-frame moving window.
 */
export function computeFrameHandSpeeds(frames: SwingFrame[]): number[] {
  const n = frames.length;
  if (n === 0) return [];
  const rawSpeeds = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const prev = getHandMidpoint2D(frames[i - 1].landmarks);
    const curr = getHandMidpoint2D(frames[i].landmarks);
    const torso = getTorsoLength2D(frames[i].landmarks);
    const dtSec = Math.max((frames[i].t - frames[i - 1].t) / 1000, 1 / 120);
    const distNorm = Math.hypot(curr.x - prev.x, curr.y - prev.y) / torso;
    rawSpeeds[i] = distNorm / dtSec;
  }
  if (n > 1) {
    rawSpeeds[0] = rawSpeeds[1];
  }

  // 3-point moving average to suppress single-frame velocity spikes
  return rawSpeeds.map((v, i) => {
    const prev = rawSpeeds[Math.max(0, i - 1)];
    const next = rawSpeeds[Math.min(n - 1, i + 1)];
    return (prev + v + next) / 3;
  });
}

/**
 * Detects the 5 canonical golf swing phases from a sequence of SwingFrames:
 *  - address:  first still frame before takeaway
 *  - takeaway: hands start moving away from address
 *  - top:      hands at max height (minimum y) before reversing into the downswing
 *  - impact:   hands return near address height with peak speed
 *  - finish:   hands high on the lead side and settling into stillness
 */
export function detectSwingPhases(
  frames: SwingFrame[],
  handedness: Handedness = 'right'
): SwingPhases {
  const n = frames.length;
  if (n < 5) {
    const t0 = frames[0]?.t ?? 0;
    const tLast = frames[n - 1]?.t ?? t0;
    return {
      address: 0,
      takeaway: 0,
      top: Math.min(1, Math.max(0, n - 1)),
      impact: Math.min(2, Math.max(0, n - 1)),
      finish: Math.max(0, n - 1),
      timestamps: {
        address: t0,
        takeaway: t0,
        top: t0,
        impact: tLast,
        finish: tLast,
      },
    };
  }

  const hands = frames.map((f) => getHandMidpoint2D(f.landmarks));
  const shoulders = frames.map((f) => getShoulderMidpoint2D(f.landmarks));
  const speeds = computeFrameHandSpeeds(frames);

  // Estimate initial address hand position from the first few frames
  const initialCount = Math.min(8, Math.max(2, Math.floor(n * 0.15)));
  let addrHandX = 0;
  let addrHandY = 0;
  for (let i = 0; i < initialCount; i++) {
    addrHandX += hands[i].x;
    addrHandY += hands[i].y;
  }
  addrHandX /= initialCount;
  addrHandY /= initialCount;
  const addrTorso = getTorsoLength2D(frames[0].landmarks);

  // 1. Locate overall peak hand speed (typically occurs during the downswing right around impact)
  const searchPeakStart = Math.max(2, Math.floor(n * 0.15));
  const searchPeakEnd = Math.max(searchPeakStart + 1, Math.floor(n * 0.9));
  let peakSpeedIdx = searchPeakStart;
  let maxSpeed = -1;
  for (let i = searchPeakStart; i <= searchPeakEnd && i < n; i++) {
    if (speeds[i] > maxSpeed) {
      maxSpeed = speeds[i];
      peakSpeedIdx = i;
    }
  }

  // 2. Locate TOP of backswing:
  // Hands reach maximum height (minimum y) prior to the downswing speed peak (or within 10%..75% of swing).
  // Note: In a golf swing, the follow-through also brings hands high, so searching prior to or around
  // the main downswing peak prevents picking the follow-through apex as the Top.
  const topSearchStart = Math.max(1, Math.floor(n * 0.08));
  const topSearchEnd = Math.max(
    topSearchStart + 1,
    Math.min(Math.floor(n * 0.78), Math.max(peakSpeedIdx, Math.floor(n * 0.45)))
  );

  let topIdx = topSearchStart;
  let minHandY = Infinity;
  for (let i = topSearchStart; i <= topSearchEnd; i++) {
    if (hands[i].y < minHandY) {
      minHandY = hands[i].y;
      topIdx = i;
    }
  }

  // Refine Top: near the apex (within 0.05 torso length of minHandY), pick the local speed minimum
  // (the transition pause where backswing reverses into downswing)
  const apexTolerance = 0.06 * addrTorso;
  let bestTransitionIdx = topIdx;
  let minTransitionSpeed = speeds[topIdx];
  const windowRadius = Math.max(2, Math.floor(n * 0.06));
  for (
    let i = Math.max(topSearchStart, topIdx - windowRadius);
    i <= Math.min(topSearchEnd, topIdx + windowRadius);
    i++
  ) {
    if (hands[i].y <= minHandY + apexTolerance && speeds[i] < minTransitionSpeed) {
      minTransitionSpeed = speeds[i];
      bestTransitionIdx = i;
    }
  }
  topIdx = bestTransitionIdx;

  // 3. Locate TAKEAWAY:
  // Walk backward from Top to find when the hands started moving away from address
  const takeawaySpeedThresh = Math.max(0.45, maxSpeed * 0.14);
  const takeawayDistThresh = 0.12 * addrTorso;
  let takeawayIdx = Math.max(1, Math.floor(topIdx * 0.25));

  for (let i = topIdx - 1; i >= 1; i--) {
    const distFromAddr = Math.hypot(hands[i].x - addrHandX, hands[i].y - addrHandY);
    if (speeds[i] < takeawaySpeedThresh && distFromAddr < takeawayDistThresh) {
      takeawayIdx = i;
      break;
    }
  }

  // 4. Locate ADDRESS:
  // First still frame before takeaway (or frame 0)
  let addressIdx = 0;
  let minAddrSpeed = Infinity;
  const addrSearchEnd = Math.max(0, takeawayIdx - 1);
  for (let i = 0; i <= addrSearchEnd; i++) {
    if (speeds[i] < minAddrSpeed) {
      minAddrSpeed = speeds[i];
      addressIdx = i;
    }
  }

  // Re-anchor address hand height at detected addressIdx
  const addressHandY = hands[addressIdx].y;
  const addressHandX = hands[addressIdx].x;

  // 5. Locate IMPACT:
  // After Top, hands return near address height with peak speed.
  // Downswing typically takes ~150ms–450ms (or within the next 45% of remaining frames).
  const impactSearchStart = Math.min(n - 2, topIdx + 1);
  const impactSearchEnd = Math.min(
    n - 2,
    Math.max(impactSearchStart + 1, topIdx + Math.max(4, Math.floor((n - topIdx) * 0.65)))
  );

  let impactIdx = impactSearchStart;
  let bestImpactScore = -Infinity;

  // Find max speed after top for normalization
  let maxDownswingSpeed = 0.01;
  for (let i = impactSearchStart; i <= impactSearchEnd; i++) {
    if (speeds[i] > maxDownswingSpeed) {
      maxDownswingSpeed = speeds[i];
    }
  }

  for (let i = impactSearchStart; i <= impactSearchEnd; i++) {
    const normSpeed = speeds[i] / maxDownswingSpeed; // 0..1 (higher is faster)
    const yDiffNorm = Math.abs(hands[i].y - addressHandY) / addrTorso;
    const xDiffNorm = Math.abs(hands[i].x - addressHandX) / addrTorso;
    // Score combines high speed through the ball + proximity to address hand position
    const posCloseness = Math.exp(-2.5 * (yDiffNorm * yDiffNorm + 0.5 * xDiffNorm * xDiffNorm));
    const score = 0.55 * normSpeed + 0.45 * posCloseness;
    if (score > bestImpactScore) {
      bestImpactScore = score;
      impactIdx = i;
    }
  }

  // 6. Locate FINISH:
  // After impact, hands rise high on the lead side (above/near shoulders) and settle into stillness
  const finishSearchStart = Math.min(n - 1, impactIdx + 1);
  let finishIdx = n - 1;
  let bestFinishScore = -Infinity;

  // Lead side direction in raw image coordinates (right-handed golfer facing camera: lead side is golfer's left = image right (+x))
  const leadSign = handedness === 'right' ? 1 : -1;

  for (let i = finishSearchStart; i < n; i++) {
    const heightAboveShoulders = (shoulders[i].y - hands[i].y) / addrTorso; // positive when hands above shoulders
    const leadOffset = ((hands[i].x - shoulders[i].x) * leadSign) / addrTorso;
    const stillnessBonus = 1 / (1 + speeds[i]);
    const score = heightAboveShoulders * 1.2 + leadOffset * 0.4 + stillnessBonus * 0.8;
    if (score > bestFinishScore) {
      bestFinishScore = score;
      finishIdx = i;
    }
  }

  // Enforce strict monotonic phase ordering: address <= takeaway < top < impact <= finish
  addressIdx = Math.max(0, Math.min(addressIdx, n - 5));
  takeawayIdx = Math.max(addressIdx, Math.min(takeawayIdx, n - 4));
  topIdx = Math.max(takeawayIdx + 1, Math.min(topIdx, n - 3));
  impactIdx = Math.max(topIdx + 1, Math.min(impactIdx, n - 2));
  finishIdx = Math.max(impactIdx, Math.min(finishIdx, n - 1));

  return {
    address: addressIdx,
    takeaway: takeawayIdx,
    top: topIdx,
    impact: impactIdx,
    finish: finishIdx,
    timestamps: {
      address: Math.round(frames[addressIdx].t),
      takeaway: Math.round(frames[takeawayIdx].t),
      top: Math.round(frames[topIdx].t),
      impact: Math.round(frames[impactIdx].t),
      finish: Math.round(frames[finishIdx].t),
    },
  };
}

/**
 * Helper to compute Backswing time (ms), Downswing time (ms), and Tempo Ratio from detected phases.
 * Tempo = (top - takeaway) / (impact - top), target ~3.0 : 1.
 */
export function computePhaseTempo(phases: SwingPhases): {
  backswingMs: number;
  downswingMs: number;
  tempoRatio: number;
} {
  const backswingMs = Math.max(1, phases.timestamps.top - phases.timestamps.takeaway);
  const downswingMs = Math.max(1, phases.timestamps.impact - phases.timestamps.top);
  const tempoRatio = Number((backswingMs / downswingMs).toFixed(2));
  return {
    backswingMs,
    downswingMs,
    tempoRatio,
  };
}
