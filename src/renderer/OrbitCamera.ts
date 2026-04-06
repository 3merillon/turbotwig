import { mat4Perspective, mat4LookAt, mat4Multiply } from './math';

/** Orbit camera with damped rotation, panning, zoom, and multi-touch support. */
export class OrbitCamera {
  // Spherical coords
  private azimuth = Math.PI * 0.75; // horizontal angle
  private polar = Math.PI * 0.35;   // vertical angle from top
  private radius = 24;

  // Target
  target: [number, number, number] = [0, 5, 0];

  // Projection
  fov = 45 * Math.PI / 180;
  aspect = 1;
  near = 0.1;
  far = 500;

  // Limits
  minDistance = 3;
  maxDistance = 100;
  maxPolarAngle = Math.PI * 0.9;
  minPolarAngle = 0.01;

  // Damping
  dampingFactor = 0.08;
  private targetAzimuth: number;
  private targetPolar: number;
  private targetRadius: number;
  private targetTarget: [number, number, number];

  // Matrices (updated each frame)
  readonly viewMatrix = new Float32Array(16);
  readonly projectionMatrix = new Float32Array(16);
  readonly viewProjectionMatrix = new Float32Array(16);
  readonly position: [number, number, number] = [0, 0, 0];

  // Input state
  private isDragging = false;
  private isPanning = false;
  private lastX = 0;
  private lastY = 0;
  private canvas: HTMLCanvasElement;

  // Multi-touch state
  private pointers = new Map<number, { x: number; y: number }>();
  private lastPinchDist = 0;
  private lastMidX = 0;
  private lastMidY = 0;

  /** Attach orbit controls to the given canvas and initialize the camera. */
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.targetAzimuth = this.azimuth;
    this.targetPolar = this.polar;
    this.targetRadius = this.radius;
    this.targetTarget = [...this.target];

    // Set initial camera to match Three.js: position (15, 12, 15) looking at (0, 5, 0)
    const dx = 15, dy = 12 - 5, dz = 15;
    this.radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.azimuth = Math.atan2(dx, dz);
    this.polar = Math.acos(dy / this.radius);
    this.targetAzimuth = this.azimuth;
    this.targetPolar = this.polar;
    this.targetRadius = this.radius;

