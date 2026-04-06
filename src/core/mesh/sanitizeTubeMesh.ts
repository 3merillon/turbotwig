/**
 * Apply MeshSanitizer to a TubeMeshResult, preserving all per-vertex attributes
 * (wind weights, branch anchors, etc.).
 *
 * Used by the generation pipeline as a final cleanup pass so that rendered
 * and exported bark meshes both go through the same cleanup.
 */

import { sanitizeMesh, type SanitizeReport } from './MeshSanitizer';
import type { TubeMeshResult } from './TubeMeshBuilder';

export interface SanitizeTubeMeshOptions {
  weldVertices?: boolean;
  weldTolerance?: number;
}

/** Per-vertex attribute spec for the bark TubeMeshResult. */
const BARK_EXTRAS_SPEC: Array<{ key: keyof TubeMeshResult; components: number }> = [
  { key: 'heightWeights', components: 1 },
  { key: 'depthWeights', components: 1 },
  { key: 'branchWeights', components: 1 },
  { key: 'branchAnchors', components: 3 },
  { key: 'branchPhases', components: 1 },
];

export function sanitizeTubeMesh(
  input: TubeMeshResult,
  options: SanitizeTubeMeshOptions = {},
): { mesh: TubeMeshResult; report: SanitizeReport } {
  const vertexCount = input.positions.length / 3;

  // Build extras map from TubeMeshResult's per-vertex arrays
  const extras: Record<string, { data: Float32Array; components: number }> = {};
  for (const spec of BARK_EXTRAS_SPEC) {
    const src = input[spec.key] as number[] | undefined;
    if (src && src.length === vertexCount * spec.components) {
      extras[spec.key as string] = {
        data: new Float32Array(src),
        components: spec.components,
      };
    }
  }

  const hasTangents = input.tangents.length === vertexCount * 4;
  const { buffers, report } = sanitizeMesh({
    positions: new Float32Array(input.positions),
    normals: new Float32Array(input.normals),
    uvs: new Float32Array(input.uvs),
    tangents: hasTangents ? new Float32Array(input.tangents) : undefined,
    indices: new Uint32Array(input.indices),
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  }, {
    dropDegenerate: true,
    normalizeNormals: true,
    weldVertices: options.weldVertices ?? false,
    weldTolerance: options.weldTolerance,
  });

  // Reconstruct TubeMeshResult with cleaned data
  const result: TubeMeshResult = {
    positions: Array.from(buffers.positions),
    normals: Array.from(buffers.normals),
    tangents: buffers.tangents ? Array.from(buffers.tangents) : input.tangents,
    uvs: Array.from(buffers.uvs),
    indices: Array.from(buffers.indices),
    heightWeights: buffers.extras?.heightWeights ? Array.from(buffers.extras.heightWeights.data) : input.heightWeights,
    depthWeights: buffers.extras?.depthWeights ? Array.from(buffers.extras.depthWeights.data) : input.depthWeights,
    branchWeights: buffers.extras?.branchWeights ? Array.from(buffers.extras.branchWeights.data) : input.branchWeights,
    branchAnchors: buffers.extras?.branchAnchors ? Array.from(buffers.extras.branchAnchors.data) : input.branchAnchors,
    branchPhases: buffers.extras?.branchPhases ? Array.from(buffers.extras.branchPhases.data) : input.branchPhases,
    segmentInfos: input.segmentInfos, // segment-level, not per-vertex
  };

  return { mesh: result, report };
}
