import type { BranchSegment, TreeSkeleton } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import { SpatialHash } from '../../utils/SpatialHash';

/**
 * Options for the iterative branch relaxation solver.
 */
export interface RelaxationOptions {
  /** Number of solver iterations (more = better resolution, slower). */
  iterations: number;
  /** Strength of repulsion forces (0-1). Higher = more aggressive avoidance. */
  strength: number;
  /** Radius multiplier for detecting nearby branches (1 = exact, 2 = generous padding). */
  radiusMultiplier: number;
  /** Stiffness exponent — how much thicker branches resist bending (1 = linear, 2 = quadratic). */
  stiffnessExponent: number;
  /** Gaussian smoothing kernel half-width in control points. */
  smoothingWidth: number;
  /** Optional callback after each iteration (iter 1-based, total). */
  onIterationComplete?: (iter: number, total: number) => void;
}

const DEFAULT_OPTIONS: RelaxationOptions = {
  iterations: 6,
  strength: 0.1,
  radiusMultiplier: 1.0,
  stiffnessExponent: 1.5,
  smoothingWidth: 3,
};

// ============================================================
// Solver tuning constants
// ============================================================

/** Padding added to capsule AABB when inserting into the spatial hash (world units). */
const GRID_INSERT_PADDING = 0.1;

/** Maximum cells a single capsule may occupy to prevent Map explosion from degenerate geometry. */
const MAX_CELLS_PER_CAPSULE = 64;

/** Spatial hash cell size (world units). Trades memory for query speed. */
const GRID_CELL_SIZE = 1.5;

/** Additive padding for local search radius to catch near-misses (world units). */
const SEARCH_RADIUS_PADDING = 0.3;

/** Scale factor for a sample's own radius to bound the local maximum radius. */
const LOCAL_RADIUS_SCALE = 4;

/** Additive offset for the local max radius cap (world units). */
const LOCAL_RADIUS_OFFSET = 0.15;

/** Quick pre-check distance multiplier (squared): 4 means check within 2x the combined radius. */
const PRECHECK_DIST_SQ_FACTOR = 4;

/** Sub-sample interval along each edge for collision detection (world units). */
const COLLISION_SUBSAMPLE_INTERVAL = 0.5;

/** Maximum sub-samples per edge segment. */
const MAX_SUBSAMPLES_PER_EDGE = 4;

/** Fraction of stiffness applied (1 = fully stiff branches are immovable, 0.8 = 80%). */
const MAX_STIFFNESS_COMPLIANCE = 0.8;

/** Fraction of branch span used as dead zone for the restoring force. */
const JITTER_DEAD_ZONE_FRACTION = 0.06;

/** Strength of the restoring force that pulls points back toward their original position. */
const RESTORING_FORCE_STRENGTH = 0.5;

/** Gaussian sigma as a fraction of the kernel half-width (controls smoothing falloff). */
const GAUSSIAN_SIGMA_FRACTION = 0.7;

/** Fraction of branch length used as anchor zone (protects sockets from displacement). */
const ANCHOR_ZONE_FRACTION = 0.25;

/** Minimum anchor zone width in control points (prevents tiny branches from being fully mobile). */
const MIN_ANCHOR_ZONE_POINTS = 3;

/** Maximum displacement per point per iteration (world units). Prevents explosive corrections. */
const MAX_DISPLACEMENT_PER_STEP = 0.5;

/** Convergence threshold: if max displacement falls below this, stop iterating early. */
const CONVERGENCE_THRESHOLD = 0.001;

/** Maximum distance (squared) for fallback parent search when topology is missing. */
const MAX_PARENT_SEARCH_DIST_SQ = 4;

/** Total control-point count above which relaxation is skipped entirely. */
const MAX_TOTAL_POINTS = 80_000;

/** Point count threshold above which solver iterations are auto-reduced. */
const LARGE_TREE_POINT_THRESHOLD = 30_000;

/** Maximum solver iterations for trees above the large-tree threshold. */
const LARGE_TREE_MAX_ITERS = 3;

// ============================================================
// Spatial hash for complete skeleton
// ============================================================

