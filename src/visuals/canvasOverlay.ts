import {
  ClubState,
  Handedness,
  Landmark,
  POSE_CONNECTIONS,
  POSE_LANDMARKS,
  SwingFault,
  SwingFrame,
  SwingMetrics,
  SwingPhases,
} from '../types';
import { getHandMidpoint2D, Point2D } from '../analysis/phaseDetector';
import { DtlPostureMetrics } from '../capture/poseTracker';

export interface SkeletonDrawOptions {
  /** Camera perspective: 'face-on' (bilateral skeleton) or 'dtl' (side-profile posture & plane chain) */
  perspective?: 'face-on' | 'dtl';
  /** Golfer handedness ('right' default or 'left') for lead-side joint identification */
  handedness?: Handedness;
  /** Mirror X coordinates (1 - x) to match a horizontally flipped <video class="mirrored"> */
  mirrored?: boolean;
  /** Whether key landmarks passed the visibility gate */
  isReliable?: boolean;
  /** Live hand trail points (normalized 0..1) */
  liveHandTrail?: Point2D[];
  /** Live clubhead trail points (normalized 0..1) when a club is detected */
  liveClubTrail?: Point2D[];
  /** Optional current frame golf club state (never required) */
  club?: ClubState | null;
  /** Side-profile posture metrics when rendering on the Down-The-Line portrait view */
  dtlMetrics?: DtlPostureMetrics;
  /** Locked address hip X on DTL view for Tush Line early-extension comparison */
  addressHipX?: number | null;
  /** Last captured swing frames for drawing user hand path (red/amber) and phase markers */
  capturedFrames?: SwingFrame[];
  /** Detected phases for the last captured swing */
  capturedPhases?: SwingPhases | null;
  /** Optional custom reference hand path (green ghost path) */
  referenceHandPath?: Point2D[];
  /** Ranked biomechanical faults from the latest swing for 2D joint color-coding (Green -> Amber -> Red) */
  activeFaults?: SwingFault[];
  /** Latest computed 9 biomechanical metrics for on-body 2D callout badges */
  latestMetrics?: SwingMetrics | null;
}

/**
 * Renders the 2D MediaPipe skeleton (or DTL side-profile posture chain), fault-colored joints,
 * body-anchored Pro Reference Ghost Hand Path (Green) vs User Hand Path (Red), live hand/club trails,
 * captured Top-of-Swing ghost pose, and on-body biomechanical metric callouts.
 */
