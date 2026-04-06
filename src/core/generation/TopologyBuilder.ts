import type { BranchSegment, TreeSkeleton } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import { CatmullRomSpline } from '../../utils/spline';

/** Max squared distance for geometric parent search (3 world units radius). */
const MAX_PARENT_SEARCH_DIST_SQ = 9;
/** Number of spline samples for geometric parent proximity search. */
const PARENT_SEARCH_SAMPLES = 20;

/**
 * Fixes/validates parent-child topology on a tree skeleton.
 *
 * The turtle now assigns parentId during generation, but some segments
 * (especially the trunk and root-attached branches) may still have
 * parentId = -1. This builder fills in missing relationships using
 * geometric proximity — the same approach TubeMeshBuilder already uses
 * for radius clamping — and rebuilds children[] arrays.
 */
export function buildTopology(skeleton: TreeSkeleton): void {
  const { segments } = skeleton;
  if (segments.length === 0) return;

  // Index segments by id for fast lookup
  const byId = new Map<number, BranchSegment>();
  for (const seg of segments) {
    byId.set(seg.id, seg);
    seg.children = []; // reset children — we'll rebuild
  }

  // For segments with parentId already set, register as child
  for (const seg of segments) {
    if (seg.parentId >= 0) {
      const parent = byId.get(seg.parentId);
      if (parent) {
        parent.children.push(seg.id);
        continue;
      }
      // Parent ID invalid — fall through to geometric search
      seg.parentId = -1;
    }

    // Skip trunk (depth=0 non-root) — it has no parent
    if (seg.depth === 0 && !seg.isRoot) continue;

    // Geometric parent search for segments with parentId = -1
    let bestParent: BranchSegment | null = null;
    let bestDist = Infinity;

    for (const candidate of segments) {
      if (candidate.id === seg.id) continue;
      if (candidate.depth >= seg.depth && !seg.isRoot) continue;

      const spline = new CatmullRomSpline(candidate.points);
      for (let i = 0; i <= PARENT_SEARCH_SAMPLES; i++) {
        const t = i / PARENT_SEARCH_SAMPLES;
        const p = spline.evaluate(t);
        const dx = p[0] - seg.startPos[0];
        const dy = p[1] - seg.startPos[1];
        const dz = p[2] - seg.startPos[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          bestParent = candidate;
        }
      }
    }

    if (bestParent && bestDist < MAX_PARENT_SEARCH_DIST_SQ) {
      seg.parentId = bestParent.id;
      bestParent.children.push(seg.id);
    }
  }

  // Update rootIds
  skeleton.rootIds = segments.filter(s => s.parentId === -1).map(s => s.id);

  // Validate skeleton integrity
  validateSkeleton(skeleton);
}

/** Validate skeleton DAG: check for orphaned segments, circular references, and empty branches. */
function validateSkeleton(skeleton: TreeSkeleton): void {
  const { segments } = skeleton;
  const ids = new Set(segments.map(s => s.id));

  for (const seg of segments) {
    // Check for orphaned parent references
    if (seg.parentId >= 0 && !ids.has(seg.parentId)) {
      console.warn(`[Topology] Segment ${seg.id} references non-existent parent ${seg.parentId}, resetting to -1`);
      seg.parentId = -1;
    }
    // Check for self-referencing
    if (seg.parentId === seg.id) {
      console.warn(`[Topology] Segment ${seg.id} references itself as parent, resetting to -1`);
      seg.parentId = -1;
    }
    // Check for empty point arrays
    if (seg.points.length < 2) {
      console.warn(`[Topology] Segment ${seg.id} has only ${seg.points.length} points`);
    }
  }

  // Check for cycles (walk parent chain, should never revisit a node)
  for (const seg of segments) {
    const visited = new Set<number>();
    let current: number = seg.id;
    while (current >= 0) {
      if (visited.has(current)) {
        console.warn(`[Topology] Cycle detected involving segment ${current}, breaking cycle`);
        const cycleSeg = segments.find(s => s.id === current);
        if (cycleSeg) cycleSeg.parentId = -1;
        break;
      }
      visited.add(current);
      const s = segments.find(s => s.id === current);
      current = s ? s.parentId : -1;
    }
  }
}
