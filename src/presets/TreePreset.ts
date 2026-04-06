import type { LSystemConfig, TurtleParams } from '../types/lsystem';
import type { LeafPlacerOptions } from '../core/mesh/LeafPlacer';
import type { TubeMeshOptions } from '../core/mesh/TubeMeshBuilder';

export interface RootPresetOptions {
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
}

export interface MaterialPresetOptions {
  barkTileU: number;
  barkTileV: number;
  parallaxEnabled?: boolean;
  parallaxScale?: number;
  parallaxSteps?: number;
  parallaxFadeNear?: number;
  parallaxFadeFar?: number;
}

export interface TreeBehaviourOptions {
  branchFlexibility: number;
  trunkStiffness: number;
  maxSway: number;
}

export interface TreePreset {
  name: string;
  /** Species key into texture manifest (e.g. 'oak', 'pine') */
  textureSpecies: string;
  lsystem: LSystemConfig;
  turtle: TurtleParams;
  mesh: Partial<TubeMeshOptions>;
  leaves: Partial<LeafPlacerOptions>;
  roots?: Partial<RootPresetOptions>;
  materials?: Partial<MaterialPresetOptions>;
  behaviour?: Partial<TreeBehaviourOptions>;
  bark: {
    color: number;
    roughness: number;
  };
  leafAppearance: {
    color: number;
    opacity: number;
    doubleSided: boolean;
  };
}