interface CapsuleRef {
  segId: number;
  pointIdx: number;
  p0: Vec3;
  p1: Vec3;
  radius: number;
  lastVisited: number;
}

class RelaxGrid {
  private grid: SpatialHash<CapsuleRef>;
  private queryGen = 0;
  constructor(cellSize: number) {
    this.grid = new SpatialHash<CapsuleRef>(cellSize);
  }

  clear() { this.grid.clear(); }

  insert(cap: CapsuleRef): void {
    const pad = cap.radius + GRID_INSERT_PADDING;
    const minX = Math.min(cap.p0[0], cap.p1[0]) - pad;
    const minY = Math.min(cap.p0[1], cap.p1[1]) - pad;
    const minZ = Math.min(cap.p0[2], cap.p1[2]) - pad;
    const maxX = Math.max(cap.p0[0], cap.p1[0]) + pad;
    const maxY = Math.max(cap.p0[1], cap.p1[1]) + pad;
    const maxZ = Math.max(cap.p0[2], cap.p1[2]) + pad;
    if (!this.grid.insert(cap, minX, minY, minZ, maxX, maxY, maxZ, MAX_CELLS_PER_CAPSULE)) {
      console.warn(`[Relaxation] Capsule seg=${cap.segId} pt=${cap.pointIdx} spans too many cells (radius=${cap.radius.toFixed(3)}), skipping spatial insert`);
    }
  }

  query(point: Vec3, searchRadius: number): CapsuleRef[] {
    const result: CapsuleRef[] = [];
    const gen = ++this.queryGen;
    this.grid.queryRaw(point, searchRadius, (c) => {
      if (c.lastVisited !== gen) {
        c.lastVisited = gen;
        result.push(c);
      }
    });
    return result;
  }
}

// ============================================================
// Geometry helpers (inlined in hot loops, kept here for non-hot paths)
// ============================================================

function radiusAt(seg: BranchSegment, idx: number): number {
  if (seg.radii.length === 0) return 0.01;
  if (idx <= 0) return seg.radii[0];
  if (idx >= seg.radii.length - 1) return seg.radii[seg.radii.length - 1];
  return seg.radii[idx];
}

// ============================================================
// Find where a child attaches to a parent's point array
// ============================================================

function findAttachment(
  child: BranchSegment,
  byId: Map<number, BranchSegment>,
  allSegments: BranchSegment[],
): { parent: BranchSegment; pointIdx: number } | null {
  let parent = child.parentId >= 0 ? byId.get(child.parentId) : undefined;

  if (!parent) {
    let bestDist = Infinity;
    for (const seg of allSegments) {
      if (seg.id === child.id) continue;
      if (seg.depth >= child.depth && !child.isRoot) continue;
      for (const p of seg.points) {
        const dx = p[0] - child.startPos[0];
        const dy = p[1] - child.startPos[1];
        const dz = p[2] - child.startPos[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) { bestDist = d; parent = seg; }
      }
    }
    if (!parent || bestDist > MAX_PARENT_SEARCH_DIST_SQ) return null;
  }

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < parent.points.length; i++) {
    const p = parent.points[i];
    const dx = p[0] - child.points[0][0];
    const dy = p[1] - child.points[0][1];
    const dz = p[2] - child.points[0][2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }

  return { parent, pointIdx: bestIdx };
}

// ============================================================
// Extracted solver sub-routines
// ============================================================

/**
 * Compute collision displacements for a single segment against the spatial hash.
 * Writes results into `dispBuf` (vec3 per control point, index 0 is anchor — untouched).
 * Also writes bilateral forces into `extForceBufs` for segments pushed by this one.
 */
