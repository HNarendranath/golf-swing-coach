import {
  ClubState,
  Landmark,
  POSE_CONNECTIONS,
  POSE_LANDMARKS,
  SwingFrame,
  SwingPhases,
} from '../types';
import { getHandMidpoint2D, Point2D } from '../analysis/phaseDetector';
import { DtlPostureMetrics } from '../capture/poseTracker';

export interface SkeletonDrawOptions {
  /** Camera perspective: 'face-on' (bilateral skeleton) or 'dtl' (side-profile posture & plane chain) */
  perspective?: 'face-on' | 'dtl';
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
  /** Optional reference hand path (green ghost path) */
  referenceHandPath?: Point2D[];
}

/**
 * Renders the 2D MediaPipe skeleton (or DTL side-profile posture chain), hand midpoint,
 * live hand trail, optional golf club shaft + clubhead trail, and captured phase markers.
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
  const toScreenX = (normX: number) => (mirrored ? (1 - normX) * w : normX * w);
  const toScreenY = (normY: number) => normY * h;

  ctx.save();

  // 1. Optional Reference Ghost Hand Path (Green)
  if (options.referenceHandPath && options.referenceHandPath.length > 1) {
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.78)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    options.referenceHandPath.forEach((pt, idx) => {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (idx === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 2. Last Captured Swing Hand Path + Phase Markers (Address, Takeaway, Top, Impact, Finish)
  if (options.capturedFrames && options.capturedFrames.length > 1) {
    const handPts = options.capturedFrames.map((f) => getHandMidpoint2D(f.landmarks));
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.75)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    handPts.forEach((pt, idx) => {
      const sx = toScreenX(pt.x);
      const sy = toScreenY(pt.y);
      if (idx === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();

    if (options.capturedPhases) {
      const p = options.capturedPhases;
      const phaseBadges: Array<{ label: string; idx: number; color: string }> = [
        { label: 'ADDR', idx: p.address, color: '#38bdf8' },
        { label: 'TAKE', idx: p.takeaway, color: '#a78bfa' },
        { label: 'TOP', idx: p.top, color: '#f59e0b' },
        { label: 'IMP', idx: p.impact, color: '#ef4444' },
        { label: 'FIN', idx: p.finish, color: '#10b981' },
      ];

      ctx.font = '700 10px Inter, system-ui, sans-serif';
      for (const badge of phaseBadges) {
        const pt = handPts[badge.idx];
        if (!pt) continue;
        const sx = toScreenX(pt.x);
        const sy = toScreenY(pt.y);

        ctx.fillStyle = badge.color;
        ctx.beginPath();
        ctx.arc(sx, sy, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#090d16';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = '#f8fafc';
        ctx.fillText(badge.label, sx + 8, sy + 3);
      }
    }
  }

  // 3. Live Clubhead Trail (Magenta/Cyan outer arc when club is tracked)
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
  //    - 'face-on': Full bilateral 33-landmark skeleton
  if (perspective === 'dtl' && options.dtlMetrics) {
    drawDtlSideProfileChain(ctx, w, h, landmarks, options.dtlMetrics, options.addressHipX, toScreenX, toScreenY);
  } else {
    drawFaceOnBilateralSkeleton(ctx, landmarks, options.isReliable !== false, toScreenX, toScreenY);
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

  ctx.restore();
}

/**
 * Draws the standard bilateral 33-landmark skeleton for the Face-On (Laptop) view.
 */
function drawFaceOnBilateralSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  reliable: boolean,
  toScreenX: (x: number) => number,
  toScreenY: (y: number) => number
): void {
  const boneStroke = reliable
    ? 'rgba(16, 185, 129, 0.88)'
    : 'rgba(245, 158, 11, 0.55)';

  ctx.strokeStyle = boneStroke;
  ctx.lineWidth = 2.5;
  for (const [i, j] of POSE_CONNECTIONS) {
    const a = landmarks[i];
    const b = landmarks[j];
    if (!a || !b) continue;
    if ((a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue;

    ctx.beginPath();
    ctx.moveTo(toScreenX(a.x), toScreenY(a.y));
    ctx.lineTo(toScreenX(b.x), toScreenY(b.y));
    ctx.stroke();
  }

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

    ctx.beginPath();
    ctx.arc(sx, sy, isKeyJoint ? 4.5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = isKeyJoint ? '#38bdf8' : 'rgba(248, 250, 252, 0.75)';
    ctx.fill();
  }
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
    ? 'rgba(167, 139, 250, 0.35)'
    : 'rgba(232, 121, 249, 0.42)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  // Crisp inner shaft line
  ctx.strokeStyle = isVirtual ? '#c4b5fd' : '#f0abfc';
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
  ctx.fillStyle = isVirtual ? '#a78bfa' : '#e879f9';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#090d16';
  ctx.stroke();

  // Shaft Plane Angle badge near clubhead
  const label = isVirtual
    ? `V-CLUB ${club.shaftAngleDeg}°`
    : `CLUB ${club.shaftAngleDeg}°`;
  drawCalloutLabel(ctx, label, cx + 10, cy + 4, isVirtual ? '#c4b5fd' : '#f0abfc');

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
