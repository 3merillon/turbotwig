export interface MeshAttribute {
  location: number; // explicit attribute location (matches layout(location=N) in shader)
  data: Float32Array;
  size: number; // components per vertex (1, 2, 3, 4)
}

/** Manages a VAO with vertex/index buffers for a single drawable mesh. */
export class GPUMesh {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  private ebo: WebGLBuffer | null = null;
  private indexType: number;
  readonly indexCount: number;
  readonly vertexCount: number;
  readonly drawMode: number;
  private attrLocations: number[];

  /** Create a GPU mesh from attribute arrays and optional index buffer. */
  constructor(
    gl: WebGL2RenderingContext,
    attributes: MeshAttribute[],
    indices?: Uint32Array | Uint16Array,
    mode?: number,
  ) {
    this.gl = gl;
    this.drawMode = mode ?? gl.TRIANGLES;
    this.attrLocations = attributes.map(a => a.location);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    for (const attr of attributes) {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, attr.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attr.location);
      gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, 0, 0);
      this.buffers.push(buf);
    }

    if (indices) {
      this.ebo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.indexCount = indices.length;
      this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    } else {
      this.indexCount = 0;
      this.indexType = 0;
    }

    this.vertexCount = attributes.length > 0 ? attributes[0].data.length / attributes[0].size : 0;
    gl.bindVertexArray(null);
  }

  private disposed = false;

  /** Bind the VAO and issue the draw call (indexed or array). */
  draw(): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.ebo) {
      gl.drawElements(this.drawMode, this.indexCount, this.indexType, 0);
    } else {
      gl.drawArrays(this.drawMode, 0, this.vertexCount);
    }
  }

  /** Update a buffer's data in-place (must match size). */
  updateAttribute(index: number, data: Float32Array): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[index]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  /** Replace the index buffer data. */
  updateIndices(indices: Uint32Array | Uint16Array): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (!this.ebo) {
      this.ebo = gl.createBuffer()!;
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    (this as { indexCount: number }).indexCount = indices.length;
    this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindVertexArray(null);
  }

  /** Delete the VAO and all associated buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const buf of this.buffers) gl.deleteBuffer(buf);
    if (this.ebo) gl.deleteBuffer(this.ebo);
  }
}
