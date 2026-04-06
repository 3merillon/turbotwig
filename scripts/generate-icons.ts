/**
 * Generate branded icons from the TurboTwig wind-tree logo SVG.
 *
 * Output:
 *   public/favicon.svg              — vector, used by all modern browsers
 *   public/favicon-16.png           — legacy tab icon
 *   public/favicon-32.png           — legacy tab icon (HiDPI)
 *   public/apple-touch-icon.png     — 180×180, iOS home screen
 *   public/icon-512.png             — PWA / large share thumbnails
 *
 * Usage:
 *   npx tsx scripts/generate-icons.ts
 */
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC = path.resolve(__dirname, '..', 'public');

const BG = '#1a1a2e';
const ACCENT = '#4fc3f7';

// The wind-tree icon in a 24×24 viewBox (matches index.html splash, static pose).
function iconMarkup(strokeScale = 1): string {
  const s = (w: number) => (w * strokeScale).toFixed(2);
  return `
    <g stroke="${ACCENT}" stroke-linecap="round" fill="none">
      <line x1="12" y1="22" x2="12" y2="5" stroke-width="${s(2.2)}"/>
      <path d="M12 7 Q9 5 4 3.5" stroke-width="${s(1.8)}"/>
      <path d="M12 7 Q15 5 20 3.5" stroke-width="${s(1.8)}"/>
      <circle cx="4" cy="3.5" r="0.8" fill="${ACCENT}" stroke="none" opacity="0.55"/>
      <circle cx="20" cy="3.5" r="0.8" fill="${ACCENT}" stroke="none" opacity="0.55"/>
      <path d="M12 14 Q9.5 12 6 10.5" stroke-width="${s(1.4)}"/>
      <path d="M12 14 Q14.5 12 18 10.5" stroke-width="${s(1.4)}"/>
      <circle cx="6" cy="10.5" r="0.6" fill="${ACCENT}" stroke="none" opacity="0.45"/>
      <circle cx="18" cy="10.5" r="0.6" fill="${ACCENT}" stroke="none" opacity="0.45"/>
    </g>`;
}

/**
 * Build an SVG sized `px` with a dark rounded-square background and the
 * icon inset by `padRatio` (e.g. 0.15 = 15% padding on each side).
 * For small sizes we thicken the strokes so lines don't vanish at 16×16.
 */
function buildSvg(px: number, padRatio: number, strokeScale: number, radiusRatio: number): string {
  const pad = px * padRatio;
  const inner = px - pad * 2;
  const r = px * radiusRatio;
  const glowBlur = Math.max(1, px * 0.02);
  return `
<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="${glowBlur}"/>
    </filter>
  </defs>
  <rect x="0" y="0" width="${px}" height="${px}" rx="${r}" ry="${r}" fill="${BG}"/>
  <g transform="translate(${pad}, ${pad}) scale(${inner / 24})">
    <g filter="url(#glow)" opacity="0.55">${iconMarkup(strokeScale)}</g>
    ${iconMarkup(strokeScale)}
  </g>
</svg>`;
}

/**
 * Standalone favicon.svg — square, transparent corners (rx=0 feels too harsh
 * in browser tabs at 16px, so we use a subtle rounded dark tile).
 */
function buildStandaloneSvg(): string {
  return buildSvg(32, 0.18, 1.05, 0.15).replace(/width="32" height="32"/, 'width="32" height="32"');
}

interface Target {
  name: string;
  px: number;
  padRatio: number;
  strokeScale: number;
  radiusRatio: number;
}

const targets: Target[] = [
  { name: 'favicon-16.png',       px: 16,  padRatio: 0.12, strokeScale: 1.35, radiusRatio: 0.18 },
  { name: 'favicon-32.png',       px: 32,  padRatio: 0.15, strokeScale: 1.15, radiusRatio: 0.16 },
  { name: 'apple-touch-icon.png', px: 180, padRatio: 0.18, strokeScale: 1.00, radiusRatio: 0.22 },
  { name: 'icon-512.png',         px: 512, padRatio: 0.18, strokeScale: 1.00, radiusRatio: 0.22 },
];

async function main() {
  // 1) Vector favicon
  const svgPath = path.join(PUBLIC, 'favicon.svg');
  fs.writeFileSync(svgPath, buildStandaloneSvg().trim() + '\n');
  console.log(`✓ Wrote ${svgPath}`);

  // 2) PNG rasters
  for (const t of targets) {
    const svg = buildSvg(t.px, t.padRatio, t.strokeScale, t.radiusRatio);
    const out = path.join(PUBLIC, t.name);
    await sharp(Buffer.from(svg), { density: 384 })
      .resize(t.px, t.px)
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`✓ Wrote ${out}  (${t.px}×${t.px})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
