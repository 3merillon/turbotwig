import Module from 'manifold-3d';
import type { ManifoldToplevel } from 'manifold-3d';
import type { Vec3 } from '../../utils/math';
import {
  vec3Sub, vec3Add, vec3Scale, vec3Normalize,
  vec3Dot, vec3Cross,
  angleBetween,
} from '../../utils/math';
import { CatmullRomSpline } from '../../utils/spline';
import type { SegmentMeshInfo, RingInfo, TubeMeshOptions, TubeMeshResult } from './TubeMeshBuilder';

// ============================================================
// Types
// ============================================================

interface SegmentGeomData {
  info: SegmentMeshInfo;
  positions: number[];
  normals: number[];
  tangents: number[];
  uvs: number[];
  indices: number[];
  heightWeights: number[];
  depthWeights: number[];
  branchWeights: number[];
  branchAnchors: number[];
  branchPhases: number[];
}

interface AttachInfo {
  attachAxisPoint: Vec3;
  parentTangent: Vec3;
  parentRadius: number;
  parentRingIdx: number;
  parentData: SegmentGeomData;
  collarRingCount: number;
}

// ============================================================
// Ray-triangle intersection (Möller–Trumbore)
// ============================================================

/** Returns ray parameter t (distance along unit-length ray) or -1 on miss. */
function rayTriHit(
  ro: Vec3, rd: Vec3, v0: Vec3, v1: Vec3, v2: Vec3,
): number {
  const e1 = vec3Sub(v1, v0);
  const e2 = vec3Sub(v2, v0);
  const h = vec3Cross(rd, e2);
  const a = vec3Dot(e1, h);
  if (a > -1e-8 && a < 1e-8) return -1;
  const f = 1 / a;
  const s = vec3Sub(ro, v0);
  const u = f * vec3Dot(s, h);
  if (u < 0 || u > 1) return -1;
  const q = vec3Cross(s, e1);
  const v = f * vec3Dot(rd, q);
  if (v < 0 || u + v > 1) return -1;
  const t = f * vec3Dot(e2, q);
  return t > 1e-6 ? t : -1;
}

/**
 * Cast a ray against a band of parent ring quads and return the closest
 * hit distance (Infinity if no hit).
 */
function raycastParentSurface(
  origin: Vec3, dir: Vec3,
  parentRings: RingInfo[],
  nearRingIdx: number,
  halfWidth: number,
): number {
  let closest = Infinity;
  const lo = Math.max(0, nearRingIdx - halfWidth);
  const hi = Math.min(parentRings.length - 2, nearRingIdx + halfWidth);

  for (let ri = lo; ri <= hi; ri++) {
    const pA = parentRings[ri].positions;
    const pB = parentRings[ri + 1].positions;
    const n = parentRings[ri].radialSegments;

    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      let t = rayTriHit(origin, dir, pA[j], pA[j1], pB[j1]);
      if (t > 0 && t < closest) closest = t;
      t = rayTriHit(origin, dir, pA[j], pB[j1], pB[j]);
      if (t > 0 && t < closest) closest = t;
    }
  }
  return closest;
}

// ============================================================
// Lightweight smart-fit: push child vertices inside parent surface (no CSG)
// ============================================================

/**
 * Push child branch vertices inside the parent surface to prevent clipping.
 *
 * For each child vertex that is outside the parent's actual mesh surface
 * (determined via ray-triangle intersection), finds the minimum-displacement
 * push by trying two directions:
 *   A) toward the child branch center (preserves cross-section shape)
 *   B) toward the parent branch center (radial push)
 * and picks whichever requires less movement to sink the vertex just inside.
 */
