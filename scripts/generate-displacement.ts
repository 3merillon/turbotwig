/**
 * Displacement / height map generator for bark textures.
 *
 * Pipeline:
 * 1. Load albedo, convert to greyscale
 * 2. Make greyscale perfectly tileable (half-offset cross-fade)
 * 3. Multi-octave tiled blur to build height field
 * 4. Contrast normalization (percentile stretch + gamma)
 * 5. Edge re-blend for perfect tiling continuity
 * 6. Save as lossless webp
 *
 * Convention: bright = ridge (high), dark = crack (low).
 *
 * Usage:
 *   npx tsx scripts/generate-displacement.ts [--contrast 1.5] [--gamma 0.8]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BARK_DIR = path.resolve(__dirname, '..', 'public', 'textures', 'trees', 'bark');

const config = {
  contrast: parseFloat(getArg('--contrast') ?? '1.5'),
  gamma: parseFloat(getArg('--gamma') ?? '0.7'),
  octaves: parseInt(getArg('--octaves') ?? '3'),
  baseBlur: parseFloat(getArg('--base-blur') ?? '12.0'),
  octaveWeights: [0.25, 0.40, 0.35],
  blendWidth: parseFloat(getArg('--blend') ?? '0.15'),
  finalSmooth: parseFloat(getArg('--smooth') ?? '6.0'),
};

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  console.log(`Displacement map generator — contrast: ${config.contrast}, gamma: ${config.gamma}, octaves: ${config.octaves}, blend: ${config.blendWidth}`);
  console.log();

  const albedoFiles = findFiles(BARK_DIR, '_alb.webp');
  console.log(`Found ${albedoFiles.length} albedo textures.\n`);

  for (const albedoPath of albedoFiles) {
    const outputPath = albedoPath.replace('_alb.webp', '_disp.webp');
    const basename = path.basename(albedoPath, '_alb.webp');
    process.stdout.write(`  ${basename}...`);

    try {
      await generateDisplacementMap(albedoPath, outputPath);
      console.log(' done');
    } catch (err) {
      console.log(` FAILED: ${err}`);
    }
  }

  console.log('\nAll done.');
}

// ============================================================
// Generate displacement map
// ============================================================

async function generateDisplacementMap(albedoPath: string, outputPath: string) {
  const fileBuffer = fs.readFileSync(albedoPath);
  const image = sharp(fileBuffer);
  const meta = await image.metadata();
  const width = meta.width!;
  const height = meta.height!;

  // Step 1: Convert to greyscale float [0,1]
  const greyBuf = await image.greyscale().raw().toBuffer();
  let grey = new Float32Array(width * height);
  for (let i = 0; i < grey.length; i++) {
    grey[i] = greyBuf[i] / 255;
  }

  // Step 2: Make tileable
  grey = makeTileableChannel(grey, width, height, config.blendWidth);

  // Step 3: Multi-octave tiled blur to build height field
  const heightField = new Float32Array(width * height);

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

    // Blur the tiled image
    // Sharp .blur() silently expands 1-channel to 3-channel.
    // Force back to greyscale with .greyscale() to get 1-channel output.
    const sigma = Math.max(0.3, blurRadius * 0.5);
    const blurredTiledBuf = blurRadius >= 0.5
      ? await sharp(tiledBuf, { raw: { width: tw, height: th, channels: 1 } })
          .blur(sigma).greyscale().raw().toBuffer()
      : tiledBuf;

    const expectedLen = tw * th;
    if (blurredTiledBuf.length !== expectedLen) {
      throw new Error(`Blur output wrong size: got ${blurredTiledBuf.length}, expected ${expectedLen}`);
    }

    // Crop center tile and accumulate
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const tiledIdx = (height + y) * tw + (width + x);
        heightField[idx] += (blurredTiledBuf[tiledIdx] / 255) * weight;
      }
    }
  }

  // Step 4: Contrast normalization — percentile stretch + gamma
  const sorted = Float32Array.from(heightField).sort();
  const p5 = sorted[Math.floor(sorted.length * 0.05)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const range = p95 - p5 || 1;

  for (let i = 0; i < heightField.length; i++) {
    let h = (heightField[i] - p5) / range;
    h = Math.max(0, Math.min(1, h));
    h = Math.pow(h, config.gamma);
    heightField[i] = h;
  }

  // Step 5: Final tiled smooth pass to remove remaining high-frequency noise
  if (config.finalSmooth >= 0.5) {
    const tw = width * 3;
    const th = height * 3;
    const tiledBuf = Buffer.alloc(tw * th);
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            tiledBuf[(ty * height + y) * tw + (tx * width + x)] =
              Math.round(Math.max(0, Math.min(255, heightField[y * width + x] * 255)));
          }
        }
      }
    }
    const sigma = Math.max(0.3, config.finalSmooth * 0.5);
    const smoothed = await sharp(tiledBuf, { raw: { width: tw, height: th, channels: 1 } })
      .blur(sigma).greyscale().raw().toBuffer();
    if (smoothed.length === tw * th) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          heightField[y * width + x] = smoothed[(height + y) * tw + (width + x)] / 255;
        }
      }
    }
  }

  // Step 6: Edge re-blend for perfect tiling after contrast enhancement
  const bw = Math.max(4, Math.floor(width * config.blendWidth));
  const bh = Math.max(4, Math.floor(height * config.blendWidth));

  // Horizontal: make col 0 match col width-1
  for (let y = 0; y < height; y++) {
    for (let b = 0; b < bw; b++) {
      const t = b / bw;
      const s = t * t * (3 - 2 * t); // smoothstep
      const left = y * width + b;
      const right = y * width + (width - 1 - b);
      const avg = (heightField[left] + heightField[right]) * 0.5;
      heightField[left]  = heightField[left]  * s + avg * (1 - s);
      heightField[right] = heightField[right] * s + avg * (1 - s);
    }
  }
  // Vertical: make row 0 match row height-1
  for (let x = 0; x < width; x++) {
    for (let b = 0; b < bh; b++) {
      const t = b / bh;
      const s = t * t * (3 - 2 * t);
      const top = b * width + x;
      const bot = (height - 1 - b) * width + x;
      const avg = (heightField[top] + heightField[bot]) * 0.5;
      heightField[top] = heightField[top] * s + avg * (1 - s);
      heightField[bot] = heightField[bot] * s + avg * (1 - s);
    }
  }

  // Step 7: Encode to uint8 and save as lossless webp
  const output = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    output[i] = Math.round(Math.max(0, Math.min(255, heightField[i] * 255)));
  }

  await sharp(output, { raw: { width, height, channels: 1 } })
    .webp({ lossless: true })
    .toFile(outputPath);
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
