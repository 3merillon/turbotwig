import type { BranchSegment, TreeSkeleton } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import { vec3Add, vec3Scale, vec3Normalize, vec3Cross, vec3RotateAroundAxis } from '../../utils/math';
import { SeededRandom } from '../../utils/random';

/** Configuration for procedural root generation including shape, sub-roots, and trunk extension. */
export interface RootOptions {
  /** Number of main roots radiating from base (3–8) */
  rootCount: number;
  /** Length of each main root relative to tree height (0.1–0.5) */
  rootLength: number;
  /** How far underground the trunk extends below Y=0 */
  trunkExtension: number;
  /** Root base radius as fraction of trunk radius (0.3–0.8) */
  rootRadiusFraction: number;
  /** How steeply roots angle downward in degrees (10–60) */
  rootPitchAngle: number;
  /** Spread angle variance in degrees */
  rootPitchVariance: number;
  /** How much roots flare where they meet the trunk (1 = no flare, 1.5 = moderate) */
  rootFlare: number;
  /** How high up the trunk the flare extends, as a multiplier of trunk radius */
  rootFlareHeight: number;
  /** Number of control points per root (more = smoother curve) */
  rootSubdivisions: number;
  /** Gravity pull — how much roots curve downward along their length (0–1) */
  rootGravity: number;
  /** Kink angle in degrees at each root subdivision for organic bends */
  rootKinkAngle: number;
  /** Vertical offset for root attachment point (positive = higher on trunk). */
  rootHeight: number;
  /** Trunk initial radius — needed to compute safe inset. */
  trunkRadius: number;
  /** Push roots in/out from trunk surface (-1=fully inside, 0=at surface, 1=outside). */
  rootSurfaceOffset: number;
  /** Trunk taper amount (must match mesh builder). */
  taperAmount: number;
  /** Trunk taper power (must match mesh builder). */
  taperPower: number;
  /** Trunk-specific taper amount override (undefined = use taperAmount). */
  trunkTaperAmount?: number;
  /** Trunk-specific taper power override (undefined = use taperPower). */
  trunkTaperPower?: number;
  /** Mesh root flare multiplier (must match mesh builder). */
  meshRootFlare: number;
  /** Mesh root flare height in world units (must match mesh builder). */
  meshRootFlareHeight: number;
  /** XZ distance from trunk center at which roots start bending straight down (world units). 0 = disabled. */
  rootPullDownRadius: number;
  /** Strength of the pull-down effect (0 = none, 1 = full vertical). */
  rootPullDownStrength: number;
  /** Number of sub-root branching levels (0 = none, 1 = one level, 2+ = recursive). */
  subRootLevels: number;
  /** Maximum number of sub-roots spawned per parent root at each level. */
  subRootCount: number;
  /** Scale multiplier for sub-root length (0.2–3). */
  subRootScale: number;
  /** Contact flare strength (must match mesh builder). */
  contactFlare: number;
  /** Contact flare length (must match mesh builder). */
  contactFlareLength: number;
}

export const DEFAULT_ROOT_OPTIONS: RootOptions = {
  rootCount: 5,
  rootLength: 0.2,
  trunkExtension: 1.5,
  rootRadiusFraction: 0.55,
  rootPitchAngle: 25,
  rootPitchVariance: 10,
  rootFlare: 1.4,
  rootFlareHeight: 3,
  rootSubdivisions: 6,
  rootGravity: 0.4,
  rootKinkAngle: 5,
  rootHeight: 0,
  trunkRadius: 0.5,
  rootSurfaceOffset: 0,
  taperAmount: 0.7,
  taperPower: 1,
  meshRootFlare: 1,
  meshRootFlareHeight: 1.5,
  rootPullDownRadius: 0,
  rootPullDownStrength: 0.8,
  subRootLevels: 1,
  subRootCount: 2,
  subRootScale: 1,
  contactFlare: 0,
  contactFlareLength: 0.15,
};

/**
 * Generate root segments and extend the trunk underground.
 *
 * The trunk extension is done by prepending points directly into the trunk
 * segment's points/radii arrays so the mesh builder produces one continuous
 * tube with shared vertices — no seam or mismatch possible.
 *
 * Root branches radiate outward and downward from the trunk base (Y=0),
 * SpeedTree-style, designed to intersect terrain.
 *
 * All returned root branch segments have `isRoot = true` so the mesh builder
 * can disable wind animation on them.
 */
