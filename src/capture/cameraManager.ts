export interface CameraDevice {
  deviceId: string;
  label: string;
  isPhoneCam: boolean;
}

export interface StreamStats {
  width: number;
  height: number;
  reportedFps: number;
  measuredFps: number;
  deviceLabel: string;
}

export class CameraManager {
  private videoEl: HTMLVideoElement;
  private currentStream: MediaStream | null = null;
  private onFrameCallback: ((video: HTMLVideoElement, timestampMs: number, fps: number) => void) | null = null;
  private frameTimes: number[] = [];
  private measuredFps = 0;
  private isRunning = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;

  constructor(videoEl: HTMLVideoElement) {
    this.videoEl = videoEl;
  }

  /**
   * Requests initial camera permission and returns all video input devices,
   * flagging DroidCam / Iriun / Camo / EpocCam phone cameras.
   */
  async listDevices(): Promise<CameraDevice[]> {
    // Ensure permissions are granted so device labels are populated
    if (!this.currentStream) {
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tempStream.getTracks().forEach((t) => t.stop());
      } catch (err) {
        console.warn('Initial camera permission check failed or denied:', err);
      }
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === 'videoinput');

    return videoInputs.map((d, idx) => {
      const label = d.label || `Camera ${idx + 1}`;
      const isPhoneCam = /droidcam|iriun|epoccam|camo|phone|ndi/i.test(label);
      return {
        deviceId: d.deviceId,
        label,
        isPhoneCam,
      };
    });
  }

  /**
   * Starts the selected camera device, requesting 60fps @ 720p ideally,
   * and gracefully falling back if the virtual webcam driver rejects high FPS constraints.
   */
  async startCamera(deviceId?: string, targetFps = 60): Promise<StreamStats> {
    this.stop();

    const baseVideoConstraints: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: targetFps, min: 24 },
    };

    if (deviceId) {
      baseVideoConstraints.deviceId = { exact: deviceId };
    }

    try {
      this.currentStream = await navigator.mediaDevices.getUserMedia({
        video: baseVideoConstraints,
        audio: false,
      });
    } catch (firstErr) {
      console.warn('Ideal camera constraints rejected by driver, falling back to relaxed constraints:', firstErr);
      // DroidCam / Iriun Virtual Drivers on Windows sometimes reject frameRate/resolution constraints
      const fallbackConstraints: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : true as unknown as MediaTrackConstraints;

      this.currentStream = await navigator.mediaDevices.getUserMedia({
        video: fallbackConstraints,
        audio: false,
      });
    }

    this.videoEl.srcObject = this.currentStream;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    await this.videoEl.play();

    this.isRunning = true;
    this.frameTimes = [];
    this.startFrameLoop();

    return this.getStreamStats();
  }

  /**
   * Loads a local video file (useful for testing or backup recordings).
   */
  async startVideoFile(file: File): Promise<StreamStats> {
    this.stop();
    const url = URL.createObjectURL(file);
    this.videoEl.srcObject = null;
    this.videoEl.src = url;
    this.videoEl.loop = true;
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    await this.videoEl.play();

    this.isRunning = true;
    this.frameTimes = [];
    this.startFrameLoop();

    return {
      width: this.videoEl.videoWidth || 1280,
      height: this.videoEl.videoHeight || 720,
      reportedFps: 60,
      measuredFps: this.measuredFps,
      deviceLabel: `File: ${file.name}`,
    };
  }

  getStreamStats(): StreamStats {
    const track = this.currentStream?.getVideoTracks()[0];
    const settings = track?.getSettings();
    return {
      width: settings?.width || this.videoEl.videoWidth || 0,
      height: settings?.height || this.videoEl.videoHeight || 0,
      reportedFps: Math.round(settings?.frameRate || 0),
      measuredFps: this.measuredFps,
      deviceLabel: track?.label || 'Video Stream',
    };
  }

  onFrame(cb: (video: HTMLVideoElement, timestampMs: number, fps: number) => void): void {
    this.onFrameCallback = cb;
  }

  private startFrameLoop(): void {
    const step = (now: number) => {
      if (!this.isRunning) return;

      // Track rolling FPS over the last 30 video frames
      this.frameTimes.push(now);
      while (this.frameTimes.length > 30) {
        this.frameTimes.shift();
      }
      if (this.frameTimes.length >= 2) {
        const elapsedSec = (this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0]) / 1000;
        if (elapsedSec > 0) {
          this.measuredFps = Math.round((this.frameTimes.length - 1) / elapsedSec);
        }
      }

      if (this.videoEl.readyState >= 2 && this.onFrameCallback) {
        this.onFrameCallback(this.videoEl, now, this.measuredFps);
      }

      if ('requestVideoFrameCallback' in this.videoEl) {
        this.rvfcHandle = (this.videoEl as any).requestVideoFrameCallback((_now: number) => {
          step(performance.now());
        });
      } else {
        this.rafHandle = requestAnimationFrame(step);
      }
    };

    if ('requestVideoFrameCallback' in this.videoEl) {
      this.rvfcHandle = (this.videoEl as any).requestVideoFrameCallback((_now: number) => {
        step(performance.now());
      });
    } else {
      this.rafHandle = requestAnimationFrame(step);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.rvfcHandle !== null && 'cancelVideoFrameCallback' in this.videoEl) {
      (this.videoEl as any).cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.currentStream) {
      this.currentStream.getTracks().forEach((t) => t.stop());
      this.currentStream = null;
    }
  }
}

