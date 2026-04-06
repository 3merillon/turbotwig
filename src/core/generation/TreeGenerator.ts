import { LSystem } from '../lsystem/LSystem';
import { interpretToSkeleton } from '../lsystem/turtle';
import { buildTreeMesh, type TubeMeshResult } from '../mesh/TubeMeshBuilder';
import { generateRoots } from '../mesh/RootGenerator';
import { placeLeaves, type LeafMeshResult } from '../mesh/LeafPlacer';
import { buildTopology } from './TopologyBuilder';

import { subdivideBranches } from './BranchSubdivider';
import type { TreePreset } from '../../presets/TreePreset';
import type { TreeSkeleton } from '../../types/tree';

/**
 * Flat parameter bag consumed by the generation pipeline.
 * The App or GUI maps its UI controls into this structure.
 */
export interface GenerationParams {
  seed: number;

  // L-system / Turtle overrides
  iterations: number;
  angle: number;
  subBranchAngle: number;
  angleVariance: number;
  lengthScale: number;
  radiusScale: number;
  initialRadius: number;
  initialLength: number;
  tropismStrength: number;
  flattenBias: number;
  branchWeight: number;
  phototropism: number;
  kinkAngle: number;
  kinkVariance: number;
  kinkRestore: number;
  whorlTaper: number;
  whorlMaxBranches: number;
  whorlBranchReduction: number;

  // Branch organic subdivision
  branchJitter: number;
  branchMinPoints: number;

  // Branch relaxation (collision avoidance)
  collisionAvoidance: boolean;
  relaxIterations: number;
  relaxStrength: number;
  relaxRadius: number;

  // Mesh quality & bark geometry
  radialSegments: number;
  radialSegmentsDepthStep: number;
  lengthSubdivision: number;
  barkNoiseAmount: number;
  barkNoiseFreq: number;
  barkNoiseOctaves: number;
  barkTwist: number;
  barkTwistNoise: number;
  barkTwistNoiseFreq: number;
  barkUvTwist: number;

  // Taper & flare
  taperAmount: number;
  taperPower: number;
  trunkTaperEnabled: boolean;
  trunkTaperAmount: number;
  trunkTaperPower: number;
  contactFlare: number;
  contactFlareLength: number;
  tipRadius: number;

  // Welding
  smartFitEnabled: boolean;
  capBranchTips: boolean;
  capRootTips: boolean;
  capTrunkBottom: boolean;
  weldEnabled: boolean;
  weldBlendRings: number;
  weldSurfaceOffset: number;
  weldMinRadiusRatio: number;

  // Roots
  rootCount: number;
  rootLength: number;
  trunkExtension: number;
  rootRadiusFraction: number;
  rootPitchAngle: number;
  rootFlare: number;
  rootFlareHeight: number;
  rootGravity: number;
  rootHeight: number;
  rootSurfaceOffset: number;
  rootTaperAmount: number;
  rootTaperPower: number;
  rootKinkAngle: number;
  rootPullDownRadius: number;
  rootPullDownStrength: number;
  subRootLevels: number;
  subRootCount: number;
  subRootScale: number;

  // Leaves
  showLeaves: boolean;
  leafDensity: number;
  leafSize: number;
  leafMinDepth: number;
  clusterMode: boolean;
  clusterSize: number;
  tipLeaves: boolean;
  tipLeafMinDepth: number;
  leafDroop: number;
  leafSpread: number;
  leafHorizontality: number;
  leafHorizontalityNoise: number;
  leafVerticality: number;
  leafVerticalityNoise: number;
  leafWorldUp: number;
  leafOrientationMode: 'branch' | 'sky' | 'pendant' | 'radial';

  // Materials / Texture
  barkTileU: number;
  barkTileV: number;
}

export interface TreeGenerationResult {
  skeleton: TreeSkeleton;
  treeHeight: number;
  barkMesh: TubeMeshResult;
  leafMesh: LeafMeshResult | null;
}

/**
 * Orchestrates the full tree generation pipeline:
 *   L-system → turtle → topology → roots → bark mesh → leaves
 *
 * Stateless — call generate() with a preset + params and get geometry back.
 * No GPU, no UI, no side effects.
 */
