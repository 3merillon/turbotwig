import type { BranchSegment } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import {
  vec3Sub, vec3Scale, vec3Normalize, vec3Cross,
  vec3Length, vec3Dot, vec3RotateAroundAxis,
} from '../../utils/math';
import { CatmullRomSpline } from '../../utils/spline';
import { smoothstep, getTaperedRadius, type TaperParams } from './taper';
import { smartFitBranches } from './BranchWelder';

/** Configuration for tube mesh generation including taper, noise, twist, and welding settings. */
export interface TubeMeshOptions {
  radialSegments: number;
  /** Subtract this many radial segments per branch depth level (min 3 floor). */
  radialSegmentsDepthStep: number;
  lengthSegmentsPerUnit: number;
  minLengthSegments: number;
  uvTileU: number;
  uvTileV: number;
  /** Radial noise amplitude as fraction of radius (0 = smooth) */
  noiseAmplitude: number;
  /** Noise bumps per unit length */
  noiseFrequency: number;
  /** Noise octaves (1 = simple, 2-3 = multi-scale) */
  noiseOctaves: number;
  /** Steady spiral twist in radians per unit length. Negative = reverse direction. */
  twistRate: number;
  /** Random twist variation amplitude in radians. Adds organic back-and-forth on top of twistRate. */
  twistNoise: number;
  /** How fast the twist noise oscillates along the branch (cycles per unit length). */
  twistNoiseFreq: number;
  /** How much texture follows geometry twist: 1 = fully follows (default),
   *  0 = texture stays static, >1 = exaggerated texture twist */
  uvTwist: number;
  /** Root flare multiplier (1 = none). Applied per-ring based on Y height. */
  rootFlare: number;
  /** Height over which root flare fades out (world units). */
  rootFlareHeight: number;
  /** How much radius shrinks along each branch (0=no taper/cylinder, 1=full taper to zero). */
  taperAmount: number;
  /** Taper curve shape: 1=linear, <1=stays thick longer (concave), >1=thins quickly (convex). */
  taperPower: number;

  /** Root-specific taper amount. If undefined, uses taperAmount. */
  rootTaperAmount?: number;
  /** Root-specific taper power. If undefined, uses taperPower. */
  rootTaperPower?: number;
  /** Trunk-specific taper amount (depth=0, non-root). If undefined, uses taperAmount. */
  trunkTaperAmount?: number;
  /** Trunk-specific taper power (depth=0, non-root). If undefined, uses taperPower. */
  trunkTaperPower?: number;
  /** Contact flare strength at branch junctions (0=none, 1=full). */
  contactFlare: number;
  /** Fraction of branch length over which contact flare applies (0.05-0.5). */
  contactFlareLength: number;
  /** Target absolute tip radius in world units. 0=disabled (use taperAmount). */
  tipRadius: number;
  /** Push child branch vertices inside parent surface (cheap, no CSG). */
  smartFitEnabled: boolean;
  /** Cap branch tips (last ring of each branch). */
  capBranchTips: boolean;
  /** Cap root tips (last ring of each root). */
  capRootTips: boolean;
  /** Cap the underground trunk bottom (first ring). */
  capTrunkBottom: boolean;
  /** Enable branch welding (collar + bridge geometry at junctions). */
  weldEnabled: boolean;
  /** Number of blend rings between collar and child base (1-4). */
  weldBlendRings: number;
  /** Outward offset of collar above parent surface (fraction of parent radius). */
  weldSurfaceOffset: number;
  /** Minimum child/parent radius ratio to perform welding. */
  weldMinRadiusRatio: number;
}

/** Output geometry arrays from tree mesh generation, including vertex attributes for wind animation. */
export interface TubeMeshResult {
  positions: number[];
  normals: number[];
  tangents: number[];
  uvs: number[];
  indices: number[];
  heightWeights: number[];
  depthWeights: number[];
  branchWeights: number[];
  branchAnchors: number[];
  branchPhases: number[];
  segmentInfos?: SegmentMeshInfo[];
}

export interface RingInfo {
  center: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
  radius: number;
  tParam: number;
  vertexStart: number;
  radialSegments: number;
  positions: Vec3[];
}

export interface SegmentMeshInfo {
  segment: BranchSegment;
  rings: RingInfo[];
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
}

