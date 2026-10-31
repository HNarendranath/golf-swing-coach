import { CaptureState, Handedness, SwingFrame } from '../types';
import {
  getHandMidpoint2D,
  getHipMidpoint2D,
  getShoulderMidpoint2D,
  getTorsoLength2D,
} from '../analysis/phaseDetector';

export interface CaptureTelemetry {
  state: CaptureState;
  holdProgress: number; // 0..1 during ADDRESS_HOLD
  recordedFrames: number;
  handSpeed: number; // torso-lengths per second
  wristsBelowHips: boolean;
  wristsHighFinish: boolean;
  isStill: boolean;
  swingMotionStarted: boolean;
  message: string;
}

export class SwingCaptureFSM {
  private state: CaptureState = 'IDLE';
  private handedness: Handedness = 'right';

  // Timing constants tuned for responsive pre-swing setup & immediate follow-through completion
  private readonly ADDRESS_HOLD_MS = 850; // ~0.85s address stillness trigger
  private readonly FINISH_HOLD_MS = 120; // 0.12s finish settle trigger (completes immediately in follow-through)
  private readonly POST_IMPACT_TIMEOUT_MS = 240; // 0.24s post-impact auto-complete (never waits for return to address)
  private readonly MAX_SETUP_WAIT_MS = 18000; // 18s generous window at setup to adjust stance & swing when ready
  private readonly MAX_SWING_MOTION_MS = 2200; // Max active swing motion duration
  private readonly DONE_COOLDOWN_MS = 1500; // Cooldown after shot finishes so lowering arms doesn't re-trigger
  private readonly STILL_SPEED_THRESHOLD = 0.75; // Forgiving stillness threshold (torso-lengths/sec)
  private readonly SWING_MOTION_THRESHOLD = 0.95; // Takeaway speed threshold indicating actual swing started

  private addressHoldStartMs: number | null = null;
  private addressLockedAtMs: number | null = null;
  private swingMotionStartMs: number | null = null;
  private preRollBuffer: SwingFrame[] = [];
  private recordedFrames: SwingFrame[] = [];
  private prevFrame: SwingFrame | null = null;
  private smoothedSpeed = 0;

  // Intra-swing tracking for accurate backswing apex, impact & immediate follow-through completion
  private swingMotionStarted = false;
  private backswingTopReached = false;
  private minHandYSeen = Infinity;
  private maxBackswingDist = 0;
  private backswingPeakX = 0;
  private backswingPeakY = 0;
  private addressHandX = 0;
  private addressHandY = 0;
  private peakSpeedSeen = 0;
  private impactTimestampMs: number | null = null;
  private finishStillStartMs: number | null = null;
  private doneTimestampMs: number | null = null;
  private isManualCapture = false;
  private customReadyMessage: string | null = null;

  private canStartAddressCheck: () => boolean = () => true;
  private onAddressLockedCallback: ((frame: SwingFrame) => void) | null = null;
  private onTakeawayStartedCallback: (() => void) | null = null;
  private onSwingCompleteCallback: ((frames: SwingFrame[]) => void) | null = null;
  private audioCtx: AudioContext | null = null;

  constructor(handedness: Handedness = 'right') {
    this.handedness = handedness;
  }

  setHandedness(handedness: Handedness): void {
    this.handedness = handedness;
  }

  getState(): CaptureState {
    return this.state;
  }

  isSwingInProgress(): boolean {
    return (
      (this.state === 'RECORDING' && this.swingMotionStarted) ||
      this.state === 'FOLLOW_THROUGH'
    );
  }

  /**
   * Registers a gate check so a new shot's address lock waits until post-swing feedback finishes speaking.
   */
  setCanStartAddressCheck(fn: () => boolean): void {
    this.canStartAddressCheck = fn;
  }

  /**
   * Sets a custom HUD ready message while the golfer is at address before takeaway
   * (e.g. showing the single setup tip + "Swing when ready!").
   */
  setCustomReadyMessage(msg: string | null): void {
    this.customReadyMessage = msg;
  }

  onAddressLocked(cb: (frame: SwingFrame) => void): void {
    this.onAddressLockedCallback = cb;
  }

  onTakeawayStarted(cb: () => void): void {
    this.onTakeawayStartedCallback = cb;
  }

  onSwingComplete(cb: (frames: SwingFrame[]) => void): void {
    this.onSwingCompleteCallback = cb;
  }

