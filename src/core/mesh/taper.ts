import type { BranchSegment } from '../../types/tree';

/**
 * Parameters that control how branch radius tapers along its length.
 * Shared by TubeMeshBuilder, LeafPlacer, and any other consumer that
 * needs to query the visual radius at a point along a branch.
 */
export interface TaperParams {
  taperAmount: number;
  taperPower: number;
  rootTaperAmount?: number;
  rootTaperPower?: number;
  trunkTaperAmount?: number;
  trunkTaperPower?: number;
  contactFlare: number;
  contactFlareLength: number;
  tipRadius: number;
}

/**
 * Hermite smoothstep: maps x from [0,1] to a smooth S-curve.
 * Values outside [0,1] are clamped.
 */
export function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/**
 * Compute the visual (tapered) radius of a branch segment at parameter t (0..1).
 *
 * Handles root, trunk, and branch taper independently, applies tipRadius override,
 * and adds contact flare at branch junctions. This is the single source of truth
 * for radius computation — TubeMeshBuilder uses it for mesh generation and
 * LeafPlacer uses it for surface placement.
 */
export function getTaperedRadius(seg: BranchSegment, t: number, params: TaperParams): number {
  // 1. Select base taper params (root / trunk / branch)
  let taperAmt: number;
  let taperPow: number;
  if (seg.isRoot) {
    taperAmt = params.rootTaperAmount ?? params.taperAmount;
    taperPow = params.rootTaperPower ?? params.taperPower;
  } else if (seg.depth === 0) {
    taperAmt = params.trunkTaperAmount ?? params.taperAmount;
    taperPow = params.trunkTaperPower ?? params.taperPower;
  } else {
    taperAmt = params.taperAmount;
    taperPow = params.taperPower;
  }

  // 2. tipRadius override (skip roots)
  if (params.tipRadius > 0 && !seg.isRoot && seg.endRadius > 0) {
    taperAmt = Math.max(0, Math.min(1, 1 - params.tipRadius / seg.endRadius));
  }

  // 3. Standard taper curve
  const taperCurve = Math.pow(t, taperPow);
  const baseR = seg.startRadius + (seg.endRadius - seg.startRadius) * t;
  let radius = baseR * (1 - taperAmt * taperCurve);

  // 4. Contact flare: shrink branch beyond the flare region so the base
  //    appears wider (collar effect) while keeping startRadius unchanged.
  if (params.contactFlare > 0 && (seg.depth >= 1 || seg.isRoot)) {
    const flareT = Math.min(t / params.contactFlareLength, 1);
    radius /= 1 + params.contactFlare * smoothstep(flareT);
  }

  return radius;
}
