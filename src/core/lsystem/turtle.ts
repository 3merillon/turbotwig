import type { TurtleParams, TurtleState } from '../../types/lsystem';
import type { BranchSegment, TreeSkeleton } from '../../types/tree';
import type { Vec3 } from '../../utils/math';
import {
  vec3Add, vec3Scale, vec3Normalize, vec3RotateAroundAxis,
  vec3Cross, vec3Length, degToRad,
} from '../../utils/math';
import { SeededRandom } from '../../utils/random';
import { parseSymbolString } from './symbols';

const UP: Vec3 = [0, 1, 0];
const HEADING: Vec3 = [0, 1, 0];
const RIGHT: Vec3 = [1, 0, 0];

/** Seed offset to decorrelate turtle RNG from the L-system's own randomness. */
const TURTLE_SEED_OFFSET = 999;

/**
 * How strongly kink biases its azimuth AWAY from the just-closed child
 * branch. Higher = stronger guarantee parent doesn't kink into its child.
 */
const KINK_AVOID_WEIGHT = 1.0;

/**
 * How much the random azimuth spread shrinks when bias is strong.
 * At full bias strength, spread = PI * (1 - this value); at 0 bias,
 * spread = PI (fully random).
 */
const KINK_SPREAD_REDUCTION = 0.75;

interface BranchAccumulator {
  points: Vec3[];
  radii: number[];
  parentId: number;
  depth: number;
  /** Hierarchical path prefix for pathId generation (e.g. "0.2") */
  pathPrefix: string;
  /** Sibling counter: incremented each time a child is flushed at this depth */
  siblingCounter: number;
}

function createDefaultState(params: TurtleParams): TurtleState {
  return {
    position: [0, 0, 0],
    heading: [...HEADING],
    up: [...UP],
    right: [...RIGHT],
    baselineHeading: [...HEADING],
    radius: params.initialRadius,
    depth: 0,
    segmentLength: params.initialLength,
    segmentIndex: 0,
  };
}

function cloneState(s: TurtleState): TurtleState {
  return {
    position: [...s.position],
    heading: [...s.heading],
    up: [...s.up],
    right: [...s.right],
    baselineHeading: [...s.baselineHeading],
    radius: s.radius,
    depth: s.depth,
    segmentLength: s.segmentLength,
    segmentIndex: s.segmentIndex,
  };
}

/** Reorthogonalize the turtle frame after modifying heading. */
function reorthogonalize(state: TurtleState): void {
  state.right = vec3Normalize(vec3Cross(state.heading, state.up));
  if (vec3Length(state.right) < 0.01) {
    state.right = vec3Normalize(vec3Cross(state.heading, [0, 0, 1]));
  }
  state.up = vec3Normalize(vec3Cross(state.right, state.heading));
}

/**
 * Tropism: gradual bending toward a gravity/wind vector.
 * Branch weight scales the effect by cumulative length so longer branches droop more.
 */
function applyTropism(state: TurtleState, params: TurtleParams, cumulativeBranchLen: number): void {
  if (params.tropismStrength <= 0) return;
  const t = params.tropism;
  const weightScale = 1 + cumulativeBranchLen * (params.branchWeight ?? 0);
  const strength = params.tropismStrength * weightScale;
  state.heading = vec3Normalize([
    state.heading[0] + t[0] * strength,
    state.heading[1] + t[1] * strength,
    state.heading[2] + t[2] * strength,
  ]);
  // Apply the same tropism pull to baselineHeading so the kink-restoration
  // target tracks with tropism/gravity instead of fighting it.
  state.baselineHeading = vec3Normalize([
    state.baselineHeading[0] + t[0] * strength,
    state.baselineHeading[1] + t[1] * strength,
    state.baselineHeading[2] + t[2] * strength,
  ]);
  // Use direct reorthogonalize with special cross check for parallel vectors
  state.right = vec3Normalize(vec3Cross(state.heading, state.up));
  if (vec3Cross(state.heading, state.up).every(v => Math.abs(v) < 0.001)) {
    state.right = vec3Normalize(vec3Cross(state.heading, [0, 0, 1]));
  }
  state.up = vec3Normalize(vec3Cross(state.right, state.heading));
}