  /**
   * Manual override for testing in tight spaces:
   * Immediately starts recording a swing (or stops & finalizes if already recording).
   */
  forceStart(): void {
    this.recordedFrames = [...this.preRollBuffer];
    this.state = 'RECORDING';
    this.isManualCapture = true;
    this.addressLockedAtMs = this.prevFrame?.t ?? performance.now();
    this.swingMotionStarted = false;
    this.swingMotionStartMs = null;
    this.backswingTopReached = false;
    this.minHandYSeen = Infinity;
    this.maxBackswingDist = 0;
    this.peakSpeedSeen = 0;
    this.impactTimestampMs = null;
    this.finishStillStartMs = null;

    if (this.prevFrame) {
      const h = getHandMidpoint2D(this.prevFrame.landmarks);
      this.addressHandX = h.x;
      this.addressHandY = h.y;
      this.backswingPeakX = h.x;
      this.backswingPeakY = h.y;
      if (this.onAddressLockedCallback) {
        this.onAddressLockedCallback(this.prevFrame);
      }
    }
    this.playBeep(880, 140);
  }

  /**
   * Manual override to immediately stop recording and process captured frames.
   */
  forceStop(): void {
    if (
      (this.state === 'RECORDING' || this.state === 'FOLLOW_THROUGH') &&
      this.recordedFrames.length >= 6
    ) {
      this.completeRecording();
    } else {
      this.reset();
    }
  }

  reset(): void {
    this.state = 'IDLE';
    this.addressHoldStartMs = null;
    this.addressLockedAtMs = null;
    this.swingMotionStartMs = null;
    this.preRollBuffer = [];
    this.recordedFrames = [];
    this.swingMotionStarted = false;
    this.backswingTopReached = false;
    this.minHandYSeen = Infinity;
    this.maxBackswingDist = 0;
    this.peakSpeedSeen = 0;
    this.impactTimestampMs = null;
    this.finishStillStartMs = null;
    this.doneTimestampMs = null;
    this.isManualCapture = false;
    this.customReadyMessage = null;
  }

