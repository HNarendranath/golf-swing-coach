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
  message: string;
}

export class SwingCaptureFSM {
  private state: CaptureState = 'IDLE';
  private handedness: Handedness = 'right';

  // Timing constants from docs/HACKATHON_PLAN.md & docs/IMPLEMENTATION_PLAN.md
  private readonly ADDRESS_HOLD_MS = 1000; // ~1.0s address stillness trigger
  private readonly FINISH_HOLD_MS = 500; // ~0.5s finish stillness trigger
  private readonly POST_IMPACT_TIMEOUT_MS = 1000; // 1.0s post-impact auto-stop fallback
  private readonly MAX_RECORDING_MS = 6500; // Safety max duration for a single swing
  private readonly STILL_SPEED_THRESHOLD = 0.65; // Torso-lengths/sec threshold for stillness
  private readonly SWING_MOTION_THRESHOLD = 1.25; // Torso-lengths/sec threshold indicating swing started

  private addressHoldStartMs: number | null = null;
  private preRollBuffer: SwingFrame[] = [];
  private recordedFrames: SwingFrame[] = [];
  private prevFrame: SwingFrame | null = null;
  private smoothedSpeed = 0;

  // Intra-swing tracking for automatic impact & follow-through transition
  private swingMotionStarted = false;
  private minHandYSeen = Infinity;
  private addressHandY = 0;
  private peakSpeedSeen = 0;
  private impactTimestampMs: number | null = null;
  private finishStillStartMs: number | null = null;
  private doneTimestampMs: number | null = null;
  private isManualCapture = false;

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
    this.swingMotionStarted = false;
    this.minHandYSeen = Infinity;
    this.peakSpeedSeen = 0;
    this.impactTimestampMs = null;
    this.finishStillStartMs = null;

    if (this.prevFrame) {
      this.addressHandY = getHandMidpoint2D(this.prevFrame.landmarks).y;
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
    this.preRollBuffer = [];
    this.recordedFrames = [];
    this.swingMotionStarted = false;
    this.minHandYSeen = Infinity;
    this.peakSpeedSeen = 0;
    this.impactTimestampMs = null;
    this.finishStillStartMs = null;
    this.doneTimestampMs = null;
    this.isManualCapture = false;
  }