export function generateRoots(
  skeleton: TreeSkeleton,
  seed: number,
  options: Partial<RootOptions> = {},
): BranchSegment[] {
  const opts = { ...DEFAULT_ROOT_OPTIONS, ...options };
  const rng = new SeededRandom(seed + 7777);

  // Find the trunk segment(s) — depth 0
  const trunkSegments = skeleton.segments.filter(s => s.depth === 0);
  if (trunkSegments.length === 0) return [];

  const trunk = trunkSegments[0];
  const trunkBaseRadius = trunk.startRadius;
  const treeHeight = skeleton.bounds.max[1] - skeleton.bounds.min[1];
  const rootLength = opts.rootLength * treeHeight;

  let nextId = skeleton.segments.reduce((max, s) => Math.max(max, s.id), 0) + 1;
  const rootSegments: BranchSegment[] = [];
  const trunkCenterX = trunk.points[0][0];
  const trunkCenterZ = trunk.points[0][2];

  // --- 1. Extend trunk underground ---
  // Create a separate depth-0 segment for the underground portion so the
  // original trunk spline is completely untouched (no tangent/noise/shape
  // side-effects).  The welder CSG-unions all depth-0 segments in Phase 1,
  // so roots will weld seamlessly to this underground extension.
  if (opts.trunkExtension > 0.01) {
    const base = trunk.points[0];
    const bottom: Vec3 = [base[0], base[1] - opts.trunkExtension, base[2]];
    // Use the trunk's visual radius at the base (including root flare) so the
    // underground cylinder matches the trunk's ring 0 exactly.
    const baseVisualRadius = visualTrunkRadiusAtY(base[1]);
    const undergroundSeg: BranchSegment = {
      id: nextId++,
      parentId: trunk.id,
      depth: 0,
      startPos: bottom,
      endPos: base,
      startRadius: baseVisualRadius,
      endRadius: baseVisualRadius,
      direction: [0, 1, 0],
      children: [],
      points: [bottom, base],
      radii: [baseVisualRadius, baseVisualRadius],
      segmentIndex: 0,
    };
    // Mark so TubeMeshBuilder skips taper/flare (radius is already final)
    undergroundSeg._undergroundTrunk = true;
    skeleton.segments.push(undergroundSeg);
  }

  // Compute the visual trunk radius at a Y height, matching the mesh builder's
  // taper + root flare logic exactly.
  function visualTrunkRadiusAtY(y: number, includeFlare = true): number {
    const pts = trunk.points;
    const rads = trunk.radii;

    // Find raw (skeleton) radius by scanning trunk points for Y bracket
    let rawRadius = rads[0];
    for (let j = 0; j < pts.length - 1; j++) {
      const y0 = pts[j][1], y1 = pts[j + 1][1];
      if ((y0 <= y && y <= y1) || (y1 <= y && y <= y0)) {
        const segT = Math.abs(y1 - y0) > 1e-6 ? (y - y0) / (y1 - y0) : 0;
        rawRadius = rads[j] + (rads[j + 1] - rads[j]) * segT;
        break;
      }
    }
    if (y >= pts[pts.length - 1][1]) rawRadius = rads[rads.length - 1];

    // Compute t as fraction of trunk's above-ground Y span (ground=0, top=1).
    // Underground (Y<0) gets t=0 → no taper, matching the mesh builder which
    // tapers based on spline arc-length from the base upward.
    const trunkTopY = pts[pts.length - 1][1];
    const t = trunkTopY > 0.01 ? Math.max(0, y) / trunkTopY : 0;

    // Apply taper (same formula as TubeMeshBuilder)
    const taperAmt = opts.trunkTaperAmount ?? opts.taperAmount;
    const taperPow = opts.trunkTaperPower ?? opts.taperPower;
    const taperCurve = Math.pow(t, taperPow);
    let radius = rawRadius * (1 - taperAmt * taperCurve);

    // Apply root flare (same formula as TubeMeshBuilder)
    if (includeFlare && opts.meshRootFlare > 1.001 && opts.meshRootFlareHeight > 0.001) {
      if (y < opts.meshRootFlareHeight) {
        const blend = 1 - Math.max(0, y) / opts.meshRootFlareHeight;
        radius *= 1 + (opts.meshRootFlare - 1) * blend * blend * blend;
      }
    }

    return radius;
  }

  // --- 2. Generate radiating root branches ---
  const goldenAngle = 137.508; // degrees — good angular distribution
  const baseAzimuth = rng.range(0, 360);

  for (let i = 0; i < opts.rootCount; i++) {
    const azimuth = (baseAzimuth + i * goldenAngle + rng.gaussian(0, 15)) * (Math.PI / 180);
    const pitch = (opts.rootPitchAngle + rng.gaussian(0, opts.rootPitchVariance)) * (Math.PI / 180);

    // Initial direction: outward in XZ plane, angled downward
    const outward: Vec3 = [Math.cos(azimuth), 0, Math.sin(azimuth)];
    const downComponent = -Math.sin(pitch);
    const horizontalComponent = Math.cos(pitch);
    let direction: Vec3 = vec3Normalize([
      outward[0] * horizontalComponent,
      downComponent,
      outward[2] * horizontalComponent,
    ]);

    // Root starts at the trunk surface at the attachment height,
    // using the visual radius including flare so roots don't clip.
    const attachY = opts.rootHeight;
    const visualRadius = visualTrunkRadiusAtY(attachY, true);
    const rootRadius = visualRadius * opts.rootRadiusFraction * rng.range(0.8, 1.2);
    const thisRootLength = rootLength * rng.range(0.7, 1.3);
    const stepLen = thisRootLength / opts.rootSubdivisions;

    const points: Vec3[] = [];
    const radii: number[] = [];
    // Place root at the visual surface, offset by rootSurfaceOffset.
    // offset=0: root center at trunk surface (half inside, half outside)
    // offset<0: pushed further into trunk, offset>0: further out
    const surfaceDist = visualRadius + rootRadius * opts.rootSurfaceOffset;
    let pos: Vec3 = [
      trunkCenterX + outward[0] * surfaceDist,
      attachY,
      trunkCenterZ + outward[2] * surfaceDist,
    ];

    for (let j = 0; j <= opts.rootSubdivisions; j++) {
      const t = j / opts.rootSubdivisions;

      const r = rootRadius;

      points.push([...pos]);
      radii.push(Math.max(r, 0.02));

      if (j < opts.rootSubdivisions) {
        // Apply gravity — gradually bend downward
        direction = vec3Normalize([
          direction[0],
          direction[1] - opts.rootGravity * stepLen * 0.3,
          direction[2],
        ]);

        // Pull-down: after a certain XZ distance, progressively force direction downward
        if (opts.rootPullDownRadius > 0) {
          const pdx = pos[0] - trunkCenterX;
          const pdz = pos[2] - trunkCenterZ;
          const xzDist = Math.sqrt(pdx * pdx + pdz * pdz);
          const fadeStart = opts.rootPullDownRadius;
          const fadeEnd = opts.rootPullDownRadius * 1.5;
          if (xzDist > fadeStart) {
            const raw = Math.max(0, Math.min(1, (xzDist - fadeStart) / (fadeEnd - fadeStart)));
            const blend = raw * raw * (3 - 2 * raw); // smoothstep
            const pullStrength = blend * opts.rootPullDownStrength;
            direction = vec3Normalize([
              direction[0] * (1 - pullStrength),
              direction[1] * (1 - pullStrength) + (-1) * pullStrength,
              direction[2] * (1 - pullStrength),
            ]);
          }
        }

        // Kink: random direction change at each step for organic bends
        if (opts.rootKinkAngle > 0) {
          const kinkRad = rng.gaussian(0, opts.rootKinkAngle * (Math.PI / 180));
          const randomAz = rng.range(0, Math.PI * 2);
          // Build perpendicular axis
          const ref: Vec3 = Math.abs(direction[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
          const perp = vec3Normalize(vec3Cross(direction, ref));
          const kinkAxis = vec3Normalize(vec3RotateAroundAxis(perp, direction, randomAz));
          direction = vec3Normalize(vec3RotateAroundAxis(direction, kinkAxis, kinkRad));
        }

        pos = vec3Add(pos, vec3Scale(direction, stepLen));
      }
    }

    const startPos = points[0];
    const endPos = points[points.length - 1];
    const dx = endPos[0] - startPos[0];
    const dy = endPos[1] - startPos[1];
    const dz = endPos[2] - startPos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dir: Vec3 = len > 1e-10 ? [dx / len, dy / len, dz / len] : [0, -1, 0];

    const seg: BranchSegment = {
      id: nextId++,
      parentId: trunk.id,
      depth: 1,
      startPos: [...startPos],
      endPos: [...endPos],
      startRadius: radii[0],
      endRadius: radii[radii.length - 1],
      direction: dir,
      children: [],
      points,
      radii,
      segmentIndex: 0,
      isRoot: true,
    };
    rootSegments.push(seg);

    // --- Sub-roots: recursive branching off each main root ---
    if (opts.subRootLevels > 0) {
      spawnSubRoots(seg, points, radii, thisRootLength, 1, 1);
    }
  }

  /**
   * Recursively spawn sub-roots off a parent root.
   * Sub-roots spread radially outward from the parent's local tangent,
   * distributed evenly along the parent with jitter.
   */
  function spawnSubRoots(
    parentSeg: BranchSegment,
    parentPoints: Vec3[],
    parentRadii: number[],
    parentLength: number,
    level: number,
    baseDepth: number,
  ): void {
    if (level > opts.subRootLevels) return;

    const count = opts.subRootCount;
    if (count <= 0) return;

    // Distribute branch points evenly along parent (20%–80% range) with jitter
    const tMin = 0.2;
    const tMax = 0.8;
    const spacing = (tMax - tMin) / Math.max(count, 1);

    for (let k = 0; k < count; k++) {
      // Evenly spaced t with random jitter within each slot
      const slotCenter = tMin + (k + 0.5) * spacing;
      const branchT = slotCenter + rng.gaussian(0, spacing * 0.2);
      const clampedT = Math.max(tMin, Math.min(tMax, branchT));
      const branchIdx = Math.floor(clampedT * (parentPoints.length - 1));
      const safeIdx = Math.min(branchIdx, parentPoints.length - 1);
      const branchPos = parentPoints[safeIdx];
      // Compute visual parent radius at branch point, matching the mesh
      // builder's formula for root segments: taper + contact flare.
      // This ensures sub-roots are sized and positioned relative to the
      // ACTUAL rendered parent surface, not the skeleton radius.
      const taperPart = 1 - opts.taperAmount * Math.pow(clampedT, opts.taperPower);
      // Contact flare: smoothstep(flareT) where flareT = clamp(t/flareLen, 0, 1)
      const flareT = Math.min(clampedT / opts.contactFlareLength, 1);
      const flareSmooth = flareT * flareT * (3 - 2 * flareT);
      const flareDivisor = 1 + opts.contactFlare * flareSmooth;
      const parentVisualR = parentRadii[safeIdx] * taperPart / flareDivisor;
      // Sub-root sized as fraction of visual parent radius.
      // Cap at 0.6 so the sub-root base is always comfortably smaller than
      // the parent — even with high contact flare on the sub-root itself.
      const branchRadius = parentVisualR * rng.range(0.35, 0.55);

      // Skip sub-roots that are too thin — they create degenerate geometry
      if (branchRadius < 0.03) continue;

      // Compute parent tangent at branch point for radial spread
      const prevIdx = Math.max(0, safeIdx - 1);
      const nextIdx = Math.min(parentPoints.length - 1, safeIdx + 1);
      const parentTangent = vec3Normalize([
        parentPoints[nextIdx][0] - parentPoints[prevIdx][0],
        parentPoints[nextIdx][1] - parentPoints[prevIdx][1],
        parentPoints[nextIdx][2] - parentPoints[prevIdx][2],
      ]);

      // Build a radial outward direction perpendicular to parent tangent
      const ref: Vec3 = Math.abs(parentTangent[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const perp1 = vec3Normalize(vec3Cross(parentTangent, ref));
      const perp2 = vec3Normalize(vec3Cross(parentTangent, perp1));
      // Random azimuth around the parent axis
      const az = rng.range(0, Math.PI * 2);
      const radialOut: Vec3 = vec3Normalize([
        perp1[0] * Math.cos(az) + perp2[0] * Math.sin(az),
        perp1[1] * Math.cos(az) + perp2[1] * Math.sin(az),
        perp1[2] * Math.cos(az) + perp2[2] * Math.sin(az),
      ]);

      // Blend parent tangent with radial outward direction (more radial = more spread)
      const radialWeight = 0.6;
      const blendedY = parentTangent[1] * (1 - radialWeight) + radialOut[1] * radialWeight - 0.4;
      let subDir = vec3Normalize([
        parentTangent[0] * (1 - radialWeight) + radialOut[0] * radialWeight,
        Math.min(blendedY, -0.1), // roots always point downward
        parentTangent[2] * (1 - radialWeight) + radialOut[2] * radialWeight,
      ]);

      // Each level is shorter and has fewer subdivisions
      const levelScale = Math.pow(0.5, level);
      const subLen = parentLength * rng.range(0.3, 0.5) * levelScale * opts.subRootScale;
      const subSteps = Math.max(3, Math.ceil(opts.rootSubdivisions * Math.pow(0.6, level)));
      const subStepLen = subLen / subSteps;
      const subPoints: Vec3[] = [];
      const subRadii: number[] = [];
      // Offset sub-root start to visual parent surface (mirrors main root surfaceDist logic)
      const surfaceDistSub = parentVisualR + branchRadius * opts.rootSurfaceOffset;
      let subPos: Vec3 = [
        branchPos[0] + radialOut[0] * surfaceDistSub,
        branchPos[1] + radialOut[1] * surfaceDistSub,
        branchPos[2] + radialOut[2] * surfaceDistSub,
      ];

      for (let s = 0; s <= subSteps; s++) {
        subPoints.push([...subPos]);
        subRadii.push(branchRadius);

        if (s < subSteps) {
          // Gravity
          subDir = vec3Normalize([
            subDir[0],
            subDir[1] - opts.rootGravity * subStepLen * 0.4,
            subDir[2],
          ]);

          // Pull-down
          if (opts.rootPullDownRadius > 0) {
            const pdx = subPos[0] - trunkCenterX;
            const pdz = subPos[2] - trunkCenterZ;
            const xzDist = Math.sqrt(pdx * pdx + pdz * pdz);
            const fadeStart = opts.rootPullDownRadius;
            const fadeEnd = opts.rootPullDownRadius * 1.5;
            if (xzDist > fadeStart) {
              const raw = Math.max(0, Math.min(1, (xzDist - fadeStart) / (fadeEnd - fadeStart)));
              const blend = raw * raw * (3 - 2 * raw);
              const pullStrength = blend * opts.rootPullDownStrength;
              subDir = vec3Normalize([
                subDir[0] * (1 - pullStrength),
                subDir[1] * (1 - pullStrength) + (-1) * pullStrength,
                subDir[2] * (1 - pullStrength),
              ]);
            }
          }

          // Kink
          if (opts.rootKinkAngle > 0) {
            const kinkRad = rng.gaussian(0, opts.rootKinkAngle * (Math.PI / 180));
            const randomAz = rng.range(0, Math.PI * 2);
            const kRef: Vec3 = Math.abs(subDir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
            const kPerp = vec3Normalize(vec3Cross(subDir, kRef));
            const kinkAxis = vec3Normalize(vec3RotateAroundAxis(kPerp, subDir, randomAz));
            subDir = vec3Normalize(vec3RotateAroundAxis(subDir, kinkAxis, kinkRad));
          }
          subPos = vec3Add(subPos, vec3Scale(subDir, subStepLen));
        }
      }

      const subStart = subPoints[0];
      const subEnd = subPoints[subPoints.length - 1];
      const sdx = subEnd[0] - subStart[0];
      const sdy = subEnd[1] - subStart[1];
      const sdz = subEnd[2] - subStart[2];
      const slen = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);

      const subSeg: BranchSegment = {
        id: nextId++,
        parentId: parentSeg.id,
        depth: baseDepth + level,
        startPos: [...subStart],
        endPos: [...subEnd],
        startRadius: subRadii[0],
        endRadius: subRadii[subRadii.length - 1],
        direction: slen > 1e-10 ? [sdx / slen, sdy / slen, sdz / slen] : [0, -1, 0],
        children: [],
        points: subPoints,
        radii: subRadii,
        segmentIndex: 0,
        isRoot: true,
      };
      rootSegments.push(subSeg);

      // Recurse for deeper levels
      if (level < opts.subRootLevels) {
        spawnSubRoots(subSeg, subPoints, subRadii, subLen, level + 1, baseDepth);
      }
    }
  }

  return rootSegments;
}
