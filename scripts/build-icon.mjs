import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '../assets');

const SVG_PATH = path.join(ASSETS, 'icon.svg');
const PNG_SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

async function renderPng(svg, size, outFile) {
  await sharp(svg, { density: 384 })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outFile);
}

async function main() {
  const svg = readFileSync(SVG_PATH);

  // 1) Multi-size PNG
  for (const size of PNG_SIZES) {
    const out = path.join(ASSETS, size === 1024 ? 'icon.png' : `icon-${size}.png`);
    await renderPng(svg, size, out);
    console.log(`✓ ${path.basename(out)} (${size}x${size})`);
  }

  // 2) Windows .ico (multi-size embedded)
  const icoBuffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(svg, { density: 384 })
        .resize(size, size, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    ),
  );

  const icoBuf = await pngToIco(icoBuffers);
  const icoPath = path.join(ASSETS, 'icon.ico');
  writeFileSync(icoPath, icoBuf);
  console.log(`✓ icon.ico (${ICO_SIZES.join(', ')} embedded)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
