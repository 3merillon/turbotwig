import type { TreePreset } from '../presets/TreePreset';

/**
 * Serialize/deserialize tree preset configurations as JSON.
 * Allows saving and loading tree configurations.
 */
export class TreeSerializer {
  /**
   * Serialize a tree preset to a JSON string.
   */
  static serialize(preset: TreePreset, uiParams?: Record<string, unknown>): string {
    const data = {
      version: 1,
      preset: {
        ...preset,
        // Strip functions from rules — serialize as strings
        lsystem: {
          ...preset.lsystem,
          rules: preset.lsystem.rules.map(r => ({
            predecessor: r.predecessor,
            successor: typeof r.successor === 'function' ? r.successor([], { next: () => 0.5 }).toString() : r.successor,
            probability: r.probability,
          })),
        },
      },
      uiParams,
      exportedAt: new Date().toISOString(),
    };

    return JSON.stringify(data, null, 2);
  }

  /**
   * Download a tree configuration as JSON.
   */
  static download(preset: TreePreset, filename: string = 'turbotwig-config', uiParams?: Record<string, unknown>) {
    const json = this.serialize(preset, uiParams);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Load a tree configuration from a JSON file.
   * Returns partial preset data (rules will be strings, not functions).
   */
  static async loadFromFile(): Promise<{ preset: Partial<TreePreset>; uiParams?: Record<string, unknown> } | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }

        try {
          const text = await file.text();
          const data = JSON.parse(text);
          resolve({
            preset: data.preset,
            uiParams: data.uiParams,
          });
        } catch {
          console.error('Failed to parse tree configuration file');
          resolve(null);
        }
      };
      input.click();
    });
  }
}