function computeCollisionDisplacements(
  seg: BranchSegment,
  nPts: number,
  grid: RelaxGrid,
  opts: RelaxationOptions,
  iterStrength: number,
  compliance: number,
  maxRadius: number,
  byId: Map<number, BranchSegment>,
  dispBuf: Float64Array,
  extForceBufs: Map<number, Float64Array>,
): void {
  for (let pi = 1; pi < nPts; pi++) {
    const p0x = seg.points[pi - 1][0], p0y = seg.points[pi - 1][1], p0z = seg.points[pi - 1][2];
    const p1x = seg.points[pi][0], p1y = seg.points[pi][1], p1z = seg.points[pi][2];
    const edx = p1x - p0x, edy = p1y - p0y, edz = p1z - p0z;
    const segLen = Math.sqrt(edx * edx + edy * edy + edz * edz);
    const numSamples = Math.max(1, Math.min(MAX_SUBSAMPLES_PER_EDGE, Math.ceil(segLen / COLLISION_SUBSAMPLE_INTERVAL)));

    for (let si = 0; si < numSamples; si++) {
      const t = (si + 1) / numSamples;
      const spx = p0x + edx * t;
      const spy = p0y + edy * t;
      const spz = p0z + edz * t;
      const sampleR = radiusAt(seg, pi - 1) * (1 - t) + radiusAt(seg, pi) * t;
      const localMaxR = Math.min(maxRadius, sampleR * LOCAL_RADIUS_SCALE + LOCAL_RADIUS_OFFSET);
      const searchR = (sampleR + localMaxR) * opts.radiusMultiplier + SEARCH_RADIUS_PADDING;
      const nearby = grid.query([spx, spy, spz] as Vec3, searchR);

      for (const cap of nearby) {
        // Same-segment collision: skip only adjacent edges (which always touch
        // each other by construction). Non-adjacent edges in the same branch
        // catch self-intersections from large kinks bending a branch back
        // into itself.
        if (cap.segId === seg.id) {
          const edgeDelta = cap.pointIdx - (pi - 1);
          if (edgeDelta >= -1 && edgeDelta <= 1) continue;
        }

        // Inline pointToSegDist
        const abx = cap.p1[0] - cap.p0[0];
        const aby = cap.p1[1] - cap.p0[1];
        const abz = cap.p1[2] - cap.p0[2];
        const apx = spx - cap.p0[0];
        const apy = spy - cap.p0[1];
        const apz = spz - cap.p0[2];
        const len2 = abx * abx + aby * aby + abz * abz;
        let ct: number;
        if (len2 < 1e-10) {
          ct = 0;
        } else {
          ct = (apx * abx + apy * aby + apz * abz) / len2;
          if (ct < 0) ct = 0; else if (ct > 1) ct = 1;
        }
        const cx = cap.p0[0] + abx * ct;
        const cy = cap.p0[1] + aby * ct;
        const cz = cap.p0[2] + abz * ct;
        const dx = spx - cx, dy = spy - cy, dz = spz - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Depth-aware: thick branch pairs get full multiplier, thin pairs fade toward 1.0
        const pairMaxR = Math.max(sampleR, cap.radius);
        const pairNormR = Math.min(1, pairMaxR / maxRadius);
        const effectiveMultiplier = 1.0 + (opts.radiusMultiplier - 1.0) * pairNormR;
        const combinedR = (sampleR + cap.radius) * effectiveMultiplier;

        if (dist < combinedR) {
          const penetration = combinedR - dist;
          let pushX: number, pushY: number, pushZ: number;
          if (dist > 1e-6) {
            const invDist = 1 / dist;
            pushX = dx * invDist;
            pushY = dy * invDist;
            pushZ = dz * invDist;
          } else {
            // Cross product of edge direction with up
            let crx = edy * 0 - edz * 1;
            let cry = edz * 0 - edx * 0;
            let crz = edx * 1 - edy * 0;
            let crLen = Math.sqrt(crx * crx + cry * cry + crz * crz);
            if (crLen < 0.01) {
              crx = edy * 0 - edz * 0;
              cry = edz * 1 - edx * 0;
              crz = edx * 0 - edy * 1;
              crLen = Math.sqrt(crx * crx + cry * cry + crz * crz);
            }
            if (crLen > 1e-10) {
              const inv = 1 / crLen;
              pushX = crx * inv; pushY = cry * inv; pushZ = crz * inv;
            } else {
              pushX = 0; pushY = 1; pushZ = 0;
            }
          }

          const totalForce = penetration * iterStrength;

          // Mass-ratio split: thinner branch absorbs more, thicker absorbs less
          const massA = sampleR * sampleR + 1e-8;
          const massB = cap.radius * cap.radius + 1e-8;
          const totalMass = massA + massB;
          const ratioA = massB / totalMass;
          const ratioB = massA / totalMass;

          // Branch A (this segment): pushed in +push direction
          const forceA = totalForce * ratioA * compliance;
          const fxA = pushX * forceA, fyA = pushY * forceA, fzA = pushZ * forceA;
          if (pi > 1) {
            const w0 = 1 - t;
            dispBuf[(pi - 1) * 3] += fxA * w0;
            dispBuf[(pi - 1) * 3 + 1] += fyA * w0;
            dispBuf[(pi - 1) * 3 + 2] += fzA * w0;
          }
          dispBuf[pi * 3] += fxA * t;
          dispBuf[pi * 3 + 1] += fyA * t;
          dispBuf[pi * 3 + 2] += fzA * t;

          // Branch B (the other segment): pushed in -push direction.
          // For self-collision (cap.segId === seg.id), the push-back will be
          // applied naturally on the reverse iteration (when pi visits the
          // other edge). Applying bilateral force here would double-count.
          const otherSeg = byId.get(cap.segId);
          if (otherSeg && !otherSeg.isRoot && cap.segId !== seg.id) {
            const otherAvgR = otherSeg.radii.length > 0 ? (otherSeg.radii[0] + otherSeg.radii[otherSeg.radii.length - 1]) * 0.5 : 0.01;
            const otherNormR = otherAvgR / maxRadius;
            const otherStiffness = Math.pow(otherNormR, opts.stiffnessExponent);
            const otherCompliance = 1 - otherStiffness * MAX_STIFFNESS_COMPLIANCE;
            const forceB = totalForce * ratioB * otherCompliance;

            const extBuf = extForceBufs.get(cap.segId)!;
            const idx0 = cap.pointIdx;
            const idx1 = cap.pointIdx + 1;
            if (idx0 > 0 && idx0 < otherSeg.points.length) {
              extBuf[idx0 * 3]     += -pushX * forceB * (1 - ct);
              extBuf[idx0 * 3 + 1] += -pushY * forceB * (1 - ct);
              extBuf[idx0 * 3 + 2] += -pushZ * forceB * (1 - ct);
            }
            if (idx1 > 0 && idx1 < otherSeg.points.length) {
              extBuf[idx1 * 3]     += -pushX * forceB * ct;
              extBuf[idx1 * 3 + 1] += -pushY * forceB * ct;
              extBuf[idx1 * 3 + 2] += -pushZ * forceB * ct;
            }
          }
        }
      }
    }
  }
}