export function smartFitBranches(
  segmentInfos: SegmentMeshInfo[],
  arrays: TubeMeshResult,
  opts: TubeMeshOptions,
): void {
  if (segmentInfos.length === 0) return;

  const segDatas = extractSegmentData(segmentInfos, arrays);
  if (segDatas.length === 0) return;

  const attachMap = new Map<number, AttachInfo>();
  buildAttachments(segDatas, attachMap, opts);

  for (const [childId, attach] of attachMap) {
    const childData = segDatas.find(d => d.info.segment.id === childId);
    if (!childData) continue;

    const { parentData } = attach;
    const parentRings = parentData.info.rings;
    const parentRadius = attach.parentRadius;
    const rings = childData.info.rings;
    const radSegs = rings[0]?.radialSegments ?? 8;
    const vertsPerRing = radSegs + 1;

    const parentSpline = new CatmullRomSpline(parentData.info.segment.points);

    // Small margin to push vertices slightly past the surface
    const margin = parentRadius * 0.02;

    // How many parent rings to test around the attachment point
    const RAY_HALF_WIDTH = 4;

    for (let ri = 0; ri < rings.length; ri++) {
      const ringCenter = rings[ri].center;

      // Find closest point on parent spline
      const isRootFit = !!parentData.info.segment.isRoot;
      const searchLo = isRootFit ? 0 : Math.max(0, attach.parentRingIdx / Math.max(1, parentRings.length - 1) - 0.15);
      const searchHi = isRootFit ? 1 : Math.min(1, attach.parentRingIdx / Math.max(1, parentRings.length - 1) + 0.15);
      let bestT = (searchLo + searchHi) * 0.5;
      let bestDist = Infinity;
      for (let i = 0; i <= 30; i++) {
        const t = searchLo + (searchHi - searchLo) * i / 30;
        const d = vec3DistSq(parentSpline.evaluate(t), ringCenter);
        if (d < bestDist) { bestDist = d; bestT = t; }
      }
      const splinePoint = parentSpline.evaluate(bestT);

      // Find nearest parent ring for raycast search window
      let nearestRingIdx = 0;
      let nearestRingDist = Infinity;
      for (let k = 0; k < parentRings.length; k++) {
        const d = Math.abs(parentRings[k].tParam - bestT);
        if (d < nearestRingDist) { nearestRingDist = d; nearestRingIdx = k; }
      }

      // Break when ring center exceeds parent radius threshold.
      // Only process ring 0 (the junction ring). Ring 1+ are the visible
      // branch outside the parent — leave them untouched.
      if (ri > 0) break;

      for (let j = 0; j <= radSegs; j++) {
        const vLocal = ri * vertsPerRing + j;
        const vGlobal = childData.info.vertexStart + vLocal;
        const px = arrays.positions[vGlobal * 3];
        const py = arrays.positions[vGlobal * 3 + 1];
        const pz = arrays.positions[vGlobal * 3 + 2];
        const vertex: Vec3 = [px, py, pz];

        // Ray toward parent center: if it hits the parent mesh surface,
        // the vertex is outside and needs to be pushed in.
        const toParent = vec3Sub(splinePoint, vertex);
        const toParentLen = Math.sqrt(vec3Dot(toParent, toParent));
        if (toParentLen < 1e-8) continue;
        const dirToParent = vec3Scale(toParent, 1 / toParentLen);

        const hitB = raycastParentSurface(vertex, dirToParent, parentRings, nearestRingIdx, RAY_HALF_WIDTH);

        // No hit before parent center → vertex is inside → skip
        if (hitB >= toParentLen) continue;

        // Vertex is outside the parent surface. Find minimum displacement
        // to push it just inside.
        const dispB = hitB + margin;

        // Option A: move toward child ring center
        const toChild = vec3Sub(ringCenter, vertex);
        const toChildLen = Math.sqrt(vec3Dot(toChild, toChild));
        let dispA = Infinity;
        let dirToChild: Vec3 = [0, 0, 0];

        if (toChildLen > 1e-8) {
          dirToChild = vec3Scale(toChild, 1 / toChildLen);
          const hitA = raycastParentSurface(vertex, dirToChild, parentRings, nearestRingIdx, RAY_HALF_WIDTH);
          if (hitA < Infinity) {
            dispA = hitA + margin;
          }
        }

        // Pick minimum displacement direction
        if (dispA < dispB) {
          const pos = vec3Add(vertex, vec3Scale(dirToChild, dispA));
          arrays.positions[vGlobal * 3] = pos[0];
          arrays.positions[vGlobal * 3 + 1] = pos[1];
          arrays.positions[vGlobal * 3 + 2] = pos[2];
        } else {
          const pos = vec3Add(vertex, vec3Scale(dirToParent, dispB));
          arrays.positions[vGlobal * 3] = pos[0];
          arrays.positions[vGlobal * 3 + 1] = pos[1];
          arrays.positions[vGlobal * 3 + 2] = pos[2];
        }
      }
    }
  }
}

// ============================================================
// Core welding logic (runs inside the worker — no DOM access)
// ============================================================

/**
 * Weld branches to their parents using CSG boolean union via Manifold.
 * Runs inside a worker (no DOM access). Replaces mesh arrays in-place with the welded result.
 * @param segmentInfos - Per-segment ring and vertex layout metadata.
 * @param arrays - Mutable mesh arrays replaced with the welded geometry.
 * @param treeHeight - Total tree height for recomputing wind weights after CSG.
 * @param opts - Mesh options controlling weld parameters.
 * @param onProgress - Optional callback reporting progress (0-1) and status message.
 */
