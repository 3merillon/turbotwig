/**
 * TurboTwig application controller.
 *
 * Orchestrates tree generation, rendering, texture management, and UI.
 * Acts as the glue between the generation pipeline, WebGL renderer,
 * and the windowed GUI system.
 */

import { WebGL2Renderer } from './renderer/WebGL2Renderer';
import { TextureManager } from './renderer/TextureManager';
import { hexToLinearRGB } from './renderer/math';
import type { TubeMeshResult } from './core/mesh/TubeMeshBuilder';
import type { LeafMeshResult } from './core/mesh/LeafPlacer';
import { runTreePipelineAsync } from './core/generation/TreePipeline';
import { TreeGenerator, type GenerationParams } from './core/generation/TreeGenerator';
import { sanitizeTubeMesh } from './core/mesh/sanitizeTubeMesh';
import { getPreset } from './presets/presetRegistry';
import type { TreePreset } from './presets/TreePreset';
import type { TreeSkeleton } from './types/tree';
import { TurboTwigExporter } from './export/GLTFExporter';
import { TreeSerializer } from './export/TreeSerializer';
import { UIManager } from './ui/ui-manager';
import { AudioEngine } from './core/audio/AudioEngine';

// Keys for params that affect tree geometry or visual result.
// Only these are applied when loading a config file or switching presets.
// Rendering settings (lighting, atmosphere, display, wind animation) are excluded.
const GEOMETRY_PARAM_KEYS: ReadonlySet<string> = new Set([
  // Species
  'seed',
  // L-system / Turtle
  'iterations', 'angle', 'subBranchAngle', 'angleVariance',
  'lengthScale', 'radiusScale', 'initialRadius', 'initialLength',
  'tropismStrength', 'flattenBias', 'branchWeight', 'phototropism',
  'kinkAngle', 'kinkVariance', 'kinkRestore',
  'whorlTaper', 'whorlMaxBranches', 'whorlBranchReduction',
  // Branch subdivision & relaxation
  'branchJitter', 'branchMinPoints',
  'collisionAvoidance', 'relaxIterations', 'relaxStrength', 'relaxRadius',
  // Mesh quality & bark geometry
  'radialSegments', 'radialSegmentsDepthStep', 'lengthSubdivision',
  'barkNoiseAmount', 'barkNoiseFreq', 'barkNoiseOctaves',
  'barkTwist', 'barkTwistNoise', 'barkTwistNoiseFreq', 'barkUvTwist',
  // Taper & flare
  'taperAmount', 'taperPower',
  'trunkTaperEnabled', 'trunkTaperAmount', 'trunkTaperPower',
  'contactFlare', 'contactFlareLength', 'tipRadius',
  // Roots
  'rootCount', 'rootLength', 'trunkExtension', 'rootRadiusFraction',
  'rootPitchAngle', 'rootFlare', 'rootFlareHeight', 'rootGravity',
  'rootHeight', 'rootSurfaceOffset', 'rootTaperAmount', 'rootTaperPower',
  'rootKinkAngle', 'rootPullDownRadius', 'rootPullDownStrength',
  'subRootLevels', 'subRootCount', 'subRootScale',
  // Leaves
  'leafDensity', 'leafSize', 'leafMinDepth', 'clusterMode', 'clusterSize',
  'tipLeaves', 'tipLeafMinDepth', 'leafDroop', 'leafSpread',
  'leafHorizontality', 'leafHorizontalityNoise',
  'leafVerticality', 'leafVerticalityNoise',
  'leafWorldUp', 'leafOrientationMode',
  // Materials / Texture
  'barkTileU', 'barkTileV',
  // Tree behaviour (species-specific, not wind environment)
  'branchFlexibility', 'trunkStiffness', 'maxSway',
  // Welding & caps (affect welded geometry output)
  'smartFitEnabled', 'weldEnabled',
  'weldBlendRings', 'weldSurfaceOffset', 'weldMinRadiusRatio',
  'capBranchTips', 'capRootTips', 'capTrunkBottom',
  'vertexWeldEnabled',
  // Leaf visibility (affects whether leaf mesh is generated)
  'showLeaves',
]);

export class App {
  private renderer: WebGL2Renderer;
  private textures: TextureManager;
  private uiManager!: UIManager;
  private currentPreset: TreePreset;
  private animationId: number = 0;
  private lastTime: number = 0;
  private exporter: TurboTwigExporter;
  private treeGenerator: TreeGenerator;
  private audioEngine: AudioEngine;

  // Store last mesh data for export
  private lastBarkMeshData: TubeMeshResult | null = null;
  private lastLeafMeshData: LeafMeshResult | null = null;
  private lastSkeleton: TreeSkeleton | null = null;

  // Wind uniforms (shared references so materials auto-update)
  private windTime = 0;