/**
 * Add restoring forces that pull displaced points back toward their original positions.
 * Uses a dead zone to avoid fighting the subdivision jitter.
 */
function applyRestoringForce(
  seg: BranchSegment,
  nPts: number,
  originalPositions: Float64Array,
  origOffset: number,
  iterStrength: number,
  dispBuf: Float64Array,
): void {
  const sp0 = seg.points[0], spN = seg.points[nPts - 1];
  const slx = spN[0] - sp0[0], sly = spN[1] - sp0[1], slz = spN[2] - sp0[2];
  const spanLen = Math.sqrt(slx * slx + sly * sly + slz * slz);
  const jitterDeadZone = JITTER_DEAD_ZONE_FRACTION * spanLen / Math.max(1, nPts - 1);

  for (let i = 1; i < nPts; i++) {
    const oi = origOffset + i * 3;
    const dvx = seg.points[i][0] - originalPositions[oi];
    const dvy = seg.points[i][1] - originalPositions[oi + 1];
    const dvz = seg.points[i][2] - originalPositions[oi + 2];
    const devLen = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    if (devLen > jitterDeadZone) {
      const effectiveDev = devLen - jitterDeadZone;
      const restoreStrength = effectiveDev * RESTORING_FORCE_STRENGTH;
      const rForce = -restoreStrength * iterStrength / devLen;
      dispBuf[i * 3] += dvx * rForce;
      dispBuf[i * 3 + 1] += dvy * rForce;
      dispBuf[i * 3 + 2] += dvz * rForce;
    }
  }
}