export async function weldBranchesCore(
  segmentInfos: SegmentMeshInfo[],
  arrays: TubeMeshResult,
  treeHeight: number,
  opts: TubeMeshOptions,
  onProgress?: (pct: number, msg: string) => void,
): Promise<void> {
  if (segmentInfos.length === 0) return;

  onProgress?.(0, 'Preparing...');
  const segDatas = extractSegmentData(segmentInfos, arrays);
  if (segDatas.length === 0) return;

  const segById = new Map<number, SegmentGeomData>();
  for (const d of segDatas) segById.set(d.info.segment.id, d);

  const attachMap = new Map<number, AttachInfo>();
  buildAttachments(segDatas, attachMap, opts);

  const hasWeldableChildren = new Set<number>();
  for (const [childId, attach] of attachMap) {
    hasWeldableChildren.add(attach.parentData.info.segment.id);
  }

  for (const [childId, attach] of attachMap) {
    const childData = segById.get(childId)!;
    pushCollarInsideParent(childData, attach);
  }

  const byDepth = new Map<number, { data: SegmentGeomData; attach: AttachInfo }[]>();
  for (const [childId, attach] of attachMap) {
    const depth = segById.get(childId)!.info.segment.depth;
    const effectiveDepth = segById.get(childId)!.info.segment.isRoot ? 1 : depth;
    if (!byDepth.has(effectiveDepth)) byDepth.set(effectiveDepth, []);
    byDepth.get(effectiveDepth)!.push({ data: segById.get(childId)!, attach });
  }

  const trunkDatas = segDatas.filter(d => !attachMap.has(d.info.segment.id));

  const wasm = await Module({
    locateFile: () => '/manifold.wasm',
  });
  wasm.setup();
  const { Manifold } = wasm;

  const ringKPositions = new Map<number, Vec3[]>();

  // Track cap center positions to strip after CSG for disabled cap categories.
  // Manifold requires watertight meshes so caps are always generated for CSG input,
  // but caps at extremities (trunk bottom, branch/root tips) survive the boolean union.
  const capCentersToStrip: Vec3[] = [];

  // Phase 1: Build trunk manifold
  onProgress?.(0.05, 'Building trunk...');
  let acc: InstanceType<typeof Manifold> | null = null;
  for (const data of trunkDatas) {
    const rings = data.info.rings;
    if (rings.length > 0) {
      const seg = data.info.segment;
      // Bottom cap: underground trunk bottom or main trunk bottom
      if (!opts.capTrunkBottom) {
        capCentersToStrip.push([...rings[0].center]);
      }
      // Top cap: trunk/branch tip
      const tipFlag = seg.isRoot ? opts.capRootTips : opts.capBranchTips;
      if (!tipFlag) {
        capCentersToStrip.push([...rings[rings.length - 1].center]);
      }
    }
    const m = segDataToManifold(wasm.Mesh, Manifold, data, data.info.rings.length);
    if (!m) continue;
    if (!acc) { acc = m; }
    else { try { const merged: InstanceType<typeof Manifold> = acc.add(m); acc.delete(); m.delete(); acc = merged; } catch (e) { console.warn('[Weld] Trunk merge failed:', e); m.delete(); } }
  }
  if (!acc) return;

  // Phase 2: Process each depth level
  const sortedDepths = [...byDepth.keys()].sort((a, b) => a - b);
  let totalCollars = 0;
  for (const [, group] of byDepth) totalCollars += group.length;
  let processedCollars = 0;

  const tailsInCSG = new Set<number>();

  for (const depth of sortedDepths) {
    const group = byDepth.get(depth)!;
    group.sort((a, b) => b.data.info.segment.startRadius - a.data.info.segment.startRadius);

    for (let i = 0; i < group.length; i++) {
      const { data, attach } = group[i];
      processedCollars++;
      const pct = 0.1 + 0.7 * (processedCollars / totalCollars);
      onProgress?.(pct, `Welding ${processedCollars}/${totalCollars}...`);

      const K = attach.collarRingCount;
      if (K < data.info.rings.length) {
        ringKPositions.set(data.info.segment.id, [...data.info.rings[K].positions]);
      }

      {
        const seg = data.info.segment;
        const tipFlag = seg.isRoot ? opts.capRootTips : opts.capBranchTips;
        const rings = data.info.rings;
        // Collar bottom (ring 0) — usually removed by CSG but track just in case
        if (!tipFlag && rings.length > 0) capCentersToStrip.push([...rings[0].center]);
        // Collar top (ring K) — junction seam, usually merged
        if (!tipFlag && K < rings.length) capCentersToStrip.push([...rings[K].center]);
      }

      const collarManifold = buildCollarManifold(wasm.Mesh, Manifold, data, attach);
      if (!collarManifold) continue;

      try {
        const merged: InstanceType<typeof Manifold> = acc!.add(collarManifold);
        acc!.delete();
        collarManifold.delete();
        acc = merged;
      } catch (e) {
        console.warn(`[Weld] Collar merge failed for segment ${data.info.segment.id}:`, e);
        collarManifold.delete();
        continue;
      }
    }

    for (const { data, attach } of group) {
      const segId = data.info.segment.id;
      if (!hasWeldableChildren.has(segId)) continue;

      {
        const seg = data.info.segment;
        const tipFlag = seg.isRoot ? opts.capRootTips : opts.capBranchTips;
        const rings = data.info.rings;
        const tailStart = attach.collarRingCount;
        // Tail bottom cap — junction seam, usually merged
        if (!tipFlag && tailStart < rings.length) capCentersToStrip.push([...rings[tailStart].center]);
        // Tail top cap — branch/root tip
        if (!tipFlag && rings.length > 0) capCentersToStrip.push([...rings[rings.length - 1].center]);
      }

      const tailManifold = buildTailManifold(wasm.Mesh, Manifold, data, attach.collarRingCount);
      if (!tailManifold) continue;

      try {
        const merged: InstanceType<typeof Manifold> = acc!.add(tailManifold);
        acc!.delete();
        tailManifold.delete();
        acc = merged;
      } catch (e) {
        console.warn(`[Weld] Tail merge failed for segment ${data.info.segment.id}:`, e);
        tailManifold.delete();
        continue;
      }

      tailsInCSG.add(segId);
    }
  }

  // Phase 3: Extract manifold result
  onProgress?.(0.85, 'Extracting geometry...');

  clearArrays(arrays);
  const resultMesh = acc!.getMesh();
  acc!.delete();
  extractManifoldToArrays(resultMesh, arrays);

  // Strip CSG-produced cap triangles for disabled cap categories.
  if (capCentersToStrip.length > 0) {
    const tolSq = 0.002 * 0.002;
    const totalVerts = arrays.positions.length / 3;
    const capVerts = new Set<number>();
    for (let v = 0; v < totalVerts; v++) {
      const vx = arrays.positions[v * 3];
      const vy = arrays.positions[v * 3 + 1];
      const vz = arrays.positions[v * 3 + 2];
      for (const c of capCentersToStrip) {
        const dx = vx - c[0], dy = vy - c[1], dz = vz - c[2];
        if (dx * dx + dy * dy + dz * dz < tolSq) {
          capVerts.add(v);
          break;
        }
      }
    }
    if (capVerts.size > 0) {
      let dst = 0;
      for (let i = 0; i < arrays.indices.length; i += 3) {
        if (capVerts.has(arrays.indices[i]) || capVerts.has(arrays.indices[i + 1]) || capVerts.has(arrays.indices[i + 2])) continue;
        arrays.indices[dst] = arrays.indices[i];
        arrays.indices[dst + 1] = arrays.indices[i + 1];
        arrays.indices[dst + 2] = arrays.indices[i + 2];
        dst += 3;
      }
      arrays.indices.length = dst;
    }
  }

  // Phase 4: Assign uniform wind weights to ALL CSG-result vertices.
  onProgress?.(0.88, 'Fixing wind weights...');
  const csgVertCount = arrays.positions.length / 3;
  for (let vi = 0; vi < csgVertCount; vi++) {
    const y = arrays.positions[vi * 3 + 1];
    arrays.heightWeights[vi] = treeHeight > 0 ? Math.max(0, y / treeHeight) : 0;
    arrays.depthWeights[vi] = 0;
  }

  // Phase 5: Append tails for branches whose tails are NOT already in the CSG result.
  onProgress?.(0.92, 'Appending branch tails...');
  const BLEND_RINGS = 6;
  for (const [childId, attach] of attachMap) {
    if (tailsInCSG.has(childId)) continue;

    const data = segById.get(childId)!;
    const K = attach.collarRingCount;
    const ringKPos = ringKPositions.get(childId);
    if (!ringKPos) continue;

    const ringK = data.info.rings[K];
    const searchRadius = (ringK?.radius ?? 1) * 3;
    const matchedIndices = findRingKInCSG(ringKPos, arrays, ringK.center, searchRadius);
    const capThisTip = data.info.segment.isRoot ? opts.capRootTips : opts.capBranchTips;
    // Snapshot tailBase BEFORE appendBranchTail, since it pushes fallback ring-K
    // verts and the cap center after the tail verts, which would shift indices.
    const tailBase = arrays.positions.length / 3;
    appendBranchTail(data, K, arrays, matchedIndices, capThisTip);

    const childSeg = data.info.segment;
    const childDw = childSeg.isRoot ? 0 : Math.min(childSeg.depth, 5) / 5;
    const radSegs = data.info.rings[0]?.radialSegments ?? 8;
    const vertsPerRing = radSegs + 1;
    const tailRings = data.info.rings.length - (K + 1);
    const blendCount = Math.min(BLEND_RINGS, tailRings);

    for (let ri = 0; ri < blendCount; ri++) {
      const t = blendCount > 1 ? ri / (blendCount - 1) : 1;
      const blendedDw = childDw * t;
      for (let j = 0; j < vertsPerRing; j++) {
        const vi = tailBase + ri * vertsPerRing + j;
        if (vi < arrays.depthWeights.length) {
          arrays.depthWeights[vi] = blendedDw;
          arrays.heightWeights[vi] = treeHeight > 0
            ? Math.max(0, arrays.positions[vi * 3 + 1] / treeHeight) : 0;
        }
      }
    }
  }

  onProgress?.(1.0, 'Done');
}