  // UI-bound params (index signature enables generic UI control access without unsafe casts)
  private params: GenerationParams & Record<string, any> = {
    preset: 'broadleaf',
    seed: 12345,
    iterations: 4,
    angle: 25,
    subBranchAngle: 35,
    angleVariance: 5,
    lengthScale: 0.72,
    radiusScale: 0.65,
    initialRadius: 0.5,
    initialLength: 2.5,
    tropismStrength: 0.05,
    flattenBias: 0,
    branchWeight: 0,
    phototropism: 0,
    leafDensity: 4.0,
    leafSize: 0.5,
    leafMinDepth: 2,
    clusterMode: true,
    clusterSize: 2.8,
    tipLeaves: true,
    tipLeafMinDepth: 0,
    leafDroop: 0,
    leafSpread: 0,
    leafHorizontality: 0,
    leafHorizontalityNoise: 0,
    leafVerticality: 0,
    leafVerticalityNoise: 0,
    leafWorldUp: 0,
    leafOrientationMode: 'branch' as 'branch' | 'sky' | 'pendant' | 'radial',
    windSpeed: 1.0,
    windAzimuth: 135,
    windElevation: 0,
    gustStrength: 0.3,
    windBias: 0.5,
    windVerticalDamping: 0.95,
    leafVerticalDamping: 0.95,
    leafPushStrength: 0.5,
    trunkStiffness: 2.0,
    branchFlexibility: 0.5,
    maxSway: 3.0,
    // Audio
    audioEnabled: false,
    masterVolume: 0.8,
    audioMute: false,
    stereoWidth: 1.0,
    reverbMix: 0.28,
    reverbRoomSize: 0.55,
    reverbDamping: 0.55,
    compressionAmount: 0.4,
    eqTilt: 0.1,
    eqPresence: 2,
    eqAir: 3,
    gustAttack: 1.0,
    gustRelease: 1.0,
    lowBandGain: 0.35,
    midBandGain: 0.70,
    highBandGain: 0.60,
    airBandGain: 0.45,
    showBarkWire: false,
    showLeafWire: false,
    wireframeBarkColor: '#00ccff',
    wireframeLeafColor: '#00ff80',
    wireframeOnTop: false,
    showLeaves: true,
    enableNormalMap: true,
    barkNormalStrength: 1.0,
    leafNormalStrength: 1.0,
    leafSSS: 0.1,
    radialSegments: 10,
    radialSegmentsDepthStep: 1,
    lengthSubdivision: 3,
    barkNoiseAmount: 0.15,
    barkNoiseFreq: 3.0,
    barkNoiseOctaves: 2,
    barkTwist: 0.3,
    barkTwistNoise: 0.3,
    barkTwistNoiseFreq: 2.0,
    barkUvTwist: 1,
    debugView: 'none' as string,
    barkTileU: 3,
    barkTileV: 3,
    parallaxEnabled: true,
    parallaxScale: 0.04,
    parallaxSteps: 16,
    parallaxFadeNear: 15,
    parallaxFadeFar: 40,
    sunIntensity: 4,
    sunAzimuth: 45,
    sunElevation: 33,
    ambientIntensity: 0.4,
    showLightHelpers: false,
    shadows: true,
    shadowBias: 0.0005,
    shadowNormalBias: 0.03,
    shadowSoftness: 4.0,
    shadowFadeStart: 15,
    shadowFadeEnd: 30,
    showGizmo: true,
    backgroundColor: '#1a1a2e',
    // Atmosphere
    skyEnabled: true,
    skyRayleighScale: 1.0,
    skyMieScale: 1.0,
    skyMieAnisotropy: 0.65,
    skyGroundAlbedo: '#a0a690',
    skyRaySteps: 16,
    // Roots
    rootCount: 5,
    rootLength: 0.2,
    trunkExtension: 1.5,
    rootRadiusFraction: 0.55,
    rootPitchAngle: 10,
    rootFlare: 1.4,
    rootFlareHeight: 3,
    rootGravity: 1,
    rootHeight: 0.25,
    rootSurfaceOffset: -1,
    rootTaperAmount: 0.95,
    rootTaperPower: 1,
    rootKinkAngle: 5,
    rootPullDownRadius: 0,
    rootPullDownStrength: 0.8,
    subRootLevels: 1,
    subRootCount: 2,
    subRootScale: 1,
    // Taper
    taperAmount: 0.7,
    taperPower: 1,
    trunkTaperEnabled: false,
    trunkTaperAmount: 0.7,
    trunkTaperPower: 1,
    contactFlare: 0,
    contactFlareLength: 0.15,
    tipRadius: 0,
    // Welding
    smartFitEnabled: true,
    capBranchTips: true,
    capRootTips: true,
    capTrunkBottom: true,
    weldEnabled: true,
    weldBlendRings: 2,
    weldSurfaceOffset: 0.003,
    weldMinRadiusRatio: 0.02,
    vertexWeldEnabled: true,
    // Kinks
    kinkAngle: 0,
    kinkVariance: 0,
    kinkRestore: 1.5,
    whorlTaper: 1,
    whorlMaxBranches: 5,
    whorlBranchReduction: 0.4,
    // Branch organic subdivision
    branchJitter: 0.06,
    branchMinPoints: 4,
    // Branch relaxation (collision avoidance)
    collisionAvoidance: true,
    relaxIterations: 6,
    relaxStrength: 0.1,
    relaxRadius: 1.0,
  };

  private pipelineAborted = false;
  private pipelineGeneration = 0;
  private pipelineStatusEl: HTMLDivElement | null = null;
  private lastPipelineGeoHash = '';
  private pipelineBusy = false;