    this.bindEvents();
    this.updateMatrices();
  }

  private bindEvents(): void {
    const c = this.canvas;
    c.style.touchAction = 'none'; // prevent browser gestures
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.canvas.setPointerCapture(e.pointerId);

    if (this.pointers.size === 2) {
      // Two fingers down — start pinch/pan, cancel any single-finger drag
      this.isDragging = false;
      this.isPanning = false;
      const [a, b] = [...this.pointers.values()];
      this.lastPinchDist = Math.hypot(b.x - a.x, b.y - a.y);
      this.lastMidX = (a.x + b.x) / 2;
      this.lastMidY = (a.y + b.y) / 2;
    } else if (this.pointers.size === 1) {
      if (e.button === 0) {
        this.isDragging = true;
      } else if (e.button === 2) {
        this.isPanning = true;
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      // Pinch zoom + two-finger pan
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;

      // Pinch zoom
      if (this.lastPinchDist > 0) {
        const scale = this.lastPinchDist / dist;
        this.targetRadius *= scale;
        this.targetRadius = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetRadius));
      }

      // Two-finger pan
      const pdx = midX - this.lastMidX;
      const pdy = midY - this.lastMidY;
      const speed = 0.003 * this.radius;
      const sinA = Math.sin(this.azimuth);
      const cosA = Math.cos(this.azimuth);
      const rx = cosA, rz = -sinA;
      this.targetTarget[0] += (-pdx * rx) * speed;
      this.targetTarget[1] += pdy * speed;
      this.targetTarget[2] += (-pdx * rz) * speed;

      this.lastPinchDist = dist;
      this.lastMidX = midX;
      this.lastMidY = midY;
      return;
    }

    // Single pointer
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.isDragging) {
      const speed = 0.005;
      this.targetAzimuth -= dx * speed;
      this.targetPolar += dy * speed;
      this.targetPolar = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, this.targetPolar));
    } else if (this.isPanning) {
      const speed = 0.003 * this.radius;
      const sinA = Math.sin(this.azimuth);
      const cosA = Math.cos(this.azimuth);
      const rx = cosA, rz = -sinA;
      this.targetTarget[0] += (-dx * rx) * speed;
      this.targetTarget[1] += dy * speed;
      this.targetTarget[2] += (-dx * rz) * speed;
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    this.canvas.releasePointerCapture(e.pointerId);

    if (this.pointers.size === 0) {
      this.isDragging = false;
      this.isPanning = false;
    } else if (this.pointers.size === 1) {
      // Went from 2 fingers to 1 — reset single-pointer tracking to avoid jump
      const [p] = [...this.pointers.values()];
      this.lastX = p.x;
      this.lastY = p.y;
      this.isDragging = true;
      this.isPanning = false;
      this.lastPinchDist = 0;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const zoomSpeed = 0.001 * this.radius;
    this.targetRadius += e.deltaY * zoomSpeed;
    this.targetRadius = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetRadius));
  };

  /** Call once per frame to apply damping and recompute matrices. */
  update(): void {
    const d = this.dampingFactor;
    const id = 1 - d;

    // Interpolate toward targets (damping = exponential smoothing per tick,
    // same feel as Three.js OrbitControls damping)
    // Use a faster lerp so the camera doesn't feel sluggish
    const lerpFactor = 1 - Math.pow(1 - d, 2);
    this.azimuth += (this.targetAzimuth - this.azimuth) * lerpFactor;
    this.polar += (this.targetPolar - this.polar) * lerpFactor;
    this.radius += (this.targetRadius - this.radius) * lerpFactor;
    this.target[0] += (this.targetTarget[0] - this.target[0]) * lerpFactor;
    this.target[1] += (this.targetTarget[1] - this.target[1]) * lerpFactor;
    this.target[2] += (this.targetTarget[2] - this.target[2]) * lerpFactor;

    this.updateMatrices();
  }

  private updateMatrices(): void {
    // Spherical to Cartesian
    const sinP = Math.sin(this.polar);
    const cosP = Math.cos(this.polar);
    const sinA = Math.sin(this.azimuth);
    const cosA = Math.cos(this.azimuth);

    this.position[0] = this.target[0] + this.radius * sinP * sinA;
    this.position[1] = this.target[1] + this.radius * cosP;
    this.position[2] = this.target[2] + this.radius * sinP * cosA;

    const view = mat4LookAt(this.position, this.target, [0, 1, 0]);
    const proj = mat4Perspective(this.fov, this.aspect, this.near, this.far);
    const vp = mat4Multiply(proj, view);

    this.viewMatrix.set(view);
    this.projectionMatrix.set(proj);
    this.viewProjectionMatrix.set(vp);
  }

  /** Get the camera's quaternion for gizmo alignment (returns [x, y, z, w]). */
  getQuaternion(): [number, number, number, number] {
    // Extract from view matrix (rotation part is the transpose of the upper-left 3x3)
    const m = this.viewMatrix;
    const trace = m[0] + m[5] + m[10];
    let x: number, y: number, z: number, w: number;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      w = 0.25 / s;
      x = (m[6] - m[9]) * s;
      y = (m[8] - m[2]) * s;
      z = (m[1] - m[4]) * s;
    } else if (m[0] > m[5] && m[0] > m[10]) {
      const s = 2.0 * Math.sqrt(1.0 + m[0] - m[5] - m[10]);
      w = (m[6] - m[9]) / s;
      x = 0.25 * s;
      y = (m[4] + m[1]) / s;
      z = (m[8] + m[2]) / s;
    } else if (m[5] > m[10]) {
      const s = 2.0 * Math.sqrt(1.0 + m[5] - m[0] - m[10]);
      w = (m[8] - m[2]) / s;
      x = (m[4] + m[1]) / s;
      y = 0.25 * s;
      z = (m[9] + m[6]) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + m[10] - m[0] - m[5]);
      w = (m[1] - m[4]) / s;
      x = (m[8] + m[2]) / s;
      y = (m[9] + m[6]) / s;
      z = 0.25 * s;
    }
    return [x, y, z, w];
  }

  /** Update the projection aspect ratio and recompute matrices. */
  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.updateMatrices();
  }

  /** Remove all pointer and wheel event listeners from the canvas. */
  dispose(): void {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('wheel', this.onWheel);
  }
}
