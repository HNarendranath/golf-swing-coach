import type {
  CoachingPayload,
  CoachingResponse,
  VoiceQAResponse,
} from '../types';

export interface SpeechCoachCallbacks {
  onStatusChange?: (status: 'idle' | 'thinking' | 'speaking' | 'listening') => void;
  onTranscriptUpdate?: (transcript: string, isFinal: boolean) => void;
  onCoachResponse?: (res: CoachingResponse, payload: CoachingPayload) => void;
  onQAResponse?: (question: string, res: VoiceQAResponse) => void;
  onError?: (err: string) => void;
}

/**
 * 3 realistic progressive swing payloads for testing the prompt, rolling memory,
 * and demo script ("1. Bad swing -> 2. Ask voice question -> 3. Better swing with praise").
 */
export const MOCK_SWING_SCENARIOS: Record<'bad' | 'improved' | 'pure', CoachingPayload> = {
  bad: {
    swing_number: 1,
    match_score: 58,
    metrics: {
      tempo_ratio: 2.0,
      head_movement_cm: 9.4,
      hip_sway_cm: 6.2,
      shoulder_turn_deg: 78,
      hip_turn_deg: 44,
      x_factor_deg: 34,
      lead_arm_deg: 144,
      spine_angle_change_deg: 6.5,
      weight_shift_cm: 1.8,
    },
    faults_ranked: ['bent_lead_arm', 'head_movement', 'hip_sway', 'fast_tempo'],
    previous_focus: null,
    improved_since_last: [],
  },
  improved: {
    swing_number: 2,
    match_score: 75,
    metrics: {
      tempo_ratio: 2.4,
      head_movement_cm: 8.1,
      hip_sway_cm: 3.1,
      shoulder_turn_deg: 85,
      hip_turn_deg: 45,
      x_factor_deg: 40,
      lead_arm_deg: 166,
      spine_angle_change_deg: 3.8,
      weight_shift_cm: 4.2,
    },
    faults_ranked: ['head_movement', 'fast_tempo'],
    previous_focus: 'bent_lead_arm',
    improved_since_last: ['bent_lead_arm', 'hip_sway'],
  },
  pure: {
    swing_number: 3,
    match_score: 92,
    metrics: {
      tempo_ratio: 2.95,
      head_movement_cm: 2.8,
      hip_sway_cm: 2.4,
      shoulder_turn_deg: 88,
      hip_turn_deg: 46,
      x_factor_deg: 42,
      lead_arm_deg: 170,
      spine_angle_change_deg: 2.1,
      weight_shift_cm: 5.5,
    },
    faults_ranked: [],
    previous_focus: 'head_movement',
    improved_since_last: ['head_movement', 'fast_tempo'],
  },
};

export class SpeechCoach {
  private callbacks: SpeechCoachCallbacks;
  private synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window
    ? window.speechSynthesis
    : null;
  private preferredVoice: SpeechSynthesisVoice | null = null;
  private isMuted = false;
  private lastSpokenText = '';
  private latestSwingPayload: CoachingPayload | null = null;
  private isSpeakingSetup = false;
  private isSpeakingPostSwing = false;

  // SpeechRecognition (Push-to-talk STT)
  private recognition: any = null;
  private isListening = false;
  private capturedTranscript = '';
  private spacebarHeld = false;

  constructor(callbacks: SpeechCoachCallbacks = {}) {
    this.callbacks = callbacks;
    this.initVoices();
    this.initSpeechRecognition();
    this.initSpacebarPushToTalk();
  }

