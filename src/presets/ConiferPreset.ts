import type { TreePreset } from './TreePreset';

export const ConiferPreset: TreePreset = {
  name: 'Conifer Pine',
  textureSpecies: 'conifer',
  lsystem: {
    axiom: 'F(4)A',
    rules: [
      {
        // Trunk whorl: variable branch count with randomised radial spacing.
        // params: [angle, length, subAngle, whorlTaper, maxBranches, branchReduction]
        predecessor: 'A',
        successor: (params, rng) => {
          const a = params[0] || 75;
          const l = params[1] || 3.0;
          const sa = params[2] || 62;
          const wt = params[3] ?? 0.82;
          const maxB = params[4] ?? 5;
          const reduction = params[5] ?? 0.4;

          // Decide branch count: round maxB with random ±0.5 bias, clamp to [1, ceil(maxB)]
          const count = Math.max(1, Math.min(
            Math.ceil(maxB),
            Math.round(maxB + (rng.next() - 0.5)),
          ));

          // Distribute branches around the trunk with jittered spacing
          const baseAzimuth = rng.next() * 360;          // random starting rotation
          const spacing = 360 / count;
          let branches = '';
          for (let i = 0; i < count; i++) {
            const azimuth = baseAzimuth + spacing * i + (rng.next() - 0.5) * spacing * 0.4;
            const angleVar = a * (0.92 + rng.next() * 0.16);        // ±8% variation
            const lenVar = l * (0.34 + rng.next() * 0.12);          // 0.34–0.46 of l
            branches += `[/(${azimuth.toFixed(1)})&(${angleVar.toFixed(2)})F(${lenVar.toFixed(4)})B(${a},${l},${sa})]`;
          }

          // Trunk continuation: next whorl gets reduced maxB
          const nextMaxB = Math.max(1, maxB - reduction);
          const trunkLen = l * (0.48 + rng.next() * 0.1);           // 0.48–0.58 of l
          const twist = 30 + rng.next() * 30;                       // 30–60° twist
          branches += `!(0.88)F(${trunkLen.toFixed(4)})/(${twist.toFixed(1)})A(${a},${(l * wt).toFixed(4)},${sa},${wt},${nextMaxB.toFixed(2)},${reduction})`;

          return branches;
        },
        probability: 1.0,
      },
      {
        // Branch: distributed sub-branches along length.
        predecessor: 'B',
        successor: (params, _rng) => {
          const a = params[2] || params[0] || 40;
          const l = params[1] || 1.5;
          return `F(${l * 0.3})` +
                 `[/(70)&(${a})F(${l * 0.7})][/(250)&(${a * 0.9})F(${l * 0.6})]` +
                 `F(${l * 0.3})` +
                 `[/(30)&(${a * 1.1})F(${l * 0.45})][/(210)&(${a * 0.85})F(${l * 0.35})]` +
                 `F(${l * 0.25})` +
                 `[/(110)&(${a})F(${l * 0.2})]` +
                 `F(${l * 0.15})`;
        },
        probability: 1.0,
      },
    ],
    iterations: 4,
    defaultAngle: 132,
    defaultSubAngle: 62,
    defaultLength: 3,
    defaultRadius: 0.45,
    lengthScale: 0.78,
    radiusScale: 0.58,
    whorlTaper: 0.82,
    whorlMaxBranches: 5,
    whorlBranchReduction: 0.4,
  },
  turtle: {
    angle: 132,
    angleVariance: 12,
    lengthScale: 0.97,
    radiusScale: 0.58,
    initialRadius: 0.45,
    initialLength: 3,
    tropism: [0, -1, 0],
    tropismStrength: 0.13,
    kinkAngle: 3,
    kinkVariance: 0.5,
    kinkRestore: 1.5,
    flattenBias: 0.35,
    branchWeight: 0.12,
    phototropism: 0.03,
  },
  mesh: {
    radialSegments: 8,
    lengthSegmentsPerUnit: 2,
    minLengthSegments: 3,
    noiseAmplitude: 0.27,
    noiseFrequency: 1.5,
    noiseOctaves: 1,
    twistRate: 0.15,
    twistNoise: 1.3,
    twistNoiseFreq: 1.7,
    taperAmount: 0.65,
    taperPower: 0.9,
    contactFlare: 0.3,
    contactFlareLength: 0.1,
    tipRadius: 0.015,
    uvTwist: 1.55,
  },
  leaves: {
    minDepth: 1,
    density: 10,
    size: 0.5,
    sizeVariance: 0.25,
    clusterMode: true,
    clusterSize: 2.5,
    tipLeaves: true,
    tipLeafMinDepth: 0,
    leafDroop: 0.3,
    leafSpread: 0.6,
    leafHorizontality: 0.65,
    leafHorizontalityNoise: 0.2,
  },
  roots: {
    rootCount: 4,
    rootLength: 0.26,
    trunkExtension: 1.8,
    rootRadiusFraction: 0.7,
    rootPitchAngle: 8,
    rootFlare: 1.9,
    rootFlareHeight: 7.5,
    rootGravity: 0.8,
    rootHeight: 0.35,
    rootSurfaceOffset: -1,
    rootTaperAmount: 0.85,
    rootTaperPower: 1.2,
    rootKinkAngle: 9.5,
    rootPullDownRadius: 1.8,
    rootPullDownStrength: 0.7,
    subRootLevels: 1,
    subRootCount: 1,
    subRootScale: 2.5,
  },
  materials: {
    barkTileU: 3,
    barkTileV: 1.5,
  },
  bark: {
    color: 0xffffff,
    roughness: 0.95,
  },
  leafAppearance: {
    color: 0xffffff,
    opacity: 0.85,
    doubleSided: true,
  },
};
