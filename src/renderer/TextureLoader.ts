/**
 * Loads images and creates WebGL2 textures with proper mipmap handling.
 * - Bark textures: tiling-correct mipmaps (3x3 tile, downsample, crop center)
 * - Leaf textures: standard mipmaps (clamped edges)
 */

/** Load an image from a URL, returning a promise that resolves when loaded. */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/** Create a WebGL2 texture from an image with optional sRGB, tiling mipmaps, and anisotropic filtering. */
export function createTexture(
  gl: WebGL2RenderingContext,
  image: HTMLImageElement,
  options: {
    srgb?: boolean;
    tiling?: boolean;
    anisotropy?: number;
  } = {},
): WebGLTexture {
  const { srgb = false, tiling = true, anisotropy = 8 } = options;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);

  const internalFormat = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
  const wrap = tiling ? gl.REPEAT : gl.CLAMP_TO_EDGE;

  if (tiling) {
    // Generate wrapping-correct mipmaps for tiling textures
    uploadTilingMipmaps(gl, image, internalFormat);
  } else {
    // Standard upload with auto-generated mipmaps
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Anisotropic filtering
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) {
    const maxAniso = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(anisotropy, maxAniso));
  }

  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/**
 * Create shadow depth texture for shadow mapping.
 */
export function createShadowTexture(gl: WebGL2RenderingContext, size: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, size, size, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Hardware depth comparison for sampler2DShadow
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/**
 * Tiling mipmap generation: tiles image 3x3, downscales, crops center tile.
 * This ensures edge averaging wraps correctly across tile boundaries.
 */
function uploadTilingMipmaps(
  gl: WebGL2RenderingContext,
  image: HTMLImageElement,
  internalFormat: number,
): void {
  // Level 0: original image
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, image);

  let w = image.width;
  let h = image.height;

  // Create initial canvas from image
  let prevCanvas = document.createElement('canvas');
  prevCanvas.width = w;
  prevCanvas.height = h;
  prevCanvas.getContext('2d')!.drawImage(image, 0, 0);

  let level = 1;
  while (w > 1 || h > 1) {
    const nextW = Math.max(1, w >> 1);
    const nextH = Math.max(1, h >> 1);

    // Tile 3x3
    const tiledCanvas = document.createElement('canvas');
    tiledCanvas.width = w * 3;
    tiledCanvas.height = h * 3;
    const tiledCtx = tiledCanvas.getContext('2d')!;
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        tiledCtx.drawImage(prevCanvas, tx * w, ty * h);
      }
    }

    // Downscale tiled image
    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = nextW * 3;
    scaledCanvas.height = nextH * 3;
    const scaledCtx = scaledCanvas.getContext('2d')!;
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = 'high';
    scaledCtx.drawImage(tiledCanvas, 0, 0, nextW * 3, nextH * 3);

    // Crop center tile
    const mipCanvas = document.createElement('canvas');
    mipCanvas.width = nextW;
    mipCanvas.height = nextH;
    mipCanvas.getContext('2d')!.drawImage(scaledCanvas, nextW, nextH, nextW, nextH, 0, 0, nextW, nextH);

    // Upload mip level
    gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, mipCanvas);

    prevCanvas = mipCanvas;
    w = nextW;
    h = nextH;
    level++;
  }
}
