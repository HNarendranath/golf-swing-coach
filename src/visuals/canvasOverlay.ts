import {
  Landmark,
  POSE_CONNECTIONS,
  POSE_LANDMARKS,
  SwingFrame,
  SwingPhases,
} from '../types';
import { getHandMidpoint2D, Point2D } from '../analysis/phaseDetector';

export interface SkeletonDrawOptions {
  /** Mirror X coordinates (1 - x) to match a horizontally flipped <video class="mirrored"> */
  mirrored?: boolean;
  /** Whether key landmarks passed the >= 0.5 visibility gate */
  isReliable?: boolean;
  /** Live hand trail points (normalized 0..1) */
  liveHandTrail?: Point2D[];
  /** Last captured swing frames for drawing user hand path (red/amber) and phase markers */
  capturedFrames?: SwingFrame[];
  /** Detected phases for the last captured swing */
  capturedPhases?: SwingPhases | null;
  /** Optional reference hand path (green ghost path) */
  referenceHandPath?: Point2D[];
}

/**
 * Renders the 2D MediaPipe skeleton, hand midpoint indicator, live hand trail,
 * and captured swing phase markers onto a video overlay canvas.
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

  // 3. Live Hand Trail during active recording
  if (options.liveHandTrail && options.liveHandTrail.length > 1) {
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
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

  // 4. Live 33-Landmark Pose Skeleton
  if (!landmarks || landmarks.length === 0) {
    ctx.restore();
    return;
  }

  const reliable = options.isReliable !== false;
  const boneStroke = reliable
    ? 'rgba(16, 185, 129, 0.88)'
    : 'rgba(245, 158, 11, 0.55)';

  // Draw POSE_CONNECTIONS bones
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

  // Draw joint spheres
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

  // Highlight Hand Midpoint ("hands" used for phase detection & capture trigger)
  const lw = landmarks[POSE_LANDMARKS.LEFT_WRIST];
  const rw = landmarks[POSE_LANDMARKS.RIGHT_WRIST];
  if (lw && rw && (lw.visibility ?? 1) >= 0.4 && (rw.visibility ?? 1) >= 0.4) {
    const handMid = getHandMidpoint2D(landmarks);
    const hx = toScreenX(handMid.x);
    const hy = toScreenY(handMid.y);

    ctx.beginPath();
    ctx.arc(hx, hy, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#090d16';
    ctx.stroke();
  }

  ctx.restore();
}
