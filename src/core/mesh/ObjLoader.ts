/**
 * Minimal OBJ parser for loading SpeedTree mesh assets (pinecone, stalk).
 * Returns raw geometry data without Three.js dependency.
 */

/** Parsed OBJ geometry with flat interleaved vertex arrays and triangle indices. */
export interface ObjGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/**
 * Parse a Wavefront OBJ string into flat geometry arrays.
 * @param objText - Raw OBJ file content.
 * @returns Triangulated geometry with positions, normals, UVs, and indices.
 */
export function parseObj(objText: string): ObjGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const vertPositions: number[][] = [];
  const vertNormals: number[][] = [];
  const vertUVs: number[][] = [];
  const indices: number[] = [];

  const vertexCache = new Map<string, number>();
  let nextIndex = 0;

  const lines = objText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'v':
        vertPositions.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
        break;

      case 'vn':
        vertNormals.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]),
          parseFloat(parts[3]),
        ]);
        break;

      case 'vt':
        vertUVs.push([
          parseFloat(parts[1]),
          parseFloat(parts[2]) ?? 0,
        ]);
        break;

      case 'f': {
        const faceVerts: number[] = [];

        for (let i = 1; i < parts.length; i++) {
          const key = parts[i];

          if (vertexCache.has(key)) {
            faceVerts.push(vertexCache.get(key)!);
            continue;
          }

          const components = key.split('/');
          const posIdx = parseInt(components[0]) - 1;
          const uvIdx = components[1] ? parseInt(components[1]) - 1 : -1;
          const normIdx = components[2] ? parseInt(components[2]) - 1 : -1;

          if (posIdx >= 0 && posIdx < vertPositions.length) {
            positions.push(...vertPositions[posIdx]);
          }

          if (uvIdx >= 0 && uvIdx < vertUVs.length) {
            uvs.push(...vertUVs[uvIdx]);
          } else {
            uvs.push(0, 0);
          }

          if (normIdx >= 0 && normIdx < vertNormals.length) {
            normals.push(...vertNormals[normIdx]);
          } else {
            normals.push(0, 1, 0);
          }

          const idx = nextIndex++;
          vertexCache.set(key, idx);
          faceVerts.push(idx);
        }

        // Triangulate (fan triangulation for convex polygons)
        for (let i = 1; i < faceVerts.length - 1; i++) {
          indices.push(faceVerts[0], faceVerts[i], faceVerts[i + 1]);
        }
        break;
      }
    }
  }

  return { positions, normals, uvs, indices };
}
