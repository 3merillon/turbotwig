import { ShaderProgram } from './ShaderProgram';
import { GPUMesh, type MeshAttribute } from './GPUMesh';
import { OrbitCamera } from './OrbitCamera';
import { createTexture, createShadowTexture } from './TextureLoader';
import { mat4Ortho, mat4LookAt, mat4Multiply, mat4Perspective, mat4Invert, srgbToLinear } from './math';

// GLSL sources (imported via vite-plugin-glsl)
import barkVert from './shaders/bark.vert.glsl';
import barkFrag from './shaders/bark.frag.glsl';
import leafVert from './shaders/leaf.vert.glsl';
import leafFrag from './shaders/leaf.frag.glsl';
import depthVert from './shaders/depth.vert.glsl';
import depthFrag from './shaders/depth.frag.glsl';
import groundVert from './shaders/ground.vert.glsl';
import groundFrag from './shaders/ground.frag.glsl';
import lineVert from './shaders/line.vert.glsl';
import lineFrag from './shaders/line.frag.glsl';
import skyVert from './shaders/sky.vert.glsl';
import skyFrag from './shaders/sky.frag.glsl';
import wireVert from './shaders/wireframe.vert.glsl';
import wireLeafVert from './shaders/wireframe_leaf.vert.glsl';
import wireFrag from './shaders/wireframe.frag.glsl';

export interface BarkMeshData {
  positions: number[] | Float32Array;
  normals: number[] | Float32Array;
  tangents: number[] | Float32Array;
  uvs: number[] | Float32Array;
  indices: number[];
  heightWeights: number[] | Float32Array;
  depthWeights: number[] | Float32Array;
}

export interface LeafMeshData {
  positions: number[] | Float32Array;
  normals: number[] | Float32Array;
  uvs: number[] | Float32Array;
  indices: number[];
  heightWeights: number[] | Float32Array;
  depthWeights: number[] | Float32Array;
  leafPhases: number[] | Float32Array;
  branchAnchors: number[] | Float32Array;
}

/** Ensure data is Float32Array */
function toF32(data: number[] | Float32Array): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

// Shadow bias matrix: maps NDC [-1,1] to texture coords [0,1]
const SHADOW_BIAS_MATRIX = new Float32Array([
  0.5, 0, 0, 0,
  0, 0.5, 0, 0,
  0, 0, 0.5, 0,
  0.5, 0.5, 0.5, 1,
]);

/**
 * Main WebGL2 renderer for the Metree tree viewer. Manages shaders,
 * shadow maps, sky rendering, ground plane, and wind-animated tree meshes.
 */
