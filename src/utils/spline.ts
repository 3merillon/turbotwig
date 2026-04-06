import type { Vec3 } from './math';
import { vec3Sub, vec3Add, vec3Scale, vec3Length } from './math';

/**
 * Catmull-Rom spline through a set of control points.
 * Provides smooth interpolation for branch paths.
 */
export class CatmullRomSpline {
  readonly points: Vec3[];
  private arcLengths: number[] | null = null;
  private totalLength: number = 0;
  private alpha: number;

  constructor(points: Vec3[], alpha: number = 0.5) {
    this.points = points;
    this.alpha = alpha; // 0 = uniform, 0.5 = centripetal, 1 = chordal
  }

  /**
   * Evaluate spline at parameter t in [0, 1].
   */
  evaluate(t: number): Vec3 {
    if (this.points.length < 2) return this.points[0] ?? [0, 0, 0];
    if (this.points.length === 2) {
      return vec3Add(
        vec3Scale(this.points[0], 1 - t),
        vec3Scale(this.points[1], t),
      );
    }

    const n = this.points.length - 1;
    const segT = t * n;
    const seg = Math.min(Math.floor(segT), n - 1);
    const localT = segT - seg;

    // Get 4 control points with clamped boundary handling
    const p0 = this.points[Math.max(0, seg - 1)];
    const p1 = this.points[seg];
    const p2 = this.points[Math.min(n, seg + 1)];
    const p3 = this.points[Math.min(n, seg + 2)];

    return this.catmullRom(p0, p1, p2, p3, localT);
  }

  /**
   * Evaluate tangent at parameter t.
   */
  tangent(t: number): Vec3 {
    const dt = 0.001;
    const a = this.evaluate(Math.max(0, t - dt));
    const b = this.evaluate(Math.min(1, t + dt));
    const d = vec3Sub(b, a);
    const len = vec3Length(d);
    if (len < 1e-10) return [0, 1, 0];
    return vec3Scale(d, 1 / len);
  }

  /**
   * Get total arc length of the spline.
   */
  getArcLength(): number {
    this.ensureArcLengths();
    return this.totalLength;
  }

  /**
   * Convert arc-length parameter s in [0, totalLength] to t in [0, 1].
   */
  arcLengthToT(s: number): number {
    this.ensureArcLengths();
    if (this.totalLength <= 0) return 0;

    const target = Math.max(0, Math.min(s, this.totalLength));
    const lengths = this.arcLengths!;

    // Binary search
    let lo = 0;
    let hi = lengths.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] < target) lo = mid;
      else hi = mid;
    }

    const segLen = lengths[hi] - lengths[lo];
    if (segLen < 1e-10) return lo / (lengths.length - 1);

    const frac = (target - lengths[lo]) / segLen;
    return (lo + frac) / (lengths.length - 1);
  }

  private ensureArcLengths() {
    if (this.arcLengths) return;

    const steps = Math.max(this.points.length * 10, 50);
    this.arcLengths = new Array(steps + 1);
    this.arcLengths[0] = 0;

    let prev = this.evaluate(0);
    let cumLen = 0;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cur = this.evaluate(t);
      cumLen += vec3Length(vec3Sub(cur, prev));
      this.arcLengths[i] = cumLen;
      prev = cur;
    }

    this.totalLength = cumLen;
  }

  private catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
    const t2 = t * t;
    const t3 = t2 * t;
    const result: Vec3 = [0, 0, 0];

    for (let i = 0; i < 3; i++) {
      const v0 = p0[i], v1 = p1[i], v2 = p2[i], v3 = p3[i];
      result[i] =
        0.5 * (
          (2 * v1) +
          (-v0 + v2) * t +
          (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
          (-v0 + 3 * v1 - 3 * v2 + v3) * t3
        );
    }

    return result;
  }
}