/**
 * Apply Gaussian smoothing to the displacement buffer, writing results to smoothBuf.
 * Index 0 (anchor) is always zero. Applies anchor zone falloff and trunk height damping.
 */
function gaussianSmoothDisplacements(
  seg: BranchSegment,
  nPts: number,
  halfW: number,
  dispBuf: Float64Array,
  smoothBuf: Float64Array,
): void {
  smoothBuf[0] = 0; smoothBuf[1] = 0; smoothBuf[2] = 0;
  const sigma = halfW * GAUSSIAN_SIGMA_FRACTION;
  const sigmaInv = 1 / (sigma * sigma);

  for (let i = 1; i < nPts; i++) {
    let sx = 0, sy = 0, sz = 0, wSum = 0;
    const jMin = Math.max(1, i - halfW);
    const jMax = Math.min(nPts - 1, i + halfW);
    for (let j = jMin; j <= jMax; j++) {
      const d = Math.abs(j - i);
      const w = Math.exp(-0.5 * d * d * sigmaInv);
      sx += dispBuf[j * 3] * w;
      sy += dispBuf[j * 3 + 1] * w;
      sz += dispBuf[j * 3 + 2] * w;
      wSum += w;
    }
    if (wSum > 0) {
      const invW = 1 / wSum;
      sx *= invW; sy *= invW; sz *= invW;
    }

    // Anchoring falloff: quadratic ramp over first portion of branch protects sockets
    const anchorZone = Math.max(MIN_ANCHOR_ZONE_POINTS, nPts * ANCHOR_ZONE_FRACTION);
    const rawFactor = Math.min(1, i / anchorZone);
    const baseFactor = rawFactor * rawFactor;
    sx *= baseFactor; sy *= baseFactor; sz *= baseFactor;

    // Trunk height-based anchoring: linear ramp (was quadratic). Combined
    // with the anchor-zone ramp above, the trunk base is still firmly
    // planted, but mid-height and upper trunk can now actually flex under
    // collision forces — which is required to resolve kink-induced
    // intersections between the trunk and its lower branches.
    if (seg.depth === 0) {
      const heightFactor = i / nPts;
      sx *= heightFactor; sy *= heightFactor; sz *= heightFactor;
    }

    smoothBuf[i * 3] = sx;
    smoothBuf[i * 3 + 1] = sy;
    smoothBuf[i * 3 + 2] = sz;
  }
}

/**
 * Apply clamped smoothed displacements to segment points.
 * Returns the maximum displacement magnitude applied.
 */
function applyClampedDisplacements(
  seg: BranchSegment,
  nPts: number,
  smoothBuf: Float64Array,
): number {
  let maxDisp = 0;
  for (let i = 1; i < nPts; i++) {
    let sx = smoothBuf[i * 3], sy = smoothBuf[i * 3 + 1], sz = smoothBuf[i * 3 + 2];
    const dLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (dLen > MAX_DISPLACEMENT_PER_STEP) {
      const scale = MAX_DISPLACEMENT_PER_STEP / dLen;
      sx *= scale; sy *= scale; sz *= scale;
    }
    if (dLen > maxDisp) maxDisp = dLen;
    seg.points[i][0] += sx;
    seg.points[i][1] += sy;
    seg.points[i][2] += sz;
  }
  return maxDisp;
}

/**
 * Apply bilateral (external) forces from other segments' collision responses.
 * Returns the maximum displacement magnitude applied.
 */
function applyBilateralForces(
  seg: BranchSegment,
  nPts: number,
  segExtBuf: Float64Array,
): number {
  let maxDisp = 0;
  for (let i = 1; i < nPts; i++) {
    const anchorZoneExt = Math.max(MIN_ANCHOR_ZONE_POINTS, nPts * ANCHOR_ZONE_FRACTION);
    const rawFact = Math.min(1, i / anchorZoneExt);
    const bf = rawFact * rawFact;
    let ex = segExtBuf[i * 3] * bf, ey = segExtBuf[i * 3 + 1] * bf, ez = segExtBuf[i * 3 + 2] * bf;
    const eLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (eLen > MAX_DISPLACEMENT_PER_STEP) {
      const sc = MAX_DISPLACEMENT_PER_STEP / eLen;
      ex *= sc; ey *= sc; ez *= sc;
    }
    if (eLen > maxDisp) maxDisp = eLen;
    seg.points[i][0] += ex;
    seg.points[i][1] += ey;
    seg.points[i][2] += ez;
  }
  return maxDisp;
}

