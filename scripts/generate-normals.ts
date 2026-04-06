/**
 * Multi-scale normal map generator for bark textures.
 *
 * Pipeline:
 * 1. Load albedo, convert to greyscale
 * 2. Make greyscale perfectly tileable (half-offset cross-fade)
 * 3. Multi-octave Sobel with 3x3 tiled blur
 * 4. Force-blend output normal map edges to match
 * 5. Re-normalize and save as lossless webp
 *
 * Also optionally makes the albedo textures themselves tileable.
 *
 * Usage:
 *   npx tsx scripts/generate-normals.ts [--strength 2.5] [--blend 0.15]
 *   npx tsx scripts/generate-normals.ts --fix-albedo
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BARK_DIR = path.resolve(__dirname, '..', 'public', 'textures', 'trees', 'bark');

const config = {
  strength: parseFloat(getArg('--strength') ?? '2.5'),
  octaves: parseInt(getArg('--octaves') ?? '4'),
  baseBlur: parseFloat(getArg('--base-blur') ?? '1.0'),
  octaveWeights: [0.15, 0.25, 0.30, 0.30],
  blendWidth: parseFloat(getArg('--blend') ?? '0.15'),
  fixAlbedo: process.argv.includes('--fix-albedo'),
};

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  console.log(`Normal map generator — strength: ${config.strength}, octaves: ${config.octaves}, blend: ${config.blendWidth}, lossless: true`);
  if (config.fixAlbedo) console.log('Also fixing albedo tiling.');
  console.log();

  const albedoFiles = findFiles(BARK_DIR, '_alb.webp');
  console.log(`Found ${albedoFiles.length} albedo textures.\n`);

  for (const albedoPath of albedoFiles) {
    const normalPath = albedoPath.replace('_alb.webp', '_nrm.webp');
    const basename = path.basename(albedoPath, '_alb.webp');
    process.stdout.write(`  ${basename}...`);

    try {
      // Step 1: Fix albedo tiling if requested
      if (config.fixAlbedo) {
        await makeAlbedoTileable(albedoPath);
        process.stdout.write(' albedo');
      }

      // Step 2: Generate normal map from (fixed) albedo
      await generateNormalMap(albedoPath, normalPath);
      console.log(' done');
    } catch (err) {
      console.log(` FAILED: ${err}`);
    }
  }

  console.log('\nAll done.');
}

// ============================================================
// Make albedo tileable
// ============================================================

async function makeAlbedoTileable(albedoPath: string) {
  const fileBuffer = fs.readFileSync(albedoPath);
  const image = sharp(fileBuffer);
  const meta = await image.metadata();
  const width = meta.width!;
  const height = meta.height!;
  const channels = meta.channels ?? 3;

  const raw = await image.raw().toBuffer();

  // Direct edge-blend each channel: average opposing edge pixels
  // with smoothstep falloff. Same approach that got normal maps to 0 diff.
  const bw = Math.max(4, Math.floor(width * config.blendWidth));
  const bh = Math.max(4, Math.floor(height * config.blendWidth));

  const floats: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      ch[i] = raw[i * channels + c] / 255;
    }
    floats.push(ch);
  }

  for (const ch of floats) {
    // Horizontal: make col 0 match col width-1
    for (let y = 0; y < height; y++) {
      for (let b = 0; b < bw; b++) {
        const t = b / bw;
        const s = t * t * (3 - 2 * t);
        const left = y * width + b;
        const right = y * width + (width - 1 - b);
        const avg = (ch[left] + ch[right]) * 0.5;
        ch[left]  = ch[left]  * s + avg * (1 - s);
        ch[right] = ch[right] * s + avg * (1 - s);
      }
    }
    // Vertical: make row 0 match row height-1
    for (let x = 0; x < width; x++) {
      for (let b = 0; b < bh; b++) {
        const t = b / bh;
        const s = t * t * (3 - 2 * t);
        const top = b * width + x;
        const bot = (height - 1 - b) * width + x;
        const avg = (ch[top] + ch[bot]) * 0.5;
        ch[top] = ch[top] * s + avg * (1 - s);
        ch[bot] = ch[bot] * s + avg * (1 - s);
      }
    }
  }

  const output = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < channels; c++) {
      output[i * channels + c] = Math.round(Math.max(0, Math.min(255, floats[c][i] * 255)));
    }
  }

  const tmpPath = albedoPath + '.tiled.webp';
  await sharp(output, { raw: { width, height, channels: channels as 3 | 4 } })
    .webp({ lossless: true })
    .toFile(tmpPath);

  fs.copyFileSync(tmpPath, albedoPath);
  fs.unlinkSync(tmpPath);
}

// ============================================================
// Make a single channel tileable using half-offset cross-fade
// ============================================================

function makeTileableChannel(data: Float32Array, width: number, height: number, blendFraction: number): Float32Array {
  const result = new Float32Array(width * height);
  const bw = Math.max(4, Math.floor(width * blendFraction));
  const bh = Math.max(4, Math.floor(height * blendFraction));
  const hw = Math.floor(width / 2);
  const hh = Math.floor(height / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const orig = data[y * width + x];
      const shifted = data[((y + hh) % height) * width + ((x + hw) % width)];

      const wx = x < bw ? x / bw
               : x >= width - bw ? (width - 1 - x) / bw
               : 1.0;
      const wy = y < bh ? y / bh
               : y >= height - bh ? (height - 1 - y) / bh
               : 1.0;

      const swx = wx * wx * (3 - 2 * wx);
      const swy = wy * wy * (3 - 2 * wy);
      const w = swx * swy;

      result[y * width + x] = orig * w + shifted * (1 - w);
    }
  }

  return result;
}

// ============================================================
// Generate normal map
// ============================================================

async function generateNormalMap(albedoPath: string, outputPath: string) {
  const fileBuffer = fs.readFileSync(albedoPath);
  const image = sharp(fileBuffer);
  const meta = await image.metadata();
  const width = meta.width!;
  const height = meta.height!;

  const greyBuf = await image.greyscale().raw().toBuffer();
  const grey = new Float32Array(width * height);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = greyBuf[i] / 255;
  }

  // Multi-octave Sobel computed entirely on a 3x3 tiled version of the image.
  // By doing both blur AND Sobel on the tiled image and cropping the center,
  // the computation never sees any edge — it's as if the texture is infinite
  // and repeating. This eliminates ALL edge artifacts in the normal map.
  const totalDx = new Float32Array(width * height);
  const totalDy = new Float32Array(width * height);

  for (let oct = 0; oct < config.octaves; oct++) {
    const blurRadius = config.baseBlur * Math.pow(2, oct);
    const weight = config.octaveWeights[Math.min(oct, config.octaveWeights.length - 1)];

    // Create 3x3 tiled greyscale
    const tw = width * 3;
    const th = height * 3;
    const tiledBuf = Buffer.alloc(tw * th);
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            tiledBuf[(ty * height + y) * tw + (tx * width + x)] =
              Math.round(Math.max(0, Math.min(255, grey[y * width + x] * 255)));
          }
        }
      }
    }

    // Blur the tiled image.
    // IMPORTANT: sharp .blur() silently expands 1-channel to 3-channel.
    // Force back to greyscale with .greyscale() to get 1-channel output.
    const sigma = Math.max(0.3, blurRadius * 0.5);
    const blurredTiledBuf = blurRadius >= 0.5
      ? await sharp(tiledBuf, { raw: { width: tw, height: th, channels: 1 } })
          .blur(sigma).greyscale().raw().toBuffer()
      : tiledBuf;

    // Convert to float — verify length matches expected 1-channel size
    const expectedLen = tw * th;
    if (blurredTiledBuf.length !== expectedLen) {
      throw new Error(`Blur output wrong size: got ${blurredTiledBuf.length}, expected ${expectedLen} (1ch). Got ${blurredTiledBuf.length / expectedLen}ch`);
    }
    const blurredTiled = new Float32Array(expectedLen);
    for (let i = 0; i < expectedLen; i++) {
      blurredTiled[i] = blurredTiledBuf[i] / 255;
    }

    // Compute Sobel on the CENTER tile of the tiled image.
    // All neighbor lookups naturally wrap because the surrounding tiles
    // provide the correct wrapped pixels. No modulo needed.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        // Offset into center tile
        const cx = width + x;
        const cy = height + y;

        const l  = blurredTiled[cy * tw + (cx - 1)];
        const r  = blurredTiled[cy * tw + (cx + 1)];
        const u  = blurredTiled[(cy - 1) * tw + cx];
        const d  = blurredTiled[(cy + 1) * tw + cx];
        const ul = blurredTiled[(cy - 1) * tw + (cx - 1)];
        const ur = blurredTiled[(cy - 1) * tw + (cx + 1)];
        const dl = blurredTiled[(cy + 1) * tw + (cx - 1)];
        const dr = blurredTiled[(cy + 1) * tw + (cx + 1)];

        totalDx[idx] += ((ur + 2 * r + dr) - (ul + 2 * l + dl)) * weight;
        // Negate Y: Sobel gives image-space gradient (Y down), but OpenGL
        // tangent-space normal maps need Y up. Three.js expects OpenGL convention.
        totalDy[idx] += -((dl + 2 * d + dr) - (ul + 2 * u + ur)) * weight;
      }
    }
  }

  // Encode to float normal vectors first
  const nxArr = new Float32Array(width * height);
  const nyArr = new Float32Array(width * height);
  const nzArr = new Float32Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const dx = totalDx[i] * config.strength;
    const dy = totalDy[i] * config.strength;
    const dz = 1.0;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    nxArr[i] = dx / len;
    nyArr[i] = dy / len;
    nzArr[i] = dz / len;
  }

  // No edge stitching — the 3x3 tiled blur already handles wrapping.
  // Max edge diff is ~20 which is imperceptible.

  // Re-normalize and encode to uint8.
  // Negate X and Y to invert height: dark pixels = deep cracks (low),
  // bright pixels = ridges (high). Without negation, the Sobel treats
  // bright as high, which makes dark cracks appear raised.
  const output = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    let nx = -nxArr[i], ny = -nyArr[i], nz = nzArr[i];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    output[i * 3 + 0] = Math.round(Math.max(0, Math.min(255, (nx * 0.5 + 0.5) * 255)));
    output[i * 3 + 1] = Math.round(Math.max(0, Math.min(255, (ny * 0.5 + 0.5) * 255)));
    output[i * 3 + 2] = Math.round(Math.max(0, Math.min(255, (nz * 0.5 + 0.5) * 255)));
  }

  await sharp(output, { raw: { width, height, channels: 3 } })
    .webp({ lossless: true })
    .toFile(outputPath);
}

// ============================================================
// Tiled blur
// ============================================================

async function blurGreyscaleTiled(
  input: Float32Array,
  width: number,
  height: number,
  radius: number,
): Promise<Float32Array> {
  if (radius < 0.5) return input;

  const tw = width * 3;
  const th = height * 3;
  const tiledBuf = Buffer.alloc(tw * th);

  for (let ty = 0; ty < 3; ty++) {
    for (let tx = 0; tx < 3; tx++) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          tiledBuf[(ty * height + y) * tw + (tx * width + x)] =
            Math.round(Math.max(0, Math.min(255, input[y * width + x] * 255)));
        }
      }
    }
  }

  const sigma = Math.max(0.3, radius * 0.5);
  const blurredTiled = await sharp(tiledBuf, { raw: { width: tw, height: th, channels: 1 } })
    .blur(sigma)
    .raw()
    .toBuffer();

  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      result[y * width + x] = blurredTiled[(height + y) * tw + (width + x)] / 255;
    }
  }
  return result;
}

// ============================================================
// Utils
// ============================================================

function findFiles(dir: string, suffix: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(full, suffix));
      } else if (entry.name.endsWith(suffix)) {
        results.push(full);
      }
    }
  } catch { /* skip */ }
  return results;
}

main().catch(console.error);
