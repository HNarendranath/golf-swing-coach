import { Landmark } from '../types';

/**
 * 1D One Euro Filter for adaptive low-pass smoothing of noisy real-time signals.
 * Smooths jitter heavily at low speeds (address) while minimizing lag at high speeds (downswing).
 *
 * Reference: Casiez et al., "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 * Default parameters from docs/IMPLEMENTATION_PLAN.md:
 *   minCutoff = 1.2, beta = 0.08, dCutoff = 1.0
 */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev: number | null = null;

  constructor(minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private smoothingFactor(te: number, cutoff: number): number {
    const r = 2 * Math.PI * cutoff * te;
    return r / (r + 1);
  }

  private exponentialSmoothing(a: number, x: number, xPrev: number): number {
    return a * x + (1 - a) * xPrev;
  }

  /**
   * Filters a scalar value at timestamp `tMs` (in milliseconds).
   */
  filter(x: number, tMs: number): number {
    if (!Number.isFinite(x)) {
      return this.xPrev ?? 0;
    }

    if (this.tPrev === null || this.xPrev === null) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.tPrev = tMs;
      return x;
    }

    // Time elapsed in seconds (clamp to avoid zero/negative dt)
    const te = Math.max((tMs - this.tPrev) / 1000, 1 / 240);
    this.tPrev = tMs;

    // If gap is > 0.5s (e.g. tracking lost and regained), reset filter state
    if (te > 0.5) {
      this.xPrev = x;
      this.dxPrev = 0;
      return x;
    }

    // Filtered derivative
    const aD = this.smoothingFactor(te, this.dCutoff);
    const dx = (x - this.xPrev) / te;
    const dxHat = this.exponentialSmoothing(aD, dx, this.dxPrev);

    // Adaptive cutoff frequency based on speed
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.smoothingFactor(te, cutoff);
    const xHat = this.exponentialSmoothing(a, x, this.xPrev);

    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

/**
 * 3D One Euro Filter for a single MediaPipe Landmark (x, y, z).
 */
export class LandmarkOneEuroFilter {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private fz: OneEuroFilter;

  constructor(minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fz = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(lm: Landmark, tMs: number): Landmark {
    return {
      x: this.fx.filter(lm.x, tMs),
      y: this.fy.filter(lm.y, tMs),
      z: this.fz.filter(lm.z, tMs),
      visibility: lm.visibility ?? 1,
    };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}

/**
 * Bank of One Euro Filters for a full 33-landmark MediaPipe Pose (2D image + 3D world landmarks).
 */
export class PoseOneEuroFilter {
  private imageFilters: LandmarkOneEuroFilter[] = [];
  private worldFilters: LandmarkOneEuroFilter[] = [];
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  constructor(numLandmarks = 33, minCutoff = 1.2, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    for (let i = 0; i < numLandmarks; i++) {
      this.imageFilters.push(new LandmarkOneEuroFilter(minCutoff, beta, dCutoff));
      this.worldFilters.push(new LandmarkOneEuroFilter(minCutoff, beta, dCutoff));
    }
  }

  filterImageLandmarks(landmarks: Landmark[], tMs: number): Landmark[] {
    while (this.imageFilters.length < landmarks.length) {
      this.imageFilters.push(
        new LandmarkOneEuroFilter(this.minCutoff, this.beta, this.dCutoff)
      );
    }
    return landmarks.map((lm, i) => this.imageFilters[i].filter(lm, tMs));
  }

  filterWorldLandmarks(worldLandmarks: Landmark[], tMs: number): Landmark[] {
    while (this.worldFilters.length < worldLandmarks.length) {
      this.worldFilters.push(
        new LandmarkOneEuroFilter(this.minCutoff, this.beta, this.dCutoff)
      );
    }
    return worldLandmarks.map((lm, i) => this.worldFilters[i].filter(lm, tMs));
  }

  reset(): void {
    this.imageFilters.forEach((f) => f.reset());
    this.worldFilters.forEach((f) => f.reset());
  }
}