// ============================================================
// Main relaxation solver
// ============================================================

/**
 * Iteratively relaxes the tree skeleton so branches avoid intersecting.
 *
 * Works on the COMPLETE skeleton after generation. Displaces control points
 * with smooth, stiffness-weighted forces. After each iteration, propagates
 * parent displacements to children so branches stay attached.
 *
 * Modifies segment.points[] in place.
 */
export function relaxBranches(
  skeleton: TreeSkeleton,
  options: Partial<RelaxationOptions> = {},
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { segments } = skeleton;
  if (segments.length < 2) return;

  // Safety: count total control points and bail / throttle for very large trees
  let totalPts = 0;
  for (const seg of segments) totalPts += seg.points.length;
  if (totalPts > MAX_TOTAL_POINTS) {
    console.warn(`[Relaxation] Skeleton has ${totalPts} control points (limit ${MAX_TOTAL_POINTS}), skipping relaxation`);
    return;
  }
  if (totalPts > LARGE_TREE_POINT_THRESHOLD && opts.iterations > LARGE_TREE_MAX_ITERS) {
    console.warn(`[Relaxation] Large skeleton (${totalPts} pts), clamping iterations ${opts.iterations} → ${LARGE_TREE_MAX_ITERS}`);
    opts.iterations = LARGE_TREE_MAX_ITERS;
  }

  // Index by id
  const byId = new Map<number, BranchSegment>();
  for (const seg of segments) byId.set(seg.id, seg);

  // Build parent-child attachment map
  const attachments = new Map<number, { parent: BranchSegment; pointIdx: number }>();
  for (const seg of segments) {
    if (seg.depth === 0 && !seg.isRoot) continue;
    const att = findAttachment(seg, byId, segments);
    if (att) attachments.set(seg.id, att);
  }

  // Process order: depth-first so parent displacements propagate to children
  const depthSorted = [...segments].sort((a, b) => a.depth - b.depth);

  // Find max radius for stiffness normalization
  let maxRadius = 0.01;
  for (const seg of segments) {
    for (const r of seg.radii) {
      if (r > maxRadius) maxRadius = r;
    }
  }

  const grid = new RelaxGrid(GRID_CELL_SIZE);

  // Store per-point displacements for child propagation (Float64Array: [x,y,z] per point)
  const segDisplacements = new Map<number, Float64Array>();

  // Pre-allocate working buffers (reused across all segments and iterations)
  let maxPts = 0;
  for (const seg of segments) {
    if (seg.points.length > maxPts) maxPts = seg.points.length;
  }
  const dispBuf = new Float64Array(maxPts * 3);
  const smoothBuf = new Float64Array(maxPts * 3);

  // Pre-allocate external force buffers per segment (reused across iterations)
  const extForceBufs = new Map<number, Float64Array>();
  for (const seg of segments) {
    extForceBufs.set(seg.id, new Float64Array(seg.points.length * 3));
  }

  // Pre-allocate totalDisp buffers per segment (reused across iterations)
  const totalDispBufs = new Map<number, Float64Array>();
  for (const seg of segments) {
    totalDispBufs.set(seg.id, new Float64Array(seg.points.length * 3));
  }

  // --- Collision pre-check: skip entire solver if no branches overlap ---
  {
    for (const seg of segments) {
      for (let i = 0; i < seg.points.length - 1; i++) {
        const r = Math.max(radiusAt(seg, i), radiusAt(seg, i + 1));
        grid.insert({ segId: seg.id, pointIdx: i, p0: seg.points[i], p1: seg.points[i + 1], radius: r, lastVisited: 0 });
      }
    }
    let anyCollision = false;
    scanLoop:
    for (const seg of segments) {
      if (seg.isRoot) continue;
      for (let pi = 1; pi < seg.points.length; pi++) {
        const r = radiusAt(seg, pi);
        const localMaxR = Math.min(maxRadius, r * LOCAL_RADIUS_SCALE + LOCAL_RADIUS_OFFSET);
        const searchR = (r + localMaxR) * opts.radiusMultiplier + SEARCH_RADIUS_PADDING;
        const nearby = grid.query(seg.points[pi], searchR);
        for (const cap of nearby) {
          if (cap.segId === seg.id) continue;
          // Quick squared-distance check against midpoint
          const mx = (cap.p0[0] + cap.p1[0]) * 0.5;
          const my = (cap.p0[1] + cap.p1[1]) * 0.5;
          const mz = (cap.p0[2] + cap.p1[2]) * 0.5;
          const dx = seg.points[pi][0] - mx;
          const dy = seg.points[pi][1] - my;
          const dz = seg.points[pi][2] - mz;
          const dist2 = dx * dx + dy * dy + dz * dz;
          const combR = (r + cap.radius) * opts.radiusMultiplier;
          if (dist2 < combR * combR * PRECHECK_DIST_SQ_FACTOR) {
            anyCollision = true;
            break scanLoop;
          }
        }
      }
    }
    if (!anyCollision) return;
    grid.clear();
  }

  // --- Replace originalPoints Map with contiguous Float64Array ---
  let totalPointCount = 0;
  const segPointOffset = new Map<number, number>();
  for (const seg of segments) {
    segPointOffset.set(seg.id, totalPointCount);
    totalPointCount += seg.points.length;
  }
  const originalPositions = new Float64Array(totalPointCount * 3);
  for (const seg of segments) {
    const offset = segPointOffset.get(seg.id)! * 3;
    for (let i = 0; i < seg.points.length; i++) {
      originalPositions[offset + i * 3] = seg.points[i][0];
      originalPositions[offset + i * 3 + 1] = seg.points[i][1];
      originalPositions[offset + i * 3 + 2] = seg.points[i][2];
    }
  }

  for (let iter = 0; iter < opts.iterations; iter++) {
    const iterStrength = opts.strength * (1 - iter / (opts.iterations * 2));

    // --- Rebuild spatial hash ---
    grid.clear();
    for (const seg of segments) {
      for (let i = 0; i < seg.points.length - 1; i++) {
        const r = Math.max(radiusAt(seg, i), radiusAt(seg, i + 1));
        grid.insert({
          segId: seg.id,
          pointIdx: i,
          p0: seg.points[i],
          p1: seg.points[i + 1],
          radius: r,
          lastVisited: 0,
        });
      }
    }

    // --- Clear displacement map and zero external force buffers ---
    segDisplacements.clear();
    for (const buf of extForceBufs.values()) buf.fill(0);

    let maxIterDisplacement = 0;


    // --- Compute and apply displacements depth-by-depth ---
    for (const seg of depthSorted) {
      if (seg.isRoot) continue;
      const nPts = seg.points.length;
      if (nPts < 2) continue;

      // Propagate parent's displacement to our anchor point
      const att = attachments.get(seg.id);
      if (att) {
        const parentDispBuf = segDisplacements.get(att.parent.id);
        if (parentDispBuf && att.pointIdx * 3 + 2 < parentDispBuf.length) {
          const ax = parentDispBuf[att.pointIdx * 3];
          const ay = parentDispBuf[att.pointIdx * 3 + 1];
          const az = parentDispBuf[att.pointIdx * 3 + 2];
          const aLen = Math.sqrt(ax * ax + ay * ay + az * az);
          if (aLen > 1e-8) {
            for (let i = 0; i < nPts; i++) {
              seg.points[i][0] += ax;
              seg.points[i][1] += ay;
              seg.points[i][2] += az;
            }
          }
        }
      }

      // Stiffness (guard against empty radii)
      const avgRadius = seg.radii.length > 0 ? (seg.radii[0] + seg.radii[seg.radii.length - 1]) * 0.5 : 0.01;
      const normalizedR = avgRadius / maxRadius;
      const stiffness = Math.pow(normalizedR, opts.stiffnessExponent);
      const compliance = 1 - stiffness * MAX_STIFFNESS_COMPLIANCE;

      // Zero displacement buffer for this segment
      for (let i = 0; i < nPts * 3; i++) dispBuf[i] = 0;

      // Compute collision-avoidance displacements
      computeCollisionDisplacements(
        seg, nPts, grid, opts, iterStrength, compliance,
        maxRadius, byId, dispBuf, extForceBufs,
      );

      // Add restoring forces toward original positions
      const origOffset = segPointOffset.get(seg.id)! * 3;
      applyRestoringForce(seg, nPts, originalPositions, origOffset, iterStrength, dispBuf);

      // Gaussian smooth and apply with anchor zone falloff
      gaussianSmoothDisplacements(seg, nPts, opts.smoothingWidth, dispBuf, smoothBuf);
      const dispMag = applyClampedDisplacements(seg, nPts, smoothBuf);
      if (dispMag > maxIterDisplacement) maxIterDisplacement = dispMag;

      // Apply bilateral forces from other segments' collisions
      const segExtBuf = extForceBufs.get(seg.id)!;
      const extMag = applyBilateralForces(seg, nPts, segExtBuf);
      if (extMag > maxIterDisplacement) maxIterDisplacement = extMag;

      // Store total displacement for children (using pre-allocated typed array)
      const tdBuf = totalDispBufs.get(seg.id)!;
      if (att) {
        const parentDispBuf = segDisplacements.get(att.parent.id);
        if (parentDispBuf && att.pointIdx * 3 + 2 < parentDispBuf.length) {
          tdBuf[0] = parentDispBuf[att.pointIdx * 3];
          tdBuf[1] = parentDispBuf[att.pointIdx * 3 + 1];
          tdBuf[2] = parentDispBuf[att.pointIdx * 3 + 2];
        } else {
          tdBuf[0] = 0; tdBuf[1] = 0; tdBuf[2] = 0;
        }
      } else {
        tdBuf[0] = 0; tdBuf[1] = 0; tdBuf[2] = 0;
      }
      for (let i = 1; i < nPts; i++) {
        let extX = 0, extY = 0, extZ = 0;
        {
          const anchorZoneExt = Math.max(MIN_ANCHOR_ZONE_POINTS, nPts * ANCHOR_ZONE_FRACTION);
          const rawFact = Math.min(1, i / anchorZoneExt);
          const bf = rawFact * rawFact;
          extX = segExtBuf[i * 3] * bf;
          extY = segExtBuf[i * 3 + 1] * bf;
          extZ = segExtBuf[i * 3 + 2] * bf;
        }
        tdBuf[i * 3] = tdBuf[0] + smoothBuf[i * 3] + extX;
        tdBuf[i * 3 + 1] = tdBuf[1] + smoothBuf[i * 3 + 1] + extY;
        tdBuf[i * 3 + 2] = tdBuf[2] + smoothBuf[i * 3 + 2] + extZ;
      }
      segDisplacements.set(seg.id, tdBuf);

      // --- Update segment endpoints ---
      seg.startPos = [...seg.points[0]];
      seg.endPos = [...seg.points[nPts - 1]];
      const sdx = seg.endPos[0] - seg.startPos[0];
      const sdy = seg.endPos[1] - seg.startPos[1];
      const sdz = seg.endPos[2] - seg.startPos[2];
      const slen = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
      seg.direction = slen > 1e-10 ? [sdx / slen, sdy / slen, sdz / slen] : [0, 1, 0];
    }

    // --- Early termination: all displacements below threshold ---
    opts.onIterationComplete?.(iter + 1, opts.iterations);
    if (maxIterDisplacement < CONVERGENCE_THRESHOLD) break;
  }

  // --- Update skeleton bounds ---
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const seg of segments) {
    for (const p of seg.points) {
      if (p[0] < min[0]) min[0] = p[0];
      if (p[1] < min[1]) min[1] = p[1];
      if (p[2] < min[2]) min[2] = p[2];
      if (p[0] > max[0]) max[0] = p[0];
      if (p[1] > max[1]) max[1] = p[1];
      if (p[2] > max[2]) max[2] = p[2];
    }
  }
  skeleton.bounds = { min, max };
}