/**
 * Flatten bias: pull branch heading toward horizontal plane.
 * Reduces the vertical component so branches spread outward.
 */
function applyFlattenBias(state: TurtleState, params: TurtleParams): void {
  if ((params.flattenBias ?? 0) <= 0 || state.depth <= 0) return;
  const hx = state.heading[0];
  const hy = state.heading[1];
  const hz = state.heading[2];
  const horiz = Math.sqrt(hx * hx + hz * hz);
  if (horiz <= 0.01) return;
  const flatY = hy * (1 - params.flattenBias);
  state.heading = vec3Normalize([hx, flatY, hz]);
  // Apply the same flatten to baselineHeading
  const bhx = state.baselineHeading[0];
  const bhy = state.baselineHeading[1];
  const bhz = state.baselineHeading[2];
  const bhoriz = Math.sqrt(bhx * bhx + bhz * bhz);
  if (bhoriz > 0.01) {
    state.baselineHeading = vec3Normalize([bhx, bhy * (1 - params.flattenBias), bhz]);
  }
  reorthogonalize(state);
}

/**
 * Phototropism: branches curve upward toward light.
 * Adds an upward bias that accumulates over branch length.
 */
function applyPhototropism(state: TurtleState, params: TurtleParams): void {
  if ((params.phototropism ?? 0) <= 0 || state.depth <= 0) return;
  state.heading = vec3Normalize([
    state.heading[0],
    state.heading[1] + params.phototropism,
    state.heading[2],
  ]);
  // Apply the same light-seeking bias to baselineHeading
  state.baselineHeading = vec3Normalize([
    state.baselineHeading[0],
    state.baselineHeading[1] + params.phototropism,
    state.baselineHeading[2],
  ]);
  reorthogonalize(state);
}

/**
 * Kink: small rotation to parent heading at branch junctions.
 *
 * The kink azimuth is biased so that kinks OSCILLATE around the branch's
 * intended direction (baselineHeading) instead of drifting cumulatively
 * to one side, and so the parent does not kink INTO the child branch
 * that just closed (avoidDirection).
 *
 * Math: for a kink axis K = cos(a)*right + sin(a)*up in the plane
 * perpendicular to heading, a small rotation of heading by angle θ moves
 * heading in the direction  sin(a)*right − cos(a)*up. So to move heading
 * toward a target direction with components (dX, dY) in (right, up)
 * coords, we pick azimuth  a = atan2(dX, -dY).
 */