const DEFAULT_OPTIONS: TubeMeshOptions = {
  radialSegments: 8,
  radialSegmentsDepthStep: 1,
  lengthSegmentsPerUnit: 3,
  minLengthSegments: 1,
  uvTileU: 1,
  uvTileV: 1,
  noiseAmplitude: 0,
  noiseFrequency: 3,
  noiseOctaves: 2,
  twistRate: 0,
  twistNoise: 0,
  twistNoiseFreq: 2,
  uvTwist: 1,
  rootFlare: 1,
  rootFlareHeight: 1.5,
  taperAmount: 0.7,
  taperPower: 1,
  contactFlare: 0,
  contactFlareLength: 0.15,
  tipRadius: 0,
  capBranchTips: true,
  capRootTips: true,
  capTrunkBottom: true,
  smartFitEnabled: true,
  weldEnabled: false,
  weldBlendRings: 2,
  weldSurfaceOffset: 0.003,
  weldMinRadiusRatio: 0.02,
};

// ============================================================
// Taper helpers
// ============================================================


// ============================================================
// Noise function
// ============================================================

/**
 * Deterministic multi-octave bark noise.
 * Uses layered sine waves for organic bumpy patterns without
 * needing a full Perlin/Simplex implementation.
 */
function barkNoise(u: number, v: number, seed: number, octaves: number): number {
  let val = 0;
  let amp = 1;
  let freq = 1;
  let totalAmp = 0;

  for (let i = 0; i < octaves; i++) {
    val += amp * (
      Math.sin(u * freq * 7.31 + seed * 1.0 + i * 3.7) *
      Math.cos(v * freq * 5.17 + seed * 1.7 + i * 2.3) +
      Math.sin((u + v) * freq * 3.93 + seed * 2.3 + i * 5.1) * 0.5
    );
    totalAmp += amp * 1.5; // normalize
    amp *= 0.5;
    freq *= 2.0;
  }

  return val / totalAmp; // returns roughly [-1, 1]
}

// ============================================================
// Main entry
// ============================================================

/**
 * Build tube mesh geometry for an entire tree from branch segments.
 * @param segments - All branch segments (trunk, branches, roots) defining the tree skeleton.
 * @param treeHeight - Total tree height in world units, used for height-based wind weights.
 * @param options - Partial mesh options merged with defaults.
 * @returns Combined mesh arrays ready for GPU upload.
 */