  /**
   * Feeds a smoothed SwingFrame into the capture state machine.
   */
  update(frame: SwingFrame, isReliable: boolean): CaptureTelemetry {
    // Auto-reset from DONE -> IDLE after cooldown AND once post-swing speech finishes,
    // so every subsequent shot gets its pre-swing setup evaluation cleanly.
    if (this.state === 'DONE') {
      const elapsedDone = frame.t - (this.doneTimestampMs ?? frame.t);
      if (elapsedDone > this.DONE_COOLDOWN_MS && this.canStartAddressCheck()) {
        this.reset();
      } else {
        return {
          state: 'DONE',
          holdProgress: 1,
          recordedFrames: this.recordedFrames.length,
          handSpeed: 0,
          wristsBelowHips: false,
          wristsHighFinish: false,
          isStill: true,
          swingMotionStarted: false,
          message: `Shot finished (${this.recordedFrames.length} frames) — Coach feedback active!`,
        };
      }
    }

    // IMPORTANT: Never abort or freeze an active swing (RECORDING / FOLLOW_THROUGH)
    // when a landmark briefly loses visibility during high-speed follow-through rotation!
    if (!isReliable && this.state !== 'RECORDING' && this.state !== 'FOLLOW_THROUGH') {
      if (this.state === 'ADDRESS_HOLD') {
        this.state = 'IDLE';
        this.addressHoldStartMs = null;
      }
      return {
        state: this.state,
        holdProgress: 0,
        recordedFrames: this.recordedFrames.length,
        handSpeed: this.smoothedSpeed,
        wristsBelowHips: false,
        wristsHighFinish: false,
        isStill: false,
        swingMotionStarted: this.swingMotionStarted,
        message: 'Step into frame — ensure shoulders, hips & wrists are visible',
      };
    }

    const hands = getHandMidpoint2D(frame.landmarks);
    const hips = getHipMidpoint2D(frame.landmarks);
    const shoulders = getShoulderMidpoint2D(frame.landmarks);
    const torso = Math.max(getTorsoLength2D(frame.landmarks), 0.08);

    // Compute normalized hand speed (in torso-lengths per second)
    let instSpeed = 0;
    if (this.prevFrame) {
      const prevHands = getHandMidpoint2D(this.prevFrame.landmarks);
      const dtSec = Math.max((frame.t - this.prevFrame.t) / 1000, 1 / 120);
      if (dtSec < 0.5) {
        instSpeed = Math.hypot(hands.x - prevHands.x, hands.y - prevHands.y) / torso / dtSec;
      }
    }
    this.smoothedSpeed = 0.45 * instSpeed + 0.55 * this.smoothedSpeed;
    this.prevFrame = frame;

    // Maintain a short rolling buffer (~14 frames) of recent frames for clean address lead-in
    this.preRollBuffer.push(frame);
    while (this.preRollBuffer.length > 14) {
      this.preRollBuffer.shift();
    }

    // Geometric posture checks (in normalized image coords, y=0 is top, y=1 is bottom)
    const wristsBelowHips = hands.y >= hips.y - 0.1 * torso;
    const isStill = this.smoothedSpeed < this.STILL_SPEED_THRESHOLD;

    // Lead side follow-through check: hands on lead side or above chest/shoulder height
    const leadSign = this.handedness === 'right' ? 1 : -1;
    const onLeadSide = (hands.x - hips.x) * leadSign >= -0.18 * torso;
    const wristsAboveChest = hands.y <= shoulders.y + 0.35 * torso;
    const wristsHighFinish = wristsAboveChest && onLeadSide;

    switch (this.state) {
      case 'IDLE': {
        if (!this.canStartAddressCheck()) {
          return {
            state: 'IDLE',
            holdProgress: 0,
            recordedFrames: 0,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            swingMotionStarted: false,
            message: 'Listening to coach feedback — step into setup for next shot when ready',
          };
        }

        if (wristsBelowHips && isStill) {
          this.state = 'ADDRESS_HOLD';
          this.addressHoldStartMs = frame.t;
          return {
            state: this.state,
            holdProgress: 0.05,
            recordedFrames: 0,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            swingMotionStarted: false,
            message: 'Checking setup posture...',
          };
        }
        return {
          state: 'IDLE',
          holdProgress: 0,
          recordedFrames: 0,
          handSpeed: this.smoothedSpeed,
          wristsBelowHips,
          wristsHighFinish,
          isStill,
          swingMotionStarted: false,
          message: wristsBelowHips
            ? 'Hold steady to check setup & lock address...'
            : 'Take your address setup (hands below hips) to begin',
        };
      }

      case 'ADDRESS_HOLD': {
        if (!wristsBelowHips || !isStill) {
          this.state = 'IDLE';
          this.addressHoldStartMs = null;
          return {
            state: 'IDLE',
            holdProgress: 0,
            recordedFrames: 0,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            swingMotionStarted: false,
            message: 'Settle into your setup and hold steady...',
          };
        }

        const elapsed = frame.t - (this.addressHoldStartMs ?? frame.t);
        const holdProgress = Math.min(1, elapsed / this.ADDRESS_HOLD_MS);

        if (elapsed >= this.ADDRESS_HOLD_MS) {
          // Lock address! Start pre-swing ready state, play audio beep, and trigger setup advice
          this.state = 'RECORDING';
          this.isManualCapture = false;
          this.addressLockedAtMs = frame.t;
          this.recordedFrames = [...this.preRollBuffer];
          this.swingMotionStarted = false;
          this.swingMotionStartMs = null;
          this.backswingTopReached = false;
          this.minHandYSeen = hands.y;
          this.maxBackswingDist = 0;
          this.addressHandX = hands.x;
          this.addressHandY = hands.y;
          this.backswingPeakX = hands.x;
          this.backswingPeakY = hands.y;
          this.peakSpeedSeen = 0;
          this.impactTimestampMs = null;
          this.finishStillStartMs = null;
          this.playBeep(880, 140);

          if (this.onAddressLockedCallback) {
            this.onAddressLockedCallback(frame);
          }

          return {
            state: 'RECORDING',
            holdProgress: 1,
            recordedFrames: this.recordedFrames.length,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            swingMotionStarted: false,
            message: this.customReadyMessage ?? '● SETUP LOCKED — Swing when ready!',
          };
        }

        return {
          state: 'ADDRESS_HOLD',
          holdProgress,
          recordedFrames: 0,
          handSpeed: this.smoothedSpeed,
          wristsBelowHips,
          wristsHighFinish,
          isStill,
          swingMotionStarted: false,
          message: `Checking setup... ${Math.round(holdProgress * 100)}%`,
        };
      }

      case 'RECORDING': {
        this.recordedFrames.push(frame);

        // ── Phase A: At Setup Waiting for Takeaway (!swingMotionStarted) ──
        if (!this.swingMotionStarted) {
          // Keep a clean rolling 18-frame (~0.3s) pre-roll window while the golfer
          // listens to setup advice or makes minor stance adjustments before swinging.
          while (this.recordedFrames.length > 18) {
            this.recordedFrames.shift();
          }

          const handRiseFromAddress = (this.addressHandY - hands.y) / torso;
          const handDistFromAddress =
            Math.hypot(hands.x - this.addressHandX, hands.y - this.addressHandY) / torso;

          // Only gently adapt address hand anchor when hands are very still and close to original address
          // (prevents a slow takeaway from dragging the address anchor along with the hands)
          if (wristsBelowHips && this.smoothedSpeed < 0.35 && handDistFromAddress < 0.12) {
            this.addressHandX = 0.92 * this.addressHandX + 0.08 * hands.x;
            this.addressHandY = 0.92 * this.addressHandY + 0.08 * hands.y;
            this.minHandYSeen = this.addressHandY;
          }

          // Detect genuine takeaway start
          if (
            !wristsBelowHips ||
            (this.smoothedSpeed > this.SWING_MOTION_THRESHOLD && handDistFromAddress > 0.10) ||
            handRiseFromAddress > 0.14 ||
            handDistFromAddress > 0.18
          ) {
            this.swingMotionStarted = true;
            this.swingMotionStartMs = frame.t;
            this.minHandYSeen = hands.y;
            this.maxBackswingDist = handDistFromAddress;
            this.backswingPeakX = hands.x;
            this.backswingPeakY = hands.y;
            if (this.onTakeawayStartedCallback) {
              this.onTakeawayStartedCallback();
            }
          } else {
            // Reset if player walks away or waits > 18s without swinging
            const waitDurationMs = frame.t - (this.addressLockedAtMs ?? frame.t);
            if (waitDurationMs > this.MAX_SETUP_WAIT_MS && !this.isManualCapture) {
              this.reset();
            }
            return {
              state: 'RECORDING',
              holdProgress: 1,
              recordedFrames: this.recordedFrames.length,
              handSpeed: this.smoothedSpeed,
              wristsBelowHips,
              wristsHighFinish,
              isStill,
              swingMotionStarted: false,
              message: this.customReadyMessage ?? '● READY — Swing when ready!',
            };
          }
        }

        // ── Phase B: Active Swing Motion (Backswing -> Downswing -> Follow-Through) ──
        const swingDurationMs = frame.t - (this.swingMotionStartMs ?? frame.t);
        const handDistFromAddress =
          Math.hypot(hands.x - this.addressHandX, hands.y - this.addressHandY) / torso;

        if (this.smoothedSpeed > this.peakSpeedSeen) {
          this.peakSpeedSeen = this.smoothedSpeed;
        }

        const distFromBackswingPeak =
          Math.hypot(hands.x - this.backswingPeakX, hands.y - this.backswingPeakY) / torso;

        // Track 2D backswing peak before the downswing starts
        if (!this.backswingTopReached) {
          if (hands.y < this.minHandYSeen) {
            this.minHandYSeen = hands.y;
          }
          if (handDistFromAddress > this.maxBackswingDist) {
            this.maxBackswingDist = handDistFromAddress;
            this.backswingPeakX = hands.x;
            this.backswingPeakY = hands.y;
          }

          const movedEnoughForBackswing =
            (this.addressHandY - this.minHandYSeen) / torso > 0.14 ||
            this.maxBackswingDist > 0.18;
          const movedAwayFromApex =
            (hands.y - this.minHandYSeen) / torso > 0.07 ||
            distFromBackswingPeak > 0.12;

          if (movedEnoughForBackswing && movedAwayFromApex) {
            this.backswingTopReached = true;
          }
        }

        // Detect transition into FOLLOW_THROUGH immediately as the shot finishes
        // (NEVER waiting for the golfer to return to the original hitting position)
        const droppedIntoImpactZone =
          this.backswingTopReached &&
          (hands.y >= this.addressHandY - 0.32 * torso || distFromBackswingPeak > 0.32);

        const crossedToFollowThroughSide =
          swingDurationMs >= 200 &&
          this.maxBackswingDist >= 0.16 &&
          distFromBackswingPeak >= 0.22 &&
          (hands.x - this.addressHandX) * (this.backswingPeakX - this.addressHandX) < 0;

        const whippedToHighFinish =
          swingDurationMs >= 180 &&
          this.maxBackswingDist >= 0.16 &&
          wristsHighFinish &&
          distFromBackswingPeak >= 0.18;

        const settledInFollowThrough =
          swingDurationMs >= 300 &&
          this.maxBackswingDist >= 0.16 &&
          handDistFromAddress >= 0.18 &&
          this.smoothedSpeed < 0.95;

        if (
          droppedIntoImpactZone ||
          crossedToFollowThroughSide ||
          whippedToHighFinish ||
          settledInFollowThrough
        ) {
          this.state = 'FOLLOW_THROUGH';
          this.impactTimestampMs = frame.t;
          this.finishStillStartMs = settledInFollowThrough ? frame.t : null;
        } else if (swingDurationMs > this.MAX_SWING_MOTION_MS) {
          // Safety completion if active swing exceeds 2.2s
          if (this.recordedFrames.length >= 10) {
            this.completeRecording(frame.t);
          } else {
            this.reset();
          }
        }

        return {
          state: this.state,
          holdProgress: 1,
          recordedFrames: this.recordedFrames.length,
          handSpeed: this.smoothedSpeed,
          wristsBelowHips,
          wristsHighFinish,
          isStill,
          swingMotionStarted: true,
          message: `● RECORDING SWING (${this.recordedFrames.length} frames)...`,
        };
      }

      case 'FOLLOW_THROUGH': {
        this.recordedFrames.push(frame);
        const sinceImpactMs = frame.t - (this.impactTimestampMs ?? frame.t);

        // Condition 1: Follow-through finish settles for 120ms while in follow-through
        const followThroughSettled = this.smoothedSpeed < 1.05;
        if (followThroughSettled && sinceImpactMs >= 60) {
          if (this.finishStillStartMs === null) {
            this.finishStillStartMs = frame.t;
          } else if (frame.t - this.finishStillStartMs >= this.FINISH_HOLD_MS) {
            this.completeRecording(frame.t);
            return {
              state: 'DONE',
              holdProgress: 1,
              recordedFrames: this.recordedFrames.length,
              handSpeed: this.smoothedSpeed,
              wristsBelowHips,
              wristsHighFinish,
              isStill,
              swingMotionStarted: false,
              message: 'Shot finished! Speaking coaching feedback...',
            };
          }
        } else if (!followThroughSettled) {
          this.finishStillStartMs = null;
        }

        // Condition 2: Immediate 240ms post-impact completion while player is still in their follow-through
        if (sinceImpactMs >= this.POST_IMPACT_TIMEOUT_MS) {
          this.completeRecording(frame.t);
          return {
            state: 'DONE',
            holdProgress: 1,
            recordedFrames: this.recordedFrames.length,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            swingMotionStarted: false,
            message: 'Shot finished! Speaking coaching feedback...',
          };
        }

        return {
          state: 'FOLLOW_THROUGH',
          holdProgress: 1,
          recordedFrames: this.recordedFrames.length,
          handSpeed: this.smoothedSpeed,
          wristsBelowHips,
          wristsHighFinish,
          isStill,
          swingMotionStarted: true,
          message: `● FOLLOW-THROUGH (${this.recordedFrames.length} frames)...`,
        };
      }

      default:
        return {
          state: this.state,
          holdProgress: 0,
          recordedFrames: this.recordedFrames.length,
          handSpeed: this.smoothedSpeed,
          wristsBelowHips,
          wristsHighFinish,
          isStill,
          swingMotionStarted: false,
          message: 'Ready',
        };
    }
  }