  constructor(container: HTMLElement) {
    this.renderer = new WebGL2Renderer(container);
    this.textures = new TextureManager(this.renderer);
    this.lastTime = performance.now();
    this.currentPreset = getPreset('broadleaf');
    this.exporter = new TurboTwigExporter();
    this.treeGenerator = new TreeGenerator();
    this.audioEngine = new AudioEngine();

    // Setup initial lighting
    this.updateSunPosition();

    // Setup GUI
    this.uiManager = new UIManager(
      this.params,
      this.renderer,
      {
        onPresetChange: (name) => this.loadPreset(name),
        onParamChange: () => this.debouncedRegenerate(),
        onExportGLB: () => this.exportTree('glb'),
        onExportGLTF: () => this.exportTree('gltf'),
        onSaveConfig: () => {
          TreeSerializer.download(this.currentPreset, `turbotwig-config-${this.params.preset}`, this.params);
        },
        onLoadConfig: async () => {
          const result = await TreeSerializer.loadFromFile();
          if (result?.uiParams) {
            const target = this.params as Record<string, unknown>;
            for (const key of Object.keys(result.uiParams)) {
              if (GEOMETRY_PARAM_KEYS.has(key) && key in this.params) {
                target[key] = result.uiParams[key];
              }
            }
            // Sync renderer state for params that have side-effects beyond the params object
            this.renderer.showLeaves = this.params.showLeaves;
            this.uiManager.updateDisplay();
            this.regenerateTree();
          }
        },
        onAudioToggle: (enabled: boolean) => {
          if (enabled) {
            this.audioEngine.initialize().then(() => this.audioEngine.start());
          } else {
            this.audioEngine.stop();
          }
        },
      },
    );

    // Load texture manifest, then apply initial preset
    this.textures.loadManifest().then(() => {
      return this.loadPreset(this.params.preset);
    });

    // Start render loop
    this.animate();
  }


  private updateStats(verts: number, tris: number, branches: number, leaves: number) {
    this.uiManager.updateStats(verts, tris, branches, leaves);
  }


  private async exportTree(format: 'glb' | 'gltf') {
    if (!this.lastBarkMeshData) return;
    if (this.pipelineBusy) {
      console.warn('[Export] Tree is still being welded/relaxed; please wait for the pipeline to finish before exporting.');
      this.showPipelineStatus('Pipeline busy — export skipped');
      setTimeout(() => this.hidePipelineStatus(), 1500);
      return;
    }

    const bd = this.lastBarkMeshData;
    const texPaths = this.textures.getPaths();
    const mimeFor = (uri: string): string => uri.endsWith('.webp') ? 'image/webp' : uri.endsWith('.png') ? 'image/png' : 'image/jpeg';

    // Bark UV tiling is already baked into the mesh UVs by TubeMeshBuilder
    // (uvs = u * uvTileU, v * uvTileV), so do NOT apply KHR_texture_transform
    // scale here — that would double-tile.
    const barkTextures: import('./export/GLTFExporter').RawMeshData['textures'] = {};
    if (texPaths.barkAlbedo) {
      barkTextures.baseColor = {
        uri: texPaths.barkAlbedo,
        mimeType: mimeFor(texPaths.barkAlbedo),
      };
    }
    if (texPaths.barkNormal) {
      barkTextures.normal = {
        uri: texPaths.barkNormal,
        mimeType: mimeFor(texPaths.barkNormal),
        normalScale: this.params.barkNormalStrength,
      };
    }
    if (texPaths.barkDisplacement) {
      barkTextures.displacement = {
        uri: texPaths.barkDisplacement,
        mimeType: mimeFor(texPaths.barkDisplacement),
        normalScale: this.params.parallaxScale, // reused as displacementFactor
      };
    }

    const meshes: import('./export/GLTFExporter').RawMeshData[] = [
      {
        name: 'bark',
        positions: new Float32Array(bd.positions),
        normals: new Float32Array(bd.normals),
        uvs: new Float32Array(bd.uvs),
        indices: new Uint32Array(bd.indices),
        tangents: bd.tangents ? new Float32Array(bd.tangents) : undefined,
        color: hexToLinearRGB(this.currentPreset.bark.color),
        roughness: this.currentPreset.bark.roughness,
        textures: Object.keys(barkTextures).length > 0 ? barkTextures : undefined,
      },
    ];

    if (this.lastLeafMeshData) {
      const ld = this.lastLeafMeshData;
      const leafTextures: import('./export/GLTFExporter').RawMeshData['textures'] = {};
      if (texPaths.leafAlbedo) {
        leafTextures.baseColor = {
          uri: texPaths.leafAlbedo,
          mimeType: mimeFor(texPaths.leafAlbedo),
        };
      }
      if (texPaths.leafNormal) {
        leafTextures.normal = {
          uri: texPaths.leafNormal,
          mimeType: mimeFor(texPaths.leafNormal),
          normalScale: this.params.leafNormalStrength,
        };
      }
      meshes.push({
        name: 'leaves',
        positions: new Float32Array(ld.positions),
        normals: new Float32Array(ld.normals),
        uvs: new Float32Array(ld.uvs),
        indices: new Uint32Array(ld.indices),
        color: hexToLinearRGB(this.currentPreset.leafAppearance.color),
        doubleSided: true,
        clampUV: true,
        // Leaf shader flips V internally — bake the flip into exported UVs.
        flipV: true,
        // Leaf textures have alpha cutout around the leaf silhouette.
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
        textures: Object.keys(leafTextures).length > 0 ? leafTextures : undefined,
      });
    }

    const filename = `turbotwig-${this.params.preset}-${this.params.seed}`;
    await this.exporter.exportAndDownload(meshes, filename, { binary: format === 'glb' });
  }

