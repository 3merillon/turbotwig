/**
 * Lightweight glTF 2.0 / GLB exporter with embedded PBR textures.
 * Works directly with raw mesh data — no three.js dependency.
 *
 * Supports:
 *  - Positions, normals, tangents (VEC4), UVs, 32-bit indices
 *  - Embedded base color + normal textures (via pbrMetallicRoughness / normalTexture)
 *  - KHR_texture_transform for per-texture tiling
 *  - KHR_materials_displacement (non-standard) for displacement/height maps
 *  - Mesh sanitization pass (degenerate triangle removal, normal fixup)
 */

import { sanitizeMesh } from '../core/mesh/MeshSanitizer';

export interface TextureSpec {
  /** URL to fetch the texture bytes from (relative or absolute). */
  uri: string;
  /** MIME type, e.g. 'image/webp' or 'image/png'. */
  mimeType: string;
  /** U-axis repeat count (KHR_texture_transform). Default: 1. */
  tilesU?: number;
  /** V-axis repeat count (KHR_texture_transform). Default: 1. */
  tilesV?: number;
  /** Normal map strength (normalTexture.scale). Default: 1.0. */
  normalScale?: number;
}

export interface ExportOptions {
  binary?: boolean;
  treeParams?: Record<string, unknown>;
}

export interface RawMeshData {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  color: [number, number, number];
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
  tangents?: Float32Array; // VEC4 (xyz + handedness)
  textures?: {
    baseColor?: TextureSpec;
    normal?: TextureSpec;
    displacement?: TextureSpec;
  };
  /** If true, use CLAMP_TO_EDGE sampler (leaves). Otherwise REPEAT (bark). */
  clampUV?: boolean;
  /** Alpha mode for the base color texture. Default OPAQUE. */
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  /** Alpha cutoff threshold when alphaMode = MASK. Default 0.5. */
  alphaCutoff?: number;
  /** If true, bake a V-flip (v' = 1-v) into exported UVs. For meshes whose shader samples with V flipped. */
  flipV?: boolean;
}

/** Validate mesh data before export. Throws on invalid data. */
function validateMesh(m: RawMeshData): void {
  const vertexCount = m.positions.length / 3;
  if (m.positions.length % 3 !== 0) throw new Error(`[Export] ${m.name}: positions length (${m.positions.length}) not divisible by 3`);
  if (m.normals.length !== m.positions.length) throw new Error(`[Export] ${m.name}: normals length (${m.normals.length}) != positions length (${m.positions.length})`);
  if (m.uvs.length !== vertexCount * 2) throw new Error(`[Export] ${m.name}: uvs length (${m.uvs.length}) != expected (${vertexCount * 2})`);
  if (m.indices.length % 3 !== 0) throw new Error(`[Export] ${m.name}: indices length (${m.indices.length}) not divisible by 3`);
  if (m.tangents && m.tangents.length !== vertexCount * 4) {
    throw new Error(`[Export] ${m.name}: tangents length (${m.tangents.length}) != expected (${vertexCount * 4})`);
  }
  for (let i = 0; i < m.indices.length; i++) {
    if (m.indices[i] >= vertexCount) throw new Error(`[Export] ${m.name}: index[${i}]=${m.indices[i]} out of bounds (${vertexCount} vertices)`);
  }
  for (let i = 0; i < m.positions.length; i++) {
    if (!isFinite(m.positions[i])) throw new Error(`[Export] ${m.name}: positions[${i}] is ${m.positions[i]}`);
  }
  for (let i = 0; i < 3; i++) {
    if (!isFinite(m.color[i])) throw new Error(`[Export] ${m.name}: color[${i}] is ${m.color[i]}`);
  }
}

interface FetchedImage {
  bytes: Uint8Array;
  mimeType: string;
}

/** Fetch all unique texture URIs used by the meshes. Returns a map keyed by URI. */
async function fetchTextureAssets(meshes: RawMeshData[]): Promise<Map<string, FetchedImage>> {
  const uriSet = new Set<string>();
  const mimeByUri = new Map<string, string>();
  for (const m of meshes) {
    if (!m.textures) continue;
    for (const slot of [m.textures.baseColor, m.textures.normal, m.textures.displacement]) {
      if (slot) {
        uriSet.add(slot.uri);
        mimeByUri.set(slot.uri, slot.mimeType);
      }
    }
  }
  const uris = [...uriSet];
  const results = await Promise.all(uris.map(async (uri) => {
    try {
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { uri, image: { bytes: buf, mimeType: mimeByUri.get(uri) ?? 'image/png' } };
    } catch (err) {
      console.warn(`[Export] Failed to fetch texture ${uri}:`, err);
      return null;
    }
  }));
  const map = new Map<string, FetchedImage>();
  for (const r of results) {
    if (r) map.set(r.uri, r.image);
  }
  return map;
}

