/**
 * UV mapping strategies for tree geometry.
 */

/**
 * Compute cylindrical UV coordinates for bark.
 * U wraps around circumference [0, 1].
 * V runs along branch length, accumulating across the tree for seamless tiling.
 */
export function computeBarkUV(
  radialIndex: number,
  radialSegments: number,
  lengthPosition: number,
  tileScaleU: number = 1.0,
  tileScaleV: number = 1.0,
): [number, number] {
  const u = (radialIndex / radialSegments) * tileScaleU;
  const v = lengthPosition * tileScaleV;
  return [u, v];
}

/**
 * Compute planar UV for leaf quads.
 * Simple [0,1] x [0,1] mapping.
 */
export function computeLeafUV(
  cornerIndex: number,
): [number, number] {
  const uvs: [number, number][] = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  return uvs[cornerIndex % 4];
}

/**
 * Compute UV for a leaf cluster atlas.
 * Allows selecting a sub-region of a texture atlas.
 */
export function computeClusterUV(
  cornerIndex: number,
  atlasCol: number,
  atlasRow: number,
  atlasCols: number,
  atlasRows: number,
): [number, number] {
  const base = computeLeafUV(cornerIndex);
  const cellW = 1 / atlasCols;
  const cellH = 1 / atlasRows;
  return [
    (atlasCol + base[0]) * cellW,
    (atlasRow + base[1]) * cellH,
  ];
}