  private async loadPreset(name: string) {
    this.currentPreset = getPreset(name);
    const p = this.currentPreset;

    // Store original axiom and default length for height scaling
    this.treeGenerator.setPresetBase(p);

    this.params.iterations = p.lsystem.iterations;
    this.params.angle = p.turtle.angle;
    this.params.subBranchAngle = p.lsystem.defaultSubAngle ?? p.turtle.angle;
    this.params.angleVariance = p.turtle.angleVariance;
    this.params.lengthScale = p.turtle.lengthScale;
    this.params.radiusScale = p.turtle.radiusScale;
    this.params.initialRadius = p.turtle.initialRadius;
    this.params.initialLength = p.turtle.initialLength;
    this.params.tropismStrength = p.turtle.tropismStrength;
    this.params.flattenBias = p.turtle.flattenBias ?? 0;
    this.params.branchWeight = p.turtle.branchWeight ?? 0;
    this.params.phototropism = p.turtle.phototropism ?? 0;
    this.params.kinkAngle = p.turtle.kinkAngle ?? 0;
    this.params.kinkVariance = p.turtle.kinkVariance ?? 0;
    this.params.kinkRestore = p.turtle.kinkRestore ?? 1.5;
    this.params.whorlTaper = p.lsystem.whorlTaper ?? 1;
    this.params.whorlMaxBranches = p.lsystem.whorlMaxBranches ?? 5;
    this.params.whorlBranchReduction = p.lsystem.whorlBranchReduction ?? 0.4;
    this.params.radialSegments = p.mesh.radialSegments ?? 8;
    this.params.radialSegmentsDepthStep = p.mesh.radialSegmentsDepthStep ?? 1;
    this.params.lengthSubdivision = p.mesh.lengthSegmentsPerUnit ?? 3;
    this.params.barkNoiseAmount = p.mesh.noiseAmplitude ?? 0.15;
    this.params.barkNoiseFreq = p.mesh.noiseFrequency ?? 3.0;
    this.params.barkNoiseOctaves = p.mesh.noiseOctaves ?? 2;
    this.params.barkTwist = p.mesh.twistRate ?? 0.3;
    this.params.barkTwistNoise = p.mesh.twistNoise ?? 0.3;
    this.params.barkTwistNoiseFreq = p.mesh.twistNoiseFreq ?? 2.0;
    this.params.barkUvTwist = p.mesh.uvTwist ?? 1;
    this.params.taperAmount = p.mesh.taperAmount ?? 0.7;
    this.params.taperPower = p.mesh.taperPower ?? 1;
    this.params.trunkTaperEnabled = p.mesh.trunkTaperAmount !== undefined;
    this.params.trunkTaperAmount = p.mesh.trunkTaperAmount ?? this.params.taperAmount;
    this.params.trunkTaperPower = p.mesh.trunkTaperPower ?? this.params.taperPower;
    this.params.contactFlare = p.mesh.contactFlare ?? 0;
    this.params.contactFlareLength = p.mesh.contactFlareLength ?? 0.15;
    this.params.tipRadius = p.mesh.tipRadius ?? 0;
    this.params.leafDensity = p.leaves.density ?? 4;
    this.params.leafSize = p.leaves.size ?? 0.5;
    this.params.leafMinDepth = p.leaves.minDepth ?? 2;
    this.params.clusterMode = p.leaves.clusterMode ?? true;
    this.params.clusterSize = p.leaves.clusterSize ?? 2.5;
    this.params.tipLeaves = p.leaves.tipLeaves ?? true;
    this.params.tipLeafMinDepth = p.leaves.tipLeafMinDepth ?? 0;
    this.params.leafDroop = p.leaves.leafDroop ?? 0;
    this.params.leafSpread = p.leaves.leafSpread ?? 0;
    this.params.leafHorizontality = p.leaves.leafHorizontality ?? 0;
    this.params.leafHorizontalityNoise = p.leaves.leafHorizontalityNoise ?? 0;
    this.params.leafVerticality = p.leaves.leafVerticality ?? 0;
    this.params.leafVerticalityNoise = p.leaves.leafVerticalityNoise ?? 0;
    this.params.leafWorldUp = p.leaves.leafWorldUp ?? 0;
    this.params.leafOrientationMode = p.leaves.leafOrientationMode ?? 'branch';

    // Roots
    if (p.roots) {
      this.params.rootCount = p.roots.rootCount ?? 5;
      this.params.rootLength = p.roots.rootLength ?? 0.2;
      this.params.trunkExtension = p.roots.trunkExtension ?? 1.5;
      this.params.rootRadiusFraction = p.roots.rootRadiusFraction ?? 0.55;
      this.params.rootPitchAngle = p.roots.rootPitchAngle ?? 10;
      this.params.rootFlare = p.roots.rootFlare ?? 1.4;
      this.params.rootFlareHeight = p.roots.rootFlareHeight ?? 3;
      this.params.rootGravity = p.roots.rootGravity ?? 1;
      this.params.rootHeight = p.roots.rootHeight ?? 0.25;
      this.params.rootSurfaceOffset = p.roots.rootSurfaceOffset ?? -1;
      this.params.rootTaperAmount = p.roots.rootTaperAmount ?? 0.95;
      this.params.rootTaperPower = p.roots.rootTaperPower ?? 1;
      this.params.rootKinkAngle = p.roots.rootKinkAngle ?? 5;
      this.params.rootPullDownRadius = p.roots.rootPullDownRadius ?? 0;
      this.params.rootPullDownStrength = p.roots.rootPullDownStrength ?? 0.8;
      this.params.subRootLevels = p.roots.subRootLevels ?? 1;
      this.params.subRootCount = p.roots.subRootCount ?? 2;
      this.params.subRootScale = p.roots.subRootScale ?? 1;
    }

    // Materials / Texture
    if (p.materials) {
      this.params.barkTileU = p.materials.barkTileU ?? 3;
      this.params.barkTileV = p.materials.barkTileV ?? 3;
      this.params.parallaxEnabled = p.materials.parallaxEnabled ?? true;
      this.params.parallaxScale = p.materials.parallaxScale ?? 0.04;
      this.params.parallaxSteps = p.materials.parallaxSteps ?? 16;
      this.params.parallaxFadeNear = p.materials.parallaxFadeNear ?? 15;
      this.params.parallaxFadeFar = p.materials.parallaxFadeFar ?? 40;
    }
    this.renderer.parallaxEnabled = this.params.parallaxEnabled;
    this.renderer.parallaxScale = this.params.parallaxScale;
    this.renderer.parallaxSteps = this.params.parallaxSteps;
    this.renderer.parallaxFadeNear = this.params.parallaxFadeNear;
    this.renderer.parallaxFadeFar = this.params.parallaxFadeFar;

    // Tree behaviour (species-specific wind response)
    if (p.behaviour) {
      this.params.branchFlexibility = p.behaviour.branchFlexibility ?? 0.5;
      this.params.trunkStiffness = p.behaviour.trunkStiffness ?? 2.0;
      this.params.maxSway = p.behaviour.maxSway ?? 3.0;
    }

    this.uiManager.updateDisplay();

    await this.textures.loadForSpecies(this.currentPreset.textureSpecies ?? 'oak');
    this.regenerateTree();
  }