function applyKink(
  state: TurtleState,
  params: TurtleParams,
  rng: SeededRandom,
  avoidDirection: Vec3 | null,
): void {
  if (params.kinkAngle <= 0) return;
  const kinkMag = degToRad(params.kinkAngle + rng.gaussian(0, params.kinkVariance));
  if (Math.abs(kinkMag) <= 1e-6) return;

  // Accumulate bias as a 2D vector in the (right, up) azimuth plane.
  // Each bias source contributes (cos(az) * strength, sin(az) * strength);
  // the resultant direction is the chosen bias azimuth.
  let biasX = 0;
  let biasY = 0;

  // --- Restoring bias: rotate toward baselineHeading ---
  // This is what kills the "tree drifts in one direction" behavior.
  {
    const bh = state.baselineHeading;
    const devR = bh[0] * state.right[0] + bh[1] * state.right[1] + bh[2] * state.right[2];
    const devU = bh[0] * state.up[0]    + bh[1] * state.up[1]    + bh[2] * state.up[2];
    const devLen = Math.sqrt(devR * devR + devU * devU);
    if (devLen > 1e-6) {
      const az = Math.atan2(devR, -devU);
      // devLen is sin(angle between heading and baseline); in [0, 1].
      // Double-and-clamp makes the bias saturate quickly as deviation grows.
      const strength = Math.min(1, devLen * 2) * params.kinkRestore;
      biasX += Math.cos(az) * strength;
      biasY += Math.sin(az) * strength;
    }
  }

  // --- Avoidance bias: rotate AWAY from just-closed child direction ---
  if (avoidDirection) {
    const devR = avoidDirection[0] * state.right[0] + avoidDirection[1] * state.right[1] + avoidDirection[2] * state.right[2];
    const devU = avoidDirection[0] * state.up[0]    + avoidDirection[1] * state.up[1]    + avoidDirection[2] * state.up[2];
    const devLen = Math.sqrt(devR * devR + devU * devU);
    if (devLen > 1e-6) {
      // Negate motion direction to point away: az = atan2(-devR, devU)
      const az = Math.atan2(-devR, devU);
      const strength = Math.min(1, devLen * 1.5) * KINK_AVOID_WEIGHT;
      biasX += Math.cos(az) * strength;
      biasY += Math.sin(az) * strength;
    }
  }

  // Sample the final azimuth: centered on biased direction + noise.
  // Spread collapses as bias magnitude grows, so strong bias → tight kink.
  const biasMag = Math.sqrt(biasX * biasX + biasY * biasY);
  let chosenAz: number;
  if (biasMag > 1e-6) {
    const biasAz = Math.atan2(biasY, biasX);
    const concentration = Math.min(1, biasMag);
    const spread = Math.PI * (1 - concentration * KINK_SPREAD_REDUCTION);
    chosenAz = biasAz + rng.range(-spread, spread);
  } else {
    chosenAz = rng.range(0, Math.PI * 2);
  }

  const kinkAxis = vec3Normalize(
    vec3RotateAroundAxis(state.right, state.heading, chosenAz),
  );
  state.heading = vec3Normalize(
    vec3RotateAroundAxis(state.heading, kinkAxis, kinkMag),
  );
  // NOTE: baselineHeading is intentionally NOT updated — kinks are the
  // deviations that subsequent kinks should restore from.
  reorthogonalize(state);
}

function cloneAccumulator(a: BranchAccumulator): BranchAccumulator {
  return {
    points: a.points.map(p => [...p] as Vec3),
    radii: [...a.radii],
    parentId: a.parentId,
    depth: a.depth,
    pathPrefix: a.pathPrefix,
    siblingCounter: a.siblingCounter,
  };
}

/**
 * Interpret an L-system symbol string into a tree skeleton using a 3D turtle.
 *
 * Key design: When `[` is encountered, the CURRENT branch accumulator is saved
 * and restored on `]`. This means the trunk (or any parent branch) stays as a
 * single continuous tube — child branches are separate, but the parent branch
 * is not split at branch points. This prevents gaps during wind animation.
 */
