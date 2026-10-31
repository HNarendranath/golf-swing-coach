// Shared TypeScript interfaces for Golf Swing Coach

export type Handedness = 'right' | 'left';

export type SwingFault =
  | 'bent_lead_arm'
  | 'head_movement'
  | 'hip_sway'
  | 'fast_tempo'
  | 'slow_tempo'
  | 'early_extension'
  | 'poor_shoulder_turn'
  | 'poor_weight_shift'
  | 'over_the_top';

export interface SwingMetrics {
  tempo_ratio: number;            // Target: ~3.0 (e.g. 2.5 - 3.5)
  head_movement_cm: number;       // Target: < 5 cm
  hip_sway_cm: number;            // Target: < 5 cm away from target
  shoulder_turn_deg: number;      // Target: 80 - 90 deg
  hip_turn_deg?: number;          // Target: 40 - 50 deg
  x_factor_deg: number;           // Target: ~40 deg
  lead_arm_deg: number;           // Target: > 160 deg (straight)
  spine_angle_change_deg: number; // Target: < 5 deg
  weight_shift_cm?: number;       // Target: > 3 cm toward target
}

export interface CoachingPayload {
  swing_number: number;
  match_score: number;            // 0 - 100
  metrics: SwingMetrics;
  faults_ranked: SwingFault[];
  previous_focus?: SwingFault | null;
  improved_since_last: SwingFault[];
}

export interface CoachingResponse {
  spoken: string;                 // Read aloud via Web Speech TTS (max 2 short sentences, ~25 words)
  fault: SwingFault | 'none';     // Primary fault addressed
  drill: string;                  // Concrete drill or feel cue displayed on screen
  latencyMs: number;
  source: 'gemini' | 'fallback';
}

export interface VoiceQAPayload {
  question: string;
  latest_swing?: CoachingPayload | null;
}

export interface VoiceQAResponse {
  spoken: string;                 // Read aloud via Web Speech TTS (max 3 short sentences)
  latencyMs: number;
  source: 'gemini' | 'fallback';
}
