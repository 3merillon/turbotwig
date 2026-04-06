import type { TreePreset } from './TreePreset';

export const BroadleafPreset: TreePreset = {
  name: 'Broadleaf Oak',
  textureSpecies: 'oak',
  lsystem: {
    axiom: 'F(3)A',
    rules: [
      {
        predecessor: 'A',
        successor: (params) => {
          const a = params[0] || 40;
          const l = params[1] || 2.5;
          return `[/(30)&(${a})F(${l})/(137.5)B]` +
                 `[/(150)&(${a * 0.88})F(${l * 0.88})/(137.5)B]` +
                 `[/(270)&(${a * 1.12})F(${l * 0.8})/(137.5)B]` +
                 `!(0.9)F(${l * 0.6})A`;
        },
        probability: 0.65,
      },
      {
        predecessor: 'A',
        successor: (params) => {
          const a = params[0] || 45;
          const l = params[1] || 2.5;
          return `[/(60)&(${a * 1.2})F(${l * 1.1})/(137.5)B]` +
                 `[/(200)&(${a * 0.95})F(${l * 0.92})/(137.5)B]` +
                 `!(0.85)F(${l * 0.5})A`;
        },
        probability: 0.35,
      },
      {
        predecessor: 'B',
        successor: (params) => {
          const a = params[2] || params[0] || 40;
          const l = params[1] || 2.5;
          return `[/(30)&(${a})F(${l})/(137.5)B]` +
                 `[/(150)&(${a * 0.88})F(${l * 0.88})/(137.5)B]` +
                 `[/(270)&(${a * 1.12})F(${l * 0.8})/(137.5)B]` +
                 `!(0.9)F(${l * 0.6})B`;
        },
        probability: 0.65,
      },
      {
        predecessor: 'B',
        successor: (params) => {
          const a = params[2] || params[0] || 45;
          const l = params[1] || 2.5;
          return `[/(60)&(${a * 1.2})F(${l * 1.1})/(137.5)B]` +
                 `[/(200)&(${a * 0.95})F(${l * 0.92})/(137.5)B]` +
                 `!(0.85)F(${l * 0.5})B`;
        },
        probability: 0.35,
      },
    ],
    iterations: 5,
    defaultAngle: 25,
    defaultSubAngle: 25,
    defaultLength: 2.5,
    defaultRadius: 0.5,
    lengthScale: 0.72,
    radiusScale: 0.65,
  },
  turtle: {
    angle: 25,
    angleVariance: 5,
    lengthScale: 0.84,
    radiusScale: 0.85,
    initialRadius: 0.5,
    initialLength: 2.5,
    tropism: [0, -1, 0],
    tropismStrength: 0.05,
    kinkAngle: 0,
    kinkVariance: 0,
    kinkRestore: 1.5,
    flattenBias: 0.15,
    branchWeight: 0.1,
    phototropism: 0.02,

  },
  mesh: {
    radialSegments: 10,
    lengthSegmentsPerUnit: 3,
    minLengthSegments: 4,
    noiseAmplitude: 0.34,
    noiseFrequency: 5,
    noiseOctaves: 2,
    twistRate: 0.3,
    twistNoise: 1.75,
    twistNoiseFreq: 2,
    taperAmount: 0.7,
    taperPower: 1.7,
    contactFlare: 1,
    contactFlareLength: 0.15,
    tipRadius: 0.03,
  },
  leaves: {
    minDepth: 2,
    density: 4,
    size: 0.2,
    sizeVariance: 0.3,
    clusterMode: true,
    clusterSize: 2.8,
    tipLeaves: true,
    tipLeafMinDepth: 0,
    leafDroop: 0.2,
    leafSpread: 0.3,
    leafHorizontality: 0.2,
    leafHorizontalityNoise: 0.15,
  },
  roots: {
    rootCount: 5,
    rootLength: 0.32,
    trunkExtension: 1.5,
    rootRadiusFraction: 1,
    rootPitchAngle: 11,
    rootFlare: 1.8,
    rootFlareHeight: 3,
    rootGravity: 1,
    rootHeight: 0.25,
    rootSurfaceOffset: -1,
    rootTaperAmount: 0.95,
    rootTaperPower: 1,
    rootKinkAngle: 6.5,
    rootPullDownRadius: 1.3,
    rootPullDownStrength: 0.8,
    subRootLevels: 1,
    subRootCount: 2,
    subRootScale: 3,
  },
  materials: {
    barkTileU: 4,
    barkTileV: 2,
  },
  bark: {
    color: 0xffffff,
    roughness: 0.9,
  },
  leafAppearance: {
    color: 0xffffff,
    opacity: 0.9,
    doubleSided: true,
  },
};