export class TreeGenerator {
  /**
   * The original axiom from the preset, before height-scaling.
   * Stored so that subsequent calls with different initialLength
   * can scale F-segment lengths proportionally.
   */
  private baseAxiom = '';
  private baseDefaultLength = 1;

  /** Call once when the preset changes (before generate). */
  setPresetBase(preset: TreePreset): void {
    this.baseAxiom = preset.lsystem.axiom;
    this.baseDefaultLength = preset.lsystem.defaultLength;
  }

  generate(preset: Readonly<TreePreset>, params: GenerationParams): TreeGenerationResult {
    // --- 1. Build working copies of mutable preset sections (never mutate input) ---
    const lsystem = { ...preset.lsystem, rules: preset.lsystem.rules.map(r => ({ ...r })) };
    const turtle = { ...preset.turtle };
    const mesh = { ...preset.mesh };

    lsystem.iterations = params.iterations;
    lsystem.defaultAngle = params.angle;
    lsystem.defaultSubAngle = params.subBranchAngle;
    lsystem.defaultLength = params.initialLength;
    lsystem.whorlTaper = params.whorlTaper;
    lsystem.whorlMaxBranches = params.whorlMaxBranches;
    lsystem.whorlBranchReduction = params.whorlBranchReduction;
    turtle.angle = params.angle;
    turtle.angleVariance = params.angleVariance;
    turtle.lengthScale = params.lengthScale;
    turtle.radiusScale = params.radiusScale;
    turtle.initialRadius = params.initialRadius;
    turtle.initialLength = params.initialLength;
    turtle.tropismStrength = params.tropismStrength;
    turtle.flattenBias = params.flattenBias;
    turtle.branchWeight = params.branchWeight;
    turtle.phototropism = params.phototropism;
    turtle.kinkAngle = params.kinkAngle;
    turtle.kinkVariance = params.kinkVariance;
    turtle.kinkRestore = params.kinkRestore;
    mesh.radialSegments = params.radialSegments;
    mesh.radialSegmentsDepthStep = params.radialSegmentsDepthStep;
    mesh.lengthSegmentsPerUnit = params.lengthSubdivision;
    mesh.noiseAmplitude = params.barkNoiseAmount;
    mesh.noiseFrequency = params.barkNoiseFreq;
    mesh.noiseOctaves = params.barkNoiseOctaves;
    mesh.twistRate = params.barkTwist;
    mesh.twistNoise = params.barkTwistNoise;
    mesh.twistNoiseFreq = params.barkTwistNoiseFreq;
    mesh.uvTwist = params.barkUvTwist;

    // --- 2. Scale axiom F-segment lengths proportionally ---
    const heightScale = params.initialLength / this.baseDefaultLength;
    lsystem.axiom = this.baseAxiom.replace(
      /F\(([^)]+)\)/g,
      (_, val) => `F(${(parseFloat(val) * heightScale).toFixed(4)})`,
    );

    // --- 3. L-system string generation ---
    const lsys = new LSystem(lsystem, params.seed);
    const symbolString = lsys.generate();

    // --- 4. Turtle interpretation → skeleton ---
    const skeleton = interpretToSkeleton(symbolString, turtle, params.seed);

    // --- 5. Build/validate tree topology ---
    buildTopology(skeleton);

    // --- 6. Tree height (computed later, after relaxation may change bounds) ---
    let treeHeight = skeleton.bounds.max[1] - skeleton.bounds.min[1];