// ============================================================
// Build attachments
// ============================================================

function buildAttachments(
  segDatas: SegmentGeomData[],
  attachMap: Map<number, AttachInfo>,
  opts: TubeMeshOptions,
): void {
  for (const childData of segDatas) {
    const child = childData.info.segment;
    if (child.depth === 0 && !child.isRoot) continue;
    if (childData.info.rings.length < 2) continue;

    let bestParent: SegmentGeomData | null = null;
    let bestT = 0;
    let bestDist = Infinity;

    for (const parentData of segDatas) {
      const parent = parentData.info.segment;
      if (parent.id === child.id) continue;
      if (parent.depth >= child.depth) continue;
      if (parentData.info.rings.length === 0) continue;

      const pSpline = new CatmullRomSpline(parent.points);
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const d = vec3DistSq(pSpline.evaluate(t), child.startPos);
        if (d < bestDist) { bestDist = d; bestT = t; bestParent = parentData; }
      }
    }

    if (!bestParent || bestDist > 9) continue;

    const pSpline = new CatmullRomSpline(bestParent.info.segment.points);
    const lo = Math.max(0, bestT - 0.05);
    const hi = Math.min(1, bestT + 0.05);
    for (let i = 0; i <= 20; i++) {
      const t = lo + (hi - lo) * i / 20;
      const d = vec3DistSq(pSpline.evaluate(t), child.startPos);
      if (d < bestDist) { bestDist = d; bestT = t; }
    }

    const attachAxisPoint = pSpline.evaluate(bestT);
    const parentTangent = pSpline.tangent(bestT);

    let bestRingIdx = 0;
    let bestRingDist = Infinity;
    for (let i = 0; i < bestParent.info.rings.length; i++) {
      const d = Math.abs(bestParent.info.rings[i].tParam - bestT);
      if (d < bestRingDist) { bestRingDist = d; bestRingIdx = i; }
    }
    const parentRadius = bestParent.info.rings[bestRingIdx].radius;

    if (opts.weldMinRadiusRatio > 0 && child.startRadius / parentRadius < opts.weldMinRadiusRatio) continue;

    const childDir = vec3Normalize(vec3Sub(child.endPos, child.startPos));
    const angle = angleBetween(childDir, parentTangent);
    if (angle < 0.05 || angle > Math.PI - 0.05) continue;

    let collarRingCount = 1;
    for (let ri = 0; ri < childData.info.rings.length; ri++) {
      const rc = childData.info.rings[ri].center;
      const toC = vec3Sub(rc, attachAxisPoint);
      const along = vec3Dot(toC, parentTangent);
      const rad = vec3Sub(toC, vec3Scale(parentTangent, along));
      if (Math.sqrt(vec3Dot(rad, rad)) > parentRadius * 1.1 && ri > 0) break;
      collarRingCount = ri + 2;
    }
    collarRingCount = Math.min(collarRingCount, childData.info.rings.length - 2);
    collarRingCount = Math.max(collarRingCount, 2);

    attachMap.set(child.id, {
      attachAxisPoint, parentTangent, parentRadius,
      parentRingIdx: bestRingIdx, parentData: bestParent,
      collarRingCount,
    });
  }
}

// ============================================================
// Smart vertex pushing (ring 0 only, only outside vertices)
// ============================================================

function pushCollarInsideParent(data: SegmentGeomData, attach: AttachInfo): void {
  const { parentData } = attach;
  const ring0 = data.info.rings[0];
  if (!ring0) return;
  const radSegs = ring0.radialSegments;
  const parentRings = parentData.info.rings;

  const parentSpline = new CatmullRomSpline(parentData.info.segment.points);
  const attachT = attach.parentRingIdx / Math.max(1, parentRings.length - 1);
  const splinePoint = parentSpline.evaluate(attachT);
  const splineTangent = parentSpline.tangent(attachT);

  for (let j = 0; j <= radSegs; j++) {
    const px = data.positions[j * 3], py = data.positions[j * 3 + 1], pz = data.positions[j * 3 + 2];
    const toVert = vec3Sub([px, py, pz], splinePoint);
    const along = vec3Dot(toVert, splineTangent);
    const radial = vec3Sub(toVert, vec3Scale(splineTangent, along));
    const radialDist = Math.sqrt(vec3Dot(radial, radial));

    const parentSurfR = getParentSurfaceRadius(splineTangent, radial, parentRings, attach.parentRingIdx);

    if (radialDist > parentSurfR * 0.90) {
      const radDir = radialDist > 1e-8 ? vec3Scale(radial, 1 / radialDist) : [0, 1, 0] as Vec3;
      // Collar ring 0 pushed inside parent for clean CSG boolean union
      const targetPos = vec3Add(splinePoint, vec3Add(
        vec3Scale(splineTangent, along),
        vec3Scale(radDir, parentSurfR * 0.85),
      ));
      data.positions[j * 3] = targetPos[0];
      data.positions[j * 3 + 1] = targetPos[1];
      data.positions[j * 3 + 2] = targetPos[2];
    }
  }
}

