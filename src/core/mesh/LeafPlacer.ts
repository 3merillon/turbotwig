import type { BranchSegment } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import {
  vec3Add, vec3Scale, vec3Normalize, vec3Cross, vec3Dot,
  vec3RotateAroundAxis, vec3Length, vec3Sub, vec3Lerp,
} from '../../utils/math';
import { CatmullRomSpline } from '../../utils/spline';
import { SeededRandom } from '../../utils/random';
import { getTaperedRadius, type TaperParams } from './taper';

/** Configuration for leaf quad placement including density, orientation, and cluster settings. */
export interface LeafPlacerOptions {
  minDepth: number;
  density: number;
  size: number;
  sizeVariance: number;
  clusterMode: boolean;
  clusterSize: number;
  /** Branch taper amount (must match mesh builder setting) */
  taperAmount: number;
  /** Branch taper power curve (must match mesh builder setting) */
  taperPower: number;

  /** Trunk-specific taper amount. If undefined, uses taperAmount. */
  trunkTaperAmount?: number;
  /** Trunk-specific taper power. If undefined, uses taperPower. */
  trunkTaperPower?: number;
  /** Contact flare strength (must match mesh builder setting) */
  contactFlare: number;
  /** Fraction of branch length for contact flare (must match mesh builder setting) */
  contactFlareLength: number;
  /** Target absolute tip radius (must match mesh builder setting) */
  tipRadius: number;
  /** Place leaf clusters at the tips of terminal branches (no children). */
  tipLeaves: boolean;
  /** Minimum depth for tip leaves (0 = include trunk tip). */
  tipLeafMinDepth: number;
  /** Leaf droop / gravity weight (0 = slight upward bias, 1 = strong downward droop). */
  leafDroop: number;
  /** Horizontal spread (0 = follow branch tangent, 1 = strongly horizontal). */
  leafSpread: number;
  /** Rotate leaf around its grow direction to bring face normal toward world-up (0 = off, 1 = fully horizontal). */
  leafHorizontality: number;
  /** Angular noise in horizontality rotation (0 = exact, 1 = up to ±90°). */
  leafHorizontalityNoise: number;
  /** Rotate leaf around its grow direction to bring face normal into horizontal plane (0 = off, 1 = fully vertical). */
  leafVerticality: number;
  /** Angular noise in verticality rotation (0 = exact, 1 = up to ±90°). */
  leafVerticalityNoise: number;
  /** Pull grow direction toward world-up (0 = follow branch, 1 = point straight up). */
  leafWorldUp: number;
  /** Orientation mode: 'branch' = default, 'sky' = face up, 'pendant' = hang down, 'radial' = face outward from trunk. */
  leafOrientationMode: 'branch' | 'sky' | 'pendant' | 'radial';
}

/** Output geometry arrays from leaf placement, including per-vertex wind animation attributes. */
export interface LeafMeshResult {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  heightWeights: number[];
  depthWeights: number[];
  leafPhases: number[];
  branchAnchors: number[];
  vertexCount: number;
}

const DEFAULT_LEAF_OPTIONS: LeafPlacerOptions = {
  minDepth: 2,
  density: 3.0,
  size: 0.6,
  sizeVariance: 0.3,
  clusterMode: true,
  clusterSize: 2.5,
  taperAmount: 0,
  taperPower: 1,
  contactFlare: 0,
  contactFlareLength: 0.15,
  tipRadius: 0,
  tipLeaves: true,
  tipLeafMinDepth: 0,
  leafDroop: 0,
  leafSpread: 0,
  leafHorizontality: 0,
  leafHorizontalityNoise: 0,
  leafVerticality: 0,
  leafVerticalityNoise: 0,
  leafWorldUp: 0,
  leafOrientationMode: 'branch',
};


/**
 * Place leaf cluster quads along branch splines.
 *
 * The SpeedTree cluster textures have a twig/stem at the bottom center
 * (UV y=0) and leaves extending upward (UV y=1). Quads are oriented so:
 * - The base (stem) sits on the branch surface
 * - The quad extends outward along the branch direction + away from branch
 * - This makes the texture's twig align with the actual branch
 */