/**
 * Export raw mesh data to glTF/GLB and trigger download.
 */
export class TurboTwigExporter {

  async exportAndDownload(
    meshes: RawMeshData[],
    filename: string = 'turbotwig-export',
    options: ExportOptions = {},
  ) {
    for (const m of meshes) validateMesh(m);

    const { binary = true } = options;

    // Sanitize each mesh (drop degenerate tris, normalize normals).
    const sanitized: RawMeshData[] = meshes.map((m) => {
      const { buffers } = sanitizeMesh({
        positions: m.positions,
        normals: m.normals,
        uvs: m.uvs,
        tangents: m.tangents,
        indices: m.indices,
      });
      return {
        ...m,
        positions: buffers.positions,
        normals: buffers.normals,
        uvs: buffers.uvs,
        tangents: buffers.tangents,
        indices: buffers.indices,
      };
    });

    const textures = await fetchTextureAssets(sanitized);

    if (binary) {
      const glb = buildGLB(sanitized, textures);
      download(glb, `${filename}.glb`, 'application/octet-stream');
    } else {
      // Text glTF: images emitted as standalone data URIs (most compatible),
      // vertex/index buffer embedded as a single base64 data URI.
      const ctx: BuildContext = { bufferViews: [], accessors: [], bufferChunks: [], byteOffset: 0 };
      const gltf = buildGLTFJsonIntoCtx(sanitized, textures, ctx, /*imagesAsDataUri=*/ true);
      const totalByteLength = ctx.byteOffset;
      gltf.buffers[0].byteLength = totalByteLength;
      const merged = mergeChunks(ctx.bufferChunks, totalByteLength);
      gltf.buffers[0].uri = 'data:application/octet-stream;base64,' + uint8ToBase64(merged);
      const json = JSON.stringify(gltf, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      download(blob, `${filename}.gltf`, 'application/json');
    }
  }
}

// ── glTF JSON builder ───────────────────────────────────────────────

interface GLTFJson {
  asset: { version: string; generator: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: Record<string, unknown>[];
  meshes: Record<string, unknown>[];
  accessors: Record<string, unknown>[];
  bufferViews: Record<string, unknown>[];
  buffers: { byteLength: number; uri?: string }[];
  materials: Record<string, unknown>[];
  images?: Record<string, unknown>[];
  samplers?: Record<string, unknown>[];
  textures?: Record<string, unknown>[];
  extensionsUsed?: string[];
}

interface BuildContext {
  bufferViews: Record<string, unknown>[];
  accessors: Record<string, unknown>[];
  bufferChunks: Uint8Array[];
  byteOffset: number;
}

function addBufferView(ctx: BuildContext, bytes: Uint8Array, opts: { byteStride?: number; target?: number }): number {
  const bv: Record<string, unknown> = {
    buffer: 0,
    byteOffset: ctx.byteOffset,
    byteLength: bytes.byteLength,
  };
  if (opts.byteStride !== undefined) bv.byteStride = opts.byteStride;
  if (opts.target !== undefined) bv.target = opts.target;
  const idx = ctx.bufferViews.length;
  ctx.bufferViews.push(bv);
  const padded = padTo4(bytes);
  ctx.bufferChunks.push(padded);
  ctx.byteOffset += padded.byteLength;
  return idx;
}

function buildGLB(meshes: RawMeshData[], textures: Map<string, FetchedImage>): Blob {
  const ctx: BuildContext = { bufferViews: [], accessors: [], bufferChunks: [], byteOffset: 0 };
  const gltf = buildGLTFJsonIntoCtx(meshes, textures, ctx, /*imagesAsDataUri=*/ false);
  const totalByteLength = ctx.byteOffset;
  const binBuffer = mergeChunks(ctx.bufferChunks, totalByteLength);

  // Finalize buffer byte length
  gltf.buffers[0].byteLength = totalByteLength;

  const jsonString = JSON.stringify(gltf);
  const jsonEncoder = new TextEncoder();
  const jsonRaw = jsonEncoder.encode(jsonString);
  const jsonPaddedLength = align4(jsonRaw.byteLength);
  const jsonBytes = new Uint8Array(jsonPaddedLength);
  jsonBytes.set(jsonRaw);
  for (let i = jsonRaw.byteLength; i < jsonPaddedLength; i++) {
    jsonBytes[i] = 0x20; // space padding per GLB spec
  }

  // binBuffer is already 4-byte aligned because every chunk in ctx is padded to 4.
  const binLength = binBuffer.byteLength;
  const totalLength = 12 + 8 + jsonPaddedLength + 8 + binLength;

  const glb = new ArrayBuffer(totalLength);
  const view = new DataView(glb);
  let offset = 0;

  // GLB header
  view.setUint32(offset, 0x46546C67, true); offset += 4; // 'glTF'
  view.setUint32(offset, 2, true); offset += 4;
  view.setUint32(offset, totalLength, true); offset += 4;

  // JSON chunk
  view.setUint32(offset, jsonPaddedLength, true); offset += 4;
  view.setUint32(offset, 0x4E4F534A, true); offset += 4; // 'JSON'
  new Uint8Array(glb, offset, jsonPaddedLength).set(jsonBytes);
  offset += jsonPaddedLength;

  // BIN chunk
  view.setUint32(offset, binLength, true); offset += 4;
  view.setUint32(offset, 0x004E4942, true); offset += 4; // 'BIN\0'
  new Uint8Array(glb, offset, binLength).set(binBuffer);

  return new Blob([glb], { type: 'application/octet-stream' });
}

/** Variant of buildGLTFJson that writes into an external BuildContext so GLB can pull the buffer chunks. */
function buildGLTFJsonIntoCtx(
  meshes: RawMeshData[],
  textures: Map<string, FetchedImage>,
  ctx: BuildContext,
  imagesAsDataUri: boolean,
): GLTFJson {
  const nodes: Record<string, unknown>[] = [];
  const gltfMeshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const images: Record<string, unknown>[] = [];
  const samplers: Record<string, unknown>[] = [];
  const gltfTextures: Record<string, unknown>[] = [];
  const extensionsUsed = new Set<string>();

  const SAMPLER_REPEAT = 0;
  const SAMPLER_CLAMP = 1;
  samplers.push({
    magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497,
  });
  samplers.push({
    magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071,
  });

  const imageIdxByUri = new Map<string, number>();
  function getOrCreateImage(uri: string): number | null {
    const existing = imageIdxByUri.get(uri);
    if (existing !== undefined) return existing;
    const fetched = textures.get(uri);
    if (!fetched) return null;
    const idx = images.length;
    if (imagesAsDataUri) {
      // Each image as its own base64 data URI (max compatibility for .gltf text)
      const b64 = uint8ToBase64(fetched.bytes);
      images.push({ uri: `data:${fetched.mimeType};base64,${b64}` });
    } else {
      // Image bytes in BIN chunk, referenced via bufferView (GLB)
      const bvIdx = addBufferView(ctx, fetched.bytes, {});
      images.push({ bufferView: bvIdx, mimeType: fetched.mimeType });
    }
    imageIdxByUri.set(uri, idx);
    return idx;
  }

  function addTextureForSpec(spec: TextureSpec, sampler: number): number | null {
    const imgIdx = getOrCreateImage(spec.uri);
    if (imgIdx === null) return null;
    const texIdx = gltfTextures.length;
    gltfTextures.push({ sampler, source: imgIdx });
    return texIdx;
  }

  function textureInfoWithTransform(texIdx: number, spec: TextureSpec, extraFields?: Record<string, unknown>): Record<string, unknown> {
    const info: Record<string, unknown> = { index: texIdx, ...extraFields };
    const u = spec.tilesU ?? 1;
    const v = spec.tilesV ?? 1;
    if (u !== 1 || v !== 1) {
      extensionsUsed.add('KHR_texture_transform');
      info.extensions = { KHR_texture_transform: { scale: [u, v] } };
    }
    return info;
  }

  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];