function ringRadiusInDirection(
  axisTangent: Vec3, radDir: Vec3, ring: RingInfo,
): number {
  if (!ring || ring.positions.length === 0) return ring?.radius ?? 1;
  const rd = vec3Normalize(radDir);
  let bestDot = -Infinity, bestDist = ring.radius;
  for (let k = 0; k < ring.positions.length; k++) {
    const toV = vec3Sub(ring.positions[k], ring.center);
    const proj = vec3Sub(toV, vec3Scale(axisTangent, vec3Dot(toV, axisTangent)));
    const pLen = Math.sqrt(vec3Dot(proj, proj));
    if (pLen < 1e-8) continue;
    const d = vec3Dot(vec3Scale(proj, 1 / pLen), rd);
    if (d > bestDot) { bestDot = d; bestDist = pLen; }
  }
  return bestDist;
}

function getParentSurfaceRadius(
  axisTangent: Vec3, radialVec: Vec3, parentRings: RingInfo[], nearestRingIdx: number,
  queryT?: number,
): number {
  const ring = parentRings[nearestRingIdx];
  if (!ring || ring.positions.length === 0) return ring?.radius ?? 1;

  const r0 = ringRadiusInDirection(axisTangent, radialVec, ring);

  // Interpolate with an adjacent ring for smoother results when the
  // query point falls between ring centers.
  if (parentRings.length > 1) {
    if (queryT !== undefined) {
      // Proper lerp: pick the neighbor on the other side of queryT
      const ringT = ring.tParam;
      let neighbor: number;
      if (queryT >= ringT && nearestRingIdx + 1 < parentRings.length) {
        neighbor = nearestRingIdx + 1;
      } else if (queryT < ringT && nearestRingIdx - 1 >= 0) {
        neighbor = nearestRingIdx - 1;
      } else {
        neighbor = nearestRingIdx + 1 < parentRings.length
          ? nearestRingIdx + 1
          : nearestRingIdx - 1;
      }
      if (neighbor >= 0 && neighbor < parentRings.length) {
        const r1 = ringRadiusInDirection(axisTangent, radialVec, parentRings[neighbor]);
        const neighborT = parentRings[neighbor].tParam;
        const span = Math.abs(neighborT - ringT);
        if (span > 1e-8) {
          const alpha = Math.abs(queryT - ringT) / span;
          return r0 * (1 - alpha) + r1 * alpha;
        }
        return (r0 + r1) * 0.5;
      }
    } else {
      // Legacy fallback: simple average (used by pushCollarInsideParent)
      const neighbor = nearestRingIdx + 1 < parentRings.length
        ? nearestRingIdx + 1
        : nearestRingIdx - 1;
      if (neighbor >= 0 && neighbor < parentRings.length) {
        const r1 = ringRadiusInDirection(axisTangent, radialVec, parentRings[neighbor]);
        return (r0 + r1) * 0.5;
      }
    }
  }

  return r0;
}

// ============================================================
// Build collar manifold (first K rings, no top cap)
// ============================================================

function buildCollarManifold(
  MeshCtor: ManifoldToplevel['Mesh'],
  ManifoldCtor: ManifoldToplevel['Manifold'],
  data: SegmentGeomData,
  attach: AttachInfo,
): InstanceType<ManifoldToplevel['Manifold']> | null {
  const K = attach.collarRingCount;
  const rings = data.info.rings;
  if (K >= rings.length || K < 1) return null;

  const radSegs = rings[0].radialSegments;
  const vertsPerRing = radSegs + 1;
  const collarVertCount = (K + 1) * vertsPerRing;

  const collarIndexCount = K * radSegs * 6;
  const indices = data.indices.slice(0, collarIndexCount);

  const collarData: SegmentGeomData = {
    info: { ...data.info, rings: rings.slice(0, K + 1), vertexCount: collarVertCount, indexCount: collarIndexCount },
    positions: data.positions.slice(0, collarVertCount * 3),
    normals: data.normals.slice(0, collarVertCount * 3),
    tangents: data.tangents.slice(0, collarVertCount * 4),
    uvs: data.uvs.slice(0, collarVertCount * 2),
    indices,
    heightWeights: data.heightWeights.slice(0, collarVertCount),
    depthWeights: data.depthWeights.slice(0, collarVertCount),
    branchWeights: data.branchWeights.slice(0, collarVertCount),
    branchAnchors: data.branchAnchors.slice(0, collarVertCount * 3),
    branchPhases: data.branchPhases.slice(0, collarVertCount),
  };

  return segDataToManifold(MeshCtor, ManifoldCtor, collarData, K + 1);
}

// ============================================================
// Build tail manifold (for parent branches that need sub-branch welding)
// ============================================================

function buildTailManifold(
  MeshCtor: ManifoldToplevel['Mesh'],
  ManifoldCtor: ManifoldToplevel['Manifold'],
  data: SegmentGeomData,
  collarRings: number,
): InstanceType<ManifoldToplevel['Manifold']> | null {
  const rings = data.info.rings;
  if (collarRings >= rings.length) return null;

  const tailStartRing = collarRings;
  const radSegs = rings[tailStartRing]?.radialSegments ?? rings[0].radialSegments;
  const vertsPerRing = radSegs + 1;
  const tailVertStart = tailStartRing * vertsPerRing;
  const tailVertCount = data.positions.length / 3 - tailVertStart;
  if (tailVertCount <= 0) return null;

  const tailIndexStart = tailStartRing * radSegs * 6;
  const indices: number[] = [];
  for (let i = tailIndexStart; i < data.indices.length; i++) {
    indices.push(data.indices[i] - tailVertStart);
  }

  const tailRings = rings.slice(tailStartRing).map(r => ({
    ...r,
    vertexStart: r.vertexStart - tailVertStart,
  }));

  const tailData: SegmentGeomData = {
    info: { ...data.info, rings: tailRings, vertexStart: 0, vertexCount: tailVertCount, indexStart: 0, indexCount: indices.length },
    positions: data.positions.slice(tailVertStart * 3),
    normals: data.normals.slice(tailVertStart * 3),
    tangents: data.tangents.slice(tailVertStart * 4),
    uvs: data.uvs.slice(tailVertStart * 2),
    indices,
    heightWeights: data.heightWeights.slice(tailVertStart),
    depthWeights: data.depthWeights.slice(tailVertStart),
    branchWeights: data.branchWeights.slice(tailVertStart),
    branchAnchors: data.branchAnchors.slice(tailVertStart * 3),
    branchPhases: data.branchPhases.slice(tailVertStart),
  };

  return segDataToManifold(MeshCtor, ManifoldCtor, tailData, tailRings.length);
}