  private initVoices(): void {
    if (!this.synth) return;

    const pickBestVoice = () => {
      const voices = this.synth!.getVoices();
      if (!voices.length) return;

      // Prefer natural Google or Microsoft English voices
      const priorities = [
        /Google UK English Male/i,
        /Google US English/i,
        /Google UK English Female/i,
        /Microsoft.*Natural.*English/i,
        /Microsoft (Ryan|Sonia|Guy|Aria)/i,
        /en-(GB|US)/i,
      ];

      for (const regex of priorities) {
        const match = voices.find((v) => regex.test(v.name) || regex.test(v.lang));
        if (match) {
          this.preferredVoice = match;
          return;
        }
      }
      this.preferredVoice = voices[0];
    };

    pickBestVoice();
    if (typeof window !== 'undefined' && 'onvoiceschanged' in this.synth) {
      this.synth.onvoiceschanged = pickBestVoice;
    }
  }

  private initSpeechRecognition(): void {
    if (typeof window === 'undefined') return;
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      console.warn('[SpeechCoach] Web Speech API SpeechRecognition not supported in this browser (use Chrome/Edge).');
      return;
    }

    this.recognition = new SpeechRecognitionCtor();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event: any) => {
      let interim = '';
      let finalChunk = '';
      for (let i = 0; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          finalChunk += res[0].transcript + ' ';
        } else {
          interim += res[0].transcript;
        }
      }
      this.capturedTranscript = (finalChunk + interim).trim();
      this.callbacks.onTranscriptUpdate?.(this.capturedTranscript, Boolean(finalChunk));
    };

    this.recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('[SpeechCoach] STT error:', event.error);
        this.callbacks.onError?.(`Mic error: ${event.error}`);
      }
    };

    this.recognition.onend = () => {
      const finalQuestion = this.capturedTranscript.trim();
      this.isListening = false;

      if (finalQuestion.length > 1) {
        this.askCoachQuestion(finalQuestion);
      } else {
        this.callbacks.onStatusChange?.('idle');
      }
    };
  }

  /**
   * Binds Spacebar push-to-talk (hold Spacebar to speak, release to send question).
   * Ignores Spacebar if the user is typing in an <input> or <textarea>.
   */
  private initSpacebarPushToTalk(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      e.preventDefault();
      if (!this.spacebarHeld) {
        this.spacebarHeld = true;
        this.startListening();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      e.preventDefault();
      if (this.spacebarHeld) {
        this.spacebarHeld = false;
        this.stopListening();
      }
    });
  }

  /**
   * Starts push-to-talk microphone capture and cancels any ongoing TTS.
   */
  startListening(): void {
    if (!this.recognition) {
      this.callbacks.onError?.('SpeechRecognition requires Chrome or Edge.');
      return;
    }
    if (this.isListening) return;

    // Stop TTS immediately so the mic never hears the coach's own voice
    this.stopSpeaking();

    this.capturedTranscript = '';
    this.isListening = true;
    this.callbacks.onStatusChange?.('listening');
    this.callbacks.onTranscriptUpdate?.('Listening... (speak now)', false);

    try {
      this.recognition.start();
    } catch (err) {
      // Ignore if already started
    }
  }

  /**
   * Stops push-to-talk after a brief 250ms tail buffer so the final word isn't clipped.
   */
  stopListening(): void {
    if (!this.isListening || !this.recognition) return;
    setTimeout(() => {
      try {
        this.recognition.stop();
      } catch (_err) {
        this.isListening = false;
        this.callbacks.onStatusChange?.('idle');
      }
    }, 250);
  }

  /**
   * Sends structured swing metrics to POST /api/coach and speaks the response aloud.
   */
  async requestSwingCoaching(payload: CoachingPayload): Promise<CoachingResponse> {
    this.latestSwingPayload = payload;
    this.isSpeakingSetup = false;
    this.isSpeakingPostSwing = true;
    this.callbacks.onStatusChange?.('thinking');

    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        this.isSpeakingPostSwing = false;
        this.callbacks.onStatusChange?.('idle');
        throw new Error(`Coach API error: ${res.status}`);
      }

      const data = (await res.json()) as CoachingResponse;
      this.callbacks.onCoachResponse?.(data, payload);
      this.speak(data.spoken, true);
      return data;
    } catch (err) {
      this.isSpeakingPostSwing = false;
      throw err;
    }
  }

  /**
   * Sends a golfer's voice or text question to POST /api/qa and speaks the answer aloud.
   */
  async askCoachQuestion(question: string): Promise<VoiceQAResponse> {
    const cleanQ = question.trim();
    this.callbacks.onStatusChange?.('thinking');
    this.callbacks.onTranscriptUpdate?.(`"${cleanQ}"`, true);

    const res = await fetch('/api/qa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: cleanQ,
        latest_swing: this.latestSwingPayload,
      }),
    });

    if (!res.ok) {
      this.callbacks.onStatusChange?.('idle');
      throw new Error(`QA API error: ${res.status}`);
    }

    const data = (await res.json()) as VoiceQAResponse;
    this.callbacks.onQAResponse?.(cleanQ, data);
    this.speak(data.spoken, false);
    return data;
  }

  /**
   * Speaks text aloud via Web Speech API speechSynthesis.
   */
  speak(text: string, isPostSwing = false): void {
    this.lastSpokenText = text;
    this.isSpeakingSetup = false;
    this.isSpeakingPostSwing = isPostSwing;

    if (this.isMuted || !this.synth) {
      this.isSpeakingPostSwing = false;
      this.callbacks.onStatusChange?.('idle');
      return;
    }

    // Cancel any stuck or ongoing utterances (fixes Chrome speechSynthesis queue freeze)
    this.synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    if (this.preferredVoice) {
      utterance.voice = this.preferredVoice;
    }
    utterance.rate = 1.05;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      this.callbacks.onStatusChange?.('speaking');
    };
    utterance.onend = () => {
      this.isSpeakingPostSwing = false;
      this.callbacks.onStatusChange?.('idle');
    };
    utterance.onerror = () => {
      this.isSpeakingPostSwing = false;
      this.callbacks.onStatusChange?.('idle');
    };

    this.synth.speak(utterance);
  }

  /**
   * Speaks concise pre-swing setup advice & green-light cue immediately at address.
   * Never interrupts active post-swing coaching, and can be cancelled as soon as takeaway begins.
   */
  speakSetupAdvice(text: string): void {
    if (this.isMuted || !this.synth || this.isSpeakingPostSwing || this.isListening) {
      return;
    }

    this.synth.cancel();
    this.isSpeakingSetup = true;

    const utterance = new SpeechSynthesisUtterance(text);
    if (this.preferredVoice) {
      utterance.voice = this.preferredVoice;
    }
    // Slightly brisker rate for quick pre-shot setup cues
    utterance.rate = 1.1;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
      this.callbacks.onStatusChange?.('speaking');
    };
    utterance.onend = () => {
      this.isSpeakingSetup = false;
      this.callbacks.onStatusChange?.('idle');
    };
    utterance.onerror = () => {
      this.isSpeakingSetup = false;
      this.callbacks.onStatusChange?.('idle');
    };

    this.synth.speak(utterance);
  }

  /**
   * Immediately stops pre-swing setup speech if the golfer starts their takeaway early.
   */
  cancelSetupSpeech(): void {
    if (this.isSpeakingSetup && this.synth) {
      this.isSpeakingSetup = false;
      this.synth.cancel();
      this.callbacks.onStatusChange?.('idle');
    }
  }

  isBusyWithPostSwing(): boolean {
    return this.isSpeakingPostSwing;
  }

  replayLastSpoken(): void {
    if (this.lastSpokenText) {
      this.speak(this.lastSpokenText, false);
    }
  }

  stopSpeaking(): void {
    this.isSpeakingSetup = false;
    this.isSpeakingPostSwing = false;
    this.synth?.cancel();
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) {
      this.stopSpeaking();
    }
  }

  getMuted(): boolean {
    return this.isMuted;
  }

  async resetSession(): Promise<void> {
    this.latestSwingPayload = null;
    await fetch('/api/coach/reset', { method: 'POST' });
  }
}
