// Shared TypeScript interfaces for Golf Swing Coach
// See docs/IMPLEMENTATION_PLAN.md & docs/HACKATHON_PLAN.md

export type Handedness = 'right' | 'left';

export type PoseModelVariant = 'lite' | 'full' | 'heavy';

export type CaptureState =
  | 'IDLE'
  | 'ADDRESS_HOLD'
  | 'RECORDING'
  | 'FOLLOW_THROUGH'
  | 'DONE';

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility: number;
}

export interface SwingFrame {
  /** Timestamp in milliseconds relative to recording or performance clock */
  t: number;
  /** Normalized 2D image landmarks (x, y in [0, 1], z relative scale) */
  landmarks: Landmark[];
  /** 3D world landmarks in meters, hip-centered by MediaPipe */
  worldLandmarks: Landmark[];
}

export interface SwingPhases {
  address: number;
  takeaway: number;
  top: number;
  impact: number;
  finish: number;
  timestamps: {
    address: number;
    takeaway: number;
    top: number;
    impact: number;
    finish: number;
  };
}

export interface SwingMetrics {
  tempo_ratio: number;
  backswing_ms: number;
  downswing_ms: number;
  head_movement_cm: number;
  hip_sway_cm: number;
  weight_shift_cm: number;
  shoulder_turn_deg: number;
  hip_turn_deg: number;
  x_factor_deg: number;
  lead_arm_deg: number;
  spine_angle_address_deg: number;
  spine_angle_impact_deg: number;
  spine_angle_change_deg: number;
}

export type SwingFault =
  | 'fast_tempo'
  | 'slow_tempo'
  | 'head_movement'
  | 'hip_sway'
  | 'poor_shoulder_turn'
  | 'low_x_factor'
  | 'bent_lead_arm'
  | 'early_extension'
  | 'no_weight_shift';

export interface SwingRecording {
  id: string;
  createdAt: string;
  handedness: Handedness;
  cameraAngle?: 'face-on' | 'dtl';
  fps: number;
  frames: SwingFrame[];
  phases: SwingPhases;
  metrics?: SwingMetrics;
  faultsRanked?: SwingFault[];
  matchScore?: number;
}

export interface CoachingPayload {
  swing_number: number;
  match_score: number;
  metrics: SwingMetrics;
  faults_ranked: SwingFault[];
  previous_focus?: SwingFault | null;
  improved_since_last: SwingFault[];
}

export interface CoachingResponse {
  spoken: string;
  fault: string;
  drill: string;
}

/**
 * Standard MediaPipe Pose 33 landmark indices.
 */
export const POSE_LANDMARKS = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/**
 * Standard MediaPipe Pose skeleton connections for 2D & 3D rendering.
 */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // Torso
  [11, 12],
  [23, 24],
  [11, 23],
  [12, 24],
  // Left Arm
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  // Right Arm
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  // Left Leg
  [23, 25],
  [25, 27],
  [27, 29],
  [27, 31],
  [29, 31],
  // Right Leg
  [24, 26],
  [26, 28],
  [28, 30],
  [28, 32],
  [30, 32],
  // Head / Face
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
];