    // --- 7. Root generation ---
    const rootSegments = generateRoots(skeleton, params.seed, {
      rootCount: params.rootCount,
      rootLength: params.rootLength,
      trunkExtension: params.trunkExtension,
      rootRadiusFraction: params.rootRadiusFraction,
      rootPitchAngle: params.rootPitchAngle,
      rootFlare: params.rootFlare,
      rootFlareHeight: params.rootFlareHeight,
      rootGravity: params.rootGravity,
      rootKinkAngle: params.rootKinkAngle,
      rootHeight: params.rootHeight,
      trunkRadius: params.initialRadius,
      rootSurfaceOffset: params.rootSurfaceOffset,
      taperAmount: params.taperAmount,
      taperPower: params.taperPower,
      trunkTaperAmount: params.trunkTaperEnabled ? params.trunkTaperAmount : undefined,
      trunkTaperPower: params.trunkTaperEnabled ? params.trunkTaperPower : undefined,
      meshRootFlare: params.rootFlare,
      meshRootFlareHeight: params.initialRadius * params.rootFlareHeight,
      rootPullDownRadius: params.rootPullDownRadius,
      rootPullDownStrength: params.rootPullDownStrength,
      subRootLevels: params.subRootLevels,
      subRootCount: params.subRootCount,
      subRootScale: params.subRootScale,
      contactFlare: params.contactFlare,
      contactFlareLength: params.contactFlareLength,
    });
    skeleton.segments.push(...rootSegments);

    // --- 8. Subdivide short branches for organic curvature ---
    subdivideBranches(skeleton, params.seed, {
      minPoints: params.branchMinPoints,
      jitterAmount: params.branchJitter,
    });

    // --- 9. Branch relaxation (collision avoidance) ---
    // Relaxation is now handled asynchronously in the pipeline worker.
    // The skeleton is passed to the worker which runs relaxation + mesh rebuild.

    // Recompute tree height after relaxation may have changed bounds
    treeHeight = skeleton.bounds.max[1] - skeleton.bounds.min[1];

    // --- 10. Bark mesh ---
    const barkMesh = buildTreeMesh(skeleton.segments, treeHeight, {
      ...mesh,
      minLengthSegments: 1,
      uvTileU: params.barkTileU,
      uvTileV: params.barkTileV,
      rootFlare: params.rootFlare,
      rootFlareHeight: params.initialRadius * params.rootFlareHeight,
      taperAmount: params.taperAmount,
      taperPower: params.taperPower,
      rootTaperAmount: params.rootTaperAmount,
      rootTaperPower: params.rootTaperPower,
      trunkTaperAmount: params.trunkTaperEnabled ? params.trunkTaperAmount : undefined,
      trunkTaperPower: params.trunkTaperEnabled ? params.trunkTaperPower : undefined,
      contactFlare: params.contactFlare,
      contactFlareLength: params.contactFlareLength,
      tipRadius: params.tipRadius,
      smartFitEnabled: params.smartFitEnabled,
      capBranchTips: params.capBranchTips,
      capRootTips: params.capRootTips,
      capTrunkBottom: params.capTrunkBottom,
      weldEnabled: params.weldEnabled,
      weldBlendRings: params.weldBlendRings,
      weldSurfaceOffset: params.weldSurfaceOffset,
      weldMinRadiusRatio: params.weldMinRadiusRatio,
    });

    // --- 9. Leaf placement ---
    const leafMesh = params.showLeaves
      ? placeLeaves(skeleton.segments, treeHeight, params.seed, {
          ...preset.leaves,
          density: params.leafDensity,
          size: params.leafSize,
          minDepth: params.leafMinDepth,
          clusterMode: params.clusterMode,
          clusterSize: params.clusterSize,
          taperAmount: params.taperAmount,
          taperPower: params.taperPower,
          trunkTaperAmount: params.trunkTaperEnabled ? params.trunkTaperAmount : undefined,
          trunkTaperPower: params.trunkTaperEnabled ? params.trunkTaperPower : undefined,
          contactFlare: params.contactFlare,
          contactFlareLength: params.contactFlareLength,
          tipRadius: params.tipRadius,
          tipLeaves: params.tipLeaves,
          tipLeafMinDepth: params.tipLeafMinDepth,
          leafDroop: params.leafDroop,
          leafSpread: params.leafSpread,
          leafHorizontality: params.leafHorizontality,
          leafHorizontalityNoise: params.leafHorizontalityNoise,
          leafVerticality: params.leafVerticality,
          leafVerticalityNoise: params.leafVerticalityNoise,
          leafWorldUp: params.leafWorldUp,
          leafOrientationMode: params.leafOrientationMode,
        })
      : null;

    return { skeleton, treeHeight, barkMesh, leafMesh };
  }
}
