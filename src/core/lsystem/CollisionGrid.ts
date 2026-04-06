import type { Vec3 } from '../../utils/math';
import { vec3Sub, vec3Add, vec3Scale, vec3Dot, vec3Cross, vec3Length, vec3Normalize } from '../../utils/math';
import { SpatialHash } from '../../utils/SpatialHash';

/** A line-segment with radius, representing a branch for collision detection. */
export interface Capsule {
  start: Vec3;
  end: Vec3;
  radius: number;
}

/**
 * Spatial hash grid for fast capsule proximity queries during tree generation.
 *
 * Branches are inserted as capsules (line segment + radius). Queries find
 * nearby capsules to test for collision before committing a new branch segment.
 */
export class CollisionGrid {
  private grid: SpatialHash<Capsule>;

  constructor(cellSize: number = 1.0) {
    this.grid = new SpatialHash<Capsule>(cellSize);
  }

  /** Insert a capsule into all cells it overlaps. */
  insert(capsule: Capsule): void {
    const pad = capsule.radius;
    const minX = Math.min(capsule.start[0], capsule.end[0]) - pad;
    const minY = Math.min(capsule.start[1], capsule.end[1]) - pad;
    const minZ = Math.min(capsule.start[2], capsule.end[2]) - pad;
    const maxX = Math.max(capsule.start[0], capsule.end[0]) + pad;
    const maxY = Math.max(capsule.start[1], capsule.end[1]) + pad;
    const maxZ = Math.max(capsule.start[2], capsule.end[2]) + pad;
    this.grid.insert(capsule, minX, minY, minZ, maxX, maxY, maxZ);
  }

  /** Query all capsules in cells near a point within searchRadius. */
  queryNearby(point: Vec3, searchRadius: number): Capsule[] {
    const result: Capsule[] = [];
    const seen = new Set<Capsule>();
    this.grid.queryRaw(point, searchRadius, (cap) => {
      if (!seen.has(cap)) {
        seen.add(cap);
        result.push(cap);
      }
    });
    return result;
  }

  clear(): void {
    this.grid.clear();
  }
}

/**
 * Compute the minimum distance between a point and a line segment.
 * Returns the closest point on the segment and the distance.
 */
export function pointToSegmentDistance(
  point: Vec3, segStart: Vec3, segEnd: Vec3,
): { distance: number; closest: Vec3 } {
  const ab = vec3Sub(segEnd, segStart);
  const ap = vec3Sub(point, segStart);
  const abLen2 = vec3Dot(ab, ab);

  if (abLen2 < 1e-10) {
    // Degenerate segment (zero length)
    const d = vec3Sub(point, segStart);
    return { distance: vec3Length(d), closest: [...segStart] };
  }

  let t = vec3Dot(ap, ab) / abLen2;
  t = Math.max(0, Math.min(1, t));

  const closest: Vec3 = vec3Add(segStart, vec3Scale(ab, t));
  return { distance: vec3Length(vec3Sub(point, closest)), closest };
}

/**
 * Compute closest distance between two line segments (segment-to-segment).
 * Returns the distance and the closest point on segment B.
 */
function segmentToSegmentDistance(
  a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3,
): { distance: number; closestOnB: Vec3 } {
  // Sample several points along segment A and find min distance to segment B
  let minDist = Infinity;
  let bestClosest: Vec3 = [...b0];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const pt: Vec3 = [
      a0[0] + (a1[0] - a0[0]) * t,
      a0[1] + (a1[1] - a0[1]) * t,
      a0[2] + (a1[2] - a0[2]) * t,
    ];
    const { distance, closest } = pointToSegmentDistance(pt, b0, b1);
    if (distance < minDist) {
      minDist = distance;
      bestClosest = closest;
    }
  }
  return { distance: minDist, closestOnB: bestClosest };
}

/**
 * Check if a proposed new segment collides with any capsules near it.
 * Returns an avoidance direction if collision is detected, or null if clear.
 *
 * Queries along the FULL segment (start, midpoint, end) to catch collisions
 * anywhere along its length, not just at the tip.
 */
export function checkCollision(
  grid: CollisionGrid,
  segStart: Vec3,
  segEnd: Vec3,
  segRadius: number,
  collisionRadius: number,
): Vec3 | null {
  // Use a generous minimum search radius so thin branches still detect
  // collisions with the trunk and thick branches nearby.
  const minSearchRadius = 0.5;
  const searchRadius = Math.max(minSearchRadius, segRadius * collisionRadius * 3);

  // Query at multiple points along the segment to catch mid-segment collisions
  const mid: Vec3 = [
    (segStart[0] + segEnd[0]) * 0.5,
    (segStart[1] + segEnd[1]) * 0.5,
    (segStart[2] + segEnd[2]) * 0.5,
  ];
  const nearbyEnd = grid.queryNearby(segEnd, searchRadius);
  const nearbyMid = grid.queryNearby(mid, searchRadius);

  // Merge without duplicates
  const seen = new Set<Capsule>(nearbyEnd);
  for (const c of nearbyMid) seen.add(c);
  const nearby = Array.from(seen);

  let closestDist = Infinity;
  let avoidDir: Vec3 | null = null;

  for (const cap of nearby) {
    // Skip if this capsule shares a start position with ours (same branch origin).
    // Use a small tolerance — capsules from the same turtle position.
    const dx = cap.start[0] - segStart[0];
    const dy = cap.start[1] - segStart[1];
    const dz = cap.start[2] - segStart[2];
    if (dx * dx + dy * dy + dz * dz < 1e-4) continue;

    // Also skip if the capsule END matches our start (parent segment we just came from)
    const ex = cap.end[0] - segStart[0];
    const ey = cap.end[1] - segStart[1];
    const ez = cap.end[2] - segStart[2];
    if (ex * ex + ey * ey + ez * ez < 1e-4) continue;

    // Full segment-to-segment distance test
    const { distance, closestOnB } = segmentToSegmentDistance(
      segStart, segEnd, cap.start, cap.end,
    );
    const combinedRadius = (segRadius + cap.radius) * collisionRadius;

    if (distance < combinedRadius && distance < closestDist) {
      closestDist = distance;

      // Avoidance direction: push midpoint of new segment away from closest
      // point on the existing capsule
      const awayFrom = vec3Sub(mid, closestOnB);
      const awayLen = vec3Length(awayFrom);
      if (awayLen > 1e-6) {
        avoidDir = vec3Normalize(awayFrom);
      } else {
        // Exactly overlapping — pick arbitrary perpendicular to heading
        const segDir = vec3Sub(segEnd, segStart);
        const perp = vec3Cross(segDir, [0, 1, 0]);
        avoidDir = vec3Length(perp) > 0.01
          ? vec3Normalize(perp)
          : vec3Normalize(vec3Cross(segDir, [1, 0, 0]));
      }
    }
  }

  return avoidDir;
}