  private regenTimeout: ReturnType<typeof setTimeout> | null = null;

  private debouncedRegenerate() {
    if (this.regenTimeout) clearTimeout(this.regenTimeout);
    this.regenTimeout = setTimeout(() => this.regenerateTree(), 150);
  }

  /**
   * Upload bark + leaf meshes to the GPU, apply textures, and update stats.
   * Handles the remove/upload cycle used by both initial generation and pipeline swap.
   */
  private uploadMeshToGPU(
    barkMesh: TubeMeshResult,
    leafMesh: LeafMeshResult | null,
    branchCount: number,
  ): void {
    // Final cleanup pass: drop degenerate triangles, normalize normals, optionally weld vertices.
    // This is the single place geometry goes through before GPU upload, so in-app rendering and
    // exports share the same cleaned mesh.
    const sanitized = sanitizeTubeMesh(barkMesh, {
      weldVertices: !!this.params.vertexWeldEnabled,
    });
    barkMesh = sanitized.mesh;
    this.lastBarkMeshData = barkMesh;

    this.renderer.removeBarkMesh();
    this.renderer.removeLeafMesh();

    let totalVerts = 0;
    let totalTris = 0;

    if (barkMesh.positions.length > 0) {
      this.renderer.uploadBarkMesh({
        positions: barkMesh.positions,
        normals: barkMesh.normals,
        tangents: barkMesh.tangents,
        uvs: barkMesh.uvs,
        indices: barkMesh.indices,
        heightWeights: barkMesh.heightWeights,
        depthWeights: barkMesh.depthWeights,
      });
      this.renderer.barkRoughness = this.currentPreset.bark.roughness;
      this.hasMeshOnGPU = true;

      totalVerts += barkMesh.positions.length / 3;
      totalTris += barkMesh.indices.length / 3;
    }

    if (leafMesh && leafMesh.positions.length > 0) {
      this.renderer.uploadLeafMesh({
        positions: leafMesh.positions,
        normals: leafMesh.normals,
        uvs: leafMesh.uvs,
        indices: leafMesh.indices,
        heightWeights: leafMesh.heightWeights,
        depthWeights: leafMesh.depthWeights,
        leafPhases: leafMesh.leafPhases,
        branchAnchors: leafMesh.branchAnchors,
      });

      totalVerts += leafMesh.positions.length / 3;
      totalTris += leafMesh.indices.length / 3;
    }

    this.textures.applyToRenderer();

    this.updateStats(
      totalVerts,
      totalTris,
      branchCount,
      leafMesh ? leafMesh.vertexCount / 4 : 0,
    );
  }

  private hasMeshOnGPU = false;