  /**
   * Feeds a smoothed SwingFrame into the capture state machine.
   * Per docs/HACKATHON_PLAN.md: "Drop frames where key landmark visibility is < 0.5."
   */
  update(frame: SwingFrame, isReliable: boolean): CaptureTelemetry {
    // Auto-reset from DONE -> IDLE after 1.6s cooldown so next swing can be captured hands-free
    if (this.state === 'DONE') {
      if (this.doneTimestampMs && frame.t - this.doneTimestampMs > 1600) {
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
          message: `Swing captured (${this.recordedFrames.length} frames)! Analyzing phases...`,
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
        message: 'Step into frame — ensure shoulders, hips & wrists are visible',
      };
    }

    const hands = getHandMidpoint2D(frame.landmarks);
    const hips = getHipMidpoint2D(frame.landmarks);
    const shoulders = getShoulderMidpoint2D(frame.landmarks);
    const torso = getTorsoLength2D(frame.landmarks);

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

    // Maintain a short rolling buffer (~12 frames) of recent frames for clean address lead-in
    this.preRollBuffer.push(frame);
    while (this.preRollBuffer.length > 12) {
      this.preRollBuffer.shift();
    }

    // Geometric posture checks (Note: in normalized image coords, y=0 is top, y=1 is bottom)
    // Wrists below hips: hands.y > hips.y (with small tolerance for high hands at address)
    const wristsBelowHips = hands.y >= hips.y - 0.08 * torso;
    const isStill = this.smoothedSpeed < this.STILL_SPEED_THRESHOLD;

    // Lead side high finish: hands above or near shoulder height
    const leadSign = this.handedness === 'right' ? 1 : -1;
    const onLeadSide = (hands.x - hips.x) * leadSign >= -0.15 * torso;
    const wristsAboveShoulders = hands.y <= shoulders.y + 0.18 * torso;
    const wristsHighFinish = wristsAboveShoulders && onLeadSide;

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
            message: 'Hold address steady (1.0s)...',
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
          message: wristsBelowHips
            ? 'Hold hands still below hips to lock address...'
            : 'Place hands below hips in address posture to begin',
        };
      }

      case 'ADDRESS_HOLD': {
        if (!wristsBelowHips || !isStill) {
          // Lost stillness before 1s completed
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
            message: 'Address moved — hold steady for 1.0s',
          };
        }

        const elapsed = frame.t - (this.addressHoldStartMs ?? frame.t);
        const holdProgress = Math.min(1, elapsed / this.ADDRESS_HOLD_MS);

        if (elapsed >= this.ADDRESS_HOLD_MS) {
          // Lock address! Start recording & play audio beep
          this.state = 'RECORDING';
          this.isManualCapture = false;
          this.recordedFrames = [...this.preRollBuffer];
          this.swingMotionStarted = false;
          this.minHandYSeen = hands.y;
          this.addressHandY = hands.y;
          this.peakSpeedSeen = 0;
          this.impactTimestampMs = null;
          this.finishStillStartMs = null;
          this.playBeep(880, 140);

          return {
            state: 'RECORDING',
            holdProgress: 1,
            recordedFrames: this.recordedFrames.length,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            message: '● ADDRESS LOCKED — Swing when ready!',
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
          message: `Locking address... ${Math.round(holdProgress * 100)}%`,
        };
      }

      case 'RECORDING': {
        this.recordedFrames.push(frame);
        const recDurationMs =
          this.recordedFrames[this.recordedFrames.length - 1].t - this.recordedFrames[0].t;

        // Track when actual takeaway / swing motion begins
        const handRiseFromAddress = (this.addressHandY - hands.y) / torso;
        if (
          !this.swingMotionStarted &&
          (this.smoothedSpeed > this.SWING_MOTION_THRESHOLD || handRiseFromAddress > 0.22)
        ) {
          this.swingMotionStarted = true;
        }

        if (this.swingMotionStarted) {
          if (hands.y < this.minHandYSeen) {
            this.minHandYSeen = hands.y;
          }
          if (this.smoothedSpeed > this.peakSpeedSeen) {
            this.peakSpeedSeen = this.smoothedSpeed;
          }

          // Detect if golfer reached top (hands rose significantly) and then swung down through impact zone
          const roseToTop = (this.addressHandY - this.minHandYSeen) / torso > 0.35;
          const backNearImpact = Math.abs(hands.y - this.addressHandY) / torso < 0.35;
          const passedTop = hands.y > this.minHandYSeen + 0.15 * torso;

          if (roseToTop && passedTop && (backNearImpact || wristsHighFinish)) {
            this.state = 'FOLLOW_THROUGH';
            this.impactTimestampMs = frame.t;
            this.finishStillStartMs = null;
          }
        }

        // Timeout safety if golfer stands still at address for > 6.5s without swinging
        if (recDurationMs > this.MAX_RECORDING_MS) {
          if (this.swingMotionStarted && this.recordedFrames.length >= 15) {
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
          message: this.swingMotionStarted
            ? `● RECORDING SWING (${this.recordedFrames.length} frames)...`
            : '● READY — Swing when ready!',
        };
      }

      case 'FOLLOW_THROUGH': {
        this.recordedFrames.push(frame);

        // Condition 1 (HACKATHON_PLAN.md): Wrists above shoulders on lead side, then still for 0.5s
        if (wristsHighFinish && isStill) {
          if (this.finishStillStartMs === null) {
            this.finishStillStartMs = frame.t;
          } else if (frame.t - this.finishStillStartMs >= this.FINISH_HOLD_MS) {
            this.completeRecording();
            return {
              state: 'DONE',
              holdProgress: 1,
              recordedFrames: this.recordedFrames.length,
              handSpeed: this.smoothedSpeed,
              wristsBelowHips,
              wristsHighFinish,
              isStill,
              message: 'Swing captured! Processing phases...',
            };
          }
        } else if (!isStill) {
          this.finishStillStartMs = null;
        }

        // Condition 2 (IMPLEMENTATION_PLAN.md): 1.0s post-impact auto-stop fallback
        const sinceImpactMs = frame.t - (this.impactTimestampMs ?? frame.t);
        if (sinceImpactMs >= this.POST_IMPACT_TIMEOUT_MS) {
          this.completeRecording();
          return {
            state: 'DONE',
            holdProgress: 1,
            recordedFrames: this.recordedFrames.length,
            handSpeed: this.smoothedSpeed,
            wristsBelowHips,
            wristsHighFinish,
            isStill,
            message: 'Swing captured (1.0s post-impact)! Processing phases...',
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
          message: `● FOLLOW-THROUGH — Hold finish (${this.recordedFrames.length} frames)...`,
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
          message: 'Ready',
        };
    }
  }

  private completeRecording(): void {
    this.state = 'DONE';
    this.doneTimestampMs = performance.now();
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
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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