export function buildTreeMesh(
  segments: BranchSegment[],
  treeHeight: number,
  options: Partial<TubeMeshOptions> = {},
): TubeMeshResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const positions: number[] = [];
  const normals: number[] = [];
  const tangents: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const heightWeights: number[] = [];
  const depthWeights: number[] = [];
  const branchWeights: number[] = [];
  const branchAnchors: number[] = [];
  const branchPhases: number[] = [];

  // Taper params derived from current mesh options (shared with LeafPlacer via taper.ts)
  const taperParams: TaperParams = {
    taperAmount: opts.taperAmount,
    taperPower: opts.taperPower,
    rootTaperAmount: opts.rootTaperAmount,
    rootTaperPower: opts.rootTaperPower,
    trunkTaperAmount: opts.trunkTaperAmount,
    trunkTaperPower: opts.trunkTaperPower,
    contactFlare: opts.contactFlare,
    contactFlareLength: opts.contactFlareLength,
    tipRadius: opts.tipRadius,
  };

  function getTaperedRadiusAt(seg: BranchSegment, t: number): number {
    return getTaperedRadius(seg, t, taperParams);
  }

  // Clamp each child branch's startRadius to the parent's tapered radius
  // at the attachment point so branches don't clip through tapered parents.
  // Uses topology (parentId) when available, falls back to geometric search.
  // Skip root segments — the RootGenerator computes appropriate sizes.
  // Process depth-by-depth so parents are clamped before their children.
  const segById = new Map<number, BranchSegment>();
  for (const s of segments) segById.set(s.id, s);

  const sortedSegments = [...segments].sort((a, b) => a.depth - b.depth);
  for (const child of sortedSegments) {
    if (child.depth === 0 && !child.isRoot) continue; // trunk has no parent

    // Find parent: use topology parentId first, fall back to geometric search
    let bestParent: BranchSegment | null = null;
    let bestT = 0;

    if (child.parentId >= 0) {
      bestParent = segById.get(child.parentId) ?? null;
    }

    if (!bestParent) {
      // Geometric fallback for segments without parentId
      let bestDist = Infinity;
      for (const candidate of segments) {
        if (candidate.id === child.id) continue;
        if (candidate.depth >= child.depth) continue;
        const pSpline = new CatmullRomSpline(candidate.points);
        for (let i = 0; i <= 20; i++) {
          const t = i / 20;
          const p = pSpline.evaluate(t);
          const dx = p[0] - child.startPos[0];
          const dy = p[1] - child.startPos[1];
          const dz = p[2] - child.startPos[2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestDist) { bestDist = d; bestT = t; bestParent = candidate; }
        }
      }
      if (!bestParent || bestDist > 9) continue;
    }

    // Find closest t on parent spline to child's start position
    if (bestParent) {
      const pSpline = new CatmullRomSpline(bestParent.points);
      let bestDist = Infinity;
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const p = pSpline.evaluate(t);
        const dx = p[0] - child.startPos[0];
        const dy = p[1] - child.startPos[1];
        const dz = p[2] - child.startPos[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) { bestDist = d; bestT = t; }
      }
      // Refine
      const lo = Math.max(0, bestT - 0.05);
      const hi = Math.min(1, bestT + 0.05);
      for (let i = 0; i <= 20; i++) {
        const t = lo + (hi - lo) * i / 20;
        const p = pSpline.evaluate(t);
        const dx = p[0] - child.startPos[0];
        const dy = p[1] - child.startPos[1];
        const dz = p[2] - child.startPos[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) { bestDist = d; bestT = t; }
      }

      let effectiveParentRadius = getTaperedRadiusAt(bestParent, bestT);

      // Root flare compensation — getTaperedRadiusAt doesn't include per-ring
      // root flare which is applied later in buildBranchTube based on Y position.
      if (bestParent.depth === 0 && !bestParent.isRoot && !bestParent._undergroundTrunk
          && opts.rootFlare > 1.001 && opts.rootFlareHeight > 0.001) {
        const attachY = pSpline.evaluate(bestT)[1];
        if (attachY < opts.rootFlareHeight) {
          const blend = 1 - Math.max(0, attachY) / opts.rootFlareHeight;
          effectiveParentRadius *= 1 + (opts.rootFlare - 1) * blend * blend * blend;
        }
      }

      if (!child.isRoot && child.startRadius > effectiveParentRadius) {
        const scale = effectiveParentRadius / child.startRadius;
        child.startRadius = effectiveParentRadius;
        child.endRadius *= scale;
      }
    }
  }

  let vertexOffset = 0;
  const segmentInfos: SegmentMeshInfo[] = [];

  for (const seg of segments) {
    const indexStart = indices.length;
    const result = buildBranchTube(seg, treeHeight, opts, vertexOffset);

    const segInfo: SegmentMeshInfo = {
      segment: seg,
      rings: result.ringInfos,
      vertexStart: vertexOffset,
      vertexCount: result.vertexCount,
      indexStart,
      indexCount: result.indices.length,
    };
    segmentInfos.push(segInfo);

    positions.push(...result.positions);
    normals.push(...result.normals);
    tangents.push(...result.tangents);
    uvs.push(...result.uvs);
    indices.push(...result.indices);
    heightWeights.push(...result.heightWeights);
    depthWeights.push(...result.depthWeights);
    branchWeights.push(...result.branchWeights);
    branchAnchors.push(...result.branchAnchors);
    branchPhases.push(...result.branchPhases);

    vertexOffset += result.vertexCount;
  }

  // Stitch underground trunk to main trunk: rebuild ALL underground rings
  // using the trunk's ring 0 frame so the cylinder is perfectly straight.
  // The underground segment's own initialFrame() may differ from the trunk's
  // (e.g. conifer trunk starts at a slight angle due to kink/tropism), which
  // would cause a visible twist between ring 0 and the stitched last ring.
  const trunkInfo = segmentInfos.find(s => s.segment.depth === 0 && !s.segment.isRoot && !s.segment._undergroundTrunk);
  const underInfo = segmentInfos.find(s => s.segment._undergroundTrunk);
  if (trunkInfo && underInfo && trunkInfo.rings.length > 0 && underInfo.rings.length > 0) {
    const trunkRing0 = trunkInfo.rings[0];
    const radSegs = trunkRing0.radialSegments;

    // Copy trunk ring 0 exactly onto the underground's last ring (stitch point)
    const underLastRing = underInfo.rings[underInfo.rings.length - 1];
    const srcBase = trunkInfo.vertexStart;
    const dstBase = underLastRing.vertexStart;
    for (let j = 0; j <= radSegs; j++) {
      const src = (srcBase + j) * 3;
      const dst = (dstBase + j) * 3;
      positions[dst] = positions[src];
      positions[dst + 1] = positions[src + 1];
      positions[dst + 2] = positions[src + 2];
      normals[dst] = normals[src];
      normals[dst + 1] = normals[src + 1];
      normals[dst + 2] = normals[src + 2];
      const src4 = (srcBase + j) * 4, dst4 = (dstBase + j) * 4;
      tangents[dst4] = tangents[src4];
      tangents[dst4 + 1] = tangents[src4 + 1];
      tangents[dst4 + 2] = tangents[src4 + 2];
      tangents[dst4 + 3] = tangents[src4 + 3];
    }
    for (let j = 0; j < radSegs; j++) {
      underLastRing.positions[j] = [...trunkRing0.positions[j]];
    }
    underLastRing.center = [...trunkRing0.center];
    underLastRing.radius = trunkRing0.radius;
    underLastRing.normal = [...trunkRing0.normal];
    underLastRing.binormal = [...trunkRing0.binormal];
    underLastRing.tangent = [...trunkRing0.tangent];

    // Rebuild all other underground rings using the trunk's frame orientation
    // so the entire underground cylinder is twist-free.
    const frameN = trunkRing0.normal;
    const frameB = trunkRing0.binormal;
    const frameT = trunkRing0.tangent;
    for (let ri = 0; ri < underInfo.rings.length - 1; ri++) {
      const ring = underInfo.rings[ri];
      const rBase = ring.vertexStart;
      const r = ring.radius;
      const c = ring.center;
      for (let j = 0; j < radSegs; j++) {
        const angle = (j / radSegs) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const nx = frameN[0] * cos + frameB[0] * sin;
        const ny = frameN[1] * cos + frameB[1] * sin;
        const nz = frameN[2] * cos + frameB[2] * sin;
        const tx = -frameN[0] * sin + frameB[0] * cos;
        const ty = -frameN[1] * sin + frameB[1] * cos;
        const tz = -frameN[2] * sin + frameB[2] * cos;
        const idx3 = (rBase + j) * 3;
        positions[idx3] = c[0] + nx * r;
        positions[idx3 + 1] = c[1] + ny * r;
        positions[idx3 + 2] = c[2] + nz * r;
        normals[idx3] = nx;
        normals[idx3 + 1] = ny;
        normals[idx3 + 2] = nz;
        const idx4 = (rBase + j) * 4;
        tangents[idx4] = tx;
        tangents[idx4 + 1] = ty;
        tangents[idx4 + 2] = tz;
        tangents[idx4 + 3] = 1.0;
        ring.positions[j] = [c[0] + nx * r, c[1] + ny * r, c[2] + nz * r];
      }
      // Seam duplicate (j = radSegs wraps to j = 0)
      const wrap3 = (rBase + radSegs) * 3;
      const first3 = rBase * 3;
      positions[wrap3] = positions[first3];
      positions[wrap3 + 1] = positions[first3 + 1];
      positions[wrap3 + 2] = positions[first3 + 2];
      normals[wrap3] = normals[first3];
      normals[wrap3 + 1] = normals[first3 + 1];
      normals[wrap3 + 2] = normals[first3 + 2];
      const wrap4 = (rBase + radSegs) * 4;
      const first4 = rBase * 4;
      tangents[wrap4] = tangents[first4];
      tangents[wrap4 + 1] = tangents[first4 + 1];
      tangents[wrap4 + 2] = tangents[first4 + 2];
      tangents[wrap4 + 3] = tangents[first4 + 3];
      ring.normal = [...frameN];
      ring.binormal = [...frameB];
      ring.tangent = [...frameT];
    }
  }

  // Generate end-caps (triangle fans) when enabled and welding is off.
  // When welding is on, caps are handled by the CSG manifold + appendBranchTail.
  if (!opts.weldEnabled) {
    // Bottom cap on the underground trunk (or main trunk if no underground)
    if (opts.capTrunkBottom) {
      const bottomSeg = underInfo ?? trunkInfo;
      if (bottomSeg && bottomSeg.rings.length > 0) {
        const ring = bottomSeg.rings[0];
        const radSegs = ring.radialSegments;
        const capIdx = positions.length / 3;
        positions.push(ring.center[0], ring.center[1], ring.center[2]);
        const n = vec3Scale(ring.tangent, -1);
        normals.push(n[0], n[1], n[2]);
        tangents.push(1, 0, 0, 1);
        uvs.push(0.5, 0.5);
        heightWeights.push(heightWeights[ring.vertexStart] ?? 0);
        depthWeights.push(depthWeights[ring.vertexStart] ?? 0);
        branchWeights.push(0);
        branchAnchors.push(
          branchAnchors[ring.vertexStart * 3] ?? 0,
          branchAnchors[ring.vertexStart * 3 + 1] ?? 0,
          branchAnchors[ring.vertexStart * 3 + 2] ?? 0,
        );
        branchPhases.push(branchPhases[ring.vertexStart] ?? 0);
        for (let j = 0; j < radSegs; j++) {
          indices.push(capIdx, ring.vertexStart + j + 1, ring.vertexStart + j);
        }
      }
    }

    // Tip caps on branch/root segments
    for (const info of segmentInfos) {
      if (info.rings.length === 0) continue;
      const seg = info.segment;
      const isBranch = !seg.isRoot && !seg._undergroundTrunk;
      const isRoot = !!seg.isRoot;
      if (isBranch && !opts.capBranchTips) continue;
      if (isRoot && !opts.capRootTips) continue;
      if (seg._undergroundTrunk) continue; // underground trunk tip joins main trunk, no cap needed

      const ring = info.rings[info.rings.length - 1];
      const radSegs = ring.radialSegments;
      const capIdx = positions.length / 3;
      positions.push(ring.center[0], ring.center[1], ring.center[2]);
      normals.push(ring.tangent[0], ring.tangent[1], ring.tangent[2]);
      tangents.push(1, 0, 0, 1);
      uvs.push(0.5, 0.5);
      const lastVert = info.vertexStart + info.vertexCount - 1;
      heightWeights.push(heightWeights[lastVert] ?? 0);
      depthWeights.push(depthWeights[lastVert] ?? 0);
      branchWeights.push(1);
      branchAnchors.push(
        branchAnchors[lastVert * 3] ?? 0,
        branchAnchors[lastVert * 3 + 1] ?? 0,
        branchAnchors[lastVert * 3 + 2] ?? 0,
      );
      branchPhases.push(branchPhases[lastVert] ?? 0);
      for (let j = 0; j < radSegs; j++) {
        indices.push(capIdx, ring.vertexStart + j, ring.vertexStart + j + 1);
      }
    }
  }

  const result = {
    positions, normals, tangents, uvs, indices,
    heightWeights, depthWeights, branchWeights, branchAnchors, branchPhases,
    segmentInfos,
  };
  if (opts.smartFitEnabled || opts.weldEnabled) {
    smartFitBranches(segmentInfos, result, opts);
  }
  return result;
}

