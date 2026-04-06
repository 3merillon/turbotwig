/**
 * Generate normal maps for leaf cluster textures.
 *
 * Strategy: Convert to greyscale, apply strong Gaussian blur to remove
 * AI artifacts and capture only the broad leaf shape/veins, compute
 * Sobel gradients. Transparent areas get neutral normals.
 *
 * Usage: npx tsx scripts/generate-leaf-normals.ts [--strength 2.0] [--blur 3.0]
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LEAVES_DIR = path.resolve(__dirname, '..', 'public', 'textures', 'trees', 'leaves');

const config = {
  strength: parseFloat(getArg('--strength') ?? '2.0'),
  blur: parseFloat(getArg('--blur') ?? '3.0'),
};

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  console.log(`Leaf normal generator — strength: ${config.strength}, blur: ${config.blur}`);
  console.log();

  const leafFiles = findFiles(LEAVES_DIR, '.webp')
    .filter(f => !f.includes('_nrm'));

  console.log(`Found ${leafFiles.length} leaf textures.\n`);

  for (const leafPath of leafFiles) {
    const normalPath = leafPath.replace('.webp', '_nrm.webp');
    const basename = path.basename(leafPath, '.webp');
    process.stdout.write(`  ${basename}...`);

    try {
      await generateLeafNormal(leafPath, normalPath);
      console.log(' done');
    } catch (err) {
      console.log(` FAILED: ${err}`);
    }
  }

  console.log('\nAll done.');
}

async function generateLeafNormal(inputPath: string, outputPath: string) {
  const fileBuffer = fs.readFileSync(inputPath);
  const meta = await sharp(fileBuffer).metadata();
  const width = meta.width!;
  const height = meta.height!;

  // Step 1: Get greyscale as a proper image (not raw buffer math)
  // Using sharp's greyscale conversion avoids issues with raw buffer interpretation
  const greyBuf = await sharp(fileBuffer)
    .greyscale()
    .raw()
    .toBuffer();

  // Step 2: Get alpha channel
  const rgbaBuf = await sharp(fileBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer();

  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    alpha[i] = rgbaBuf[i * 4 + 3];
  }

  // Step 3: Fill transparent areas with mid-grey to prevent
  // alpha edges from creating Sobel artifacts.
  const filledBuf = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    filledBuf[i] = alpha[i] > 25 ? greyBuf[i] : 128;
  }

  // Step 4: Blur and force output to single channel greyscale
  const blurredRaw = await sharp(filledBuf, { raw: { width, height, channels: 1 } })
    .blur(config.blur)
    .greyscale()
    .raw()
    .toBuffer();
  // Ensure we have exactly width*height bytes (1 channel)
  const blurredBuf = blurredRaw.length === width * height
    ? blurredRaw
    : await sharp(blurredRaw, { raw: { width, height, channels: Math.round(blurredRaw.length / (width * height)) } })
        .greyscale().raw().toBuffer();

  // Step 5: Compute Sobel gradients
  const output = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;

      if (alpha[idx] < 25) {
        // Transparent — neutral normal, zero alpha
        output[idx * 4] = 128;
        output[idx * 4 + 1] = 128;
        output[idx * 4 + 2] = 255;
        output[idx * 4 + 3] = 0;
        continue;
      }

      const sample = (sx: number, sy: number) => {
        const cx = Math.max(0, Math.min(width - 1, sx));
        const cy = Math.max(0, Math.min(height - 1, sy));
        return blurredBuf[cy * width + cx] / 255;
      };

      const l  = sample(x - 1, y);
      const r  = sample(x + 1, y);
      const u  = sample(x, y - 1);
      const d  = sample(x, y + 1);
      const ul = sample(x - 1, y - 1);
      const ur = sample(x + 1, y - 1);
      const dl = sample(x - 1, y + 1);
      const dr = sample(x + 1, y + 1);

      const dx = ((ur + 2 * r + dr) - (ul + 2 * l + dl)) * config.strength;
      // Negate Y: image-space Y is down, OpenGL tangent-space Y is up
      const dy = -((dl + 2 * d + dr) - (ul + 2 * u + ur)) * config.strength;
      const dz = 1.0;

      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Negate X and Y to invert height: dark = low, bright = high
      output[idx * 4]     = Math.round(Math.max(0, Math.min(255, (-dx / len * 0.5 + 0.5) * 255)));
      output[idx * 4 + 1] = Math.round(Math.max(0, Math.min(255, (-dy / len * 0.5 + 0.5) * 255)));
      output[idx * 4 + 2] = Math.round(Math.max(0, Math.min(255, (dz / len * 0.5 + 0.5) * 255)));
      output[idx * 4 + 3] = alpha[idx];
    }
  }

  await sharp(output, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true })
    .toFile(outputPath);
}

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
