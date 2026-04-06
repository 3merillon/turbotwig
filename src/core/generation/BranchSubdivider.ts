import type { BranchSegment, TreeSkeleton } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import {
  vec3Add, vec3Sub, vec3Scale, vec3Normalize,
  vec3Cross, vec3Length,
} from '../../utils/math';
import { SeededRandom } from '../../utils/random';

export interface SubdivisionOptions {
  /** Minimum number of control points per branch. Branches with fewer get subdivided. */
  minPoints: number;
  /** Random perpendicular offset as fraction of segment length. */
  jitterAmount: number;
  /** Gravity droop added per subdivision point (world units downward). */
  droopPerPoint: number;
}

const DEFAULT_OPTIONS: SubdivisionOptions = {
  minPoints: 4,
  jitterAmount: 0.06,
  droopPerPoint: 0.02,
};

/** Seed offset to decorrelate subdivision RNG from other pipeline stages. */
const SUBDIVIDER_SEED_OFFSET = 55555;

/**
 * Subdivides branches that have too few control points, adding slight
 * random perturbation for organic curvature. Without this, short branches
 * (single F command) are perfectly straight sticks.
 *
 * Runs after turtle generation, before relaxation and mesh building.
 * Modifies segment.points[] and segment.radii[] in place.
 */
export function subdivideBranches(
  skeleton: TreeSkeleton,
  seed: number,
  options: Partial<SubdivisionOptions> = {},
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const rng = new SeededRandom(seed + SUBDIVIDER_SEED_OFFSET);

  for (const seg of skeleton.segments) {
    if (seg.isRoot) continue;
    if (seg.points.length >= opts.minPoints) continue;

    const oldPoints = seg.points;
    const oldRadii = seg.radii;
    const nOld = oldPoints.length;
    if (nOld < 2) continue;

    // Target: split each existing span into enough sub-segments
    // to reach minPoints total
    const targetPts = opts.minPoints;
    const newPoints: Vec3[] = [oldPoints[0]];
    const newRadii: number[] = [oldRadii[0]];

    for (let i = 0; i < nOld - 1; i++) {
      const p0 = oldPoints[i];
      const p1 = oldPoints[i + 1];
      const r0 = oldRadii[i];
      const r1 = oldRadii[Math.min(i + 1, oldRadii.length - 1)];

      // How many subdivisions for this span
      const spansNeeded = Math.max(1, Math.ceil(
        (targetPts - nOld) / Math.max(1, nOld - 1),
      ));
      const totalSubs = spansNeeded + 1;

      const dir = vec3Sub(p1, p0);
      const spanLen = vec3Length(dir);
      if (spanLen < 1e-6) {
        newPoints.push(p1);
        newRadii.push(r1);
        continue;
      }

      const spanDir = vec3Normalize(dir);

      // Build a perpendicular frame for jitter
      let perp1: Vec3;
      if (Math.abs(spanDir[1]) < 0.95) {
        perp1 = vec3Normalize(vec3Cross(spanDir, [0, 1, 0]));
      } else {
        perp1 = vec3Normalize(vec3Cross(spanDir, [1, 0, 0]));
      }
      const perp2 = vec3Normalize(vec3Cross(spanDir, perp1));

      for (let s = 1; s <= totalSubs; s++) {
        const t = s / totalSubs;

        // Interpolated position
        const base: Vec3 = [
          p0[0] + dir[0] * t,
          p0[1] + dir[1] * t,
          p0[2] + dir[2] * t,
        ];

        // Add perpendicular jitter (not at the endpoints)
        if (s < totalSubs) {
          const jitter = opts.jitterAmount * spanLen;
          // Smooth jitter that peaks at midpoint: sin curve
          const envelope = Math.sin(t * Math.PI);
          const dx = rng.gaussian(0, jitter * envelope);
          const dz = rng.gaussian(0, jitter * envelope);
          base[0] += perp1[0] * dx + perp2[0] * dz;
          base[1] += perp1[1] * dx + perp2[1] * dz;
          base[2] += perp1[2] * dx + perp2[2] * dz;

          // Gentle gravity droop, increasing toward tip
          base[1] -= opts.droopPerPoint * t * envelope;
        }

        newPoints.push(base);
        newRadii.push(r0 + (r1 - r0) * t);
      }
    }

    seg.points = newPoints;
    seg.radii = newRadii;
    seg.startPos = [...newPoints[0]];
    seg.endPos = [...newPoints[newPoints.length - 1]];
  }
}
