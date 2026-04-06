import type { TreePreset } from './TreePreset';
import { BroadleafPreset } from './BroadleafPreset';
import { ConiferPreset } from './ConiferPreset';

export const presets: Record<string, TreePreset> = {
  broadleaf: BroadleafPreset,
  conifer: ConiferPreset,
};

export const presetNames = Object.keys(presets);

export function getPreset(name: string): TreePreset {
  return presets[name] ?? BroadleafPreset;
}
