import { loadImage } from './TextureLoader';
import type { WebGL2Renderer } from './WebGL2Renderer';

interface BarkManifest {
  species: Record<string, {
    barkAlbedo: string[];
    barkNormal: string[];
    barkDisplacement?: string[];
    leaf?: string[];
  }>;
}

/**
 * Manages loading and applying bark/leaf textures for the current tree preset.
 * Owns the manifest fetch, per-species image loading, and GPU upload via the renderer.
 */
export interface TexturePaths {
  barkAlbedo?: string;
  barkNormal?: string;
  barkDisplacement?: string;
  leafAlbedo?: string;
  leafNormal?: string;
}

export class TextureManager {
  private renderer: WebGL2Renderer;
  private manifest: BarkManifest | null = null;
  private currentSpecies: string | null = null;

  private barkDiffuseImg: HTMLImageElement | null = null;
  private barkNormalImg: HTMLImageElement | null = null;
  private barkDisplacementImg: HTMLImageElement | null = null;
  private leafDiffuseImg: HTMLImageElement | null = null;
  private leafNormalImg: HTMLImageElement | null = null;

  constructor(renderer: WebGL2Renderer) {
    this.renderer = renderer;
  }

  /** Return the loaded texture URIs for the current species (for export purposes). */
  getPaths(): TexturePaths {
    if (!this.currentSpecies || !this.manifest) return {};
    const s = this.manifest.species[this.currentSpecies];
    if (!s) return {};
    const leafAlbedo = s.leaf?.[0];
    const leafNormal = leafAlbedo ? leafAlbedo.replace('_alb.webp', '_nrm.webp') : undefined;
    return {
      barkAlbedo: s.barkAlbedo?.[0],
      barkNormal: s.barkNormal?.[0],
      barkDisplacement: s.barkDisplacement?.[0],
      leafAlbedo,
      leafNormal,
    };
  }

  /** Fetch the texture manifest (call once at startup). */
  async loadManifest(): Promise<void> {
    try {
      const resp = await fetch('/textures/trees/manifest.json');
      this.manifest = await resp.json();
    } catch {
      this.manifest = null;
    }
  }

  /** Load bark + leaf textures for a given species key (e.g. 'oak', 'conifer'). */
  async loadForSpecies(textureSpecies: string): Promise<void> {
    this.currentSpecies = textureSpecies;
    // Load bark textures
    try {
      const speciesData = this.manifest?.species[textureSpecies];
      if (speciesData) {
        const albedoPath = speciesData.barkAlbedo?.[0];
        const normalPath = speciesData.barkNormal?.[0];
        const displacementPath = speciesData.barkDisplacement?.[0];
        const [diffuse, normal, displacement] = await Promise.all([
          albedoPath ? loadImage(albedoPath) : Promise.resolve(null),
          normalPath ? loadImage(normalPath).catch(() => null) : Promise.resolve(null),
          displacementPath ? loadImage(displacementPath).catch(() => null) : Promise.resolve(null),
        ]);
        this.barkDiffuseImg = diffuse;
        this.barkNormalImg = normal;
        this.barkDisplacementImg = displacement;
      }
    } catch {
      this.barkDiffuseImg = null;
      this.barkNormalImg = null;
    }

    // Load leaf textures
    try {
      const speciesData = this.manifest?.species[textureSpecies];
      if (speciesData?.leaf?.length) {
        const leafPath = speciesData.leaf[0];
        const normalPath = leafPath.replace('_alb.webp', '_nrm.webp');
        const [diffuse, normal] = await Promise.all([
          loadImage(leafPath),
          loadImage(normalPath).catch(() => null),
        ]);
        this.leafDiffuseImg = diffuse;
        this.leafNormalImg = normal;
      }
    } catch {
      this.leafDiffuseImg = null;
      this.leafNormalImg = null;
    }
  }

  /**
   * Push loaded images to the GPU via the renderer.
   * Safe to call multiple times — images are retained until replaced by loadForSpecies().
   */
  applyToRenderer(): void {
    this.renderer.setBarkTextures(this.barkDiffuseImg, this.barkNormalImg, null, null, this.barkDisplacementImg);
    this.renderer.setLeafTextures(this.leafDiffuseImg, this.leafNormalImg);
  }
}
