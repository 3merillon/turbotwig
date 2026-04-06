import type { TreeSkeleton } from '../../types/tree';
import type { TubeMeshResult, TubeMeshOptions } from '../mesh/TubeMeshBuilder';
import type { LeafPlacerOptions, LeafMeshResult } from '../mesh/LeafPlacer';
import type { RelaxationOptions } from './BranchRelaxation';

/**
 * Runs the tree refinement pipeline (relax + mesh rebuild + weld) in a Web Worker.
 * Returns a promise that resolves with the final mesh data.
 */
export async function runTreePipelineAsync(
  skeleton: TreeSkeleton,
  meshOptions: Partial<TubeMeshOptions>,
  treeHeight: number,
  relaxOptions: Partial<RelaxationOptions>,
  doRelax: boolean,
  doWeld: boolean,
  onProgress?: (stage: string, pct: number, msg?: string) => void,
  leafOptions?: { seed: number; options: Partial<LeafPlacerOptions> } | null,
  onRelaxed?: (result: { barkMesh: TubeMeshResult; treeHeight: number; leafMesh?: LeafMeshResult }) => void,
): Promise<{ barkMesh: TubeMeshResult; treeHeight: number; leafMesh?: LeafMeshResult }> {
  if (!doRelax && !doWeld) {
    return Promise.reject(new Error('Pipeline called with nothing to do'));
  }

  onProgress?.('relax', 0, 'Preparing...');

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./TreePipelineWorker.ts', import.meta.url),
      { type: 'module' },
    );

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.stage, msg.pct, msg.msg);
      } else if (msg.type === 'relaxed') {
        onRelaxed?.({
          barkMesh: msg.barkMesh as TubeMeshResult,
          treeHeight: msg.treeHeight as number,
          leafMesh: msg.leafMesh as LeafMeshResult | undefined,
        });
      } else if (msg.type === 'done') {
        worker.terminate();
        resolve({
          barkMesh: msg.barkMesh as TubeMeshResult,
          treeHeight: msg.treeHeight as number,
          leafMesh: msg.leafMesh as LeafMeshResult | undefined,
        });
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };

    worker.postMessage({
      type: 'pipeline',
      skeleton,
      meshOptions,
      treeHeight,
      doRelax,
      relaxOptions,
      doWeld,
      leafOptions: leafOptions ?? null,
    });
  });
}
