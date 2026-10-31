/**
 * Interactive 3D Golf Swing Skeleton Replay & Ghost Reference Comparison (`src/visuals/replay3D.ts`).
 *
 * Features:
 * - Three.js 3D studio scene with OrbitControls, studio lighting, ground grid, and target-line arrow.
 * - Renders the User 3D Skeleton (spheres + bone cylinders + 3D golf club shaft & clubhead) alongside
 *   a time-aligned Reference Ghost Skeleton (semi-transparent emerald green).
 * - Per-joint biomechanical fault & alignment error color-coding (Green -> Amber -> Red) so problem
 *   joints (e.g., Chicken Wing lead elbow, Head movement, Hip sway) stand out visually at each phase.
 * - 3D Hand Path & Clubhead Arc ribbons for both User and Reference swings.
 * - Full playback controls: Play/Pause, 0..99 canonical frame scrubber, Phase quick-jump buttons
 *   (Address, Takeaway, Top, Impact, Finish), Speed selector (0.25x, 0.5x, 1.0x), Camera Presets
 *   (Face-On, DTL, Overhead), Ghost toggle, and Expand-to-Main-Stage toggle.
 * - Built-in biomechanically realistic synthetic 3D swing generator so the 3D viewer works out of the
 *   box with a Pro Reference Ghost and responds to both live camera swings and simulated test swings.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  Handedness,
  Landmark,
  POSE_CONNECTIONS,
  POSE_LANDMARKS,
  SwingFault,
  SwingFrame,
  SwingPhases,
} from '../types';
import { AlignedSwingResult, resampleSwingByPhases } from '../analysis/referenceAligner';

export type Camera3DPreset = 'face-on' | 'dtl' | 'overhead';
export type SyntheticSwingPreset = 'reference' | 'bad' | 'improved' | 'pure';

interface SkeletonMeshGroup {
  root: THREE.Group;
  jointMeshes: Map<number, THREE.Mesh>;
  boneMeshes: Array<{ conn: readonly [number, number]; mesh: THREE.Mesh }>;
  headSphere: THREE.Mesh;
  clubShaft: THREE.Mesh;
  clubHead: THREE.Mesh;
  handTrailLine: THREE.Line;
  clubTrailLine: THREE.Line;
}

const KEY_SKELETON_JOINTS: number[] = [
  POSE_LANDMARKS.NOSE,
  POSE_LANDMARKS.LEFT_SHOULDER,
  POSE_LANDMARKS.RIGHT_SHOULDER,
  POSE_LANDMARKS.LEFT_ELBOW,
  POSE_LANDMARKS.RIGHT_ELBOW,
  POSE_LANDMARKS.LEFT_WRIST,
  POSE_LANDMARKS.RIGHT_WRIST,
  POSE_LANDMARKS.LEFT_HIP,
  POSE_LANDMARKS.RIGHT_HIP,
  POSE_LANDMARKS.LEFT_KNEE,
  POSE_LANDMARKS.RIGHT_KNEE,
  POSE_LANDMARKS.LEFT_ANKLE,
  POSE_LANDMARKS.RIGHT_ANKLE,
];

const CANONICAL_PHASES: Array<{ key: string; label: string; frame: number; color: string }> = [
  { key: 'address', label: 'Address', frame: 0, color: '#4a8ad6' },
  { key: 'takeaway', label: 'Takeaway', frame: 18, color: '#38bdf8' },
  { key: 'top', label: 'Top', frame: 50, color: '#d9a441' },
  { key: 'impact', label: 'Impact', frame: 75, color: '#e5566f' },
  { key: 'finish', label: 'Finish', frame: 99, color: '#44a282' },
];

export class Replay3DViewer {
  private container: HTMLElement;
  private viewportEl!: HTMLDivElement;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;

  private userGroup!: SkeletonMeshGroup;
  private refGroup!: SkeletonMeshGroup;

  private userFrames: Landmark[][] = [];
  private refFrames: Landmark[][] = [];
  private perFrameJointErrors: Record<number, number>[] = [];
  private activeFaults: SwingFault[] = [];
  private handedness: Handedness = 'right';

  // Playback state
  private isPlaying = true;
  private playbackSpeed = 0.25; // Default 0.25x slow-mo for biomechanical inspection
  private currentFrameFloat = 0;
  private showGhostRef = true;
  private showTrails = true;
  private isExpandedStage = false;
  private lastTickMs = performance.now();
  private rafId: number | null = null;

  // UI elements inside the self-contained widget
  private playBtn!: HTMLButtonElement;
  private scrubInput!: HTMLInputElement;
  private frameCounterEl!: HTMLSpanElement;
  private phasePillEl!: HTMLSpanElement;
  private expandBtn!: HTMLButtonElement;
  private ghostBtn!: HTMLButtonElement;
  private trailsBtn!: HTMLButtonElement;
  private faultLegendEl!: HTMLDivElement;

  private onExpandChange?: (expanded: boolean) => void;

  constructor(
    mountContainer: HTMLElement,
    options?: { onExpandChange?: (expanded: boolean) => void }
  ) {
    this.container = mountContainer;
    this.onExpandChange = options?.onExpandChange;

    this.buildDOM();
    this.initThreeScene();
    this.userGroup = this.createSkeletonMeshGroup(false);
    this.refGroup = this.createSkeletonMeshGroup(true);
    this.scene.add(this.refGroup.root);
    this.scene.add(this.userGroup.root);

    // Load default Pro Reference + Pure Swing on startup so the 3D scene is immediately alive
    const defaultRef = generateSyntheticCanonicalFrames('reference', 'right');
    this.refFrames = defaultRef;
    this.userFrames = generateSyntheticCanonicalFrames('pure', 'right');
    this.rebuild3DTrails();
    this.renderAtCanonicalFrame(0);

    this.startLoop();
  }

  /**
   * Builds the self-contained 3D Replay Studio UI inside `this.container` so `index.html` stays clean.
   */
  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="replay3d-card-header">
        <div class="replay3d-title-group">
          <h2>3D Swing Rendering Lab</h2>
          <span class="replay3d-phase-pill" id="r3d-phase-pill">Address</span>
          <span class="replay3d-subnote">Normalized 3D skeleton · Torso = 1.0 · Drag to orbit, scroll to zoom</span>
        </div>
        <div class="row-inline">
          <button type="button" class="btn btn-xs active" id="r3d-ghost-btn" title="Toggle semi-transparent green Pro Reference skeleton">
            Pro Ghost: On
          </button>
          <button type="button" class="btn btn-xs active" id="r3d-trails-btn" title="Toggle 3D hand and clubhead arc ribbons">
            3D Arcs: On
          </button>
          <button type="button" class="btn btn-xs" id="r3d-expand-btn" title="Return to Live Camera Studio">
            Live Cameras
          </button>
        </div>
      </div>

      <div class="replay3d-viewport" id="r3d-viewport">
        <div class="replay3d-hud-top">
          <div class="segmented replay3d-cam-presets" id="r3d-cam-presets">
            <button type="button" class="seg-btn active" data-cam="face-on">Face-On</button>
            <button type="button" class="seg-btn" data-cam="dtl">Down-the-Line</button>
            <button type="button" class="seg-btn" data-cam="overhead">Overhead</button>
          </div>
          <span class="replay3d-frame-badge num" id="r3d-frame-counter">Frame 00 / 99</span>
        </div>

        <div class="replay3d-legend-bar" id="r3d-fault-legend">
          <span><i class="r3d-dot dot-user"></i>Golfer (Fault Color-Coded)</span>
          <span><i class="r3d-dot dot-ref"></i>Pro Reference Ghost</span>
          <span><i class="r3d-dot dot-club"></i>3D Club Arc</span>
        </div>
      </div>

      <div class="replay3d-controls">
        <div class="replay3d-scrub-row">
          <button type="button" class="btn btn-primary btn-xs" id="r3d-play-btn" title="Play / Pause 3D Replay">
            Pause
          </button>
          <input
            type="range"
            id="r3d-scrub-slider"
            class="replay3d-slider"
            min="0"
            max="99"
            step="1"
            value="0"
          />
          <div class="segmented replay3d-speed-group" id="r3d-speed-group">
            <button type="button" class="seg-btn active" data-speed="0.25">0.25×</button>
            <button type="button" class="seg-btn" data-speed="0.5">0.5×</button>
            <button type="button" class="seg-btn" data-speed="1">1×</button>
          </div>
        </div>

        <div class="replay3d-phase-jumps" id="r3d-phase-jumps">
          <span class="sub-label">Phase Jump</span>
          <button type="button" class="btn btn-xs r3d-jump-btn" data-frame="0">1. Address</button>
          <button type="button" class="btn btn-xs r3d-jump-btn" data-frame="18">2. Takeaway</button>
          <button type="button" class="btn btn-xs r3d-jump-btn" data-frame="50">3. Top</button>
          <button type="button" class="btn btn-xs r3d-jump-btn" data-frame="75">4. Impact</button>
          <button type="button" class="btn btn-xs r3d-jump-btn" data-frame="99">5. Finish</button>
        </div>
      </div>
    `;

    this.viewportEl = this.container.querySelector('#r3d-viewport') as HTMLDivElement;
    this.playBtn = this.container.querySelector('#r3d-play-btn') as HTMLButtonElement;
    this.scrubInput = this.container.querySelector('#r3d-scrub-slider') as HTMLInputElement;
    this.frameCounterEl = this.container.querySelector('#r3d-frame-counter') as HTMLSpanElement;
    this.phasePillEl = this.container.querySelector('#r3d-phase-pill') as HTMLSpanElement;
    this.expandBtn = this.container.querySelector('#r3d-expand-btn') as HTMLButtonElement;
    this.ghostBtn = this.container.querySelector('#r3d-ghost-btn') as HTMLButtonElement;
    this.trailsBtn = this.container.querySelector('#r3d-trails-btn') as HTMLButtonElement;
    this.faultLegendEl = this.container.querySelector('#r3d-fault-legend') as HTMLDivElement;

    // Play / Pause
    this.playBtn.addEventListener('click', () => {
      this.setPlaying(!this.isPlaying);
    });

    // Scrubber drag
    this.scrubInput.addEventListener('input', () => {
      this.setPlaying(false);
      this.currentFrameFloat = Number(this.scrubInput.value) || 0;
      this.renderAtCanonicalFrame(this.currentFrameFloat);
    });

    // Speed selector (0.25x, 0.5x, 1.0x)
    const speedGroup = this.container.querySelector('#r3d-speed-group') as HTMLDivElement;
    speedGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLButtonElement | null;
      if (!btn) return;
      const spd = Number(btn.dataset.speed);
      if (!spd) return;
      this.playbackSpeed = spd;
      speedGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });

    // Phase jump buttons
    const jumpsGroup = this.container.querySelector('#r3d-phase-jumps') as HTMLDivElement;
    jumpsGroup.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.r3d-jump-btn') as HTMLButtonElement | null;
      if (!btn) return;
      const targetFrame = Number(btn.dataset.frame);
      if (Number.isNaN(targetFrame)) return;
      this.setPlaying(false);
      this.currentFrameFloat = targetFrame;
      this.scrubInput.value = `${targetFrame}`;
      this.renderAtCanonicalFrame(targetFrame);
    });

    // Camera presets (Face-On, DTL, Overhead)
    const camPresets = this.container.querySelector('#r3d-cam-presets') as HTMLDivElement;
    camPresets.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.seg-btn') as HTMLButtonElement | null;
      if (!btn) return;
      const preset = btn.dataset.cam as Camera3DPreset;
      if (!preset) return;
      camPresets.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      this.setCameraPreset(preset);
    });

    // Ghost Reference Toggle
    this.ghostBtn.addEventListener('click', () => {
      this.showGhostRef = !this.showGhostRef;
      this.ghostBtn.classList.toggle('active', this.showGhostRef);
      this.ghostBtn.textContent = this.showGhostRef ? 'Pro Ghost: On' : 'Pro Ghost: Off';
      this.refGroup.root.visible = this.showGhostRef;
    });

    // 3D Arc Trails Toggle
    this.trailsBtn.addEventListener('click', () => {
      this.showTrails = !this.showTrails;
      this.trailsBtn.classList.toggle('active', this.showTrails);
      this.trailsBtn.textContent = this.showTrails ? '3D Arcs: On' : '3D Arcs: Off';
      this.userGroup.handTrailLine.visible = this.showTrails;
      this.userGroup.clubTrailLine.visible = this.showTrails;
      this.refGroup.handTrailLine.visible = this.showTrails && this.showGhostRef;
    });

    // Expand / Collapse Main Stage
    this.expandBtn.addEventListener('click', () => {
      this.setExpandedStage(!this.isExpandedStage);
    });
  }

  public setExpandedStage(expanded: boolean): void {
    this.isExpandedStage = expanded;
    this.container.classList.toggle('replay3d-expanded-stage', expanded);
    this.expandBtn.classList.toggle('active', expanded);
    this.expandBtn.textContent = expanded ? 'Live Cameras' : 'Full Stage';
    if (this.onExpandChange) {
      this.onExpandChange(expanded);
    }
    requestAnimationFrame(() => this.handleResize());
  }

  public isExpanded(): boolean {
    return this.isExpandedStage;
  }

  private setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    this.playBtn.textContent = playing ? 'Pause' : 'Play';
  }

  /**
   * Initializes the Three.js scene, studio lights, floor grid, target arrow, and OrbitControls.
   */
  private initThreeScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b14);

    const width = Math.max(this.viewportEl.clientWidth, 300);
    const height = Math.max(this.viewportEl.clientHeight, 240);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 50);
    this.camera.position.set(0, 0.35, 3.8);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.viewportEl.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.05, 0);
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 8.5;
    this.controls.maxPolarAngle = Math.PI * 0.53;

    // Studio Lighting
    const ambient = new THREE.AmbientLight(0xdbeafe, 0.85);
    this.scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
    keyLight.position.set(2.5, 4.5, 3.5);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.65);
    rimLight.position.set(-3.0, 2.0, -2.5);
    this.scene.add(rimLight);

    // Studio Floor Grid (at y = -1.65 in torso-normalized coordinates)
    const floorY = -1.65;
    const grid = new THREE.GridHelper(5.5, 16, 0x1e293b, 0x0f172a);
    grid.position.y = floorY;
    this.scene.add(grid);

    // Golf Ball + Target Line Arrow on the studio floor
    const ballGeo = new THREE.SphereGeometry(0.045, 16, 16);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.25,
      roughness: 0.2,
    });
    const ballMesh = new THREE.Mesh(ballGeo, ballMat);
    ballMesh.position.set(0, floorY + 0.045, 0.48);
    this.scene.add(ballMesh);

    // Target line arrow pointing toward lead target (-X in normalized 3D view)
    const arrowDir = new THREE.Vector3(-1, 0, 0);
    const arrowOrigin = new THREE.Vector3(0.65, floorY + 0.01, 0.48);
    const targetArrow = new THREE.ArrowHelper(arrowDir, arrowOrigin, 1.45, 0x38bdf8, 0.16, 0.09);
    this.scene.add(targetArrow);

    window.addEventListener('resize', () => this.handleResize());
  }

  public handleResize(): void {
    if (!this.viewportEl || !this.renderer || !this.camera) return;
    const w = this.viewportEl.clientWidth;
    const h = this.viewportEl.clientHeight;
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /**
   * Repositions the OrbitControls camera to a standard golf coaching viewpoint.
   */
  public setCameraPreset(preset: Camera3DPreset): void {
    const leadSign = this.handedness === 'right' ? -1 : 1;
    this.controls.target.set(0, 0.05, 0);

    if (preset === 'face-on') {
      // Looking straight at the golfer's chest
      this.camera.position.set(0, 0.25, 3.75);
    } else if (preset === 'dtl') {
      // Down-The-Line: perpendicular behind the golfer's hands looking toward the target
      this.camera.position.set(-leadSign * 3.65, 0.28, 0.35);
    } else if (preset === 'overhead') {
      // Overhead tour-telecast view showing shoulder vs hip turn (X-Factor)
      this.camera.position.set(0, 4.1, 0.45);
    }
    this.controls.update();
  }

  /**
   * Creates a 3D skeleton mesh group (joint spheres, bone cylinders, head, club shaft/head, and 3D trails).
   */
  private createSkeletonMeshGroup(isGhostReference: boolean): SkeletonMeshGroup {
    const root = new THREE.Group();
    const jointMeshes = new Map<number, THREE.Mesh>();
    const boneMeshes: Array<{ conn: readonly [number, number]; mesh: THREE.Mesh }> = [];

    const jointRadius = isGhostReference ? 0.042 : 0.054;
    const boneRadius = isGhostReference ? 0.022 : 0.03;

    const jointGeo = new THREE.SphereGeometry(jointRadius, 16, 16);
    const boneGeo = new THREE.CylinderGeometry(boneRadius, boneRadius, 1, 12);

    for (const idx of KEY_SKELETON_JOINTS) {
      const mat = new THREE.MeshStandardMaterial({
        color: isGhostReference ? 0x10b981 : 0x38bdf8,
        transparent: isGhostReference,
        opacity: isGhostReference ? 0.38 : 1.0,
        roughness: 0.3,
        metalness: 0.15,
      });
      const mesh = new THREE.Mesh(jointGeo, mat);
      root.add(mesh);
      jointMeshes.set(idx, mesh);
    }

    // Larger head sphere around NOSE landmark
    const headGeo = new THREE.SphereGeometry(isGhostReference ? 0.105 : 0.115, 20, 20);
    const headMat = new THREE.MeshStandardMaterial({
      color: isGhostReference ? 0x10b981 : 0x38bdf8,
      transparent: true,
      opacity: isGhostReference ? 0.28 : 0.88,
      roughness: 0.35,
    });
    const headSphere = new THREE.Mesh(headGeo, headMat);
    root.add(headSphere);

    for (const conn of POSE_CONNECTIONS) {
      const mat = new THREE.MeshStandardMaterial({
        color: isGhostReference ? 0x10b981 : 0xe2e8f0,
        transparent: isGhostReference,
        opacity: isGhostReference ? 0.32 : 0.95,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(boneGeo, mat);
      root.add(mesh);
      boneMeshes.push({ conn, mesh });
    }

    // 3D Golf Club Shaft & Clubhead
    const shaftGeo = new THREE.CylinderGeometry(0.015, 0.012, 1, 10);
    const shaftMat = new THREE.MeshStandardMaterial({
      color: isGhostReference ? 0x34d399 : 0xf0abfc,
      transparent: isGhostReference,
      opacity: isGhostReference ? 0.35 : 0.95,
      emissive: isGhostReference ? 0x059669 : 0xc026d3,
      emissiveIntensity: 0.25,
    });
    const clubShaft = new THREE.Mesh(shaftGeo, shaftMat);
    root.add(clubShaft);

    const clubHeadGeo = new THREE.BoxGeometry(0.11, 0.045, 0.065);
    const clubHeadMat = new THREE.MeshStandardMaterial({
      color: isGhostReference ? 0x10b981 : 0x38bdf8,
      transparent: isGhostReference,
      opacity: isGhostReference ? 0.4 : 1.0,
      emissive: isGhostReference ? 0x059669 : 0x0284c7,
      emissiveIntensity: 0.35,
    });
    const clubHead = new THREE.Mesh(clubHeadGeo, clubHeadMat);
    root.add(clubHead);

    // 3D Hand & Clubhead Trajectory Lines
    const handTrailMat = new THREE.LineBasicMaterial({
      color: isGhostReference ? 0x10b981 : 0xf59e0b,
      transparent: true,
      opacity: isGhostReference ? 0.55 : 0.92,
    });
    const handTrailLine = new THREE.Line(new THREE.BufferGeometry(), handTrailMat);
    root.add(handTrailLine);

    const clubTrailMat = new THREE.LineBasicMaterial({
      color: isGhostReference ? 0x059669 : 0xe879f9,
      transparent: true,
      opacity: isGhostReference ? 0.35 : 0.85,
    });
    const clubTrailLine = new THREE.Line(new THREE.BufferGeometry(), clubTrailMat);
    if (isGhostReference) {
      clubTrailLine.visible = false;
    }
    root.add(clubTrailLine);

    return {
      root,
      jointMeshes,
      boneMeshes,
      headSphere,
      clubShaft,
      clubHead,
      handTrailLine,
      clubTrailLine,
    };
  }

  /**
   * Loads a real captured swing (already aligned via `alignAndScoreSwing`) into the 3D Replay Viewer.
   */
  public loadAlignedSwing(
    alignment: AlignedSwingResult,
    faultsRanked: SwingFault[],
    handedness: Handedness
  ): void {
    this.handedness = handedness;
    this.activeFaults = faultsRanked;
    this.perFrameJointErrors = alignment.perFrameJointErrors;

    if (alignment.alignedUserFrames.length > 0) {
      this.userFrames = alignment.alignedUserFrames;
    }
    if (alignment.alignedRefFrames.length > 0) {
      this.refFrames = alignment.alignedRefFrames;
    } else if (this.refFrames.length === 0) {
      this.refFrames = generateSyntheticCanonicalFrames('reference', handedness);
    }

    this.updateFaultLegendUI();
    this.rebuild3DTrails();
    this.currentFrameFloat = 0;
    this.setPlaying(true);
    this.renderAtCanonicalFrame(0);
  }

  /**
   * Updates the Reference Ghost Skeleton when a user clicks "⭐ Set as Reference" or loads `/api/reference`.
   */
  public setReferenceRecording(frames: SwingFrame[], phases: SwingPhases, handedness: Handedness): void {
    const resampled = resampleSwingByPhases(frames, phases);
    if (resampled.length > 0) {
      this.refFrames = resampled;
      this.handedness = handedness;
      this.rebuild3DTrails();
      this.renderAtCanonicalFrame(this.currentFrameFloat);
    }
  }

  /**
   * Loads one of the 3 simulated demo scenarios ('bad' | 'improved' | 'pure') into the 3D Replay Viewer
   * so clicking the simulation buttons in the UI also demonstrates the 3D replay & fault highlighting!
   */
  public loadSimulatedScenario(
    preset: 'bad' | 'improved' | 'pure',
    faultsRanked: SwingFault[],
    handedness: Handedness
  ): void {
    this.handedness = handedness;
    this.activeFaults = faultsRanked;
    this.refFrames = generateSyntheticCanonicalFrames('reference', handedness);
    this.userFrames = generateSyntheticCanonicalFrames(preset, handedness);
    this.perFrameJointErrors = computeSyntheticJointErrors(this.userFrames, this.refFrames);

    this.updateFaultLegendUI();
    this.rebuild3DTrails();
    this.currentFrameFloat = 0;
    this.setPlaying(true);
    this.renderAtCanonicalFrame(0);
  }

  private updateFaultLegendUI(): void {
    const primary = this.activeFaults[0];
    if (!primary) {
      this.faultLegendEl.innerHTML = `
        <span><i class="r3d-dot dot-good"></i>All Joints On-Plane</span>
        <span><i class="r3d-dot dot-ref"></i>Pro Reference Ghost</span>
        <span><i class="r3d-dot dot-club"></i>3D Clubhead Arc</span>
      `;
      return;
    }
    const label = primary.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    this.faultLegendEl.innerHTML = `
      <span><i class="r3d-dot dot-fault"></i>Fault Highlight: <strong>${label}</strong></span>
      <span><i class="r3d-dot dot-ref"></i>Pro Ghost</span>
      <span><i class="r3d-dot dot-club"></i>Club Arc</span>
    `;
  }

  /**
   * Converts a normalized MediaPipe 3D landmark (`y` down, `z` depth) to Three.js world space (`y` up).
   */
  private landmarkToVec3(lm: Landmark): THREE.Vector3 {
    return new THREE.Vector3(-lm.x, -lm.y, -lm.z);
  }

  /**
   * Computes the 3D grip midpoint and estimated 3D clubhead position from a frame's landmarks.
   */
  private compute3DClubPositions(frame: Landmark[]): {
    grip: THREE.Vector3;
    clubhead: THREE.Vector3;
  } {
    const lw = frame[POSE_LANDMARKS.LEFT_WRIST];
    const rw = frame[POSE_LANDMARKS.RIGHT_WRIST];
    const le = frame[POSE_LANDMARKS.LEFT_ELBOW];
    const re = frame[POSE_LANDMARKS.RIGHT_ELBOW];
    const ls = frame[POSE_LANDMARKS.LEFT_SHOULDER];
    const rs = frame[POSE_LANDMARKS.RIGHT_SHOULDER];

    const grip = new THREE.Vector3(
      -(lw.x + rw.x) * 0.5,
      -(lw.y + rw.y) * 0.5,
      -(lw.z + rw.z) * 0.5
    );
    const elbowMid = new THREE.Vector3(
      -(le.x + re.x) * 0.5,
      -(le.y + re.y) * 0.5,
      -(le.z + re.z) * 0.5
    );
    const shoulderMid = new THREE.Vector3(
      -(ls.x + rs.x) * 0.5,
      -(ls.y + rs.y) * 0.5,
      -(ls.z + rs.z) * 0.5
    );

    // Project club shaft along forearm vector + slight wrist hinge
    const forearmDir = new THREE.Vector3().subVectors(grip, elbowMid).normalize();
    const armDir = new THREE.Vector3().subVectors(grip, shoulderMid).normalize();
    const shaftDir = new THREE.Vector3()
      .addScaledVector(forearmDir, 0.72)
      .addScaledVector(armDir, 0.28)
      .normalize();

    const shaftLength = 1.18; // ~1.18 torso units for an iron/driver in normalized space
    const clubhead = new THREE.Vector3().copy(grip).addScaledVector(shaftDir, shaftLength);
    return { grip, clubhead };
  }

  /**
   * Rebuilds the 3D Hand Path and 3D Clubhead Arc trajectory lines for both User and Reference swings.
   */
  private rebuild3DTrails(): void {
    const buildTrailsForFrames = (frames: Landmark[][], group: SkeletonMeshGroup) => {
      if (frames.length < 2) return;
      const handPts: THREE.Vector3[] = [];
      const clubPts: THREE.Vector3[] = [];
      for (const f of frames) {
        const { grip, clubhead } = this.compute3DClubPositions(f);
        handPts.push(grip);
        clubPts.push(clubhead);
      }
      group.handTrailLine.geometry.dispose();
      group.handTrailLine.geometry = new THREE.BufferGeometry().setFromPoints(handPts);

      group.clubTrailLine.geometry.dispose();
      group.clubTrailLine.geometry = new THREE.BufferGeometry().setFromPoints(clubPts);
    };

    buildTrailsForFrames(this.userFrames, this.userGroup);
    buildTrailsForFrames(this.refFrames, this.refGroup);
  }

  /**
   * Interpolates a canonical frame array `[0..99]` at a floating-point index `frameFloat`.
   */
  private sampleFrame(frames: Landmark[][], frameFloat: number): Landmark[] | null {
    if (frames.length === 0) return null;
    const clamped = Math.max(0, Math.min(frames.length - 1, frameFloat));
    const idx0 = Math.floor(clamped);
    const idx1 = Math.min(frames.length - 1, Math.ceil(clamped));
    const t = clamped - idx0;
    const f0 = frames[idx0];
    const f1 = frames[idx1];
    if (!f0 || !f1) return f0 || null;

    return f0.map((lm, i) => {
      const b = f1[i] ?? lm;
      return {
        x: lm.x + (b.x - lm.x) * t,
        y: lm.y + (b.y - lm.y) * t,
        z: lm.z + (b.z - lm.z) * t,
        visibility: lm.visibility,
      };
    });
  }

  /**
   * Determines the joint color (`green` / `amber` / `red`) for a user joint at canonical frame `frameIdx`.
   */
  private getJointFaultColor(jointIdx: number, frameIdx: number): number {
    const leadElbow =
      this.handedness === 'right' ? POSE_LANDMARKS.LEFT_ELBOW : POSE_LANDMARKS.RIGHT_ELBOW;
    const leadWrist =
      this.handedness === 'right' ? POSE_LANDMARKS.LEFT_WRIST : POSE_LANDMARKS.RIGHT_WRIST;
    const leadShoulder =
      this.handedness === 'right' ? POSE_LANDMARKS.LEFT_SHOULDER : POSE_LANDMARKS.RIGHT_SHOULDER;

    // Highlight active biomechanical faults on the specific anatomical joints involved
    for (let rank = 0; rank < Math.min(2, this.activeFaults.length); rank++) {
      const fault = this.activeFaults[rank];
      const color = rank === 0 ? 0xef4444 : 0xf59e0b; // #1 Fault = Red, #2 Fault = Amber

      if (
        (fault === 'bent_lead_arm' || fault === 'over_the_top') &&
        (jointIdx === leadElbow || jointIdx === leadWrist || jointIdx === leadShoulder) &&
        frameIdx >= 35 &&
        frameIdx <= 85
      ) {
        return color;
      }
      if (
        fault === 'head_movement' &&
        jointIdx === POSE_LANDMARKS.NOSE &&
        frameIdx >= 15 &&
        frameIdx <= 85
      ) {
        return color;
      }
      if (
        (fault === 'hip_sway' || fault === 'no_weight_shift') &&
        (jointIdx === POSE_LANDMARKS.LEFT_HIP || jointIdx === POSE_LANDMARKS.RIGHT_HIP)
      ) {
        return color;
      }
      if (
        (fault === 'poor_shoulder_turn' || fault === 'low_x_factor' || fault === 'early_extension') &&
        (jointIdx === POSE_LANDMARKS.LEFT_SHOULDER || jointIdx === POSE_LANDMARKS.RIGHT_SHOULDER)
      ) {
        return color;
      }
    }

    // Also check per-frame spatial alignment error against the reference swing
    const errMap = this.perFrameJointErrors[Math.round(frameIdx)];
    const err = errMap?.[jointIdx] ?? 0;
    if (err > 0.34) return 0xef4444; // Red (high deviation)
    if (err > 0.2) return 0xf59e0b; // Amber (moderate deviation)
    return 0x10b981; // Emerald green (on plane)
  }

  /**
   * Updates both 3D skeletons (User + Reference Ghost) and UI badges for `frameFloat` in `[0..99]`.
   */
  public renderAtCanonicalFrame(frameFloat: number): void {
    const fIdx = Math.round(frameFloat);
    this.frameCounterEl.textContent = `Frame ${String(fIdx).padStart(2, '0')} / 99`;

    // Update Phase Pill
    let currentPhase = CANONICAL_PHASES[0];
    for (const p of CANONICAL_PHASES) {
      if (fIdx >= p.frame - 6) currentPhase = p;
    }
    this.phasePillEl.textContent = currentPhase.label.toUpperCase();
    this.phasePillEl.style.borderColor = currentPhase.color;
    this.phasePillEl.style.color = currentPhase.color;

    const uLandmarks = this.sampleFrame(this.userFrames, frameFloat);
    if (uLandmarks) {
      this.poseSkeletonGroup(this.userGroup, uLandmarks, false, fIdx);
    }

    const rLandmarks = this.sampleFrame(this.refFrames, frameFloat);
    if (rLandmarks) {
      this.poseSkeletonGroup(this.refGroup, rLandmarks, true, fIdx);
    }
  }

  /**
   * Positions all joints, bones, head sphere, and 3D golf club for a `SkeletonMeshGroup`.
   */
  private poseSkeletonGroup(
    group: SkeletonMeshGroup,
    landmarks: Landmark[],
    isGhostReference: boolean,
    frameIdx: number
  ): void {
    const upVec = new THREE.Vector3(0, 1, 0);

    for (const [idx, mesh] of group.jointMeshes.entries()) {
      const lm = landmarks[idx];
      if (!lm) continue;
      mesh.position.copy(this.landmarkToVec3(lm));

      if (!isGhostReference) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.color.setHex(this.getJointFaultColor(idx, frameIdx));
      }
    }

    // Position head sphere slightly above nose
    const nose = landmarks[POSE_LANDMARKS.NOSE];
    if (nose) {
      const nosePos = this.landmarkToVec3(nose);
      group.headSphere.position.set(nosePos.x, nosePos.y + 0.04, nosePos.z);
      if (!isGhostReference) {
        const headMat = group.headSphere.material as THREE.MeshStandardMaterial;
        headMat.color.setHex(this.getJointFaultColor(POSE_LANDMARKS.NOSE, frameIdx));
      }
    }

    // Orient and scale bone cylinders between connected joints
    for (const { conn, mesh } of group.boneMeshes) {
      const aLm = landmarks[conn[0]];
      const bLm = landmarks[conn[1]];
      if (!aLm || !bLm) continue;

      const a = this.landmarkToVec3(aLm);
      const b = this.landmarkToVec3(bLm);
      const dist = a.distanceTo(b);
      if (dist < 0.001) continue;

      mesh.position.lerpVectors(a, b, 0.5);
      mesh.scale.set(1, dist, 1);

      const dir = new THREE.Vector3().subVectors(b, a).normalize();
      mesh.quaternion.setFromUnitVectors(upVec, dir);

      if (!isGhostReference) {
        const cA = this.getJointFaultColor(conn[0], frameIdx);
        const cB = this.getJointFaultColor(conn[1], frameIdx);
        const boneMat = mesh.material as THREE.MeshStandardMaterial;
        if (cA === 0xef4444 || cB === 0xef4444) {
          boneMat.color.setHex(0xfca5a5);
        } else if (cA === 0xf59e0b || cB === 0xf59e0b) {
          boneMat.color.setHex(0xfde68a);
        } else {
          boneMat.color.setHex(0xe2e8f0);
        }
      }
    }

    // Position 3D Golf Club Shaft & Clubhead
    const { grip, clubhead } = this.compute3DClubPositions(landmarks);
    const shaftLen = grip.distanceTo(clubhead);
    group.clubShaft.position.lerpVectors(grip, clubhead, 0.5);
    group.clubShaft.scale.set(1, shaftLen, 1);
    const shaftDir = new THREE.Vector3().subVectors(clubhead, grip).normalize();
    group.clubShaft.quaternion.setFromUnitVectors(upVec, shaftDir);

    group.clubHead.position.copy(clubhead);
    group.clubHead.quaternion.copy(group.clubShaft.quaternion);
  }

  private startLoop(): void {
    const tick = (nowMs: number) => {
      const dtSec = Math.min((nowMs - this.lastTickMs) / 1000, 0.1);
      this.lastTickMs = nowMs;

      if (this.isPlaying && this.userFrames.length > 1) {
        // Base 1.0x speed = 60 canonical frames/sec (~1.65s full swing)
        this.currentFrameFloat += dtSec * 60 * this.playbackSpeed;
        if (this.currentFrameFloat >= 99.4) {
          this.currentFrameFloat = 0;
        }
        this.scrubInput.value = `${Math.round(this.currentFrameFloat)}`;
        this.renderAtCanonicalFrame(this.currentFrameFloat);
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  public dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
    }
    this.renderer.dispose();
  }
}

/**
 * Generates a realistic 100-frame canonical 3D golf swing (`[0..99]`) normalized to hip midpoint `(0,0,0)`
 * and torso length `1.0`. Supports `'reference'` / `'pure'` (on-plane tour swing), `'bad'` (chicken wing +
 * head movement + hip sway), and `'improved'` (mild lead arm bend).
 */
export function generateSyntheticCanonicalFrames(
  preset: SyntheticSwingPreset,
  handedness: Handedness = 'right'
): Landmark[][] {
  const frames: Landmark[][] = [];
  const sign = handedness === 'right' ? 1 : -1;

  for (let f = 0; f < 100; f++) {
    // Phase progress parameter:
    // 0..50 = Address -> Top, 50..75 = Top -> Impact, 75..99 = Impact -> Finish
    let backswingT = 0;
    let downswingT = 0;
    let followT = 0;

    if (f <= 50) {
      backswingT = Math.sin((f / 50) * (Math.PI / 2));
    } else if (f <= 75) {
      backswingT = 1 - (f - 50) / 25;
      downswingT = (f - 50) / 25;
    } else {
      followT = Math.sin(((f - 75) / 24) * (Math.PI / 2));
    }

    const isBad = preset === 'bad';
    const isImproved = preset === 'improved';

    // Hip sway (bad swing sways away from target on backswing)
    const hipSwayX = isBad ? -sign * 0.18 * backswingT : sign * 0.08 * (downswingT + followT);
    // Spine tilt forward (Z) and height (Y, negative is up in MediaPipe coordinates)
    const earlyExtZ = isBad ? -0.14 * downswingT : 0;
    const headBobY = isBad ? 0.16 * backswingT - 0.12 * downswingT : 0;

    // Shoulder & Hip rotation angles (radians)
    const maxShoulderRad = ((isBad ? 68 : 88) * Math.PI) / 180;
    const maxHipRad = ((isBad ? 36 : 45) * Math.PI) / 180;
    const finishRotRad = (-95 * Math.PI) / 180;

    const shoulderYaw =
      sign * (backswingT * maxShoulderRad + followT * finishRotRad);
    const hipYaw =
      sign * (backswingT * maxHipRad + (downswingT * -0.35 + followT * -1.15));

    const lms: Landmark[] = Array.from({ length: 33 }, () => ({
      x: 0,
      y: 0,
      z: 0,
      visibility: 0.99,
    }));

    // Hips (centered around 0,0,0)
    const hipHalfW = 0.22;
    lms[POSE_LANDMARKS.LEFT_HIP] = {
      x: hipSwayX - Math.cos(hipYaw) * hipHalfW,
      y: 0,
      z: -Math.sin(hipYaw) * hipHalfW,
      visibility: 0.99,
    };
    lms[POSE_LANDMARKS.RIGHT_HIP] = {
      x: hipSwayX + Math.cos(hipYaw) * hipHalfW,
      y: 0,
      z: Math.sin(hipYaw) * hipHalfW,
      visibility: 0.99,
    };

    // Shoulders (torso length = 1.0 above hips, tilted forward in Z)
    const shHalfW = 0.34;
    const shCenterX = hipSwayX * 0.7;
    const shCenterY = -0.92 + headBobY * 0.6;
    const shCenterZ = -0.32 - earlyExtZ;

    lms[POSE_LANDMARKS.LEFT_SHOULDER] = {
      x: shCenterX - Math.cos(shoulderYaw) * shHalfW,
      y: shCenterY,
      z: shCenterZ - Math.sin(shoulderYaw) * shHalfW,
      visibility: 0.99,
    };
    lms[POSE_LANDMARKS.RIGHT_SHOULDER] = {
      x: shCenterX + Math.cos(shoulderYaw) * shHalfW,
      y: shCenterY,
      z: shCenterZ + Math.sin(shoulderYaw) * shHalfW,
      visibility: 0.99,
    };

    // Head / Nose
    lms[POSE_LANDMARKS.NOSE] = {
      x: shCenterX + (isBad ? -sign * 0.16 * backswingT : 0),
      y: -1.32 + headBobY,
      z: shCenterZ - 0.12,
      visibility: 0.99,
    };

    // Knees & Ankles
    lms[POSE_LANDMARKS.LEFT_KNEE] = {
      x: -0.25 + hipSwayX * 0.4,
      y: 0.78,
      z: -0.14,
      visibility: 0.99,
    };
    lms[POSE_LANDMARKS.RIGHT_KNEE] = {
      x: 0.25 + hipSwayX * 0.4,
      y: 0.78,
      z: -0.14,
      visibility: 0.99,
    };
    lms[POSE_LANDMARKS.LEFT_ANKLE] = { x: -0.27, y: 1.55, z: -0.04, visibility: 0.99 };
    lms[POSE_LANDMARKS.RIGHT_ANKLE] = { x: 0.27, y: 1.55, z: -0.04, visibility: 0.99 };

    // Hand Grip & Elbows across Swing Arc
    const swingAngle =
      backswingT * (Math.PI * 0.78) - followT * (Math.PI * 0.82);
    const arcRadius = isBad ? 0.66 : isImproved ? 0.75 : 0.82;

    const gripX = shCenterX + sign * Math.sin(swingAngle) * arcRadius;
    const gripY = -0.32 - Math.abs(Math.sin(swingAngle)) * 0.92;
    const gripZ = -0.52 + Math.abs(Math.sin(swingAngle)) * 0.28;

    lms[POSE_LANDMARKS.LEFT_WRIST] = { x: gripX - 0.03, y: gripY, z: gripZ, visibility: 0.99 };
    lms[POSE_LANDMARKS.RIGHT_WRIST] = { x: gripX + 0.03, y: gripY, z: gripZ, visibility: 0.99 };

    // Chicken wing bend on bad/improved swing
    const chickenWingOut = isBad ? 0.24 * (backswingT + downswingT) : isImproved ? 0.1 * backswingT : 0.02;
    const lSh = lms[POSE_LANDMARKS.LEFT_SHOULDER];
    const rSh = lms[POSE_LANDMARKS.RIGHT_SHOULDER];

    lms[POSE_LANDMARKS.LEFT_ELBOW] = {
      x: (lSh.x + gripX) * 0.5 - chickenWingOut,
      y: (lSh.y + gripY) * 0.5 + chickenWingOut * 0.7,
      z: (lSh.z + gripZ) * 0.5 - 0.06,
      visibility: 0.99,
    };
    lms[POSE_LANDMARKS.RIGHT_ELBOW] = {
      x: (rSh.x + gripX) * 0.5 + 0.08,
      y: (rSh.y + gripY) * 0.5 + 0.06,
      z: (rSh.z + gripZ) * 0.5 - 0.05,
      visibility: 0.99,
    };

    frames.push(lms);
  }

  return frames;
}

function computeSyntheticJointErrors(
  userFrames: Landmark[][],
  refFrames: Landmark[][]
): Record<number, number>[] {
  const out: Record<number, number>[] = [];
  const count = Math.min(userFrames.length, refFrames.length);
  for (let f = 0; f < count; f++) {
    const map: Record<number, number> = {};
    for (const j of KEY_SKELETON_JOINTS) {
      const u = userFrames[f][j];
      const r = refFrames[f][j];
      if (u && r) {
        map[j] = Math.hypot(u.x - r.x, u.y - r.y, (u.z - r.z) * 0.5);
      }
    }
    out.push(map);
  }
  return out;
}
