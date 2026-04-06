export interface ProductionRule {
  predecessor: string;
  condition?: (params: number[]) => boolean;
  successor: string | ((params: number[], rng: { next(): number }) => string);
  probability?: number;
}

export interface LSystemConfig {
  axiom: string;
  rules: ProductionRule[];
  iterations: number;
  defaultAngle: number;
  defaultSubAngle: number;
  defaultLength: number;
  defaultRadius: number;
  lengthScale: number;
  radiusScale: number;
  /** Per-whorl branch length reduction factor (1 = no taper, 0.8 = 20% shorter each whorl). */
  whorlTaper?: number;
  /** Maximum branches per whorl at the base of the tree (default 5). */
  whorlMaxBranches?: number;
  /** Reduction in branch count per whorl going up (default 0.4). */
  whorlBranchReduction?: number;
}

export interface TurtleState {
  position: [number, number, number];
  heading: [number, number, number];
  up: [number, number, number];
  right: [number, number, number];
  /**
   * "Intended" heading tracked parallel to `heading`, receiving all the same
   * rotations EXCEPT kinks. Used by applyKink to bias its azimuth so kinks
   * oscillate around the intended direction instead of drifting cumulatively.
   */
  baselineHeading: [number, number, number];
  radius: number;
  depth: number;
  segmentLength: number;
  segmentIndex: number;
}

export interface TurtleParams {
  angle: number;
  angleVariance: number;
  lengthScale: number;
  radiusScale: number;
  initialRadius: number;
  initialLength: number;
  tropism: [number, number, number];
  tropismStrength: number;
  /** Kink angle in degrees applied to parent heading at each branch junction (0=none). */
  kinkAngle: number;
  /** Gaussian variance of kink angle in degrees. */
  kinkVariance: number;
  /**
   * How strongly kink biases its azimuth toward restoring the branch's
   * intended direction (0 = fully random, ~1.5 = balanced, 3+ = strongly
   * oscillating around intended direction). Prevents cumulative drift.
   */
  kinkRestore: number;
  /** Bias branch headings toward horizontal plane (0=none, 1=strong). */
  flattenBias: number;
  /** Weight-based droop: longer branches droop more (scales tropism by cumulative length). */
  branchWeight: number;
  /** Upward light-seeking bias for branches (0=none). Branches curve toward light. */
  phototropism: number;
}