  private completeRecording(currentFrameTimeMs?: number): void {
    this.state = 'DONE';
    this.doneTimestampMs =
      currentFrameTimeMs ?? this.prevFrame?.t ?? performance.now();
    this.playBeep(1174, 110, 1480);

    // Normalize frame timestamps so frame[0].t === 0 ms
    const t0 = this.recordedFrames[0]?.t ?? 0;
    const normalizedFrames: SwingFrame[] = this.recordedFrames.map((f) => ({
      t: Math.round(f.t - t0),
      landmarks: f.landmarks,
      worldLandmarks: f.worldLandmarks,
    }));

    if (this.onSwingCompleteCallback && normalizedFrames.length >= 6) {
      this.onSwingCompleteCallback(normalizedFrames);
    }
  }

  /**
   * Synthesizes a clean Web Audio API beep for address lock and swing capture completion.
   */
  private playBeep(freqHz: number, durationMs: number, secondFreqHz?: number): void {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqHz, now);
      if (secondFreqHz) {
        osc.frequency.setValueAtTime(secondFreqHz, now + durationMs / 1000);
      }

      gain.gain.setValueAtTime(0.12, now);
      const totalDur = (secondFreqHz ? durationMs * 2 : durationMs) / 1000;
      gain.gain.exponentialRampToValueAtTime(0.001, now + totalDur);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + totalDur);
    } catch {
      // Ignore if browser blocks audio before user gesture
    }
  }
}
