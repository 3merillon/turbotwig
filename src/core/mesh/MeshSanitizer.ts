/**
 * Mesh sanitization pass for exports.
 *
 * Drops degenerate triangles, normalizes/repairs normals, and optionally
 * welds coincident vertices so that third-party apps (3D Builder, Blender,
 * Unity importer, etc.) don't complain about ill-defined geometry.
 *
 * Runs on a copy — input buffers are never mutated.
 */

export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  tangents?: Float32Array; // VEC4 per vertex (x,y,z,w)
  indices: Uint32Array;
  /** Additional per-vertex attributes keyed by name. Each entry's data length must equal `vertexCount * components`. */
  extras?: Record<string, { data: Float32Array; components: number }>;
}

export interface SanitizeOptions {
  /** Drop triangles whose cross-product magnitude is below epsilon. Default: true. */
  dropDegenerate?: boolean;
  /** Squared area threshold. Default: 1e-12. */
  epsilon?: number;
  /** Normalize normals, recomputing any with zero length from adjacent face. Default: true. */
  normalizeNormals?: boolean;
  /** Weld coincident vertices within tolerance. Default: false (expensive, usually unneeded). */
  weldVertices?: boolean;
  /** Euclidean distance threshold for weld. Default: 1e-5. */
  weldTolerance?: number;
}

export interface SanitizeReport {
  droppedTriangles: number;
  fixedNormals: number;
  weldedVertices: number;
  droppedDuplicates: number;
  originalTriangles: number;
  originalVertices: number;
}

/**
 * Sanitize a mesh for export. Returns cleaned copy + a report.
 * The original buffers are NOT mutated.
 */