export class WebGL2Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly camera: OrbitCamera;

  // Shader programs
  private barkProg!: ShaderProgram;
  private leafProg!: ShaderProgram;
  private depthProg!: ShaderProgram;
  private groundProg!: ShaderProgram;
  private lineProg!: ShaderProgram;
  private skyProg!: ShaderProgram;
  private wireBarkProg!: ShaderProgram;
  private wireLeafProg!: ShaderProgram;

  // Scene meshes
  private barkMesh: GPUMesh | null = null;
  private leafMesh: GPUMesh | null = null;
  private barkWireMesh: GPUMesh | null = null;
  private leafWireMesh: GPUMesh | null = null;
  private groundMesh!: GPUMesh;
  private gridMesh!: GPUMesh;
  private axisMesh!: GPUMesh;

  // Sky
  private skyVAO!: WebGLVertexArrayObject;

  // Shadow map
  private shadowFBO!: WebGLFramebuffer;
  private shadowTex!: WebGLTexture;
  private shadowMapSize = 2048;
  private shadowMatrix = new Float32Array(16);
  private shadowLightVP: Float32Array = new Float32Array(16);
  private lastShadowSunPos: [number, number, number] = [NaN, NaN, NaN];

  // Textures
  private barkDiffuseTex: WebGLTexture | null = null;
  private barkNormalTex: WebGLTexture | null = null;
  private barkAOTex: WebGLTexture | null = null;
  private barkGlossTex: WebGLTexture | null = null;
  private barkDisplacementTex: WebGLTexture | null = null;
  private leafDiffuseTex: WebGLTexture | null = null;
  private leafNormalTex: WebGLTexture | null = null;
  private dummyTex!: WebGLTexture; // 1x1 white texture to prevent sampler type mismatches

  // Render state
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private resizeObserver: ResizeObserver;
  private container: HTMLElement;

  // ── Public state ──

  // Background & fog
  backgroundColor: [number, number, number] = [0.102, 0.102, 0.180]; // sRGB 0-1
  fogColor: [number, number, number] = [0.0088, 0.0088, 0.027]; // linear RGB
  fogNear = 200;
  fogFar = 500;
  exposure = 1.6;

  // Atmospheric sky
  skyEnabled = true;
  skyRayleighScale = 1.0;
  skyMieScale = 1.0;
  skyMieAnisotropy = 0.65;
  skyRaySteps = 16;
  skyLightSteps = 4;
  skyGroundAlbedo: [number, number, number] = [0.627, 0.651, 0.565]; // sRGB, not linear
  private tintedGroundColor: [number, number, number] = [0.627, 0.651, 0.565];

  // Sun
  sunPosition: [number, number, number] = [8, 20, 12];
  sunColor: [number, number, number] = [1, 0.941, 0.867]; // 0xfff0dd linear
  sunIntensity = 4;
  shadowsEnabled = true;
  shadowBias = 0.0005;
  shadowNormalBias = 0.03;
  shadowSoftness = 4.0;
  shadowFadeStart = 15;
  shadowFadeEnd = 30;

  // Shadow camera
  shadowCameraNear = 0.5;
  shadowCameraFar = 80;
  shadowCameraLeft = -25;
  shadowCameraRight = 25;
  shadowCameraTop = 30;
  shadowCameraBottom = -5;

  // Hemisphere ambient
  skyColor: [number, number, number] = [0.439, 0.659, 0.878]; // 0xb0d0f0 linear
  groundAmbientColor: [number, number, number] = [0.128, 0.220, 0.072]; // 0x607050 linear
  ambientIntensity = 0.4;


  // Bark material
  barkColor: [number, number, number] = [1, 1, 1]; // linear
  barkRoughness = 0.85;
  barkNormalScale = 1.2;
  normalMappingEnabled = true;

  // Parallax occlusion mapping
  parallaxEnabled = true;
  parallaxScale = 0.04;
  parallaxSteps = 16;
  parallaxFadeNear = 15;
  parallaxFadeFar = 40;

  // Leaf material
  leafColor: [number, number, number] = [1, 1, 1]; // linear
  leafNormalScale = 0.8;
  leafSSSStrength = 0.1;
  showLeaves = true;

  // Wind
  windTime = 0;
  windSpeed = 1;
  windDirection: [number, number, number] = [1, 0, 0];
  gustStrength = 0.3;
  windBias = 0.5;
  windVertDamp = 0.95;
  leafVertDamp = 0;
  leafPushStrength = 0.5;
  trunkStiffness = 2;
  branchFlex = 0.5;
  maxSway = 3;

  // Display
  barkWire = false;
  leafWire = false;
  wireframeBarkColor: [number, number, number] = [0.0, 0.8, 1.0];
  wireframeLeafColor: [number, number, number] = [0.0, 1.0, 0.5];
  wireframeAlpha = 0.8;
  wireframeOnTop = false;
  debugView = 0;

  // Gizmo
  gizmoVisible = true;
  gizmoSunDir: [number, number, number] = [0, -1, 0];
  gizmoWindDir: [number, number, number] = [1, 0, 0];
  private gizmoLineMesh!: GPUMesh;
  private gizmoArrowMesh!: GPUMesh;
  private gizmoGridMesh!: GPUMesh;
  private gizmoSunMesh!: GPUMesh;
  private gizmoWindMesh!: GPUMesh;
  private gizmoSunPos = new Float32Array(6);
  private gizmoWindPos = new Float32Array(6);
  private gizmoOverlay!: HTMLDivElement;
  private gizmoLabels: Map<string, HTMLSpanElement> = new Map();

  /** True when the WebGL context has been lost and not yet restored. */
  contextLost = false;
  /** Optional callback invoked when context is lost. */
  onContextLost?: () => void;
  /** Optional callback invoked after context is restored and GPU resources rebuilt. */
  onContextRestored?: () => void;
  private contextLostHandler: (e: Event) => void;
  private contextRestoredHandler: () => void;

  /** Create a renderer and append a canvas to the given container element. */
  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    container.appendChild(this.canvas);

    const gl = this.canvas.getContext('webgl2', {
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;

    this.pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.camera = new OrbitCamera(this.canvas);

    this.initShaders();
    this.initShadowMap();
    this.initDummyTexture();
    this.initGroundGeometry();
    this.initGizmo();

    // GL state
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.depthFunc(gl.LEQUAL);

    // WebGL context loss handling
    this.contextLostHandler = (e: Event) => {
      e.preventDefault();
      this.contextLost = true;
      console.warn('[Renderer] WebGL context lost');
      this.onContextLost?.();
    };
    this.contextRestoredHandler = () => {
      console.info('[Renderer] WebGL context restored, rebuilding GPU resources');
      this.contextLost = false;
      this.initShaders();
      this.initShadowMap();
      this.initDummyTexture();
      this.initGroundGeometry();
      this.initGizmo();
      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.depthFunc(gl.LEQUAL);
      this.onContextRestored?.();
    };
    this.canvas.addEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.addEventListener('webglcontextrestored', this.contextRestoredHandler);

    // Resize
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(container);
    this.onResize();
  }

  private initShaders(): void {
    const gl = this.gl;
    this.barkProg = new ShaderProgram(gl, barkVert, barkFrag, 'bark');
    this.leafProg = new ShaderProgram(gl, leafVert, leafFrag, 'leaf');
    this.depthProg = new ShaderProgram(gl, depthVert, depthFrag, 'depth');
    this.groundProg = new ShaderProgram(gl, groundVert, groundFrag, 'ground');
    this.lineProg = new ShaderProgram(gl, lineVert, lineFrag, 'line');
    this.skyProg = new ShaderProgram(gl, skyVert, skyFrag, 'sky');
    this.wireBarkProg = new ShaderProgram(gl, wireVert, wireFrag, 'wireBark');
    this.wireLeafProg = new ShaderProgram(gl, wireLeafVert, wireFrag, 'wireLeaf');
    this.skyVAO = gl.createVertexArray()!; // empty — sky.vert uses gl_VertexID only
  }

  private initShadowMap(): void {
    const gl = this.gl;
    this.shadowTex = createShadowTexture(gl, this.shadowMapSize);
    this.shadowFBO = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Shadow FBO incomplete:', status);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private initDummyTexture(): void {
    const gl = this.gl;
    this.dummyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  private groundDiscRadius = 10;

  private initGroundGeometry(): void {
    const gl = this.gl;
    const R = this.groundDiscRadius;
    const cellSize = 2;

    // Large quad for shadow projection (extends well beyond the disc)
    const S = 100;
    const gPositions = new Float32Array([
      -S, 0, -S,
       S, 0, -S,
       S, 0,  S,
      -S, 0,  S,
    ]);
    const gUVs = new Float32Array([
      0, 0,  1, 0,  1, 1,  0, 1,
    ]);
    const gIndices = new Uint16Array([0, 2, 1, 0, 3, 2]);

    this.groundMesh = new GPUMesh(gl,
      [{ location: 0, data: gPositions, size: 3 },
       { location: 1, data: gUVs, size: 2 }],
      gIndices,
    );

    // Grid + circle outline + axis lines
    this.buildGridMesh(R, cellSize);
  }

  private buildGridMesh(R: number, cellSize: number): void {
    const gl = this.gl;
    const positions: number[] = [];
    const colors: number[] = [];
    const c = 0.85; // light grey
    const ag = 0.85; // axis negative grey

    // Grid lines centered on origin: ..., -4, -2, 2, 4, ...
    const maxLine = Math.floor(R / cellSize) * cellSize;
    for (let t = -maxLine; t <= maxLine; t += cellSize) {
      if (Math.abs(t) < 0.01) continue; // skip center (axis lines cover it)
      const span = Math.sqrt(R * R - t * t);
      positions.push(t, 0.01, -span, t, 0.01, span);
      colors.push(c, c, c, c, c, c);
      positions.push(-span, 0.01, t, span, 0.01, t);
      colors.push(c, c, c, c, c, c);
    }

    // Circle outline
    const circSegs = 64;
    for (let i = 0; i < circSegs; i++) {
      const a0 = (i / circSegs) * Math.PI * 2;
      const a1 = ((i + 1) / circSegs) * Math.PI * 2;
      positions.push(
        Math.cos(a0) * R, 0.01, Math.sin(a0) * R,
        Math.cos(a1) * R, 0.01, Math.sin(a1) * R,
      );
      colors.push(c, c, c, c, c, c);
    }

    this.gridMesh = new GPUMesh(gl,
      [{ location: 0, data: new Float32Array(positions), size: 3 },
       { location: 1, data: new Float32Array(colors), size: 3 }],
      undefined, gl.LINES,
    );

    // Axis lines (separate mesh so they stay opaque)
    const axisPos: number[] = [];
    const axisCol: number[] = [];
    axisPos.push(0, 0.02, 0, R, 0.02, 0);       // +X
    axisCol.push(1, 0.267, 0.267, 1, 0.267, 0.267);
    axisPos.push(0, 0.02, 0, 0, 0.02, R);        // +Z
    axisCol.push(0.267, 0.267, 1, 0.267, 0.267, 1);
    axisPos.push(0, 0.02, 0, -R, 0.02, 0);       // -X grey
    axisCol.push(ag, ag, ag, ag, ag, ag);
    axisPos.push(0, 0.02, 0, 0, 0.02, -R);       // -Z grey
    axisCol.push(ag, ag, ag, ag, ag, ag);

    this.axisMesh = new GPUMesh(gl,
      [{ location: 0, data: new Float32Array(axisPos), size: 3 },
       { location: 1, data: new Float32Array(axisCol), size: 3 }],
      undefined, gl.LINES,
    );
  }

  private initGizmo(): void {
    const gl = this.gl;
    const len = 1.2;
    const headLen = 0.25;
    const headR = 0.08;
    const segments = 8;

    // ── Lines (axis shafts) ──
    const negLen = 1.0;
    const g = 0.4; // grey, matching grid lines
    const linePos: number[] = [
      // Positive (colored, with arrowheads)
      0, 0, 0, len - headLen, 0, 0,
      0, 0, 0, 0, len - headLen, 0,
      0, 0, 0, 0, 0, len - headLen,
      // Negative (grey)
      0, 0, 0, -negLen, 0, 0,
      0, 0, 0, 0, 0, -negLen,
    ];
    const lineCol: number[] = [
      1, 0.267, 0.267, 1, 0.267, 0.267,
      0.267, 1, 0.267, 0.267, 1, 0.267,
      0.267, 0.267, 1, 0.267, 0.267, 1,
      g, g, g, g, g, g,
      g, g, g, g, g, g,
    ];
    this.gizmoLineMesh = new GPUMesh(gl,
      [{ location: 0, data: new Float32Array(linePos), size: 3 },
       { location: 1, data: new Float32Array(lineCol), size: 3 }],
      undefined, gl.LINES,
    );

    // ── Arrowhead cones (triangle fans as indexed triangles) ──
    const arrowPos: number[] = [];
    const arrowCol: number[] = [];
    const arrowIdx: number[] = [];

    const addCone = (
      tipX: number, tipY: number, tipZ: number,
      axisX: number, axisY: number, axisZ: number,
      r: number, g: number, b: number,
    ) => {
      const baseOff = arrowPos.length / 3;
      // tip vertex
      arrowPos.push(tipX, tipY, tipZ);
      arrowCol.push(r, g, b);

      // base center (tip - axis * headLen)
      const bx = tipX - axisX * headLen;
      const by = tipY - axisY * headLen;
      const bz = tipZ - axisZ * headLen;

      // Find two perpendicular vectors to the axis
      let px: number, py: number, pz: number;
      if (Math.abs(axisY) < 0.9) {
        // cross(axis, up)
        px = axisZ; py = 0; pz = -axisX;
      } else {
        // cross(axis, right)
        px = 0; py = -axisZ; pz = axisY;
      }
      const pLen = Math.sqrt(px * px + py * py + pz * pz) || 1;
      px /= pLen; py /= pLen; pz /= pLen;
      // q = cross(axis, p)
      const qx = axisY * pz - axisZ * py;
      const qy = axisZ * px - axisX * pz;
      const qz = axisX * py - axisY * px;

      // Ring vertices around base
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const cos = Math.cos(a) * headR;
        const sin = Math.sin(a) * headR;
        arrowPos.push(
          bx + px * cos + qx * sin,
          by + py * cos + qy * sin,
          bz + pz * cos + qz * sin,
        );
        arrowCol.push(r, g, b);
      }

      // Triangle fan indices (tip → ring)
      for (let i = 0; i < segments; i++) {
        arrowIdx.push(baseOff, baseOff + 1 + i, baseOff + 1 + i + 1);
      }
    };

    addCone(len, 0, 0, 1, 0, 0, 1, 0.267, 0.267);   // X red
    addCone(0, len, 0, 0, 1, 0, 0.267, 1, 0.267);    // Y green
    addCone(0, 0, len, 0, 0, 1, 0.267, 0.267, 1);    // Z blue

    this.gizmoArrowMesh = new GPUMesh(gl,
      [{ location: 0, data: new Float32Array(arrowPos), size: 3 },
       { location: 1, data: new Float32Array(arrowCol), size: 3 }],
      new Uint16Array(arrowIdx),
    );

    // ── Circular ground grid (matches scene: 5 cells per radius) ──
    {
      const gridPos: number[] = [];
      const gridCol: number[] = [];
      const gridR = 1.0;
      const cellSize = gridR / 5; // 5 cells per radius, matching ground
      const gc = 0.4;

      // Grid lines centered on origin
      const maxLine = Math.floor(gridR / cellSize) * cellSize;
      for (let t = -maxLine; t <= maxLine; t += cellSize) {
        if (Math.abs(t) < 0.001) continue;
        if (Math.abs(t) > gridR) continue;
        const span = Math.sqrt(gridR * gridR - t * t);
        gridPos.push(t, 0, -span, t, 0, span);
        gridCol.push(gc, gc, gc, gc, gc, gc);
        gridPos.push(-span, 0, t, span, 0, t);
        gridCol.push(gc, gc, gc, gc, gc, gc);
      }

      // Circle outline
      const circSegs = 48;
      for (let i = 0; i < circSegs; i++) {
        const a0 = (i / circSegs) * Math.PI * 2;
        const a1 = ((i + 1) / circSegs) * Math.PI * 2;
        gridPos.push(
          Math.cos(a0) * gridR, 0, Math.sin(a0) * gridR,
          Math.cos(a1) * gridR, 0, Math.sin(a1) * gridR,
        );
        gridCol.push(gc, gc, gc, gc, gc, gc);
      }

      this.gizmoGridMesh = new GPUMesh(gl,
        [{ location: 0, data: new Float32Array(gridPos), size: 3 },
         { location: 1, data: new Float32Array(gridCol), size: 3 }],
        undefined, gl.LINES,
      );
    }

    // ── HTML overlay for labels (no clipping issues, pointer-events transparent) ──
    this.gizmoOverlay = document.createElement('div');
    this.gizmoOverlay.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; overflow: visible;
    `;
    this.container.appendChild(this.gizmoOverlay);

    const makeLabel = (id: string, text: string, color: string): HTMLSpanElement => {
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText = `
        position: absolute; color: ${color};
        font: bold 13px Consolas, monospace;
        pointer-events: none; white-space: nowrap;
        transform: translate(-50%, -50%);
        text-shadow: 0 0 3px rgba(0,0,0,0.7);
      `;
      this.gizmoOverlay.appendChild(el);
      this.gizmoLabels.set(id, el);
      return el;
    };
    makeLabel('X', 'X', '#ff4444');
    makeLabel('Y', 'Y', '#44ff44');
    makeLabel('Z', 'Z', '#4444ff');
    makeLabel('sun', '\u2600', '#ffdd44');   // ☀
    makeLabel('wind', '\uD83D\uDCA8', '#44ddff'); // 💨

    // Pre-allocate reusable sun/wind direction line meshes (updated each frame via buffer update)
    const sunLineCol = new Float32Array([1, 0.867, 0.267, 1, 0.867, 0.267]);
    this.gizmoSunMesh = new GPUMesh(gl,
      [{ location: 0, data: new Float32Array(6), size: 3 }, { location: 1, data: sunLineCol, size: 3 }],
      undefined, gl.LINES,
    );
    const windLineCol = new Float32Array([0.267, 0.867, 1, 0.267, 0.867, 1]);
    this.gizmoWindMesh = new GPUMesh(gl,
      [{ location: 0, data: new Float32Array(6), size: 3 }, { location: 1, data: windLineCol, size: 3 }],
      undefined, gl.LINES,
    );
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.width = w * this.pixelRatio;
    this.height = h * this.pixelRatio;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.setAspect(w / h);
    // Re-render immediately to avoid blank frame flash
    this.render();
  }

  // ── Edge extraction for wireframe ──

  /** Convert triangle indices to unique edge (line) indices. */
  private static trianglesToEdges(indices: number[] | Uint32Array): Uint32Array {
    const edgeSet = new Set<string>();
    const lineIndices: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const edges: [number, number][] = [[a, b], [b, c], [c, a]];
      for (const [v0, v1] of edges) {
        const lo = Math.min(v0, v1);
        const hi = Math.max(v0, v1);
        const key = lo + ':' + hi;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          lineIndices.push(v0, v1);
        }
      }
    }
    return new Uint32Array(lineIndices);
  }

  // ── Mesh upload ──

  /** Upload bark geometry to the GPU, replacing any existing bark mesh. */
  uploadBarkMesh(data: BarkMeshData): void {
    if (this.barkMesh) this.barkMesh.dispose();
    if (this.barkWireMesh) { this.barkWireMesh.dispose(); this.barkWireMesh = null; }
    const gl = this.gl;
    const attrs: MeshAttribute[] = [
      { location: 0, data: toF32(data.positions), size: 3 },
      { location: 1, data: toF32(data.normals), size: 3 },
      { location: 2, data: toF32(data.tangents), size: 4 },
      { location: 3, data: toF32(data.uvs), size: 2 },
      { location: 4, data: toF32(data.heightWeights), size: 1 },
      { location: 5, data: toF32(data.depthWeights), size: 1 },
    ];
    this.barkMesh = new GPUMesh(gl, attrs, new Uint32Array(data.indices));
    this.buildBarkWireMesh(data);
  }

  private buildBarkWireMesh(data: BarkMeshData): void {
    const gl = this.gl;
    const edgeIndices = WebGL2Renderer.trianglesToEdges(data.indices);
    this.barkWireMesh = new GPUMesh(gl, [
      { location: 0, data: toF32(data.positions), size: 3 },
      { location: 4, data: toF32(data.heightWeights), size: 1 },
      { location: 5, data: toF32(data.depthWeights), size: 1 },
    ], edgeIndices, gl.LINES);
  }

  /** Upload leaf geometry to the GPU, replacing any existing leaf mesh. */
  uploadLeafMesh(data: LeafMeshData): void {
    if (this.leafMesh) this.leafMesh.dispose();
    if (this.leafWireMesh) { this.leafWireMesh.dispose(); this.leafWireMesh = null; }
    const gl = this.gl;
    const attrs: MeshAttribute[] = [
      { location: 0, data: toF32(data.positions), size: 3 },
      { location: 1, data: toF32(data.normals), size: 3 },
      { location: 3, data: toF32(data.uvs), size: 2 },
      { location: 4, data: toF32(data.heightWeights), size: 1 },
      { location: 5, data: toF32(data.depthWeights), size: 1 },
      { location: 6, data: toF32(data.leafPhases), size: 1 },
      { location: 7, data: toF32(data.branchAnchors), size: 3 },
    ];
    this.leafMesh = new GPUMesh(gl, attrs, new Uint32Array(data.indices));
    this.buildLeafWireMesh(data);
  }

  private buildLeafWireMesh(data: LeafMeshData): void {
    const gl = this.gl;
    const edgeIndices = WebGL2Renderer.trianglesToEdges(data.indices);
    this.leafWireMesh = new GPUMesh(gl, [
      { location: 0, data: toF32(data.positions), size: 3 },
      { location: 1, data: toF32(data.normals), size: 3 },
      { location: 3, data: toF32(data.uvs), size: 2 },
      { location: 4, data: toF32(data.heightWeights), size: 1 },
      { location: 5, data: toF32(data.depthWeights), size: 1 },
      { location: 6, data: toF32(data.leafPhases), size: 1 },
    ], edgeIndices, gl.LINES);
  }

  /** Dispose and remove the current bark mesh from the scene. */
  removeBarkMesh(): void {
    if (this.barkMesh) { this.barkMesh.dispose(); this.barkMesh = null; }
    if (this.barkWireMesh) { this.barkWireMesh.dispose(); this.barkWireMesh = null; }
  }

  /** Dispose and remove the current leaf mesh from the scene. */
  removeLeafMesh(): void {
    if (this.leafMesh) { this.leafMesh.dispose(); this.leafMesh = null; }
    if (this.leafWireMesh) { this.leafWireMesh.dispose(); this.leafWireMesh = null; }
  }

  // ── Texture upload ──

  /** Set bark material textures (diffuse, normal, AO, gloss). Pass null to clear a slot. */
  setBarkTextures(
    diffuse: HTMLImageElement | null,
    normal: HTMLImageElement | null,
    ao: HTMLImageElement | null,
    gloss: HTMLImageElement | null,
    displacement: HTMLImageElement | null = null,
  ): void {
    const gl = this.gl;
    if (this.barkDiffuseTex) gl.deleteTexture(this.barkDiffuseTex);
    if (this.barkNormalTex) gl.deleteTexture(this.barkNormalTex);
    if (this.barkAOTex) gl.deleteTexture(this.barkAOTex);
    if (this.barkGlossTex) gl.deleteTexture(this.barkGlossTex);
    if (this.barkDisplacementTex) gl.deleteTexture(this.barkDisplacementTex);

    this.barkDiffuseTex = diffuse ? createTexture(gl, diffuse, { srgb: true, tiling: true, anisotropy: 16 }) : null;
    this.barkNormalTex = normal ? createTexture(gl, normal, { srgb: false, tiling: true, anisotropy: 16 }) : null;
    this.barkAOTex = ao ? createTexture(gl, ao, { srgb: false, tiling: true }) : null;
    this.barkGlossTex = gloss ? createTexture(gl, gloss, { srgb: false, tiling: true }) : null;
    this.barkDisplacementTex = displacement ? createTexture(gl, displacement, { srgb: false, tiling: true, anisotropy: 16 }) : null;
  }

  /** Set leaf material textures (diffuse, normal). Pass null to clear a slot. */
  setLeafTextures(
    diffuse: HTMLImageElement | null,
    normal: HTMLImageElement | null,
  ): void {
    const gl = this.gl;
    if (this.leafDiffuseTex) gl.deleteTexture(this.leafDiffuseTex);
    if (this.leafNormalTex) gl.deleteTexture(this.leafNormalTex);

    this.leafDiffuseTex = diffuse ? createTexture(gl, diffuse, { srgb: true, tiling: false }) : null;
    this.leafNormalTex = normal ? createTexture(gl, normal, { srgb: false, tiling: false }) : null;
  }

  /** Update bark mesh in-place (for welding). */
  updateBarkMeshData(data: BarkMeshData): void {
    if (!this.barkMesh) return;
    this.barkMesh.updateAttribute(0, toF32(data.positions));
    this.barkMesh.updateAttribute(1, toF32(data.normals));
    this.barkMesh.updateAttribute(2, toF32(data.tangents));
    this.barkMesh.updateAttribute(3, toF32(data.uvs));
    this.barkMesh.updateAttribute(4, toF32(data.heightWeights));
    this.barkMesh.updateAttribute(5, toF32(data.depthWeights));
    this.barkMesh.updateIndices(new Uint32Array(data.indices));
    // Rebuild wireframe mesh with new topology
    if (this.barkWireMesh) { this.barkWireMesh.dispose(); this.barkWireMesh = null; }
    this.buildBarkWireMesh(data);
  }

  // ── Shadow matrix computation ──

  private computeShadowMatrix(): void {
    // Skip recomputation if sun position hasn't changed
    const sp = this.sunPosition;
    if (sp[0] === this.lastShadowSunPos[0] && sp[1] === this.lastShadowSunPos[1] && sp[2] === this.lastShadowSunPos[2]) return;
    this.lastShadowSunPos[0] = sp[0]; this.lastShadowSunPos[1] = sp[1]; this.lastShadowSunPos[2] = sp[2];

    const lightPos: [number, number, number] = [sp[0], sp[1], sp[2]];
    const lightView = mat4LookAt(lightPos, [0, 0, 0], [0, 1, 0]);
    const lightProj = mat4Ortho(
      this.shadowCameraLeft, this.shadowCameraRight,
      this.shadowCameraBottom, this.shadowCameraTop,
      this.shadowCameraNear, this.shadowCameraFar,
    );
    const lightVP = mat4Multiply(lightProj, lightView);
    this.shadowLightVP = lightVP;
    const sm = mat4Multiply(SHADOW_BIAS_MATRIX, lightVP);
    this.shadowMatrix.set(sm);
  }

  // ── Uniform helpers ──

  private setWindUniforms(prog: ShaderProgram): void {
    prog.set1f('uTime', this.windTime);
    prog.set1f('uWindSpeed', this.windSpeed);
    prog.set3f('uWindDir', this.windDirection[0], this.windDirection[1], this.windDirection[2]);
    prog.set1f('uGustStrength', this.gustStrength);
    prog.set1f('uWindBias', this.windBias);
    prog.set1f('uWindVertDamp', this.windVertDamp);
    prog.set1f('uTrunkStiffness', this.trunkStiffness);
    prog.set1f('uBranchFlex', this.branchFlex);
    prog.set1f('uMaxSway', this.maxSway);
  }

  /** Atmospheric transmittance: fraction of sunlight surviving at current elevation */
  private atmosphericTransmittance(): [number, number, number] {
    const sp = this.sunPosition;
    const sLen = Math.sqrt(sp[0] * sp[0] + sp[1] * sp[1] + sp[2] * sp[2]);
    const sinElev = sp[1] / sLen;

    // Rayleigh + Mie extinction along the sun's path through the atmosphere
    // At low angles, the path is much longer (airmass approximation)
    const betaR = [5.8e-6, 13.6e-6, 33.1e-6]; // match sky shader
    const betaM = 21e-6;
    const H_R = 8000;
    const H_M = 1200;

    // Optical depth for a vertical column
    const odR = betaR.map(b => b * H_R);
    const odM = betaM * H_M;

    // Airmass: 1/sin(elev), clamped to avoid extremes at horizon
    const airmass = 1.0 / Math.max(sinElev, 0.06);

    const r = Math.exp(-(odR[0] + odM * 1.1) * airmass * this.skyRayleighScale);
    const g = Math.exp(-(odR[1] + odM * 1.1) * airmass * this.skyRayleighScale);
    const b = Math.exp(-(odR[2] + odM * 1.1) * airmass * this.skyRayleighScale);

    // Blend toward neutral (1,1,1) to keep the effect subtle
    const strength = 0.95;
    return [
      1.0 - (1.0 - r) * strength,
      1.0 - (1.0 - g) * strength,
      1.0 - (1.0 - b) * strength,
    ];
  }

  private setLightUniforms(prog: ShaderProgram): void {
    const sp = this.sunPosition;
    const sLen = Math.sqrt(sp[0] * sp[0] + sp[1] * sp[1] + sp[2] * sp[2]);
    prog.set3f('uSunDir', sp[0] / sLen, sp[1] / sLen, sp[2] / sLen);

    // Tint sun color by atmospheric transmittance
    const atmo = this.atmosphericTransmittance();
    prog.set3f('uSunColor',
      this.sunColor[0] * atmo[0],
      this.sunColor[1] * atmo[1],
      this.sunColor[2] * atmo[2],
    );
    prog.set1f('uSunIntensity', this.sunIntensity);

    // Tint hemisphere ambient by atmosphere too
    prog.set3f('uSkyColor',
      this.skyColor[0] * atmo[0],
      this.skyColor[1] * atmo[1],
      this.skyColor[2] * atmo[2],
    );
    prog.set3f('uGroundColor', this.groundAmbientColor[0], this.groundAmbientColor[1], this.groundAmbientColor[2]);
    prog.set1f('uAmbientIntensity', this.ambientIntensity);


    // Shadow
    prog.set1i('uShadowsEnabled', this.shadowsEnabled ? 1 : 0);
    prog.set1f('uShadowBias', this.shadowBias);
    prog.set1f('uShadowMapSize', this.shadowMapSize);
    prog.set1f('uShadowSoftness', this.shadowSoftness);
    prog.setMat4('uShadowMatrix', this.shadowMatrix);

    // Fog
    prog.set3f('uFogColor', this.fogColor[0], this.fogColor[1], this.fogColor[2]);
    prog.set1f('uFogNear', this.fogNear);
    prog.set1f('uFogFar', this.fogFar);

    // Exposure
    prog.set1f('uExposure', this.exposure);
  }

  private bindShadowTexture(prog: ShaderProgram, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    prog.set1i('uShadowMap', unit);
  }

  // ── Render ──

  /** Render a full frame: shadow pass, sky, ground, bark, leaves, wireframes, and gizmos. */
  render(): void {
    if (this.contextLost) return;
    const gl = this.gl;
    this.camera.update();
    this.computeShadowMatrix();

    const vp = this.camera.viewProjectionMatrix;
    const view = this.camera.viewMatrix;

    this.renderShadowPass(gl);
    this.renderMainPassSetup(gl);
    this.renderSkyPass(gl, vp);
    this.renderBarkPass(gl, vp, view);
    this.renderLeafPass(gl, vp, view);
    this.renderWireframePass(gl, vp);
    this.renderGroundPass(gl, vp, view);

    // Gizmo
    this.gizmoOverlay.style.display = this.gizmoVisible ? '' : 'none';
    if (this.gizmoVisible) this.renderGizmo();

    gl.bindVertexArray(null);
  }

  // ── Render pass methods ──

  private renderShadowPass(gl: WebGL2RenderingContext): void {
    if (!this.shadowsEnabled) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.viewport(0, 0, this.shadowMapSize, this.shadowMapSize);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);

    this.depthProg.use();
    this.depthProg.setMat4('uLightVP', this.shadowLightVP);
    this.setWindUniforms(this.depthProg);
    this.depthProg.set1f('uLeafVertDamp', this.leafVertDamp);
    this.depthProg.set1f('uLeafPush', this.leafPushStrength);

    if (this.barkMesh) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.dummyTex);
      this.depthProg.set1i('uDiffuseMap', 0);
      this.depthProg.set1i('uIsLeaf', 0);
      this.depthProg.set1i('uAlphaTest', 0);
      this.barkMesh.draw();
    }

    if (this.leafMesh && this.showLeaves) {
      this.depthProg.set1i('uIsLeaf', 1);
      this.depthProg.set1i('uAlphaTest', this.leafDiffuseTex ? 1 : 0);
      if (this.leafDiffuseTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.leafDiffuseTex);
        this.depthProg.set1i('uDiffuseMap', 0);
      }
      this.leafMesh.draw();
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.CULL_FACE);
  }

  private renderMainPassSetup(gl: WebGL2RenderingContext): void {
    gl.viewport(0, 0, this.width, this.height);
    const bg = this.backgroundColor;
    gl.clearColor(bg[0], bg[1], bg[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  private renderSkyPass(gl: WebGL2RenderingContext, vp: Float32Array): void {
    if (!this.skyEnabled) return;

    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    this.skyProg.use();
    const invVP = mat4Invert(vp);
    this.skyProg.setMat4('uInvViewProjection', invVP);
    this.skyProg.set3f('uCameraPos', ...this.camera.position);

    const sp = this.sunPosition;
    const sLen = Math.sqrt(sp[0] * sp[0] + sp[1] * sp[1] + sp[2] * sp[2]);
    this.skyProg.set3f('uSunDir', sp[0] / sLen, sp[1] / sLen, sp[2] / sLen);

    this.skyProg.set1f('uRayleighScale', this.skyRayleighScale);
    this.skyProg.set1f('uMieScale', this.skyMieScale);
    this.skyProg.set1f('uMieAnisotropy', this.skyMieAnisotropy);
    this.skyProg.set1i('uRaySteps', this.skyRaySteps);
    this.skyProg.set1i('uLightSteps', this.skyLightSteps);
    this.skyProg.set1f('uExposure', this.exposure);

    const atmo = this.atmosphericTransmittance();
    const maxC = Math.max(atmo[0], atmo[1], atmo[2], 0.01);
    const tint: [number, number, number] = [atmo[0] / maxC, atmo[1] / maxC, atmo[2] / maxC];
    this.tintedGroundColor = [
      this.skyGroundAlbedo[0] * tint[0],
      this.skyGroundAlbedo[1] * tint[1],
      this.skyGroundAlbedo[2] * tint[2],
    ];
    this.skyProg.set3f('uGroundAlbedo', ...this.tintedGroundColor);

    gl.bindVertexArray(this.skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);

    this.updateFogFromSky();
  }

  private renderBarkPass(gl: WebGL2RenderingContext, vp: Float32Array, view: Float32Array): void {
    if (!this.barkMesh) return;

    this.barkProg.use();
    this.barkProg.setMat4('uViewProjection', vp);
    this.barkProg.setMat4('uViewMatrix', view);
    this.barkProg.setMat4('uShadowMatrix', this.shadowMatrix);
    this.barkProg.set1f('uShadowNormalBias', this.shadowNormalBias);
    this.barkProg.set3f('uCameraPos', ...this.camera.position);
    this.barkProg.set3f('uColor', 1.0, 1.0, 1.0);
    this.barkProg.set1f('uRoughness', this.barkRoughness);
    this.barkProg.set1f('uNormalScale', this.normalMappingEnabled ? this.barkNormalScale : 0);
    this.barkProg.set1i('uDebugMode', this.debugView);
    this.setWindUniforms(this.barkProg);
    this.setLightUniforms(this.barkProg);

    let texUnit = 0;
    const bindTex = (uniform: string, tex: WebGLTexture | null, hasUniform: string): void => {
      if (tex) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        this.barkProg.set1i(uniform, texUnit);
        this.barkProg.set1i(hasUniform, 1);
        texUnit++;
      } else {
        this.barkProg.set1i(hasUniform, 0);
      }
    };
    bindTex('uDiffuseMap', this.barkDiffuseTex, 'uHasDiffuse');
    bindTex('uNormalMap', this.normalMappingEnabled ? this.barkNormalTex : null, 'uHasNormal');
    bindTex('uAOMap', this.barkAOTex, 'uHasAO');
    bindTex('uGlossMap', this.barkGlossTex, 'uHasGloss');
    bindTex('uDisplacementMap', this.parallaxEnabled ? this.barkDisplacementTex : null, 'uHasDisplacement');
    this.barkProg.set1i('uParallaxEnabled', this.parallaxEnabled ? 1 : 0);
    this.barkProg.set1f('uParallaxScale', this.parallaxScale);
    this.barkProg.set1f('uParallaxSteps', this.parallaxSteps);
    this.barkProg.set1f('uParallaxFadeNear', this.parallaxFadeNear);
    this.barkProg.set1f('uParallaxFadeFar', this.parallaxFadeFar);
    this.bindShadowTexture(this.barkProg, texUnit);

    this.barkMesh.draw();
  }

  private renderLeafPass(gl: WebGL2RenderingContext, vp: Float32Array, view: Float32Array): void {
    if (!this.leafMesh || !this.showLeaves) return;

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);

    this.leafProg.use();
    this.leafProg.setMat4('uViewProjection', vp);
    this.leafProg.setMat4('uViewMatrix', view);
    this.leafProg.setMat4('uShadowMatrix', this.shadowMatrix);
    this.leafProg.set1f('uShadowNormalBias', this.shadowNormalBias);
    this.leafProg.set3f('uCameraPos', ...this.camera.position);
    this.leafProg.set3f('uColor', 1.0, 1.0, 1.0);
    this.leafProg.set1f('uNormalScale', this.normalMappingEnabled ? this.leafNormalScale : 0);
    this.leafProg.set3f('uSubsurfaceColor', srgbToLinear(0x4a / 255), srgbToLinear(0x8a / 255), srgbToLinear(0x2a / 255));
    this.leafProg.set1f('uSubsurfaceStrength', this.leafSSSStrength);
    this.setWindUniforms(this.leafProg);
    this.leafProg.set1f('uLeafVertDamp', this.leafVertDamp);
    this.leafProg.set1f('uLeafPush', this.leafPushStrength);
    this.setLightUniforms(this.leafProg);

    let texUnit = 0;
    if (this.leafDiffuseTex) {
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, this.leafDiffuseTex);
      this.leafProg.set1i('uDiffuseMap', texUnit);
      this.leafProg.set1i('uHasDiffuse', 1);
      texUnit++;
    } else {
      this.leafProg.set1i('uHasDiffuse', 0);
    }
    if (this.leafNormalTex && this.normalMappingEnabled) {
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, this.leafNormalTex);
      this.leafProg.set1i('uNormalMap', texUnit);
      this.leafProg.set1i('uHasNormal', 1);
      texUnit++;
    } else {
      this.leafProg.set1i('uHasNormal', 0);
    }
    this.bindShadowTexture(this.leafProg, texUnit);

    this.leafMesh.draw();

    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.enable(gl.CULL_FACE);
  }

  private renderWireframePass(gl: WebGL2RenderingContext, vp: Float32Array): void {
    if (!this.barkWire && !this.leafWire) return;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    if (this.wireframeOnTop) gl.depthFunc(gl.ALWAYS);

    if (this.barkWire && this.barkWireMesh) {
      this.wireBarkProg.use();
      this.wireBarkProg.setMat4('uViewProjection', vp);
      this.setWindUniforms(this.wireBarkProg);
      this.wireBarkProg.set3f('uWireColor', ...this.wireframeBarkColor);
      this.wireBarkProg.set1f('uWireAlpha', this.wireframeAlpha);
      this.barkWireMesh.draw();
    }

    if (this.leafWire && this.leafWireMesh && this.showLeaves) {
      this.wireLeafProg.use();
      this.wireLeafProg.setMat4('uViewProjection', vp);
      this.setWindUniforms(this.wireLeafProg);
      this.wireLeafProg.set1f('uLeafVertDamp', this.leafVertDamp);
      this.wireLeafProg.set1f('uLeafPush', this.leafPushStrength);
      this.wireLeafProg.set3f('uWireColor', ...this.wireframeLeafColor);
      this.wireLeafProg.set1f('uWireAlpha', this.wireframeAlpha);
      this.leafWireMesh.draw();
    }

    if (this.wireframeOnTop) gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  private renderGroundPass(gl: WebGL2RenderingContext, vp: Float32Array, view: Float32Array): void {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    this.groundProg.use();
    this.groundProg.setMat4('uViewProjection', vp);
    this.groundProg.setMat4('uViewMatrix', view);
    this.groundProg.setMat4('uShadowMatrix', this.shadowMatrix);
    this.groundProg.set3f('uColor', this.tintedGroundColor[0], this.tintedGroundColor[1], this.tintedGroundColor[2]);
    this.groundProg.set1f('uOpacity', 0.8);
    this.groundProg.set1f('uDiscRadius', this.groundDiscRadius);
    this.groundProg.set1i('uShadowsEnabled', this.shadowsEnabled ? 1 : 0);
    this.groundProg.set1f('uShadowBias', this.shadowBias);
    this.groundProg.set1f('uShadowMapSize', this.shadowMapSize);
    this.groundProg.set1f('uShadowSoftness', this.shadowSoftness);
    this.groundProg.set1f('uShadowFadeStart', this.shadowFadeStart);
    this.groundProg.set1f('uShadowFadeEnd', this.shadowFadeEnd);
    this.bindShadowTexture(this.groundProg, 0);

    // Pass 1: shadows outside disc (double-sided)
    gl.disable(gl.CULL_FACE);
    this.groundProg.set1i('uDiscPass', 0);
    this.groundMesh.draw();

    // Pass 2: disc with shadow (front-face only)
    gl.enable(gl.CULL_FACE);
    this.groundProg.set1i('uDiscPass', 1);
    this.groundMesh.draw();

    // Grid lines + axis lines
    gl.disable(gl.CULL_FACE);
    this.lineProg.use();
    this.lineProg.setMat4('uViewProjection', vp);
    this.lineProg.set1f('uAlpha', 0.15);
    this.gridMesh.draw();
    this.lineProg.set1f('uAlpha', 0.35);
    this.axisMesh.draw();

    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
  }

  /** Project a 3D gizmo point to 2D canvas pixel coords. */
  private gizmoProject(
    x: number, y: number, z: number,
    vpMatrix: Float32Array, canvasSize: number,
  ): [number, number] {
    // Multiply by VP
    const cx = vpMatrix[0] * x + vpMatrix[4] * y + vpMatrix[8] * z + vpMatrix[12];
    const cy = vpMatrix[1] * x + vpMatrix[5] * y + vpMatrix[9] * z + vpMatrix[13];
    const cw = vpMatrix[3] * x + vpMatrix[7] * y + vpMatrix[11] * z + vpMatrix[15];
    // NDC to canvas
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return [
      (ndcX * 0.5 + 0.5) * canvasSize,
      (1 - (ndcY * 0.5 + 0.5)) * canvasSize,
    ];
  }

  private renderGizmo(): void {
    const gl = this.gl;
    const gizmoSize = 150 * this.pixelRatio;

    // Viewport in top-left corner (WebGL origin is bottom-left)
    const x = 8 * this.pixelRatio;
    const y = this.height - gizmoSize - 8 * this.pixelRatio;

    gl.viewport(x, y, gizmoSize, gizmoSize);
    gl.scissor(x, y, gizmoSize, gizmoSize);
    gl.enable(gl.SCISSOR_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // Gizmo camera: follow main camera rotation at fixed distance
    const dx = this.camera.position[0] - this.camera.target[0];
    const dy = this.camera.position[1] - this.camera.target[1];
    const dz = this.camera.position[2] - this.camera.target[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const camDist = 4;
    const gizmoEye: [number, number, number] = [dx / dist * camDist, dy / dist * camDist, dz / dist * camDist];
    const gizmoView = mat4LookAt(gizmoEye, [0, 0, 0], [0, 1, 0]);
    const gizmoProj = mat4Perspective(50 * Math.PI / 180, 1, 0.1, 100);
    const gizmoVP = mat4Multiply(gizmoProj, gizmoView);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Draw ground grid
    this.lineProg.use();
    this.lineProg.setMat4('uViewProjection', gizmoVP);
    this.lineProg.set1f('uAlpha', 0.35);
    this.gizmoGridMesh.draw();

    // Draw axis lines
    this.lineProg.set1f('uAlpha', 1.0);
    this.gizmoLineMesh.draw();

    // Draw arrowhead cones
    this.gizmoArrowMesh.draw();

    // Dynamic sun direction line (yellow) — update cached mesh positions
    const sunLen = 1.5;
    this.gizmoSunPos[0] = 0; this.gizmoSunPos[1] = 0; this.gizmoSunPos[2] = 0;
    this.gizmoSunPos[3] = this.gizmoSunDir[0] * sunLen;
    this.gizmoSunPos[4] = this.gizmoSunDir[1] * sunLen;
    this.gizmoSunPos[5] = this.gizmoSunDir[2] * sunLen;
    this.gizmoSunMesh.updateAttribute(0, this.gizmoSunPos);
    this.gizmoSunMesh.draw();

    // Dynamic wind source line (cyan) — update cached mesh positions
    const windLen = 1.3;
    this.gizmoWindPos[0] = 0; this.gizmoWindPos[1] = 0; this.gizmoWindPos[2] = 0;
    this.gizmoWindPos[3] = -this.gizmoWindDir[0] * windLen;
    this.gizmoWindPos[4] = -this.gizmoWindDir[1] * windLen;
    this.gizmoWindPos[5] = -this.gizmoWindDir[2] * windLen;
    this.gizmoWindMesh.updateAttribute(0, this.gizmoWindPos);
    this.gizmoWindMesh.draw();

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.width, this.height);

    // ── Position HTML labels ──
    const gizmoPx = 150; // CSS size of the gizmo viewport
    const gizmoLeft = 8;
    const gizmoTop = 8;

    const posLabel = (id: string, wx: number, wy: number, wz: number) => {
      const el = this.gizmoLabels.get(id);
      if (!el) return;
      // Project 3D → gizmo viewport pixel
      const [px, py] = this.gizmoProject(wx, wy, wz, gizmoVP, gizmoPx);
      el.style.left = (gizmoLeft + px) + 'px';
      el.style.top = (gizmoTop + py) + 'px';
    };

    const labelOffset = 1.55;
    posLabel('X', labelOffset, 0, 0);
    posLabel('Y', 0, labelOffset, 0);
    posLabel('Z', 0, 0, labelOffset);
    posLabel('sun',
      this.gizmoSunDir[0] * (sunLen + 0.3),
      this.gizmoSunDir[1] * (sunLen + 0.3),
      this.gizmoSunDir[2] * (sunLen + 0.3),
    );
    posLabel('wind',
      -this.gizmoWindDir[0] * (windLen + 0.3),
      -this.gizmoWindDir[1] * (windLen + 0.3),
      -this.gizmoWindDir[2] * (windLen + 0.3),
    );
  }

  // ── Helpers ──

  get resolution(): [number, number] {
    return [this.container.clientWidth, this.container.clientHeight];
  }

  private updateFogFromSky(): void {
    const sp = this.sunPosition;
    const sLen = Math.sqrt(sp[0] * sp[0] + sp[1] * sp[1] + sp[2] * sp[2]);
    const sunElev = Math.asin(sp[1] / sLen);

    const betaR = [5.5e-6, 13.0e-6, 22.4e-6];
    const pathLen = 40000;
    const depthScale = Math.min(1.0 / Math.max(sunElev, 0.05), 10.0);

    const r = Math.exp(-betaR[0] * pathLen * depthScale);
    const g = Math.exp(-betaR[1] * pathLen * depthScale);
    const b = Math.exp(-betaR[2] * pathLen * depthScale);

    // Scattered light approximation
    this.fogColor = [
      this.sunColor[0] * (1 - r) * 0.3 * this.skyRayleighScale,
      this.sunColor[1] * (1 - g) * 0.3 * this.skyRayleighScale,
      this.sunColor[2] * (1 - b) * 0.3 * this.skyRayleighScale,
    ];
  }

  /** Release all GPU resources, event listeners, and DOM elements. */
  dispose(): void {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.contextLostHandler);
    this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredHandler);
    this.resizeObserver.disconnect();
    this.camera.dispose();

    this.barkProg.dispose();
    this.leafProg.dispose();
    this.depthProg.dispose();
    this.groundProg.dispose();
    this.lineProg.dispose();
    this.skyProg.dispose();
    this.wireBarkProg.dispose();
    this.wireLeafProg.dispose();
    gl.deleteVertexArray(this.skyVAO);

    if (this.barkMesh) this.barkMesh.dispose();
    if (this.leafMesh) this.leafMesh.dispose();
    if (this.barkWireMesh) this.barkWireMesh.dispose();
    if (this.leafWireMesh) this.leafWireMesh.dispose();
    this.groundMesh.dispose();
    this.gridMesh.dispose();
    this.axisMesh.dispose();
    this.gizmoLineMesh.dispose();
    this.gizmoArrowMesh.dispose();
    this.gizmoGridMesh.dispose();
    this.gizmoSunMesh.dispose();
    this.gizmoWindMesh.dispose();
    if (this.gizmoOverlay.parentNode) this.gizmoOverlay.remove();

    gl.deleteFramebuffer(this.shadowFBO);
    gl.deleteTexture(this.shadowTex);
    gl.deleteTexture(this.dummyTex);
    if (this.barkDiffuseTex) gl.deleteTexture(this.barkDiffuseTex);
    if (this.barkNormalTex) gl.deleteTexture(this.barkNormalTex);
    if (this.barkAOTex) gl.deleteTexture(this.barkAOTex);
    if (this.barkGlossTex) gl.deleteTexture(this.barkGlossTex);
    if (this.barkDisplacementTex) gl.deleteTexture(this.barkDisplacementTex);
    if (this.leafDiffuseTex) gl.deleteTexture(this.leafDiffuseTex);
    if (this.leafNormalTex) gl.deleteTexture(this.leafNormalTex);

    this.canvas.remove();
  }
}