// ============================================================
// Find ring K vertices in CSG result by position matching
// ============================================================

function findRingKInCSG(
  ringKPositions: Vec3[],
  arrays: TubeMeshResult,
  ringCenter: Vec3,
  maxSearchRadius: number,
): number[] {
  const totalVerts = arrays.positions.length / 3;
  const matched: number[] = [];
  const used = new Set<number>();
  const searchRadSq = maxSearchRadius * maxSearchRadius;

  for (let j = 0; j < ringKPositions.length; j++) {
    const [tx, ty, tz] = ringKPositions[j];
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let v = 0; v < totalVerts; v++) {
      if (used.has(v)) continue;
      // Spatial guard: skip vertices far from the expected ring center
      // to prevent cross-branch matching when two branches are nearby.
      const cx = arrays.positions[v * 3] - ringCenter[0];
      const cy = arrays.positions[v * 3 + 1] - ringCenter[1];
      const cz = arrays.positions[v * 3 + 2] - ringCenter[2];
      if (cx * cx + cy * cy + cz * cz > searchRadSq) continue;

      const dx = arrays.positions[v * 3] - tx;
      const dy = arrays.positions[v * 3 + 1] - ty;
      const dz = arrays.positions[v * 3 + 2] - tz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) { bestDist = d; bestIdx = v; }
    }

    if (bestDist < 0.0001 && bestIdx >= 0) {
      matched.push(bestIdx);
      used.add(bestIdx);
    } else {
      matched.push(-1);
    }
  }

  return matched;
}

// ============================================================
// Append branch tail with shared ring K vertices
// ============================================================

function appendBranchTail(
  data: SegmentGeomData,
  collarRings: number,
  arrays: TubeMeshResult,
  ringKIndices: number[], // CSG result indices for ring K vertices
  generateCaps: boolean,
): void {
  const rings = data.info.rings;
  if (collarRings >= rings.length) return;

  const radSegs = rings[0].radialSegments;
  const vertsPerRing = radSegs + 1;

  // Tail vertices start at ring K+1 (ring K is shared from CSG result)
  const tailVertStartRing = collarRings + 1;
  if (tailVertStartRing >= rings.length) return;

  const tailVertStart = tailVertStartRing * vertsPerRing;
  const tailVertCount = data.positions.length / 3 - tailVertStart;
  if (tailVertCount <= 0) return;

  const vertexBase = arrays.positions.length / 3;

  // Emit tail vertices (ring K+1 onwards)
  for (let v = 0; v < tailVertCount; v++) {
    const src = tailVertStart + v;
    arrays.positions.push(data.positions[src * 3], data.positions[src * 3 + 1], data.positions[src * 3 + 2]);
    arrays.normals.push(data.normals[src * 3], data.normals[src * 3 + 1], data.normals[src * 3 + 2]);
    arrays.tangents.push(data.tangents[src * 4], data.tangents[src * 4 + 1], data.tangents[src * 4 + 2], data.tangents[src * 4 + 3]);
    arrays.uvs.push(data.uvs[src * 2], data.uvs[src * 2 + 1]);
    arrays.heightWeights.push(data.heightWeights[src] ?? 0);
    arrays.depthWeights.push(data.depthWeights[src] ?? 0);
    arrays.branchWeights.push(data.branchWeights[src] ?? 0);
    arrays.branchAnchors.push(data.branchAnchors[src * 3] ?? 0, data.branchAnchors[src * 3 + 1] ?? 0, data.branchAnchors[src * 3 + 2] ?? 0);
    arrays.branchPhases.push(data.branchPhases[src] ?? 0);
  }

  // Emit bridge quad strip: ring K (CSG indices) → ring K+1 (new indices).
  // For any unmatched ring K vertex, emit a fallback vertex from the original
  // segment data so the bridge is always complete.
  const ringKVertStart = collarRings * vertsPerRing;
  const effectiveRingK: number[] = [];
  for (let j = 0; j < radSegs; j++) {
    if (j < ringKIndices.length && ringKIndices[j] >= 0) {
      effectiveRingK.push(ringKIndices[j]);
    } else {
      const src = ringKVertStart + j;
      const newIdx = arrays.positions.length / 3;
      arrays.positions.push(data.positions[src * 3], data.positions[src * 3 + 1], data.positions[src * 3 + 2]);
      arrays.normals.push(data.normals[src * 3], data.normals[src * 3 + 1], data.normals[src * 3 + 2]);
      arrays.tangents.push(data.tangents[src * 4], data.tangents[src * 4 + 1], data.tangents[src * 4 + 2], data.tangents[src * 4 + 3]);
      arrays.uvs.push(data.uvs[src * 2], data.uvs[src * 2 + 1]);
      arrays.heightWeights.push(data.heightWeights[src] ?? 0);
      arrays.depthWeights.push(data.depthWeights[src] ?? 0);
      arrays.branchWeights.push(data.branchWeights[src] ?? 0);
      arrays.branchAnchors.push(data.branchAnchors[src * 3] ?? 0, data.branchAnchors[src * 3 + 1] ?? 0, data.branchAnchors[src * 3 + 2] ?? 0);
      arrays.branchPhases.push(data.branchPhases[src] ?? 0);
      effectiveRingK.push(newIdx);
    }
  }

  for (let j = 0; j < radSegs; j++) {
    const a0 = effectiveRingK[j];
    const a1 = effectiveRingK[(j + 1) % radSegs];
    const b0 = vertexBase + j;
    const b1 = vertexBase + j + 1;
    arrays.indices.push(a0, a1, b0);
    arrays.indices.push(a1, b1, b0);
  }

  // Emit rest of tail indices (ring K+1 → K+2, K+2 → K+3, etc.)
  const tailIndexStart = tailVertStartRing * radSegs * 6;
  for (let i = tailIndexStart; i < data.indices.length; i++) {
    arrays.indices.push(data.indices[i] - tailVertStart + vertexBase);
  }

  // Tip cap: triangle fan at the last ring
  if (generateCaps) {
    const lastRing = rings[rings.length - 1];
    const lastRingRadSegs = lastRing.radialSegments;
    const lastRingOutputStart = vertexBase + (rings.length - 1 - tailVertStartRing) * vertsPerRing;
    const capCenter = arrays.positions.length / 3;
    arrays.positions.push(lastRing.center[0], lastRing.center[1], lastRing.center[2]);
    arrays.normals.push(lastRing.tangent[0], lastRing.tangent[1], lastRing.tangent[2]);
    arrays.tangents.push(1, 0, 0, 1);
    arrays.uvs.push(0.5, 0.5);
    const lastSrc = data.positions.length / 3 - 1;
    arrays.heightWeights.push(data.heightWeights[lastSrc] ?? 0);
    arrays.depthWeights.push(data.depthWeights[lastSrc] ?? 0);
    arrays.branchWeights.push(1);
    arrays.branchAnchors.push(
      data.branchAnchors[lastSrc * 3] ?? 0,
      data.branchAnchors[lastSrc * 3 + 1] ?? 0,
      data.branchAnchors[lastSrc * 3 + 2] ?? 0,
    );
    arrays.branchPhases.push(data.branchPhases[lastSrc] ?? 0);
    for (let j = 0; j < lastRingRadSegs; j++) {
      arrays.indices.push(capCenter, lastRingOutputStart + j, lastRingOutputStart + j + 1);
    }
  }
}

