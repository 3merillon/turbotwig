import type { Vec3 } from './math';

/**
 * Generic spatial hash for fast proximity queries in 3D space.
 *
 * Items are inserted with an AABB (min/max bounds). Queries return all items
 * whose cells overlap the search sphere. Uses integer hashing for performance.
 *
 * @typeParam T - The type of items stored in the grid.
 */
export class SpatialHash<T> {
  private cells = new Map<number, T[]>();
  private cellSize: number;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
  }

  private hash(x: number, y: number, z: number): number {
    return ((x * 73856093) ^ (y * 19349669) ^ (z * 83492791)) | 0;
  }

  /** Insert an item into all cells its AABB overlaps. Returns false if it spans too many cells. */
  insert(item: T, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, maxCells = 64): boolean {
    const cs = this.cellSize;
    const x0 = Math.floor(minX / cs), x1 = Math.floor(maxX / cs);
    const y0 = Math.floor(minY / cs), y1 = Math.floor(maxY / cs);
    const z0 = Math.floor(minZ / cs), z1 = Math.floor(maxZ / cs);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > maxCells) return false;
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const k = this.hash(x, y, z);
          let arr = this.cells.get(k);
          if (!arr) { arr = []; this.cells.set(k, arr); }
          arr.push(item);
        }
      }
    }
    return true;
  }

  /** Query all items in cells near a point within searchRadius. Deduplication is caller's responsibility. */
  queryRaw(point: Vec3, searchRadius: number, visitor: (item: T) => void): void {
    const cs = this.cellSize;
    const r = searchRadius;
    for (let x = Math.floor((point[0] - r) / cs); x <= Math.floor((point[0] + r) / cs); x++) {
      for (let y = Math.floor((point[1] - r) / cs); y <= Math.floor((point[1] + r) / cs); y++) {
        for (let z = Math.floor((point[2] - r) / cs); z <= Math.floor((point[2] + r) / cs); z++) {
          const arr = this.cells.get(this.hash(x, y, z));
          if (!arr) continue;
          for (const item of arr) visitor(item);
        }
      }
    }
  }

  clear(): void {
    this.cells.clear();
  }
}