export function drawPoseSkeletonOverlay(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[] | null,
  options: SkeletonDrawOptions = {}
): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;

  const mirrored = Boolean(options.mirrored);
  const perspective = options.perspective ?? 'face-on';
  const handedness = options.handedness ?? 'right';
  const activeFaults = options.activeFaults ?? [];
  const toScreenX = (normX: number) => (mirrored ? (1 - normX) * w : normX * w);
  const toScreenY = (normY: number) => normY * h;

  ctx.save();

  // Determine anchor torso (from captured Address frame or live landmarks) for Reference Ghost alignment
  const anchorLandmarks =
    options.capturedFrames &&
    options.capturedFrames.length > 0 &&
    options.capturedPhases
      ? options.capturedFrames[options.capturedPhases.address]?.landmarks ?? landmarks
      : landmarks;

  // 1. Reference Ghost Hand Path (Green Dashed) — uses saved reference path or body-anchored Pro Reference arc
  const refPathToDraw =
    options.referenceHandPath && options.referenceHandPath.length > 1
      ? options.referenceHandPath
      : perspective === 'face-on' && anchorLandmarks
        ? buildBodyAnchoredProReferencePath(anchorLandmarks, handedness)
        : [];

  if (refPathToDraw.length > 1) {
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.82)';
    ctx.lineWidth = 3;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    refPathToDraw.forEach((pt, idx) => {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (idx === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Label the apex of the Pro Reference Ghost Path
    let refTopPt = refPathToDraw[0];
    for (const pt of refPathToDraw) {
      if (pt.y < refTopPt.y) refTopPt = pt;
    }
    drawCalloutLabel(
      ctx,
      'PRO REF ARC',
      toScreenX(refTopPt.x) - 36,
      toScreenY(refTopPt.y) - 8,
      '#10b981'
    );
  }

  // 2. Last Captured Swing: Ghost "Top of Swing" Pose + User Hand Path (Red) + Phase Markers
  if (options.capturedFrames && options.capturedFrames.length > 1) {
    // 2a. Subtle Ghost Skeleton at TOP OF SWING so user can inspect their Top posture on 2D video
    if (perspective === 'face-on' && options.capturedPhases) {
      const topFrame = options.capturedFrames[options.capturedPhases.top];
      if (topFrame?.landmarks) {
        drawCapturedPhaseGhostSkeleton(
          ctx,
          topFrame.landmarks,
          handedness,
          activeFaults,
          toScreenX,
          toScreenY
        );
      }
    }

    // 2b. User Captured Hand Path (Red/Coral)
    const handPts = options.capturedFrames.map((f) => getHandMidpoint2D(f.landmarks));
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    handPts.forEach((pt, idx) => {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (idx === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    // 2c. Phase Badges (ADDR, TAKE, TOP, IMP, FIN)
    if (options.capturedPhases) {
      const p = options.capturedPhases;
      const phaseBadges: Array<{ label: string; idx: number; color: string }> = [
        { label: 'ADDR', idx: p.address, color: '#4a8ad6' },
        { label: 'TAKE', idx: p.takeaway, color: '#38bdf8' },
        { label: 'TOP', idx: p.top, color: '#d9a441' },
        { label: 'IMP', idx: p.impact, color: '#e5566f' },
        { label: 'FIN', idx: p.finish, color: '#44a282' },
      ];

      ctx.font = '700 10px Inter, system-ui, sans-serif';
      for (const badge of phaseBadges) {
        const pt = handPts[badge.idx];
        if (!pt) continue;
        const sx = toScreenX(pt.x);
        const sy = toScreenY(pt.y);

        ctx.fillStyle = badge.color;
        ctx.beginPath();
        ctx.arc(sx, sy, 5.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#090d16';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.fillText(badge.label, sx + 8, sy + 3);
      }
    }
  }

  // 3. Live Clubhead Trail (Magenta outer arc when club is tracked)
  if (options.liveClubTrail && options.liveClubTrail.length > 1) {
    ctx.strokeStyle = 'rgba(232, 121, 249, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    options.liveClubTrail.forEach((pt, idx) => {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (idx === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 4. Live Hand Trail during active recording / DTL swing plane tracking
  if (options.liveHandTrail && options.liveHandTrail.length > 1) {
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.92)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    options.liveHandTrail.forEach((pt, idx) => {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (idx === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  }

  if (!landmarks || landmarks.length === 0) {
    ctx.restore();
    return;
  }

  // 5. Render perspective-specific body tracking:
  //    - 'dtl': Side-profile Spine Tilt, Hip Tush-Line Depth, Knee Flex, and Arm/Hand Slot
  //    - 'face-on': Full bilateral 33-landmark skeleton with Fault Color-Coding & Metric Badges
  if (perspective === 'dtl' && options.dtlMetrics) {
    drawDtlSideProfileChain(
      ctx,
      w,
      h,
      landmarks,
      options.dtlMetrics,
      options.addressHipX,
      toScreenX,
      toScreenY
    );
  } else {
    drawFaceOnBilateralSkeleton(
      ctx,
      landmarks,
      options.isReliable !== false,
      handedness,
      activeFaults,
      options.latestMetrics ?? null,
      toScreenX,
      toScreenY
    );
  }

  // 6. Highlight Hand / Grip Midpoint
  const lw = landmarks[POSE_LANDMARKS.LEFT_WRIST];
  const rw = landmarks[POSE_LANDMARKS.RIGHT_WRIST];
  if (lw && rw && ((lw.visibility ?? 0) >= 0.35 || (rw.visibility ?? 0) >= 0.35)) {
    const handMid = getHandMidpoint2D(landmarks);
    const hx = toScreenX(handMid.x);
    const hy = toScreenY(handMid.y);

    ctx.beginPath();
    ctx.arc(hx, hy, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#090d16';
    ctx.stroke();
  }

  // 7. Optional Golf Club Shaft & Clubhead Overlay (only drawn when detected or in virtual mode)
  if (options.club && options.club.detected) {
    drawTrackedGolfClub(ctx, options.club, toScreenX, toScreenY);
  }

  // 8. 2D Path & Fault Legend Pill (bottom-right above HUD bar when paths/faults are active)
  if (perspective === 'face-on' && (refPathToDraw.length > 1 || activeFaults.length > 0)) {
    draw2DOverlayLegend(ctx, w, h, activeFaults);
  }

  ctx.restore();
}

/**
 * Computes a body-anchored Pro Reference Hand Path (normalized 0..1) scaled to the golfer's
 * live torso length and centered on their hip/shoulder axis so the green ghost arc always
 * lines up with where the golfer is standing in the frame.
 */
function buildBodyAnchoredProReferencePath(
  landmarks: Landmark[],
  handedness: Handedness
): Point2D[] {
  const ls = landmarks[POSE_LANDMARKS.LEFT_SHOULDER];
  const rs = landmarks[POSE_LANDMARKS.RIGHT_SHOULDER];
  const lh = landmarks[POSE_LANDMARKS.LEFT_HIP];
  const rh = landmarks[POSE_LANDMARKS.RIGHT_HIP];
  if (!ls || !rs || !lh || !rh) return [];

  const shMidX = (ls.x + rs.x) * 0.5;
  const shMidY = (ls.y + rs.y) * 0.5;
  const hipMidX = (lh.x + rh.x) * 0.5;
  const hipMidY = (lh.y + rh.y) * 0.5;

  const torsoLen = Math.hypot(shMidX - hipMidX, shMidY - hipMidY);
  if (torsoLen < 0.05) return [];

  // In raw MediaPipe 2D coordinates, right-handed backswing moves toward Golfer's Right (smaller X)
  const backswingDirX = handedness === 'right' ? -1 : 1;
  const radius = torsoLen * 0.88;
  const pts: Point2D[] = [];

  // 1. Address -> Top of Backswing arc (20 points)
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const angle = t * (Math.PI * 0.78); // 0 (bottom) to ~140 deg (top)
    const x = shMidX + backswingDirX * Math.sin(angle) * radius;
    const y = shMidY + Math.cos(angle) * radius * 0.95;
    pts.push({ x, y });
  }

  // 2. Downswing -> Impact -> Follow-Through Finish arc (20 points)
  const innerRadius = torsoLen * 0.82;
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    const angle = (1 - t) * (Math.PI * 0.78) - t * (Math.PI * 0.82);
    const x = shMidX + backswingDirX * Math.sin(angle) * innerRadius;
    const y = shMidY + Math.cos(angle) * innerRadius * 0.92;
    pts.push({ x, y });
  }

  return pts;
}

/**
 * Returns the fault highlight color (`#ef4444` Red for #1 fault, `#f59e0b` Amber for #2 fault, or null)
 * for a given MediaPipe joint index based on `activeFaults`.
 */
function getJointFaultColor2D(
  jointIdx: number,
  handedness: Handedness,
  activeFaults: SwingFault[]
): string | null {
  if (activeFaults.length === 0) return null;

  const leadElbow =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_ELBOW : POSE_LANDMARKS.RIGHT_ELBOW;
  const leadWrist =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_WRIST : POSE_LANDMARKS.RIGHT_WRIST;
  const leadShoulder =
    handedness === 'right' ? POSE_LANDMARKS.LEFT_SHOULDER : POSE_LANDMARKS.RIGHT_SHOULDER;

  for (let rank = 0; rank < Math.min(2, activeFaults.length); rank++) {
    const fault = activeFaults[rank];
    const color = rank === 0 ? '#ef4444' : '#f59e0b';

    if (
      (fault === 'bent_lead_arm' || fault === 'over_the_top') &&
      (jointIdx === leadElbow || jointIdx === leadWrist || jointIdx === leadShoulder)
    ) {
      return color;
    }
    if (fault === 'head_movement' && jointIdx === POSE_LANDMARKS.NOSE) {
      return color;
    }
    if (
      (fault === 'hip_sway' || fault === 'no_weight_shift') &&
      (jointIdx === POSE_LANDMARKS.LEFT_HIP || jointIdx === POSE_LANDMARKS.RIGHT_HIP)
    ) {
      return color;
    }
    if (
      (fault === 'poor_shoulder_turn' ||
        fault === 'low_x_factor' ||
        fault === 'early_extension') &&
      (jointIdx === POSE_LANDMARKS.LEFT_SHOULDER || jointIdx === POSE_LANDMARKS.RIGHT_SHOULDER)
    ) {
      return color;
    }
  }
  return null;
}

/**
 * Draws a subtle ghost silhouette of the user's captured Top-of-Swing upper body so they can
 * inspect lead-arm extension and shoulder turn right on the 2D canvas.
 */
function drawCapturedPhaseGhostSkeleton(
  ctx: CanvasRenderingContext2D,
  topLandmarks: Landmark[],
  handedness: Handedness,
  activeFaults: SwingFault[],
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number
): void {
  const upperConnections: Array<[number, number]> = [
    [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.RIGHT_SHOULDER],
    [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_HIP],
    [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_HIP],
    [POSE_LANDMARKS.LEFT_HIP, POSE_LANDMARKS.RIGHT_HIP],
    [POSE_LANDMARKS.LEFT_SHOULDER, POSE_LANDMARKS.LEFT_ELBOW],
    [POSE_LANDMARKS.LEFT_ELBOW, POSE_LANDMARKS.LEFT_WRIST],
    [POSE_LANDMARKS.RIGHT_SHOULDER, POSE_LANDMARKS.RIGHT_ELBOW],
    [POSE_LANDMARKS.RIGHT_ELBOW, POSE_LANDMARKS.RIGHT_WRIST],
  ];

  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);

  for (const [i, j] of upperConnections) {
    const a = topLandmarks[i];
    const b = topLandmarks[j];
    if (!a || !b) continue;
    const faultCol =
      getJointFaultColor2D(i, handedness, activeFaults) ||
      getJointFaultColor2D(j, handedness, activeFaults);
    ctx.strokeStyle = faultCol ? 'rgba(239, 68, 68, 0.55)' : 'rgba(245, 158, 11, 0.38)';
    ctx.beginPath();
    ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
    ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
    ctx.stroke();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draws the standard bilateral 33-landmark skeleton for the Face-On (Laptop) view,
 * with per-joint biomechanical fault color-coding (Green -> Amber -> Red) and live metric callouts.
 */
function drawFaceOnBilateralSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  reliable: boolean,
  handedness: Handedness,
  activeFaults: SwingFault[],
  metrics: SwingMetrics | null,
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number
): void {
  const defaultBoneStroke = reliable
    ? 'rgba(16, 185, 129, 0.88)'
    : 'rgba(245, 158, 11, 0.55)';

  // 1. Bones (colored Red/Amber if connected to an active fault joint)
  for (const [i, j] of POSE_CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;
    if ((a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue;

    const faultA = getJointFaultColor2D(i, handedness, activeFaults);
    const faultB = getJointFaultColor2D(j, handedness, activeFaults);
    const faultStroke =
      faultA === '#ef4444' || faultB === '#ef4444'
        ? 'rgba(239, 68, 68, 0.92)'
        : faultA || faultB
          ? 'rgba(245, 158, 11, 0.92)'
          : defaultBoneStroke;

    ctx.strokeStyle = faultStroke;
    ctx.lineWidth = faultA || faultB ? 3.5 : 2.5;
    ctx.beginPath();
    ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
    ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
    ctx.stroke();
  }

  // 2. Joints (with glowing fault ring on problem joints)
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (!lm || (lm.visibility ?? 1) < 0.35) continue;

    const sx = toScreenX(lm.x);
    const sy = toScreenY(lm.y);
    const isKeyJoint =
      i === POSE_LANDMARKS.LEFT_SHOULDER ||
      i === POSE_LANDMARKS.RIGHT_SHOULDER ||
      i === POSE_LANDMARKS.LEFT_ELBOW ||
      i === POSE_LANDMARKS.RIGHT_ELBOW ||
      i === POSE_LANDMARKS.LEFT_WRIST ||
      i === POSE_LANDMARKS.RIGHT_WRIST ||
      i === POSE_LANDMARKS.LEFT_HIP ||
      i === POSE_LANDMARKS.RIGHT_HIP ||
      i === POSE_LANDMARKS.NOSE;

    const faultColor = getJointFaultColor2D(i, handedness, activeFaults);

    if (faultColor) {
      // Outer warning pulse halo on fault joint
      ctx.beginPath();
      ctx.arc(sx, sy, 9.5, 0, Math.PI * 2);
      ctx.fillStyle =
        faultColor === '#ef4444' ? 'rgba(239, 68, 68, 0.28)' : 'rgba(245, 158, 11, 0.28)';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(sx, sy, faultColor ? 6 : isKeyJoint ? 4.5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = faultColor || (isKeyJoint ? '#38bdf8' : 'rgba(248, 250, 252, 0.75)');
    ctx.fill();
    if (faultColor || isKeyJoint) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#090d16';
      ctx.stroke();
    }
  }

  // 3. On-Body 2D Biomechanical Metric Callout Badges (when metrics are available)
  if (metrics) {
    const nose = landmarks[POSE_LANDMARKS.NOSE];
    const leadElbowIdx =
      handedness === 'right' ? POSE_LANDMARKS.LEFT_ELBOW : POSE_LANDMARKS.RIGHT_ELBOW;
    const leadElbow = landmarks[leadElbowIdx];
    const lHip = landmarks[POSE_LANDMARKS.LEFT_HIP];
    const rHip = landmarks[POSE_LANDMARKS.RIGHT_HIP];

    if (nose && (nose.visibility ?? 1) >= 0.35) {
      const headBad = activeFaults.includes('head_movement');
      drawCalloutLabel(
        ctx,
        `HEAD Δ ${metrics.head_movement_cm}cm`,
        toScreenX(nose.x) + 12,
        toScreenY(nose.y) - 6,
        headBad ? '#ef4444' : '#34d399'
      );
    }

    if (leadElbow && (leadElbow.visibility ?? 1) >= 0.35) {
      const armBad = activeFaults.includes('bent_lead_arm');
      drawCalloutLabel(
        ctx,
        `LEAD ARM ${metrics.lead_arm_deg}°`,
        toScreenX(leadElbow.x) + 10,
        toScreenY(leadElbow.y) + 4,
        armBad ? '#ef4444' : '#38bdf8'
      );
    }

    if (lHip && rHip) {
      const hipMidX = toScreenX((lHip.x + rHip.x) * 0.5);
      const hipMidY = toScreenY((lHip.y + rHip.y) * 0.5);
      const hipBad =
        activeFaults.includes('hip_sway') || activeFaults.includes('no_weight_shift');
      drawCalloutLabel(
        ctx,
        `SWAY ${metrics.hip_sway_cm}cm | X-FAC ${metrics.x_factor_deg}°`,
        hipMidX - 58,
        hipMidY + 24,
        hipBad ? '#f59e0b' : '#34d399'
      );
    }
  }
}

/**
 * Draws a compact legend badge in the bottom-right corner of the 2D Face-On canvas.
 */
function draw2DOverlayLegend(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  activeFaults: SwingFault[]
): void {
  const primaryFault = activeFaults[0]
    ? `FAULT #1: ${activeFaults[0].replace(/_/g, ' ').toUpperCase()}`
    : 'ON-PLANE';
  const text = `Pro Ref Arc  ·  Your Swing  ·  ${primaryFault}`;
  drawCalloutLabel(
    ctx,
    text,
    Math.max(12, w - ctx.measureText(text).width - 28),
    h - 54,
    activeFaults.length > 0 ? '#d9a441' : '#44a282'
  );
}

/**
 * Draws the Down-The-Line (Portrait Phone) side-profile biomechanical chain:
 * - Spine Tilt Vector (Hip -> Shoulder -> Head) + live Spine Angle degree readout
 * - Dynamic Tush Line at the pelvis + Early Extension indicator
 * - Lower-Body Post (Ankle -> Knee -> Hip) + Knee Flex readout
 * - Arm & Hand Slot Triangle (Shoulder -> Elbow -> Wrist/Grip)
 */
function drawDtlSideProfileChain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  _landmarks: Landmark[],
  dtl: DtlPostureMetrics,
  addressHipX: number | null | undefined,
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number
): void {
  const hipX = toScreenX(dtl.hipPt.x);
  const hipY = toScreenY(dtl.hipPt.y);
  const shoulderX = toScreenX(dtl.shoulderPt.x);
  const shoulderY = toScreenY(dtl.shoulderPt.y);
  const headX = toScreenX(dtl.headPt.x);
  const headY = toScreenY(dtl.headPt.y);
  const kneeX = toScreenX(dtl.kneePt.x);
  const kneeY = toScreenY(dtl.kneePt.y);
  const ankleX = toScreenX(dtl.anklePt.x);
  const ankleY = toScreenY(dtl.anklePt.y);
  const elbowX = toScreenX(dtl.elbowPt.x);
  const elbowY = toScreenY(dtl.elbowPt.y);
  const wristX = toScreenX(dtl.wristPt.x);
  const wristY = toScreenY(dtl.wristPt.y);

  // 1. Live Pelvis / Tush Line vertical reference anchored at Address Hip (or current Hip)
  const refTushX = addressHipX != null ? toScreenX(addressHipX) : hipX;
  const hipDeltaPx = Math.round(hipX - refTushX);
  const isEarlyExtending = Math.abs(hipDeltaPx) > w * 0.055;

  ctx.save();
  ctx.strokeStyle = isEarlyExtending
    ? 'rgba(239, 68, 68, 0.85)'
    : 'rgba(16, 185, 129, 0.85)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(refTushX, Math.max(16, hipY - h * 0.22));
  ctx.lineTo(refTushX, Math.min(h - 16, ankleY + 10));
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Lower Body Post: Ankle -> Knee -> Hip (Emerald)
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.92)';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(ankleX, ankleY);
  ctx.lineTo(kneeX, kneeY);
  ctx.lineTo(hipX, hipY);
  ctx.stroke();

  // 3. Spine Tilt Chain: Hip -> Shoulder -> Head (Sky Blue)
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.lineTo(shoulderX, shoulderY);
  ctx.lineTo(headX, headY);
  ctx.stroke();

  // Vertical reference dashed tick from Hip upward to illustrate Spine Tilt Angle
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(hipX, hipY);
  ctx.lineTo(hipX, shoulderY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 4. Arm & Hand Plane Chain: Shoulder -> Elbow -> Wrist (Amber)
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.92)';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(shoulderX, shoulderY);
  ctx.lineTo(elbowX, elbowY);
  ctx.lineTo(wristX, wristY);
  ctx.stroke();

  // Draw key side-profile joint nodes
  const joints: Array<{ x: number; y: number; color: string; r: number }> = [
    { x: ankleX, y: ankleY, color: '#10b981', r: 4 },
    { x: kneeX, y: kneeY, color: '#10b981', r: 5 },
    { x: hipX, y: hipY, color: '#38bdf8', r: 6 },
    { x: shoulderX, y: shoulderY, color: '#38bdf8', r: 6 },
    { x: headX, y: headY, color: '#93c5fd', r: 5 },
    { x: elbowX, y: elbowY, color: '#fbbf24', r: 5 },
    { x: wristX, y: wristY, color: '#f59e0b', r: 5.5 },
  ];

  for (const j of joints) {
    ctx.beginPath();
    ctx.arc(j.x, j.y, j.r, 0, Math.PI * 2);
    ctx.fillStyle = j.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#090d16';
    ctx.stroke();
  }

  // 5. Compact Biomechanical Callout Pills on DTL View
  ctx.font = '700 10.5px Inter, system-ui, sans-serif';
  drawCalloutLabel(
    ctx,
    `SPINE ${dtl.spineTiltDeg}°`,
    (hipX + shoulderX) / 2 - 36,
    (hipY + shoulderY) / 2 - 8,
    '#38bdf8'
  );
  drawCalloutLabel(
    ctx,
    `KNEE ${dtl.kneeFlexDeg}°`,
    kneeX + 10,
    kneeY + 4,
    '#34d399'
  );
  if (isEarlyExtending) {
    drawCalloutLabel(
      ctx,
      'EARLY EXTENSION',
      hipX + 12,
      hipY - 12,
      '#e5566f'
    );
  }

  ctx.restore();
}

/**
 * Draws the tracked golf club shaft, clubhead marker, and shaft angle readout.
 */
function drawTrackedGolfClub(
  ctx: CanvasRenderingContext2D,
  club: ClubState,
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number
): void {
  const gx = toScreenX(club.grip.x);
  const gy = toScreenY(club.grip.y);
  const cx = toScreenX(club.clubhead.x);
  const cy = toScreenY(club.clubhead.y);

  const isVirtual = club.source === 'virtual';

  ctx.save();

  // Outer glow along club shaft
  ctx.strokeStyle = isVirtual
    ? 'rgba(74, 138, 214, 0.35)'
    : 'rgba(217, 164, 65, 0.42)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  // Crisp inner shaft line
  ctx.strokeStyle = isVirtual ? '#93c5fd' : '#fde68a';
  ctx.lineWidth = 2.8;
  if (isVirtual) {
    ctx.setLineDash([6, 4]);
  }
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  // Clubhead Toe/Face marker
  ctx.beginPath();
  ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
  ctx.fillStyle = isVirtual ? '#4a8ad6' : '#d9a441';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#090d16';
  ctx.stroke();

  // Shaft Plane Angle badge near clubhead
  const label = isVirtual
    ? `V-CLUB ${club.shaftAngleDeg}°`
    : `CLUB ${club.shaftAngleDeg}°`;
  drawCalloutLabel(ctx, label, cx + 10, cy + 4, isVirtual ? '#93c5fd' : '#fde68a');

  ctx.restore();
}

function drawCalloutLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  accentColor: string
): void {
  ctx.save();
  ctx.font = '700 10px Inter, system-ui, sans-serif';
  const metrics = ctx.measureText(text);
  const padX = 5;
  const boxW = metrics.width + padX * 2;
  const boxH = 16;

  ctx.fillStyle = 'rgba(9, 13, 22, 0.82)';
  ctx.beginPath();
  ctx.roundRect(x, y - boxH + 4, boxW, boxH, 4);
  ctx.fill();

  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = accentColor;
  ctx.textAlign = 'left';
  ctx.fillText(text, x + padX, y);
  ctx.restore();
}
