/** Compiles and links a vertex/fragment shader pair with cached uniform lookups. */
export class ShaderProgram {
  readonly program: WebGLProgram;
  private gl: WebGL2RenderingContext;
  private uniformCache = new Map<string, WebGLUniformLocation | null>();

  /** Compile and link a shader program from GLSL source strings. Throws on failure. */
  private label: string;

  constructor(gl: WebGL2RenderingContext, vertSrc: string, fragSrc: string, label?: string) {
    this.gl = gl;
    this.label = label ?? 'unknown';
    const vert = this.compile(gl.VERTEX_SHADER, vertSrc, label ? `${label}.vert` : undefined);
    const frag = this.compile(gl.FRAGMENT_SHADER, fragSrc, label ? `${label}.frag` : undefined);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vert);
    gl.attachShader(this.program, frag);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(this.program);
      gl.deleteProgram(this.program);
      throw new Error(`Shader link failed (${label ?? 'unknown'}): ${log}`);
    }
    gl.deleteShader(vert);
    gl.deleteShader(frag);
  }

  private compile(type: number, src: string, label?: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed (${label ?? 'unknown'}):\n${log}\n\nSource:\n${src}`);
    }
    return shader;
  }

  /** Bind this program as the active shader. */
  use(): void {
    this.gl.useProgram(this.program);
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.uniformCache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      if (!l && typeof console !== 'undefined') {
        console.warn(`[Shader] Uniform '${name}' not found in program '${this.label}'`);
      }
      this.uniformCache.set(name, l);
    }
    return l;
  }

  set1i(name: string, v: number): void { const l = this.loc(name); if (l) this.gl.uniform1i(l, v); }
  set1f(name: string, v: number): void { const l = this.loc(name); if (l) this.gl.uniform1f(l, v); }
  set2f(name: string, x: number, y: number): void { const l = this.loc(name); if (l) this.gl.uniform2f(l, x, y); }
  set3f(name: string, x: number, y: number, z: number): void { const l = this.loc(name); if (l) this.gl.uniform3f(l, x, y, z); }
  set4f(name: string, x: number, y: number, z: number, w: number): void { const l = this.loc(name); if (l) this.gl.uniform4f(l, x, y, z, w); }
  setMat4(name: string, m: Float32Array): void { const l = this.loc(name); if (l) this.gl.uniformMatrix4fv(l, false, m); }
  setMat3(name: string, m: Float32Array): void { const l = this.loc(name); if (l) this.gl.uniformMatrix3fv(l, false, m); }
  set3fv(name: string, v: Float32Array | number[]): void { const l = this.loc(name); if (l) this.gl.uniform3fv(l, v); }

  /** Delete the GL program. */
  dispose(): void {
    this.gl.deleteProgram(this.program);
  }
}
