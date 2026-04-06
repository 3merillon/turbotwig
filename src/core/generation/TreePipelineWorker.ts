/**
 * Web Worker that runs the tree refinement pipeline off the main thread.
 * Receives a PipelineMessage, executes relax/mesh/weld steps, and posts
 * progress updates and final results back to the caller.
 */

import { relaxBranches } from './BranchRelaxation';
import type { RelaxationOptions } from './BranchRelaxation';
import { buildTreeMesh } from '../mesh/TubeMeshBuilder';
import type { TubeMeshOptions, TubeMeshResult } from '../mesh/TubeMeshBuilder';
import { placeLeaves } from '../mesh/LeafPlacer';
import type { LeafPlacerOptions } from '../mesh/LeafPlacer';
import { weldBranchesCore } from '../mesh/BranchWelder';
import type { TreeSkeleton } from '../../types/tree';

/** Message payload expected by the pipeline worker. */
export interface PipelineMessage {
  type: 'pipeline';
  skeleton: TreeSkeleton;
  meshOptions: Partial<TubeMeshOptions>;
  treeHeight: number;
  doRelax: boolean;
  relaxOptions: Partial<RelaxationOptions>;
  doWeld: boolean;
  leafOptions: { seed: number; options: Partial<LeafPlacerOptions> } | null;
}

self.onmessage = async (e: MessageEvent<PipelineMessage>) => {
  if (!e.data || e.data.type !== 'pipeline') {
    self.postMessage({ type: 'error', message: `[Worker] Invalid message type: ${e.data?.type}` });
    return;
  }
  const { skeleton, meshOptions, treeHeight, doRelax, relaxOptions, doWeld, leafOptions } = e.data;
  if (!skeleton || !skeleton.segments || !Array.isArray(skeleton.segments)) {
    self.postMessage({ type: 'error', message: '[Worker] Invalid skeleton data' });
    return;
  }

  try {
    // Step 1: Relax skeleton (if enabled)
    if (doRelax) {
      self.postMessage({ type: 'progress', stage: 'relax', pct: 0, msg: 'Relaxing...' });
      relaxBranches(skeleton, {
        ...relaxOptions,
        onIterationComplete: (iter, total) => {
          self.postMessage({ type: 'progress', stage: 'relax', pct: iter / total, msg: `Relaxing: iteration ${iter}/${total}` });
        },
      });
      self.postMessage({ type: 'progress', stage: 'relax', pct: 1, msg: 'Relaxing done' });
    }

    // Recompute tree height after relaxation may have changed bounds
    const newHeight = doRelax
      ? skeleton.bounds.max[1] - skeleton.bounds.min[1]
      : treeHeight;

    // Step 1b: Re-place leaves on relaxed skeleton so they stay attached
    let leafMesh = undefined;
    if (doRelax && leafOptions) {
      leafMesh = placeLeaves(skeleton.segments, newHeight, leafOptions.seed, leafOptions.options);
    }

    // Step 2: Rebuild mesh from (possibly relaxed) skeleton
    self.postMessage({ type: 'progress', stage: 'mesh', pct: 0, msg: 'Building mesh...' });
    const barkMesh: TubeMeshResult = buildTreeMesh(skeleton.segments, newHeight, meshOptions);
    self.postMessage({ type: 'progress', stage: 'mesh', pct: 1, msg: 'Mesh built' });

    // Post intermediate relaxed mesh so main thread can display it while
    // welding continues in the background.
    if (doRelax && doWeld) {
      self.postMessage({
        type: 'relaxed',
        barkMesh,
        treeHeight: newHeight,
        leafMesh,
      });
    }

    // Step 3: Weld (if enabled and mesh has segment info)
    if (doWeld && barkMesh.segmentInfos && barkMesh.segmentInfos.length > 0) {
      await weldBranchesCore(
        barkMesh.segmentInfos,
        barkMesh,
        newHeight,
        meshOptions as TubeMeshOptions,
        (pct, msg) => {
          self.postMessage({ type: 'progress', stage: 'weld', pct, msg });
        },
      );
    }

    self.postMessage({
      type: 'done',
      barkMesh,
      treeHeight: newHeight,
      leafMesh,
    });
  } catch (err: any) {
    self.postMessage({
      type: 'error',
      message: err?.message ?? String(err),
    });
  }
};