    const indicesBV = addBufferView(ctx, new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength), { target: 34963 });
    const indicesAcc = ctx.accessors.length;
    ctx.accessors.push({ bufferView: indicesBV, componentType: 5125, count: m.indices.length, type: 'SCALAR' });

    const posBV = addBufferView(ctx, new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength), { byteStride: 12, target: 34962 });
    const posAcc = ctx.accessors.length;
    ctx.accessors.push({ bufferView: posBV, componentType: 5126, count: m.positions.length / 3, type: 'VEC3', min: vec3Min(m.positions), max: vec3Max(m.positions) });

    const normBV = addBufferView(ctx, new Uint8Array(m.normals.buffer, m.normals.byteOffset, m.normals.byteLength), { byteStride: 12, target: 34962 });
    const normAcc = ctx.accessors.length;
    ctx.accessors.push({ bufferView: normBV, componentType: 5126, count: m.normals.length / 3, type: 'VEC3' });

    let tangentAcc: number | undefined;
    if (m.tangents) {
      const tanBV = addBufferView(ctx, new Uint8Array(m.tangents.buffer, m.tangents.byteOffset, m.tangents.byteLength), { byteStride: 16, target: 34962 });
      tangentAcc = ctx.accessors.length;
      ctx.accessors.push({ bufferView: tanBV, componentType: 5126, count: m.tangents.length / 4, type: 'VEC4' });
    }

    // Optionally flip V to bake shader-side flip into exported UVs
    let uvSource = m.uvs;
    if (m.flipV) {
      uvSource = new Float32Array(m.uvs.length);
      for (let u = 0; u < m.uvs.length; u += 2) {
        uvSource[u] = m.uvs[u];
        uvSource[u + 1] = 1 - m.uvs[u + 1];
      }
    }
    const uvBV = addBufferView(ctx, new Uint8Array(uvSource.buffer, uvSource.byteOffset, uvSource.byteLength), { byteStride: 8, target: 34962 });
    const uvAcc = ctx.accessors.length;
    ctx.accessors.push({ bufferView: uvBV, componentType: 5126, count: uvSource.length / 2, type: 'VEC2' });

    const sampler = m.clampUV ? SAMPLER_CLAMP : SAMPLER_REPEAT;
    const matIndex = materials.length;
    const pbr: Record<string, unknown> = {
      baseColorFactor: [m.color[0], m.color[1], m.color[2], 1.0],
      roughnessFactor: m.roughness ?? 0.8,
      metallicFactor: m.metalness ?? 0.0,
    };
    const matObj: Record<string, unknown> = {
      name: m.name + '_mat',
      pbrMetallicRoughness: pbr,
      doubleSided: m.doubleSided ?? false,
    };
    if (m.alphaMode && m.alphaMode !== 'OPAQUE') {
      matObj.alphaMode = m.alphaMode;
      if (m.alphaMode === 'MASK') {
        matObj.alphaCutoff = m.alphaCutoff ?? 0.5;
      }
    }

    if (m.textures) {
      if (m.textures.baseColor) {
        const texIdx = addTextureForSpec(m.textures.baseColor, sampler);
        if (texIdx !== null) pbr.baseColorTexture = textureInfoWithTransform(texIdx, m.textures.baseColor);
      }
      if (m.textures.normal) {
        const texIdx = addTextureForSpec(m.textures.normal, sampler);
        if (texIdx !== null) {
          const scale = m.textures.normal.normalScale ?? 1.0;
          matObj.normalTexture = textureInfoWithTransform(texIdx, m.textures.normal, { scale });
        }
      }
      if (m.textures.displacement) {
        const texIdx = addTextureForSpec(m.textures.displacement, sampler);
        if (texIdx !== null) {
          extensionsUsed.add('KHR_materials_displacement');
          matObj.extensions = {
            KHR_materials_displacement: {
              displacementTexture: textureInfoWithTransform(texIdx, m.textures.displacement),
              displacementFactor: m.textures.displacement.normalScale ?? 0.04,
              displacementBias: 0,
            },
          };
        }
      }
    }

    materials.push(matObj);

    const attrs: Record<string, number> = {
      POSITION: posAcc, NORMAL: normAcc, TEXCOORD_0: uvAcc,
    };
    if (tangentAcc !== undefined) attrs.TANGENT = tangentAcc;

    gltfMeshes.push({
      name: m.name,
      primitives: [{ attributes: attrs, indices: indicesAcc, material: matIndex }],
    });
    nodes.push({ name: m.name, mesh: mi });
  }

  const totalByteLength = ctx.byteOffset;
  const gltf: GLTFJson = {
    asset: { version: '2.0', generator: 'turbotwig' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    accessors: ctx.accessors,
    bufferViews: ctx.bufferViews,
    buffers: [{ byteLength: totalByteLength }],
    materials,
  };
  if (images.length > 0) gltf.images = images;
  if (samplers.length > 0) gltf.samplers = samplers;
  if (gltfTextures.length > 0) gltf.textures = gltfTextures;
  if (extensionsUsed.size > 0) gltf.extensionsUsed = [...extensionsUsed];
  return gltf;
}

// ── Helpers ─────────────────────────────────────────────────────────

function align4(n: number): number {
  return (n + 3) & ~3;
}

function padTo4(buf: Uint8Array): Uint8Array {
  const padded = align4(buf.byteLength);
  if (padded === buf.byteLength) return buf;
  const out = new Uint8Array(padded);
  out.set(buf);
  return out;
}

function mergeChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function vec3Min(arr: Float32Array): [number, number, number] {
  let x = Infinity, y = Infinity, z = Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    if (arr[i] < x) x = arr[i];
    if (arr[i + 1] < y) y = arr[i + 1];
    if (arr[i + 2] < z) z = arr[i + 2];
  }
  return [x, y, z];
}

function vec3Max(arr: Float32Array): [number, number, number] {
  let x = -Infinity, y = -Infinity, z = -Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    if (arr[i] > x) x = arr[i];
    if (arr[i + 1] > y) y = arr[i + 1];
    if (arr[i + 2] > z) z = arr[i + 2];
  }
  return [x, y, z];
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call stack overflow on large buffers
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

function download(data: Blob | ArrayBuffer, filename: string, mimeType: string) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