export function placeLeaves(
  segments: BranchSegment[],
  treeHeight: number,
  seed: number = 12345,
  options: Partial<LeafPlacerOptions> = {},
): LeafMeshResult {
  const opts = { ...DEFAULT_LEAF_OPTIONS, ...options };
  const rng = new SeededRandom(seed + 7777);

  // Build taper params once (shared formula from taper.ts)
  const taperParams: TaperParams = {
    taperAmount: opts.taperAmount,
    taperPower: opts.taperPower,
    trunkTaperAmount: opts.trunkTaperAmount,
    trunkTaperPower: opts.trunkTaperPower,
    contactFlare: opts.contactFlare,
    contactFlareLength: opts.contactFlareLength,
    tipRadius: opts.tipRadius,
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const heightWeights: number[] = [];
  const depthWeights: number[] = [];
  const leafPhases: number[] = [];
  const branchAnchors: number[] = [];
  let vertexOffset = 0;

  // Helper: emit a leaf quad at a given position with a grow direction
  function emitLeafQuad(
    surfacePoint: Vec3, growDir: Vec3, size: number,
    seg: BranchSegment, center: Vec3,
  ): boolean {
    // Face normal: perpendicular to growDir
    let faceNormal: Vec3;
    if (Math.abs(growDir[1]) < 0.95) {
      faceNormal = vec3Normalize(vec3Cross(growDir, [0, 1, 0]));
    } else {
      faceNormal = vec3Normalize(vec3Cross(growDir, [1, 0, 0]));
    }
    if (vec3Length(faceNormal) < 0.01) return false;

    const tilt = rng.range(-0.7, 0.7);
    faceNormal = vec3Normalize(vec3RotateAroundAxis(faceNormal, growDir, tilt));

    // Horizontality: rotate leaf around its own grow direction to bring
    // face normal toward world-up. Preserves perpendicularity since the
    // rotation axis IS growDir, so no re-projection needed.
    if (opts.leafHorizontality > 0) {
      const factor = Math.min(opts.leafHorizontality, 1);
      // Target: projection of world-up onto the plane ⊥ growDir
      const dotUp = vec3Dot(growDir, [0, 1, 0]);
      const targetRaw: Vec3 = vec3Sub([0, 1, 0], vec3Scale(growDir, dotUp));
      if (vec3Length(targetRaw) > 0.01) {
        const target = vec3Normalize(targetRaw);
        // Signed angle from current faceNormal to target around growDir
        const cosA = vec3Dot(faceNormal, target);
        const sinA = vec3Dot(vec3Cross(faceNormal, target), growDir);
        const angle = Math.atan2(sinA, cosA);
        const noise = rng.range(-1, 1) * opts.leafHorizontalityNoise * Math.PI * 0.5;
        faceNormal = vec3Normalize(vec3RotateAroundAxis(faceNormal, growDir, angle * factor + noise));
      }
    }

    // Verticality: rotate leaf around its own grow direction to bring
    // face normal into the horizontal plane (vertical leaf blade).
    if (opts.leafVerticality > 0) {
      const factor = Math.min(opts.leafVerticality, 1);
      // Target: direction in plane ⊥ growDir that lies in the horizontal plane
      const horizDir = vec3Cross(growDir, [0, 1, 0]);
      if (vec3Length(horizDir) > 0.01) {
        let target = vec3Normalize(horizDir);
        // Pick the side closest to current faceNormal
        if (vec3Dot(target, faceNormal) < 0) {
          target = vec3Scale(target, -1) as Vec3;
        }
        const cosA = vec3Dot(faceNormal, target);
        const sinA = vec3Dot(vec3Cross(faceNormal, target), growDir);
        const angle = Math.atan2(sinA, cosA);
        const noise = rng.range(-1, 1) * opts.leafVerticalityNoise * Math.PI * 0.5;
        faceNormal = vec3Normalize(vec3RotateAroundAxis(faceNormal, growDir, angle * factor + noise));
      }
    }

    let widthDir = vec3Normalize(vec3Cross(growDir, faceNormal));
    if (vec3Length(widthDir) < 0.01) {
      // growDir parallel to faceNormal — use arbitrary perpendicular
      widthDir = vec3Normalize(vec3Cross([1, 0, 0], faceNormal));
      if (vec3Length(widthDir) < 0.01) {
        widthDir = vec3Normalize(vec3Cross([0, 0, 1], faceNormal));
      }
    }
    const halfW = size * 0.5;

    const corners: Vec3[] = [
      vec3Add(surfacePoint, vec3Scale(widthDir, -halfW)),
      vec3Add(surfacePoint, vec3Scale(widthDir, halfW)),
      vec3Add(vec3Add(surfacePoint, vec3Scale(growDir, size)), vec3Scale(widthDir, halfW)),
      vec3Add(vec3Add(surfacePoint, vec3Scale(growDir, size)), vec3Scale(widthDir, -halfW)),
    ];

    const phase = rng.next();
    const hWeight = treeHeight > 0 ? Math.max(0, center[1] / treeHeight) : 0;
    const leafUvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];

    for (let v = 0; v < 4; v++) {
      positions.push(corners[v][0], corners[v][1], corners[v][2]);
      normals.push(faceNormal[0], faceNormal[1], faceNormal[2]);
      uvs.push(leafUvs[v][0], leafUvs[v][1]);
      heightWeights.push(hWeight);
      depthWeights.push(Math.min(seg.depth, 5) / 5);
      leafPhases.push(phase);
      branchAnchors.push(seg.startPos[0], seg.startPos[1], seg.startPos[2]);
    }

    indices.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset, vertexOffset + 2, vertexOffset + 3,
    );
    vertexOffset += 4;
    return true;
  }

  // Helper: place a surface-attached leaf at parameter t on a branch
  function placeSurfaceLeaf(
    seg: BranchSegment, spline: CatmullRomSpline, t: number, leafSize: number,
  ) {
    const center = spline.evaluate(t);
    const tangent = spline.tangent(t);
    const radius = getTaperedRadius(seg, t, taperParams);

    let perp1: Vec3;
    if (Math.abs(tangent[1]) < 0.95) {
      perp1 = vec3Normalize(vec3Cross(tangent, [0, 1, 0]));
    } else {
      perp1 = vec3Normalize(vec3Cross(tangent, [1, 0, 0]));
    }
    if (vec3Length(perp1) < 0.01) return;
    const perp2 = vec3Normalize(vec3Cross(tangent, perp1));

    const around = rng.range(0, Math.PI * 2);
    const outward: Vec3 = vec3Normalize([
      perp1[0] * Math.cos(around) + perp2[0] * Math.sin(around),
      perp1[1] * Math.cos(around) + perp2[1] * Math.sin(around),
      perp1[2] * Math.cos(around) + perp2[2] * Math.sin(around),
    ]);

    // Droop: interpolate vertical bias from +0.25 (upward) to -0.5 (drooping)
    const vertBias = 0.25 - opts.leafDroop * 0.75;
    const biasedOut = vec3Normalize([
      outward[0],
      outward[1] + vertBias,
      outward[2],
    ]);

    const surfacePoint: Vec3 = vec3Add(center, vec3Scale(biasedOut, radius));

    // Skip leaves near or below ground level — prevents leaves on roots/trunk base
    if (surfacePoint[1] < treeHeight * 0.05) return;

    const size = leafSize * (1 - opts.sizeVariance + rng.range(0, opts.sizeVariance * 2));

    let growDir: Vec3;

    switch (opts.leafOrientationMode) {
      case 'sky':
        // Leaves grow outward from branch, face upward (broad deciduous)
        growDir = vec3Normalize(biasedOut);
        break;
      case 'pendant':
        // Leaves hang downward (weeping willow style)
        growDir = vec3Normalize(vec3Add(
          vec3Scale(biasedOut, 0.3),
          [0, -0.7, 0],
        ));
        break;
      case 'radial':
        // Leaves face outward from trunk center (conifer needle clusters)
        growDir = vec3Normalize([
          surfacePoint[0],
          0,
          surfacePoint[2],
        ]);
        if (vec3Length(growDir) < 0.01) growDir = vec3Normalize(biasedOut);
        break;
      default: {
        // 'branch' mode: outward-dominant blend of tangent + outward
        const alongWeight = 0.3 + rng.range(0, 0.2);
        const outWeight = 0.5 + rng.range(0, 0.3);
        growDir = vec3Normalize(vec3Add(
          vec3Scale(tangent, alongWeight),
          vec3Scale(biasedOut, outWeight),
        ));
        break;
      }
    }

    // World-up bias: pull grow direction toward vertical
    if (opts.leafWorldUp > 0) {
      growDir = vec3Normalize(vec3Lerp(growDir, [0, 1, 0], opts.leafWorldUp));
    }

    // Spread (horizontality): dampen vertical component of grow direction
    if (opts.leafSpread > 0) {
      const hLen = Math.sqrt(growDir[0] * growDir[0] + growDir[2] * growDir[2]);
      if (hLen > 0.01) {
        growDir = vec3Normalize([
          growDir[0],
          growDir[1] * (1 - opts.leafSpread),
          growDir[2],
        ]);
      }
    }

    emitLeafQuad(surfacePoint, growDir, size, seg, center);
  }

  // === Pass 1: Along-branch leaves (existing behavior) ===
  for (const seg of segments) {
    if (seg.depth < opts.minDepth || seg.isRoot) continue;

    const spline = new CatmullRomSpline(seg.points);
    const arcLen = spline.getArcLength();
    if (arcLen < 0.05) continue;

    const numLeaves = Math.max(1, Math.round(arcLen * opts.density));
    const leafSize = opts.clusterMode ? opts.size * opts.clusterSize : opts.size;

    for (let i = 0; i < numLeaves; i++) {
      placeSurfaceLeaf(seg, spline, rng.range(0.1, 0.95), leafSize);
    }
  }

  // === Pass 2: Tip leaves on branches with exposed tips ===
  // A tip is "exposed" if no child branch starts near the segment's endpoint.
  // This catches terminal branches AND trunk/branch tips where only lateral
  // branches fork off but nothing continues from the very tip.
  if (opts.tipLeaves) {
    const segById = new Map<number, BranchSegment>();
    for (const s of segments) segById.set(s.id, s);

    for (const seg of segments) {
      if (seg.isRoot) continue;
      if (seg.depth < opts.tipLeafMinDepth) continue;

      // Skip if a same-depth child continues from this tip (future: trunk splitting).
      // Lateral branches (higher depth) don't count — they fork off, not continue.
      if (seg.children.some(childId => {
        const child = segById.get(childId);
        return child && child.depth === seg.depth;
      })) continue;

      const spline = new CatmullRomSpline(seg.points);
      const arcLen = spline.getArcLength();
      if (arcLen < 0.05) continue;

      const leafSize = opts.clusterMode ? opts.size * opts.clusterSize : opts.size;

      // 1-3 leaves at the actual tip, surface-attached
      const numTip = 1 + Math.floor(rng.next() * 3);
      for (let i = 0; i < numTip; i++) {
        placeSurfaceLeaf(seg, spline, rng.range(0.85, 1.0), leafSize);
      }

      // If this branch is shallower than minDepth (wouldn't normally get
      // along-branch leaves), add some along the branch too.
      // Skip depth 0 (trunk) — trunk should never get scattered along-branch leaves.
      if (seg.depth < opts.minDepth && seg.depth > 0) {
        const numExtra = Math.max(1, Math.round(arcLen * opts.density * 0.5));
        for (let i = 0; i < numExtra; i++) {
          placeSurfaceLeaf(seg, spline, rng.range(0.2, 0.85), leafSize);
        }
      }
    }
  }

  return {
    positions, normals, uvs, indices,
    heightWeights, depthWeights, leafPhases, branchAnchors,
    vertexCount: vertexOffset,
  };
}