// ============================================================
// Convert segment data to Manifold (with caps and merge vectors)
// ============================================================

// Interleaved property layout: pos(3) + uv(2) + normal(3) + tangent(4) + hw(1) + dw(1) + bw(1) + anchor(3) + phase(1) = 19
const NUM_PROP = 19;

function segDataToManifold(
  MeshCtor: ManifoldToplevel['Mesh'],
  ManifoldCtor: ManifoldToplevel['Manifold'],
  data: SegmentGeomData,
  ringCount: number,
): InstanceType<ManifoldToplevel['Manifold']> | null {
  const rings = data.info.rings;
  const vCount = data.positions.length / 3;
  const radSegs = rings.length > 0 ? rings[0].radialSegments : 8;
  const lastRingIdx = Math.min(ringCount - 1, rings.length - 1);
  const lastRadSegs = rings[lastRingIdx]?.radialSegments ?? radSegs;

  const cp = [...data.positions];
  const cn = [...data.normals];
  const cu = [...data.uvs];
  const ci = [...data.indices];
  const ct = [...data.tangents];
  const chw = [...data.heightWeights];
  const cdw = [...data.depthWeights];
  const cbw = [...data.branchWeights];
  const cba = [...data.branchAnchors];
  const cbp = [...data.branchPhases];

  // Bottom cap
  if (rings.length > 0) {
    const r0 = rings[0];
    const n = vec3Scale(r0.tangent, -1);
    const c = cp.length / 3;
    cp.push(r0.center[0], r0.center[1], r0.center[2]);
    cn.push(n[0], n[1], n[2]); cu.push(0.5, 0.5); ct.push(1, 0, 0, 1);
    chw.push(data.heightWeights[0] ?? 0); cdw.push(data.depthWeights[0] ?? 0); cbw.push(0);
    cba.push(data.branchAnchors[0] ?? 0, data.branchAnchors[1] ?? 0, data.branchAnchors[2] ?? 0);
    cbp.push(data.branchPhases[0] ?? 0);
    for (let j = 0; j < radSegs; j++) ci.push(c, j + 1, j);
  }

  // Top cap
  if (lastRingIdx > 0 && lastRingIdx < rings.length) {
    const lr = rings[lastRingIdx];
    const c = cp.length / 3;
    cp.push(lr.center[0], lr.center[1], lr.center[2]);
    cn.push(lr.tangent[0], lr.tangent[1], lr.tangent[2]); cu.push(0.5, 0.5); ct.push(1, 0, 0, 1);
    const lv = vCount - 1;
    chw.push(data.heightWeights[lv] ?? 0); cdw.push(data.depthWeights[lv] ?? 0); cbw.push(1);
    cba.push(data.branchAnchors[lv * 3] ?? 0, data.branchAnchors[lv * 3 + 1] ?? 0, data.branchAnchors[lv * 3 + 2] ?? 0);
    cbp.push(data.branchPhases[lv] ?? 0);
    const lrs = lastRingIdx * (lastRadSegs + 1);
    for (let j = 0; j < lastRadSegs; j++) ci.push(c, lrs + j, lrs + j + 1);
  }

  const totalVerts = cp.length / 3;

  // Build interleaved vertProperties
  const vertProperties = new Float32Array(totalVerts * NUM_PROP);
  for (let i = 0; i < totalVerts; i++) {
    const o = i * NUM_PROP;
    vertProperties[o + 0]  = cp[i * 3];     // pos x
    vertProperties[o + 1]  = cp[i * 3 + 1]; // pos y
    vertProperties[o + 2]  = cp[i * 3 + 2]; // pos z
    vertProperties[o + 3]  = cu[i * 2];      // uv u
    vertProperties[o + 4]  = cu[i * 2 + 1];  // uv v
    vertProperties[o + 5]  = cn[i * 3];      // normal x
    vertProperties[o + 6]  = cn[i * 3 + 1];  // normal y
    vertProperties[o + 7]  = cn[i * 3 + 2];  // normal z
    vertProperties[o + 8]  = ct[i * 4];      // tangent x
    vertProperties[o + 9]  = ct[i * 4 + 1];  // tangent y
    vertProperties[o + 10] = ct[i * 4 + 2];  // tangent z
    vertProperties[o + 11] = ct[i * 4 + 3];  // tangent w
    vertProperties[o + 12] = chw[i] ?? 0;    // heightWeight
    vertProperties[o + 13] = cdw[i] ?? 0;    // depthWeight
    vertProperties[o + 14] = cbw[i] ?? 0;    // branchWeight
    vertProperties[o + 15] = cba[i * 3] ?? 0;     // branchAnchor x
    vertProperties[o + 16] = cba[i * 3 + 1] ?? 0; // branchAnchor y
    vertProperties[o + 17] = cba[i * 3 + 2] ?? 0; // branchAnchor z
    vertProperties[o + 18] = cbp[i] ?? 0;    // branchPhase
  }

  // Build merge vectors for UV seam vertices.
  // Tube meshes have vertsPerRing = radSegs + 1: vertex j=radSegs is a seam
  // duplicate of j=0 (same position, u=1 vs u=0). Manifold needs to know
  // these are geometrically the same point.
  const vertsPerRing = radSegs + 1;
  const ringCountActual = Math.min(ringCount, rings.length);
  const mergeFrom: number[] = [];
  const mergeTo: number[] = [];
  for (let ri = 0; ri < ringCountActual; ri++) {
    const seamVert = ri * vertsPerRing + radSegs; // j = radSegs (last)
    const firstVert = ri * vertsPerRing;            // j = 0
    if (seamVert < vCount) { // only mesh body verts, not cap verts
      mergeFrom.push(seamVert);
      mergeTo.push(firstVert);
    }
  }

  const triVerts = new Uint32Array(ci);

  try {
    const mesh = new MeshCtor({
      numProp: NUM_PROP,
      vertProperties,
      triVerts,
      mergeFromVert: new Uint32Array(mergeFrom),
      mergeToVert: new Uint32Array(mergeTo),
      tolerance: 0.001,
    });
    return new ManifoldCtor(mesh);
  } catch (e) {
    console.warn('[Weld] Failed to create manifold:', e);
    return null;
  }
}