  private regenerateTree() {
    // Generate tree via pipeline
    const { skeleton, treeHeight, barkMesh: barkMeshData, leafMesh: leafMeshData } =
      this.treeGenerator.generate(this.currentPreset, this.params);

    this.lastSkeleton = skeleton;
    this.lastBarkMeshData = barkMeshData;
    this.lastLeafMeshData = leafMeshData;

    // Decide if the async pipeline (relaxation/welding) will run
    const doRelax = !!this.params.collisionAvoidance;
    const doWeld = !!this.params.weldEnabled;
    const geoHash = this.computeGeoHash();
    const needsPipeline = doRelax || doWeld;
    const pipelineWillRun = needsPipeline && geoHash !== this.lastPipelineGeoHash;

    // If the pipeline isn't needed at all, clear the cached hash so that
    // re-enabling relax/weld later always triggers a fresh run.
    if (!needsPipeline) {
      this.lastPipelineGeoHash = '';
    }

    // When pipeline will run and we already have a tree on screen, keep the
    // OLD tree visible — the pipeline callback will atomically swap it.
    // Otherwise (no pipeline, or first-ever tree) upload immediately.
    if (!pipelineWillRun || !this.hasMeshOnGPU) {
      this.uploadMeshToGPU(barkMeshData, leafMeshData, skeleton.segments.length);
    }

    // Async pipeline: relaxation + mesh rebuild + welding (all in one worker)
    if (pipelineWillRun) {
      this.lastPipelineGeoHash = geoHash;
      this.pipelineAborted = true;
      const generation = ++this.pipelineGeneration;
      this.pipelineAborted = false;
      this.pipelineBusy = true;

      this.showPipelineStatus(doRelax ? 'Relaxing: 0%' : 'Welding: 0%');

      const meshOpts = {
        ...this.currentPreset.mesh,
        radialSegments: this.params.radialSegments,
        radialSegmentsDepthStep: this.params.radialSegmentsDepthStep,
        lengthSegmentsPerUnit: this.params.lengthSubdivision,
        minLengthSegments: 1,
        noiseAmplitude: this.params.barkNoiseAmount,
        noiseFrequency: this.params.barkNoiseFreq,
        noiseOctaves: this.params.barkNoiseOctaves,
        twistRate: this.params.barkTwist,
        twistNoise: this.params.barkTwistNoise,
        twistNoiseFreq: this.params.barkTwistNoiseFreq,
        uvTwist: this.params.barkUvTwist,
        uvTileU: this.params.barkTileU,
        uvTileV: this.params.barkTileV,
        rootFlare: this.params.rootFlare,
        rootFlareHeight: this.params.initialRadius * this.params.rootFlareHeight,
        taperAmount: this.params.taperAmount,
        taperPower: this.params.taperPower,
        rootTaperAmount: this.params.rootTaperAmount,
        rootTaperPower: this.params.rootTaperPower,
        trunkTaperAmount: this.params.trunkTaperEnabled ? this.params.trunkTaperAmount : undefined,
        trunkTaperPower: this.params.trunkTaperEnabled ? this.params.trunkTaperPower : undefined,
        contactFlare: this.params.contactFlare,
        contactFlareLength: this.params.contactFlareLength,
        tipRadius: this.params.tipRadius,
        smartFitEnabled: this.params.smartFitEnabled,
        capBranchTips: this.params.capBranchTips,
        capRootTips: this.params.capRootTips,
        capTrunkBottom: this.params.capTrunkBottom,
        weldEnabled: doWeld,
        weldBlendRings: this.params.weldBlendRings,
        weldSurfaceOffset: this.params.weldSurfaceOffset,
        weldMinRadiusRatio: this.params.weldMinRadiusRatio,
      };

      const relaxOpts = {
        iterations: this.params.relaxIterations,
        strength: this.params.relaxStrength,
        radiusMultiplier: this.params.relaxRadius,
      };

      const leafPipelineOpts = (doRelax && this.params.showLeaves) ? {
        seed: this.params.seed,
        options: {
          ...this.currentPreset.leaves,
          density: this.params.leafDensity,
          size: this.params.leafSize,
          minDepth: this.params.leafMinDepth,
          clusterMode: this.params.clusterMode,
          clusterSize: this.params.clusterSize,
          taperAmount: this.params.taperAmount,
          taperPower: this.params.taperPower,
          trunkTaperAmount: this.params.trunkTaperEnabled ? this.params.trunkTaperAmount : undefined,
          trunkTaperPower: this.params.trunkTaperEnabled ? this.params.trunkTaperPower : undefined,
          contactFlare: this.params.contactFlare,
          contactFlareLength: this.params.contactFlareLength,
          tipRadius: this.params.tipRadius,
          tipLeaves: this.params.tipLeaves,
          tipLeafMinDepth: this.params.tipLeafMinDepth,
          leafDroop: this.params.leafDroop,
          leafSpread: this.params.leafSpread,
          leafHorizontality: this.params.leafHorizontality,
          leafHorizontalityNoise: this.params.leafHorizontalityNoise,
          leafVerticality: this.params.leafVerticality,
          leafVerticalityNoise: this.params.leafVerticalityNoise,
          leafWorldUp: this.params.leafWorldUp,
          leafOrientationMode: this.params.leafOrientationMode,
        },
      } : null;

      runTreePipelineAsync(
        skeleton,
        meshOpts,
        skeleton.bounds.max[1] - skeleton.bounds.min[1],
        relaxOpts,
        doRelax,
        doWeld,
        (stage, pct, _msg) => {
          if (this.pipelineGeneration !== generation) return;
          if (stage === 'relax') {
            this.showPipelineStatus(`Relaxing: ${Math.round(pct * 100)}%`);
          } else if (stage === 'mesh') {
            this.showPipelineStatus('Building mesh...');
          } else if (stage === 'weld') {
            this.showPipelineStatus(`Welding: ${Math.round(pct * 100)}%`);
          }
        },
        leafPipelineOpts,
        (relaxedResult) => {
          if (this.pipelineGeneration !== generation || this.pipelineAborted) return;
          const rl = relaxedResult.leafMesh;
          const intermediateLeaf = (rl && rl.positions.length > 0) ? rl : leafMeshData;
          // Capture the relaxed-but-not-yet-welded mesh so exports during weld use up-to-date geometry.
          this.lastBarkMeshData = relaxedResult.barkMesh;
          if (rl && rl.positions.length > 0) {
            this.lastLeafMeshData = rl;
          }
          this.uploadMeshToGPU(relaxedResult.barkMesh, intermediateLeaf, skeleton.segments.length);
        },
      ).then((result) => {
        if (this.pipelineGeneration !== generation || this.pipelineAborted) {
          this.pipelineBusy = false;
          this.hidePipelineStatus();
          return;
        }
        // Atomic swap with relaxed/welded mesh
        const newLeaf = result.leafMesh;
        const finalLeaf = (newLeaf && newLeaf.positions.length > 0) ? newLeaf : leafMeshData;
        // Capture final welded mesh for export.
        this.lastBarkMeshData = result.barkMesh;
        if (newLeaf && newLeaf.positions.length > 0) {
          this.lastLeafMeshData = newLeaf;
        }

        this.uploadMeshToGPU(result.barkMesh, finalLeaf, skeleton.segments.length);
        this.pipelineBusy = false;
        this.hidePipelineStatus();
      }).catch((err) => {
        console.error('Pipeline worker error:', err);
        this.pipelineBusy = false;
        this.hidePipelineStatus();
      });
    }
  }

