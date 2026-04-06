export interface BranchSegment {
  id: number;
  parentId: number;
  depth: number;
  startPos: [number, number, number];
  endPos: [number, number, number];
  startRadius: number;
  endRadius: number;
  direction: [number, number, number];
  children: number[];
  /** Control points along this branch for spline fitting */
  points: [number, number, number][];
  /** Radii at each control point */
  radii: number[];
  /** Index of this segment within its branch (0 = first segment from branch base) */
  segmentIndex: number;
  /** True for root segments — no wind animation, grow below ground */
  isRoot?: boolean;
  /** Stable hierarchical path ID for per-branch editing (e.g. "0.2.1").
   *  Encodes position in tree: trunk child-index . sub-child-index ...
   *  Stable across regenerations with same seed/iterations. */
  pathId?: string;
  /** True for the synthetic underground trunk extension created by RootGenerator. */
  _undergroundTrunk?: boolean;
}

export interface TreeSkeleton {
  segments: BranchSegment[];
  rootIds: number[];
  maxDepth: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