// ============================================================
// Extract manifold mesh to flat arrays
// ============================================================

function extractManifoldToArrays(mesh: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }, arrays: TubeMeshResult): void {
  const np = mesh.numProp;
  const vp = mesh.vertProperties;
  const count = vp.length / np;

  for (let i = 0; i < count; i++) {
    const o = i * np;
    arrays.positions.push(vp[o], vp[o + 1], vp[o + 2]);
    arrays.uvs.push(vp[o + 3], vp[o + 4]);
    // Re-normalize normals (linear interpolation at CSG cuts denormalizes them)
    let nx = vp[o + 5], ny = vp[o + 6], nz = vp[o + 7];
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen > 1e-8) { nx /= nLen; ny /= nLen; nz /= nLen; }
    arrays.normals.push(nx, ny, nz);
    arrays.tangents.push(vp[o + 8], vp[o + 9], vp[o + 10], vp[o + 11]);
    arrays.heightWeights.push(vp[o + 12]);
    arrays.depthWeights.push(vp[o + 13]);
    arrays.branchWeights.push(vp[o + 14]);
    arrays.branchAnchors.push(vp[o + 15], vp[o + 16], vp[o + 17]);
    arrays.branchPhases.push(vp[o + 18]);
  }
  for (let i = 0; i < mesh.triVerts.length; i++) {
    arrays.indices.push(mesh.triVerts[i]);
  }
}

function clearArrays(a: TubeMeshResult): void {
  a.positions.length = 0; a.normals.length = 0; a.tangents.length = 0;
  a.uvs.length = 0; a.indices.length = 0; a.heightWeights.length = 0;
  a.depthWeights.length = 0; a.branchWeights.length = 0;
  a.branchAnchors.length = 0; a.branchPhases.length = 0;
}

function extractSegmentData(segmentInfos: SegmentMeshInfo[], arrays: TubeMeshResult): SegmentGeomData[] {
  const result: SegmentGeomData[] = [];
  for (const info of segmentInfos) {
    const vs = info.vertexStart, vc = info.vertexCount, is = info.indexStart, ic = info.indexCount;
    const p: number[] = [], n: number[] = [], t: number[] = [], u: number[] = [], ix: number[] = [];
    const hw: number[] = [], dw: number[] = [], bw: number[] = [], ba: number[] = [], bp: number[] = [];
    for (let v = 0; v < vc; v++) {
      const gi = vs + v;
      p.push(arrays.positions[gi * 3], arrays.positions[gi * 3 + 1], arrays.positions[gi * 3 + 2]);
      n.push(arrays.normals[gi * 3], arrays.normals[gi * 3 + 1], arrays.normals[gi * 3 + 2]);
      t.push(arrays.tangents[gi * 4], arrays.tangents[gi * 4 + 1], arrays.tangents[gi * 4 + 2], arrays.tangents[gi * 4 + 3]);
      u.push(arrays.uvs[gi * 2], arrays.uvs[gi * 2 + 1]);
      hw.push(arrays.heightWeights[gi] ?? 0); dw.push(arrays.depthWeights[gi] ?? 0);
      bw.push(arrays.branchWeights[gi] ?? 0);
      ba.push(arrays.branchAnchors[gi * 3] ?? 0, arrays.branchAnchors[gi * 3 + 1] ?? 0, arrays.branchAnchors[gi * 3 + 2] ?? 0);
      bp.push(arrays.branchPhases[gi] ?? 0);
    }
    for (let i = 0; i < ic; i++) ix.push(arrays.indices[is + i] - vs);
    result.push({ info, positions: p, normals: n, tangents: t, uvs: u, indices: ix, heightWeights: hw, depthWeights: dw, branchWeights: bw, branchAnchors: ba, branchPhases: bp });
  }
  return result;
}

function vec3DistSq(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

