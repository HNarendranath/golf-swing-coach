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

  // Timing constants tuned for responsive pre-swing setup & immediate post-shot completion
  private readonly ADDRESS_HOLD_MS = 900; // ~0.9s address stillness trigger
  private readonly FINISH_HOLD_MS = 250; // 0.25s finish settle trigger (completes while in follow-through)
  private readonly POST_IMPACT_TIMEOUT_MS = 550; // 0.55s post-impact auto-complete (never waits for return to address)
  private readonly MAX_SETUP_WAIT_MS = 15000; // 15s generous window at setup to adjust stance & swing when ready
  private readonly MAX_SWING_MOTION_MS = 3200; // Max active swing motion duration
  private readonly DONE_COOLDOWN_MS = 2400; // Cooldown after shot finishes so lowering arms doesn't re-trigger
  private readonly STILL_SPEED_THRESHOLD = 0.72; // Forgiving stillness threshold (torso-lengths/sec)
  private readonly SWING_MOTION_THRESHOLD = 1.35; // Takeaway speed threshold indicating actual swing started

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
  private addressHandX = 0;
  private addressHandY = 0;
  private peakSpeedSeen = 0;
  private impactTimestampMs: number | null = null;
  private finishStillStartMs: number | null = null;
  private doneTimestampMs: number | null = null;
  private isManualCapture = false;
  private customReadyMessage: string | null = null;

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
      this.recordedFrames.length >= 8
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
    // Auto-reset from DONE -> IDLE after cooldown so lowering arms after follow-through
    // never re-triggers or delays post-shot coaching feedback.
    if (this.state === 'DONE') {
      const elapsedDone = frame.t - (this.doneTimestampMs ?? frame.t);
      if (elapsedDone > this.DONE_COOLDOWN_MS) {
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
          message: `✓ Shot finished (${this.recordedFrames.length} frames) — Coach feedback active!`,
        };
      }
    }

    // Drop frames where key landmark visibility < 0.5
    if (!isReliable) {
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
    const onLeadSide = (hands.x - hips.x) * leadSign >= -0.15 * torso;
    const wristsAboveChest = hands.y <= shoulders.y + 0.28 * torso;
    const wristsHighFinish = wristsAboveChest && onLeadSide;

    switch (this.state) {
      case 'IDLE': {
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

          // Gently adapt address hand anchor if golfer adjusts stance while still
          if (wristsBelowHips && isStill) {
            this.addressHandX = 0.88 * this.addressHandX + 0.12 * hands.x;
            this.addressHandY = 0.88 * this.addressHandY + 0.12 * hands.y;
            this.minHandYSeen = this.addressHandY;
          }

          const handRiseFromAddress = (this.addressHandY - hands.y) / torso;
          const handDistFromAddress =
            Math.hypot(hands.x - this.addressHandX, hands.y - this.addressHandY) / torso;

          // Detect genuine takeaway start (forgives small stance/grip wiggles)
          if (
            (this.smoothedSpeed > this.SWING_MOTION_THRESHOLD && handDistFromAddress > 0.16) ||
            handRiseFromAddress > 0.22 ||
            handDistFromAddress > 0.3
          ) {
            this.swingMotionStarted = true;
            this.swingMotionStartMs = frame.t;
            this.minHandYSeen = hands.y;
            this.maxBackswingDist = handDistFromAddress;
            if (this.onTakeawayStartedCallback) {
              this.onTakeawayStartedCallback();
            }
          } else {
            // Reset if player walks away or waits > 15s without swinging
            const waitDurationMs = frame.t - (this.addressLockedAtMs ?? frame.t);
            if (waitDurationMs > this.MAX_SETUP_WAIT_MS && ! this.isManualCapture) {
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

        // ── Phase B: Active Swing Motion (Backswing -> Downswing -> Impact) ──
        const swingDurationMs = frame.t - (this.swingMotionStartMs ?? frame.t);
        const handDistFromAddress =
          Math.hypot(hands.x - this.addressHandX, hands.y - this.addressHandY) / torso;

        if (this.smoothedSpeed > this.peakSpeedSeen) {
          this.peakSpeedSeen = this.smoothedSpeed;
        }

        // Track backswing apex ONLY before the downswing drop begins,
        // so high follow-through hands never overwrite `minHandYSeen`.
        if (!this.backswingTopReached) {
          if (hands.y < this.minHandYSeen) {
            this.minHandYSeen = hands.y;
          }
          if (handDistFromAddress > this.maxBackswingDist) {
            this.maxBackswingDist = handDistFromAddress;
          }

          const roseEnoughForBackswing =
            (this.addressHandY - this.minHandYSeen) / torso > 0.18 ||
            this.maxBackswingDist > 0.28;
          const droppedFromApex = (hands.y - this.minHandYSeen) / torso > 0.09;

          if (roseEnoughForBackswing && droppedFromApex) {
            this.backswingTopReached = true;
          }
        }

        // Detect transition into FOLLOW_THROUGH right as the shot is hit (never waiting for return to address)
        const droppedIntoImpactZone =
          this.backswingTopReached &&
          (hands.y >= this.addressHandY - 0.3 * torso ||
            (hands.x - hips.x) * leadSign > 0.08 * torso);

        const whippedToHighFinish =
          swingDurationMs >= 200 && this.peakSpeedSeen > 1.2 && wristsHighFinish;

        const deceleratedAfterDownswing =
          swingDurationMs >= 360 &&
          this.backswingTopReached &&
          this.peakSpeedSeen > 1.35 &&
          this.smoothedSpeed < 0.48 * this.peakSpeedSeen;

        if (droppedIntoImpactZone || whippedToHighFinish || deceleratedAfterDownswing) {
          this.state = 'FOLLOW_THROUGH';
          this.impactTimestampMs = frame.t;
          this.finishStillStartMs = null;
        } else if (swingDurationMs > this.MAX_SWING_MOTION_MS) {
          // Safety completion if active swing exceeds 3.2s
          if (this.recordedFrames.length >= 12) {
            this.completeRecording();
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

        // Condition 1: Follow-through finish settles for 250ms (whether high finish or balanced follow-through)
        const followThroughSettled = this.smoothedSpeed < 0.92;
        if (followThroughSettled && sinceImpactMs >= 120) {
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
              message: '✓ Shot finished! Speaking coaching feedback...',
            };
          }
        } else if (!followThroughSettled) {
          this.finishStillStartMs = null;
        }

        // Condition 2: Immediate 550ms post-impact completion while player is still in their follow-through
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
            message: '✓ Shot finished! Speaking coaching feedback...',
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