export function sanitizeMesh(
  buffers: MeshBuffers,
  options: SanitizeOptions = {},
): { buffers: MeshBuffers; report: SanitizeReport } {
  const {
    dropDegenerate = true,
    epsilon = 1e-12,
    normalizeNormals = true,
    weldVertices = false,
    weldTolerance = 1e-5,
  } = options;

  const positions = buffers.positions;
  const originalTriangles = buffers.indices.length / 3;
  const originalVertices = positions.length / 3;

  // Step 1: Drop degenerate triangles.
  let indices: Uint32Array;
  let droppedTriangles = 0;
  if (dropDegenerate) {
    const kept: number[] = [];
    const src = buffers.indices;
    for (let t = 0; t < src.length; t += 3) {
      const i0 = src[t];
      const i1 = src[t + 1];
      const i2 = src[t + 2];
      if (i0 === i1 || i1 === i2 || i0 === i2) {
        droppedTriangles++;
        continue;
      }
      const ax = positions[i0 * 3];
      const ay = positions[i0 * 3 + 1];
      const az = positions[i0 * 3 + 2];
      const bx = positions[i1 * 3] - ax;
      const by = positions[i1 * 3 + 1] - ay;
      const bz = positions[i1 * 3 + 2] - az;
      const cx = positions[i2 * 3] - ax;
      const cy = positions[i2 * 3 + 1] - ay;
      const cz = positions[i2 * 3 + 2] - az;
      // Cross product
      const nx = by * cz - bz * cy;
      const ny = bz * cx - bx * cz;
      const nz = bx * cy - by * cx;
      const areaSq = nx * nx + ny * ny + nz * nz;
      if (areaSq < epsilon) {
        droppedTriangles++;
        continue;
      }
      kept.push(i0, i1, i2);
    }
    indices = new Uint32Array(kept);
  } else {
    indices = new Uint32Array(buffers.indices);
  }

  // Step 2: Normalize normals. For degenerate (~zero-length) normals,
  // recompute from the first triangle that references the vertex.
  const normals = new Float32Array(buffers.normals);
  let fixedNormals = 0;
  if (normalizeNormals) {
    const vertCount = normals.length / 3;
    // Track which vertex normals need recomputing
    const needsRecompute: number[] = [];
    for (let v = 0; v < vertCount; v++) {
      const nx = normals[v * 3];
      const ny = normals[v * 3 + 1];
      const nz = normals[v * 3 + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6 || !isFinite(len)) {
        needsRecompute.push(v);
      } else if (Math.abs(len - 1) > 1e-4) {
        normals[v * 3] = nx / len;
        normals[v * 3 + 1] = ny / len;
        normals[v * 3 + 2] = nz / len;
      }
    }
    if (needsRecompute.length > 0) {
      // Recompute as face-normal accumulator
      const recomputeSet = new Set(needsRecompute);
      const accum = new Float32Array(needsRecompute.length * 3);
      const indexInList = new Map<number, number>();
      needsRecompute.forEach((v, i) => indexInList.set(v, i));
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];
        const hit0 = recomputeSet.has(i0);
        const hit1 = recomputeSet.has(i1);
        const hit2 = recomputeSet.has(i2);
        if (!hit0 && !hit1 && !hit2) continue;
        const ax = positions[i0 * 3];
        const ay = positions[i0 * 3 + 1];
        const az = positions[i0 * 3 + 2];
        const bx = positions[i1 * 3] - ax;
        const by = positions[i1 * 3 + 1] - ay;
        const bz = positions[i1 * 3 + 2] - az;
        const cx = positions[i2 * 3] - ax;
        const cy = positions[i2 * 3 + 1] - ay;
        const cz = positions[i2 * 3 + 2] - az;
        const fx = by * cz - bz * cy;
        const fy = bz * cx - bx * cz;
        const fz = bx * cy - by * cx;
        if (hit0) {
          const idx = indexInList.get(i0)! * 3;
          accum[idx] += fx; accum[idx + 1] += fy; accum[idx + 2] += fz;
        }
        if (hit1) {
          const idx = indexInList.get(i1)! * 3;
          accum[idx] += fx; accum[idx + 1] += fy; accum[idx + 2] += fz;
        }
        if (hit2) {
          const idx = indexInList.get(i2)! * 3;
          accum[idx] += fx; accum[idx + 1] += fy; accum[idx + 2] += fz;
        }
      }
      for (let i = 0; i < needsRecompute.length; i++) {
        const v = needsRecompute[i];
        const ax = accum[i * 3];
        const ay = accum[i * 3 + 1];
        const az = accum[i * 3 + 2];
        const len = Math.hypot(ax, ay, az);
        if (len > 1e-12) {
          normals[v * 3] = ax / len;
          normals[v * 3 + 1] = ay / len;
          normals[v * 3 + 2] = az / len;
          fixedNormals++;
        } else {
          // Fallback: arbitrary up vector
          normals[v * 3] = 0;
          normals[v * 3 + 1] = 1;
          normals[v * 3 + 2] = 0;
          fixedNormals++;
        }
      }
    }
  }

  // Step 3: Optional vertex weld via spatial hash.
  // Vertices are welded only when positions AND normals AND UVs all match within tolerance —
  // otherwise welding collapses UV seams and vertex normals at sharp edges.
  let finalPositions = positions;
  let finalNormals = normals;
  let finalUVs = buffers.uvs;
  let finalTangents = buffers.tangents;
  let finalIndices = indices;
  let finalExtras = buffers.extras;
  let weldedVertices = 0;

  if (weldVertices) {
    const vertCount = positions.length / 3;
    const remap = new Int32Array(vertCount).fill(-1);
    const bucket = new Map<string, number>();
    const invTol = 1 / weldTolerance;
    const invNTol = 1 / 1e-3;  // Coarser tolerance for normals (~0.06°)
    const invUVTol = 1 / 1e-4;
    let writeIdx = 0;
    // First pass: build remap using position + normal + UV composite key so UV seams and hard edges stay intact.
    for (let v = 0; v < vertCount; v++) {
      const px = positions[v * 3];
      const py = positions[v * 3 + 1];
      const pz = positions[v * 3 + 2];
      const nx = normals[v * 3];
      const ny = normals[v * 3 + 1];
      const nz = normals[v * 3 + 2];
      const u = buffers.uvs[v * 2];
      const vv = buffers.uvs[v * 2 + 1];
      const key =
        `${Math.round(px * invTol)},${Math.round(py * invTol)},${Math.round(pz * invTol)}|` +
        `${Math.round(nx * invNTol)},${Math.round(ny * invNTol)},${Math.round(nz * invNTol)}|` +
        `${Math.round(u * invUVTol)},${Math.round(vv * invUVTol)}`;
      const existing = bucket.get(key);
      if (existing !== undefined) {
        remap[v] = existing;
      } else {
        bucket.set(key, writeIdx);
        remap[v] = writeIdx;
        writeIdx++;
      }
    }
    if (writeIdx < vertCount) {
      // Compact buffers
      const newPositions = new Float32Array(writeIdx * 3);
      const newNormals = new Float32Array(writeIdx * 3);
      const newUVs = new Float32Array(writeIdx * 2);
      const newTangents = buffers.tangents ? new Float32Array(writeIdx * 4) : undefined;
      const newExtras: Record<string, { data: Float32Array; components: number }> | undefined = buffers.extras
        ? Object.fromEntries(Object.entries(buffers.extras).map(([k, v]) => [k, { data: new Float32Array(writeIdx * v.components), components: v.components }]))
        : undefined;
      const written = new Uint8Array(writeIdx);
      for (let v = 0; v < vertCount; v++) {
        const dst = remap[v];
        if (written[dst]) continue;
        written[dst] = 1;
        newPositions[dst * 3] = positions[v * 3];
        newPositions[dst * 3 + 1] = positions[v * 3 + 1];
        newPositions[dst * 3 + 2] = positions[v * 3 + 2];
        newNormals[dst * 3] = normals[v * 3];
        newNormals[dst * 3 + 1] = normals[v * 3 + 1];
        newNormals[dst * 3 + 2] = normals[v * 3 + 2];
        newUVs[dst * 2] = buffers.uvs[v * 2];
        newUVs[dst * 2 + 1] = buffers.uvs[v * 2 + 1];
        if (newTangents && buffers.tangents) {
          newTangents[dst * 4] = buffers.tangents[v * 4];
          newTangents[dst * 4 + 1] = buffers.tangents[v * 4 + 1];
          newTangents[dst * 4 + 2] = buffers.tangents[v * 4 + 2];
          newTangents[dst * 4 + 3] = buffers.tangents[v * 4 + 3];
        }
        if (newExtras && buffers.extras) {
          for (const name of Object.keys(buffers.extras)) {
            const src = buffers.extras[name];
            const dstArr = newExtras[name].data;
            const c = src.components;
            for (let k = 0; k < c; k++) dstArr[dst * c + k] = src.data[v * c + k];
          }
        }
      }
      const newIndices = new Uint32Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        newIndices[i] = remap[indices[i]];
      }
      finalPositions = newPositions;
      finalNormals = newNormals;
      finalUVs = newUVs;
      finalTangents = newTangents;
      finalIndices = newIndices;
      finalExtras = newExtras;
      weldedVertices = vertCount - writeIdx;
    }
  }

  // Step 4: Post-weld cleanup — drop degenerate triangles (two indices collapsed into one)
  // and deduplicate triangles (same three vertices in any winding, from CSG overlaps).
  let droppedDuplicates = 0;
  if (dropDegenerate || weldVertices) {
    const kept: number[] = [];
    const seen = new Set<string>();
    for (let t = 0; t < finalIndices.length; t += 3) {
      const i0 = finalIndices[t];
      const i1 = finalIndices[t + 1];
      const i2 = finalIndices[t + 2];
      // Degenerate: collapsed edges
      if (i0 === i1 || i1 === i2 || i0 === i2) {
        droppedTriangles++;
        continue;
      }
      // Duplicate: same 3 vertices in any order
      const a = Math.min(i0, i1, i2);
      const c = Math.max(i0, i1, i2);
      const b = i0 + i1 + i2 - a - c;
      const key = `${a},${b},${c}`;
      if (seen.has(key)) {
        droppedDuplicates++;
        continue;
      }
      seen.add(key);
      kept.push(i0, i1, i2);
    }
    if (kept.length !== finalIndices.length) {
      finalIndices = new Uint32Array(kept);
    }
  }

  return {
    buffers: {
      positions: finalPositions === positions ? new Float32Array(finalPositions) : finalPositions,
      normals: finalNormals,
      uvs: finalUVs === buffers.uvs ? new Float32Array(finalUVs) : finalUVs,
      tangents: finalTangents,
      indices: finalIndices,
      extras: finalExtras,
    },
    report: {
      droppedTriangles,
      fixedNormals,
      weldedVertices,
      droppedDuplicates,
      originalTriangles,
      originalVertices,
    },
  };
}