export function interpretToSkeleton(
  symbolString: string,
  params: TurtleParams,
  seed: number = 12345,
): TreeSkeleton {
  const rng = new SeededRandom(seed + TURTLE_SEED_OFFSET);
  const symbols = parseSymbolString(symbolString);

  const segments: BranchSegment[] = [];
  const stateStack: TurtleState[] = [];
  const accumStack: BranchAccumulator[] = [];
  const branchLenStack: number[] = [];

  let state = createDefaultState(params);
  let nextId = 0;

  // Track the last flushed segment ID at each depth for proper parent assignment.
  // When '[' is encountered, the current branch hasn't been flushed yet, but
  // we know the trunk/parent is being built — so we track what the current
  // accumulator will become once flushed.
  let lastFlushedId = -1;
  const parentIdStack: number[] = [];

  // Current branch being accumulated
  let accum: BranchAccumulator = {
    points: [[...state.position]],
    radii: [state.radius],
    parentId: -1,
    depth: 0,
    pathPrefix: '0',
    siblingCounter: 0,
  };
  let cumulativeBranchLen = 0; // tracks length along current branch for weight droop

  const bounds = {
    min: [Infinity, Infinity, Infinity] as Vec3,
    max: [-Infinity, -Infinity, -Infinity] as Vec3,
  };

  function updateBounds(p: Vec3) {
    for (let i = 0; i < 3; i++) {
      bounds.min[i] = Math.min(bounds.min[i], p[i]);
      bounds.max[i] = Math.max(bounds.max[i], p[i]);
    }
  }

  function flushBranch(): number {
    if (accum.points.length < 2) return -1;

    const points = accum.points;
    const startPos = points[0];
    const endPos = points[points.length - 1];

    const dx = endPos[0] - startPos[0];
    const dy = endPos[1] - startPos[1];
    const dz = endPos[2] - startPos[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dir: Vec3 = len > 1e-10
      ? [dx / len, dy / len, dz / len]
      : [0, 1, 0];

    const seg: BranchSegment = {
      id: nextId++,
      parentId: accum.parentId,
      depth: accum.depth,
      startPos: [...startPos],
      endPos: [...endPos],
      startRadius: accum.radii[0],
      endRadius: accum.radii[accum.radii.length - 1],
      direction: dir,
      children: [],
      points: points.map(p => [...p] as Vec3),
      radii: [...accum.radii],
      segmentIndex: 0,
      pathId: accum.pathPrefix,
    };

    segments.push(seg);

    // Register as child of parent
    if (seg.parentId >= 0) {
      const parent = segments.find(s => s.id === seg.parentId);
      if (parent) parent.children.push(seg.id);
    }

    for (const p of points) updateBounds(p);

    return seg.id;
  }

  for (const sym of symbols) {
    const p0 = sym.params[0];

    switch (sym.char) {
      case 'F': {
        // If F has an explicit param, scale it by the depth-accumulated
        // length scale so the Length Scale slider affects all branches.
        const depthScale = Math.pow(params.lengthScale, state.depth);
        const len = p0 !== undefined ? p0 * depthScale : state.segmentLength;

        applyTropism(state, params, cumulativeBranchLen);
        applyFlattenBias(state, params);
        applyPhototropism(state, params);

        cumulativeBranchLen += len;

        const newPos = vec3Add(state.position, vec3Scale(state.heading, len));
        state.position = newPos;

        accum.points.push([...newPos]);
        accum.radii.push(state.radius);
        break;
      }

      case 'f': {
        const len = p0 ?? state.segmentLength;
        state.position = vec3Add(state.position, vec3Scale(state.heading, len));
        break;
      }

      case '+': {
        // Only add variance when using default angle (no explicit param)
        const baseAngle = p0 ?? (params.angle + rng.gaussian(0, params.angleVariance));
        const angle = degToRad(baseAngle);
        state.heading = vec3Normalize(vec3RotateAroundAxis(state.heading, state.up, angle));
        state.baselineHeading = vec3Normalize(vec3RotateAroundAxis(state.baselineHeading, state.up, angle));
        state.right = vec3Normalize(vec3Cross(state.heading, state.up));
        break;
      }

      case '-': {
        const baseAngle = p0 ?? (params.angle + rng.gaussian(0, params.angleVariance));
        const angle = degToRad(baseAngle);
        state.heading = vec3Normalize(vec3RotateAroundAxis(state.heading, state.up, -angle));
        state.baselineHeading = vec3Normalize(vec3RotateAroundAxis(state.baselineHeading, state.up, -angle));
        state.right = vec3Normalize(vec3Cross(state.heading, state.up));
        break;
      }

      case '^': {
        const base = p0 ?? params.angle;
        const angle = degToRad(base + rng.gaussian(0, params.angleVariance));
        state.heading = vec3Normalize(vec3RotateAroundAxis(state.heading, state.right, angle));
        state.baselineHeading = vec3Normalize(vec3RotateAroundAxis(state.baselineHeading, state.right, angle));
        state.up = vec3Normalize(vec3Cross(state.right, state.heading));
        break;
      }

      case '&': {
        const base = p0 ?? params.angle;
        const angle = degToRad(base + rng.gaussian(0, params.angleVariance));
        state.heading = vec3Normalize(vec3RotateAroundAxis(state.heading, state.right, -angle));
        state.baselineHeading = vec3Normalize(vec3RotateAroundAxis(state.baselineHeading, state.right, -angle));
        state.up = vec3Normalize(vec3Cross(state.right, state.heading));
        break;
      }

      case '\\': {
        const angle = degToRad(p0 ?? params.angle);
        state.right = vec3Normalize(vec3RotateAroundAxis(state.right, state.heading, angle));
        state.up = vec3Normalize(vec3Cross(state.right, state.heading));
        break;
      }

      case '/': {
        const angle = degToRad(p0 ?? params.angle);
        state.right = vec3Normalize(vec3RotateAroundAxis(state.right, state.heading, -angle));
        state.up = vec3Normalize(vec3Cross(state.right, state.heading));
        break;
      }

      case '|': {
        state.heading = vec3Scale(state.heading, -1);
        state.baselineHeading = vec3Scale(state.baselineHeading, -1);
        state.right = vec3Scale(state.right, -1);
        break;
      }

      case '[': {
        // Save current state AND current branch accumulator
        // This is critical: the parent branch continues accumulating after ']'
        // so the trunk stays as one continuous tube (no gaps during wind animation)
        stateStack.push(cloneState(state));
        accumStack.push(cloneAccumulator(accum));
        branchLenStack.push(cumulativeBranchLen);
        parentIdStack.push(lastFlushedId);
        cumulativeBranchLen = 0;

        // Build child pathId: parent's prefix + "." + sibling index
        const childPathId = accum.pathPrefix + '.' + accum.siblingCounter;
        accum.siblingCounter++;

        state.depth++;
        state.segmentLength *= params.lengthScale;
        state.radius *= params.radiusScale;
        state.segmentIndex = 0;
        // The child branch starts here — its own baseline is the current
        // heading (any subsequent +/- etc. will rotate the baseline with it).
        state.baselineHeading = [...state.heading];

        // Start a new child branch from current position.
        // parentId is set to lastFlushedId — the most recently completed
        // segment in the parent branch. This gives proper tree topology.
        accum = {
          points: [[...state.position]],
          radii: [state.radius],
          parentId: lastFlushedId,
          depth: state.depth,
          pathPrefix: childPathId,
          siblingCounter: 0,
        };
        break;
      }

      case ']': {
        // Flush the child branch, capturing its starting direction so we
        // can bias the parent's post-fork kink AWAY from it.
        const flushedId = flushBranch();
        let childStartDir: Vec3 | null = null;
        if (flushedId >= 0) {
          lastFlushedId = flushedId;
          const flushedSeg = segments[segments.length - 1];
          if (flushedSeg.points.length >= 2) {
            const p0 = flushedSeg.points[0];
            const p1 = flushedSeg.points[1];
            const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len > 1e-8) childStartDir = [dx / len, dy / len, dz / len];
          }
        }

        // Restore parent state and branch accumulator
        // The parent branch continues from where it left off
        if (stateStack.length > 0) {
          state = stateStack.pop()!;
          accum = accumStack.pop()!;
          cumulativeBranchLen = branchLenStack.pop()!;
          lastFlushedId = parentIdStack.pop()!;
          applyKink(state, params, rng, childStartDir);
        }
        break;
      }

      case '!': {
        const scale = p0 ?? params.radiusScale;
        state.radius *= scale;
        break;
      }

      case "'": {
        state.segmentIndex++;
        break;
      }

      default:
        // Non-drawing symbols (A, B, etc.) — ignore during interpretation
        break;
    }
  }

  // Flush any remaining branch
  flushBranch();

  // Fix bounds if no segments
  if (segments.length === 0) {
    bounds.min = [0, 0, 0];
    bounds.max = [0, 1, 0];
  }

  // Compute max depth
  let maxDepth = 0;
  for (const seg of segments) {
    maxDepth = Math.max(maxDepth, seg.depth);
  }

  const rootIds = segments.filter(s => s.parentId === -1).map(s => s.id);

  return { segments, rootIds, maxDepth, bounds };
}