// ============================================================
// Frame utilities
// ============================================================

function initialFrame(tangent: Vec3): { normal: Vec3; binormal: Vec3 } {
  let ref: Vec3 = [0, 1, 0];
  if (Math.abs(tangent[1]) > 0.99) {
    ref = [1, 0, 0];
  }
  const normal = vec3Normalize(vec3Cross(tangent, ref));
  const binormal = vec3Normalize(vec3Cross(tangent, normal));
  return { normal, binormal };
}

function parallelTransportFrame(
  prevNormal: Vec3,
  prevBinormal: Vec3,
  prevTangent: Vec3,
  nextTangent: Vec3,
): { normal: Vec3; binormal: Vec3 } {
  const axis = vec3Cross(prevTangent, nextTangent);
  const axisLen = vec3Length(axis);

  if (axisLen < 1e-8) {
    return { normal: [...prevNormal], binormal: [...prevBinormal] };
  }

  const normalizedAxis = vec3Scale(axis, 1 / axisLen);
  const dot = Math.max(-1, Math.min(1, vec3Dot(prevTangent, nextTangent)));
  const angle = Math.acos(dot);

  const normal = vec3Normalize(vec3RotateAroundAxis(prevNormal, normalizedAxis, angle));
  const binormal = vec3Normalize(vec3RotateAroundAxis(prevBinormal, normalizedAxis, angle));

  return { normal, binormal };
}