  private showPipelineStatus(msg: string) {
    if (!this.pipelineStatusEl) {
      this.pipelineStatusEl = document.createElement('div');
      this.pipelineStatusEl.className = 'tt-pipeline-status';
      document.body.appendChild(this.pipelineStatusEl);
    }
    this.pipelineStatusEl.textContent = msg;
    this.pipelineStatusEl.style.display = '';
  }

  private hidePipelineStatus() {
    if (this.pipelineStatusEl) this.pipelineStatusEl.style.display = 'none';
  }

  private computeGeoHash(): string {
    const p = this.params;
    return JSON.stringify([
      p.seed, p.iterations, p.angle, p.subBranchAngle, p.angleVariance,
      p.lengthScale, p.radiusScale, p.initialRadius, p.initialLength,
      p.whorlTaper, p.whorlMaxBranches, p.whorlBranchReduction,
      p.radialSegments, p.radialSegmentsDepthStep, p.lengthSubdivision,
      p.taperAmount, p.taperPower, p.trunkTaperEnabled, p.trunkTaperAmount, p.trunkTaperPower,
      p.contactFlare, p.contactFlareLength, p.tipRadius,
      p.barkNoiseAmount, p.barkNoiseFreq, p.barkNoiseOctaves,
      p.barkTwist, p.barkTwistNoise, p.barkTwistNoiseFreq,
      p.rootCount, p.rootLength, p.rootFlare, p.rootFlareHeight,
      p.rootGravity, p.rootHeight, p.rootSurfaceOffset,
      p.rootTaperAmount, p.rootTaperPower, p.rootKinkAngle, p.rootPitchAngle,
      p.rootPullDownRadius, p.rootPullDownStrength,
      p.subRootLevels, p.subRootCount, p.subRootScale,
      p.rootRadiusFraction, p.trunkExtension,
      p.tropismStrength, p.flattenBias, p.branchWeight, p.phototropism,
      p.kinkAngle, p.kinkVariance, p.kinkRestore, p.smartFitEnabled,
      p.branchJitter, p.branchMinPoints,
      p.collisionAvoidance, p.relaxIterations, p.relaxStrength, p.relaxRadius,
      p.capBranchTips, p.capRootTips, p.capTrunkBottom,
      p.weldEnabled, p.weldBlendRings, p.weldSurfaceOffset, p.weldMinRadiusRatio,
      p.vertexWeldEnabled,
    ]);
  }

  // ── Shader-accurate gust sampler (mirrors wind.glsl::computeGust) ──
  // Sampled at a few tree canopy positions each frame; the max drives audio.
  private sampleVisualGust(): number {
    const t = this.windTime;
    const wx = this.renderer.windDirection[0];
    const wz = this.renderer.windDirection[2];
    const hLen = Math.hypot(wx, wz) || 1;
    const wNx = wx / hLen, wNz = wz / hLen;
    const wPx = -wNz,      wPz = wNx;

    const whash = (x: number, y: number): number => {
      // Integer hash — mirrors GLSL _whash (no sin precision issues)
      const qx = (Math.floor(x) + 32768) | 0;
      const qy = (Math.floor(y) + 32768) | 0;
      let h = (Math.imul(qx, 1597334677) ^ Math.imul(qy, -482951495));
      h = Math.imul(h, -1640531527);
      h = h ^ (h >>> 16);
      return (h >>> 0) / 4294967296;
    };
    const wnoise = (px: number, py: number): number => {
      const ix = Math.floor(px), iy = Math.floor(py);
      let fx = px - ix, fy = py - iy;
      fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);   // quintic C2
      fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      const h00 = whash(ix, iy);
      const h10 = whash(ix + 1, iy);
      const h01 = whash(ix, iy + 1);
      const h11 = whash(ix + 1, iy + 1);
      return (h00 * (1 - fx) + h10 * fx) * (1 - fy)
           + (h01 * (1 - fx) + h11 * fx) * fy;
    };
    const wfbm = (px: number, py: number): number =>
      wnoise(px, py) * 0.50
      + wnoise(px * 2.13 + 5.3, py * 2.13 + 1.7) * 0.30
      + wnoise(px * 4.37 + 13.1, py * 4.37 + 7.3) * 0.20;

    // Sample canopy points: (x, y, z) triplets
    const pts: Array<[number, number, number]> = [
      [ 0, 5, 0],
      [ 3, 7, 1],
      [-3, 7, -1],
      [ 0, 9, 2],
    ];
    let maxG = 0;
    for (const [px, py, pz] of pts) {
      const along  = px * wNx + pz * wNz;
      const across = px * wPx + pz * wPz;
      const uvx = along * 0.008 - t * 0.18 + py * 0.003;
      const uvy = across * 0.006 + t * 0.04 + py * 0.003;
      let g = wfbm(uvx, uvy);
      if (g > maxG) maxG = g;
    }
    // Shader multiplies by windSpeed*gustStrength; do the same here.
    return maxG * this.params.windSpeed * this.params.gustStrength;
  }

  private updateSunPosition() {
    const az = (this.params.sunAzimuth * Math.PI) / 180;
    const el = (this.params.sunElevation * Math.PI) / 180;
    const dist = 25;
    const x = Math.cos(el) * Math.sin(az) * dist;
    const y = Math.sin(el) * dist;
    const z = Math.cos(el) * Math.cos(az) * dist;
    this.renderer.sunPosition = [x, y, z];
    this.renderer.sunColor = hexToLinearRGB(0xfff0dd);

    // Update gizmo sun direction (toward sun position)
    const len = Math.sqrt(x * x + y * y + z * z) || 1;
    this.renderer.gizmoSunDir = [x / len, y / len, z / len];
  }

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate);

    const now = performance.now();
    const delta = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Update wind
    this.windTime += delta;
    this.renderer.windTime = this.windTime;
    this.renderer.windSpeed = this.params.windSpeed;
    this.renderer.gustStrength = this.params.gustStrength;
    this.renderer.windBias = this.params.windBias;
    this.renderer.windVertDamp = this.params.windVerticalDamping;
    this.renderer.leafVertDamp = this.params.leafVerticalDamping;
    this.renderer.leafPushStrength = this.params.leafPushStrength;
    this.renderer.trunkStiffness = this.params.trunkStiffness;
    this.renderer.branchFlex = this.params.branchFlexibility;
    this.renderer.maxSway = this.params.maxSway;

    const wAz = (this.params.windAzimuth * Math.PI) / 180;
    const wEl = (this.params.windElevation * Math.PI) / 180;
    const wx = Math.cos(wEl) * Math.sin(wAz);
    const wy = Math.sin(wEl);
    const wz = Math.cos(wEl) * Math.cos(wAz);
    this.renderer.windDirection = [wx, wy, wz];

    // Update gizmo wind direction
    const wLen = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    this.renderer.gizmoWindDir = [wx / wLen, wy / wLen, wz / wLen];

    // Update sun position (so GUI changes take effect immediately)
    this.updateSunPosition();

    // Project tree target to NDC for scene-space audio panning
    const cam = this.renderer.camera;
    const t = cam.target;
    const m = cam.viewProjectionMatrix;
    const clipX = m[0] * t[0] + m[4] * t[1] + m[8]  * t[2] + m[12];
    const clipW = m[3] * t[0] + m[7] * t[1] + m[11] * t[2] + m[15];
    const ndcX = clipW !== 0 ? clipX / clipW : 0;

    // Sample the visual gust wavefront and scale it to match actual leaf
    // motion. Raw sample = smoothstep × windSpeed × gustStrength (range 0..15).
    // The visual DISPLACEMENT from a gust is proportional to this × windSpeed
    // (since base sway ∝ windSpeed and gust multiplies base), so normalizing
    // by the maximum possible raw gust (15) gives a value proportional to
    // actual motion: near-zero at low wind, full-scale only when the tree
    // is really moving.
    const gustSample = this.sampleVisualGust() / 15;

    // Update procedural audio engine
    this.audioEngine.update({
      windSpeed: this.params.windSpeed,
      gustStrength: this.params.gustStrength,
      windBias: this.params.windBias,
      gustSample,
      treeScreenX: ndcX,
      audioEnabled: this.params.audioEnabled,
      masterVolume: this.params.masterVolume,
      audioMute: this.params.audioMute,
      stereoWidth: this.params.stereoWidth,
      reverbMix: this.params.reverbMix,
      reverbRoomSize: this.params.reverbRoomSize,
      reverbDamping: this.params.reverbDamping,
      compressionAmount: this.params.compressionAmount,
      eqTilt: this.params.eqTilt,
      eqPresence: this.params.eqPresence,
      eqAir: this.params.eqAir,
      gustAttack: this.params.gustAttack,
      gustRelease: this.params.gustRelease,
      lowBandGain: this.params.lowBandGain,
      midBandGain: this.params.midBandGain,
      highBandGain: this.params.highBandGain,
      airBandGain: this.params.airBandGain,
    }, delta);

    this.renderer.render();
  };

  dispose() {
    cancelAnimationFrame(this.animationId);
    this.audioEngine.dispose();
    this.uiManager.dispose();
    this.renderer.dispose();
  }
}