// ============================================================
// Branch tube builder
// ============================================================

function buildBranchTube(
  seg: BranchSegment,
  treeHeight: number,
  opts: TubeMeshOptions,
  vertexOffset: number,
): TubeMeshResult & { vertexCount: number; ringInfos: RingInfo[] } {
  const spline = new CatmullRomSpline(seg.points);
  const arcLen = spline.getArcLength();
  let lengthSegs = Math.max(opts.minLengthSegments, Math.ceil(arcLen * opts.lengthSegmentsPerUnit));
  const radSegs = Math.max(3, Math.round(opts.radialSegments - seg.depth * opts.radialSegmentsDepthStep));

  const tValues: number[] = [];
  for (let i = 0; i <= lengthSegs; i++) tValues.push(i / lengthSegs);

  const positions: number[] = [];
  const normals: number[] = [];
  const tangents: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const heightWeights: number[] = [];
  const depthWeights: number[] = [];
  const branchWeights: number[] = [];
  const branchAnchors: number[] = [];
  const branchPhases: number[] = [];

  const bPhase = hashFloat(seg.id);
  const noiseSeed = seg.id * 137.5 + 42;
  const anchor: Vec3 = seg.depth === 0 ? [0, 0, 0] : seg.startPos;
  const depthFlex = seg.isRoot ? 0 : Math.min(seg.depth, 5) / 5;

  // Underground trunk extension: radii are already final (includes flare),
  // skip all taper / flare / twist / noise so the cylinder stays aligned
  // with the real trunk's ring 0 (which gets stitched onto the last ring).
  const isUndergroundTrunk = !!seg._undergroundTrunk;

  const hasNoise = opts.noiseAmplitude > 0 && !isUndergroundTrunk;
  const hasTwist = (Math.abs(opts.twistRate) > 0.001 || opts.twistNoise > 0.001) && !isUndergroundTrunk;

  // Per-branch taper — roots, trunk and branches can have their own settings
  let effectiveTaperAmount: number;
  let segTaperPower: number;
  if (isUndergroundTrunk) {
    effectiveTaperAmount = 0;
    segTaperPower = 1;
  } else if (seg.isRoot) {
    effectiveTaperAmount = opts.rootTaperAmount ?? opts.taperAmount;
    segTaperPower = opts.rootTaperPower ?? opts.taperPower;
  } else if (seg.depth === 0) {
    effectiveTaperAmount = opts.trunkTaperAmount ?? opts.taperAmount;
    segTaperPower = opts.trunkTaperPower ?? opts.taperPower;
  } else {
    effectiveTaperAmount = opts.taperAmount;
    segTaperPower = opts.taperPower;
  }
  // tipRadius override (skip roots and underground trunk)
  if (opts.tipRadius > 0 && !seg.isRoot && !isUndergroundTrunk && seg.endRadius > 0) {
    effectiveTaperAmount = Math.max(0, Math.min(1, 1 - opts.tipRadius / seg.endRadius));
  }
  // Precompute tangents and frames using parallel transport
  const splineTangents: Vec3[] = [];
  const frames: { normal: Vec3; binormal: Vec3 }[] = [];

  for (let i = 0; i <= lengthSegs; i++) {
    splineTangents.push(spline.tangent(tValues[i]));
  }

  frames.push(initialFrame(splineTangents[0]));
  for (let i = 1; i <= lengthSegs; i++) {
    const prev = frames[i - 1];
    frames.push(parallelTransportFrame(
      prev.normal, prev.binormal,
      splineTangents[i - 1], splineTangents[i],
    ));
  }

  // Precompute cumulative twist angles.
  //
  // Total twist = steady spiral + random variation
  //   twist(v) = twistRate * v  +  integral of twistNoise * noise(v, twistNoiseFreq)
  //
  // twistRate: steady directional spiral (can be negative for reverse)
  // twistNoise: amplitude of random back-and-forth variation (radians)
  // twistNoiseFreq: how fast the random variation oscillates (cycles/unit)
  //
  // Examples:
  //   rate=0.5, noise=0         → clean spiral
  //   rate=0,   noise=1, freq=2 → pure random twisting, no net direction
  //   rate=0.3, noise=0.8       → spiral with organic wobble
  const twistAngles: number[] = [];
  const hasTwistNoise = opts.twistNoise > 0.001;
  if (hasTwist) {
    let cumulativeTwist = 0;
    for (let i = 0; i <= lengthSegs; i++) {
      const t = tValues[i];
      const vCoord = arcLen * t;

      if (i > 0) {
        const dt = arcLen * (tValues[i] - tValues[i - 1]);

        // Steady component
        let twistDelta = opts.twistRate * dt;

        // Noise component: additive random twist variation
        if (hasTwistNoise) {
          const freq = opts.twistNoiseFreq;
          const noiseVal =
            0.6 * Math.sin(vCoord * freq * 1.7 + noiseSeed * 0.3) +
            0.4 * Math.sin(vCoord * freq * 3.1 + noiseSeed * 0.7) +
            0.3 * Math.cos(vCoord * freq * 2.3 + noiseSeed * 1.1);
          twistDelta += opts.twistNoise * noiseVal * dt;
        }

        cumulativeTwist += twistDelta;
      }
      twistAngles.push(cumulativeTwist);
    }
  }

  // Store all ring positions for normal recomputation after noise
  const allRingPositions: Vec3[][] = [];
  const ringInfos: RingInfo[] = [];

  // === Pass 1: Generate displaced ring positions ===
  for (let i = 0; i <= lengthSegs; i++) {
    const t = tValues[i];
    const point = spline.evaluate(t);
    // Taper: standard power curve
    const taperCurve = Math.pow(t, segTaperPower);
    const taperScale = 1 - effectiveTaperAmount * taperCurve;
    const baseRadius = seg.startRadius + (seg.endRadius - seg.startRadius) * t;
    let radius = baseRadius * taperScale;

    // Contact flare: shrink branch beyond flare region for collar effect
    if (opts.contactFlare > 0 && (seg.depth >= 1 || seg.isRoot)) {
      const flareT = Math.min(t / opts.contactFlareLength, 1);
      radius /= 1 + opts.contactFlare * smoothstep(flareT);
    }

    // Root flare: widen radius based on Y position, applied per-ring so
    // it never affects section spacing — only the radius changes.
    if (opts.rootFlare > 1.001 && seg.depth === 0 && !isUndergroundTrunk && opts.rootFlareHeight > 0.001) {
      const y = point[1];
      if (y < opts.rootFlareHeight) {
        const blend = 1 - Math.max(0, y) / opts.rootFlareHeight;
        radius *= 1 + (opts.rootFlare - 1) * blend * blend * blend;
      }
    }

    let { normal: frameNormal, binormal } = frames[i];
    const tangentDir = splineTangents[i];

    // Underground trunk: continue V below zero so the texture flows in the
    // same direction as the above-ground trunk instead of mirroring at ground level.
    // At t=1 (stitch point) V=0, matching trunk ring 0. Going down, V goes negative.
    const vCoord = isUndergroundTrunk ? arcLen * (t - 1) : arcLen * t;

    // Apply geometric twist: rotate the frame around the tangent
    if (hasTwist) {
      const twistAngle = twistAngles[i];
      frameNormal = vec3Normalize(vec3RotateAroundAxis(frameNormal, tangentDir, twistAngle));
      binormal = vec3Normalize(vec3RotateAroundAxis(binormal, tangentDir, twistAngle));
    }

    const ringPositions: Vec3[] = [];

    for (let j = 0; j < radSegs; j++) {
      const angle = (j / radSegs) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // Outward direction on the circle
      const nx = frameNormal[0] * cos + binormal[0] * sin;
      const ny = frameNormal[1] * cos + binormal[1] * sin;
      const nz = frameNormal[2] * cos + binormal[2] * sin;

      // Apply radial noise displacement
      let r = radius;
      if (hasNoise) {
        const noiseU = angle * opts.noiseFrequency;
        const noiseV = vCoord * opts.noiseFrequency;
        const n = barkNoise(noiseU, noiseV, noiseSeed, opts.noiseOctaves);
        r = radius * (1 + n * opts.noiseAmplitude);
      }

      ringPositions.push([
        point[0] + nx * r,
        point[1] + ny * r,
        point[2] + nz * r,
      ]);
    }

    allRingPositions.push(ringPositions);

    ringInfos.push({
      center: point,
      tangent: tangentDir,
      normal: frameNormal,
      binormal,
      radius,
      tParam: t,
      vertexStart: vertexOffset + i * (radSegs + 1),
      radialSegments: radSegs,
      positions: ringPositions,
    });
  }

  // === Pass 2: Compute normals from displaced geometry + emit vertices ===
  for (let i = 0; i <= lengthSegs; i++) {
    const t = tValues[i];
    const vCoord = isUndergroundTrunk ? arcLen * (t - 1) : arcLen * t;
    const hWeight = seg.isRoot ? 0 : (treeHeight > 0 ? Math.max(0, spline.evaluate(t)[1] / treeHeight) : 0);

    const ringPos = allRingPositions[i];
    const ringNormals: Vec3[] = [];
    const ringTangentsArr: Vec3[] = [];

    for (let j = 0; j < radSegs; j++) {
      if (hasNoise) {
        // Recompute normals from displaced surface via finite differences
        // Circumferential neighbor
        const jNext = (j + 1) % radSegs;
        const circumTangent = vec3Sub(ringPos[jNext], ringPos[j]);

        // Longitudinal neighbor
        let longTangent: Vec3;
        if (i < lengthSegs) {
          longTangent = vec3Sub(allRingPositions[i + 1][j], ringPos[j]);
        } else if (i > 0) {
          longTangent = vec3Sub(ringPos[j], allRingPositions[i - 1][j]);
        } else {
          longTangent = splineTangents[i];
        }

        const crossResult = vec3Cross(circumTangent, longTangent);
        const crossLen = vec3Length(crossResult);
        // Fallback to analytical frame normal when circumferential and longitudinal tangents are parallel
        const normal = crossLen > 1e-8 ? vec3Scale(crossResult, 1 / crossLen) : frames[i].normal;
        ringNormals.push(normal);
        ringTangentsArr.push(vec3Length(circumTangent) > 1e-8 ? vec3Normalize(circumTangent) : frames[i].binormal);
      } else {
        // No noise: use the clean analytical normals
        let { normal: frameNormal, binormal } = frames[i];
        const tangentDir = splineTangents[i];

        if (hasTwist) {
          const twistAngle = twistAngles[i];
          frameNormal = vec3Normalize(vec3RotateAroundAxis(frameNormal, tangentDir, twistAngle));
          binormal = vec3Normalize(vec3RotateAroundAxis(binormal, tangentDir, twistAngle));
        }

        const angle = (j / radSegs) * Math.PI * 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const nx = frameNormal[0] * cos + binormal[0] * sin;
        const ny = frameNormal[1] * cos + binormal[1] * sin;
        const nz = frameNormal[2] * cos + binormal[2] * sin;
        ringNormals.push([nx, ny, nz]);

        const tx = -frameNormal[0] * sin + binormal[0] * cos;
        const ty = -frameNormal[1] * sin + binormal[1] * cos;
        const tz = -frameNormal[2] * sin + binormal[2] * cos;
        ringTangentsArr.push(vec3Normalize([tx, ty, tz]));
      }
    }

    // Emit vertices (radSegs + 1, with seam duplicate)
    for (let j = 0; j <= radSegs; j++) {
      const srcJ = j % radSegs;

      const p = ringPos[srcJ];
      const n = ringNormals[srcJ];
      const tng = ringTangentsArr[srcJ];

      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      tangents.push(tng[0], tng[1], tng[2], 1.0);

      // UV twist: controls how much texture follows geometry twist.
      // uvTwist=1: texture fully follows geometry (no UV offset needed)
      // uvTwist=0: texture stays static (full counter-offset undoes twist)
      // uvTwist>1: texture twists MORE than geometry (exaggerated)
      let u = j / radSegs;
      if (hasTwist && Math.abs(opts.uvTwist - 1) > 0.001) {
        // Counter-rotate UV by (1 - uvTwist) of the twist angle.
        // At uvTwist=1, offset=0 (texture follows). At uvTwist=0, full counter-rotation.
        u += (twistAngles[i] / (Math.PI * 2)) * (1 - opts.uvTwist);
      }
      uvs.push(u * opts.uvTileU, vCoord * opts.uvTileV);

      heightWeights.push(hWeight);
      depthWeights.push(depthFlex);
      branchWeights.push(t);
      branchAnchors.push(anchor[0], anchor[1], anchor[2]);
      branchPhases.push(bPhase);
    }
  }

  // Generate indices
  for (let i = 0; i < lengthSegs; i++) {
    for (let j = 0; j < radSegs; j++) {
      const a = vertexOffset + i * (radSegs + 1) + j;
      const b = vertexOffset + i * (radSegs + 1) + j + 1;
      const c = vertexOffset + (i + 1) * (radSegs + 1) + j + 1;
      const d = vertexOffset + (i + 1) * (radSegs + 1) + j;

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const vertexCount = (lengthSegs + 1) * (radSegs + 1);

  return {
    positions, normals, tangents, uvs, indices,
    heightWeights, depthWeights, branchWeights, branchAnchors, branchPhases,
    vertexCount,
    ringInfos,
  };
}

function hashFloat(n: number): number {
  let x = ((n + 1) * 2654435761) | 0;
  x = ((x >>> 16) ^ x) * 0x45d9f3b | 0;
  return ((x >>> 0) % 10000) / 10000;
}
