// Rasterizes client/public/icons/icon.svg into the PWA icon PNGs.
//
//   Run from the repo root:  node client/scripts/generate-icons.mjs
//
// Produces (overwriting) in client/public/icons/:
//   - icon-192.png            192x192  standard mark
//   - icon-512.png            512x512  standard mark
//   - icon-maskable-512.png   512x512  mark scaled into the maskable safe zone
//   - apple-touch-icon.png    180x180  opaque background (iOS home screen)
//
// No new deps: `sharp` is already a server dependency and npm workspaces hoist it
// to the repo-root node_modules. If a future hoisting change breaks the bare
// import, run this script with `--prefix server` cwd or import from
// server/node_modules/sharp directly.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'public', 'icons');
const svgPath = join(iconsDir, 'icon.svg');

const baseSvg = await readFile(svgPath, 'utf8');

// Maskable variant: shrink the mark group into the inner safe circle (~72% of the
// full mark) while the gradient background keeps bleeding to every edge. Scale is
// applied about the icon centre (256,256) so the composition stays centred.
const MASKABLE_SCALE = 0.72;
const maskableSvg = baseSvg.replace(
  '<g id="mark">',
  `<g id="mark" transform="translate(256 256) scale(${MASKABLE_SCALE}) translate(-256 -256)">`,
);

async function render(svg, size, outFile, { flatten } = {}) {
  let pipeline = sharp(Buffer.from(svg), { density: 384 }).resize(size, size);
  // apple-touch icons must be fully opaque (iOS ignores transparency, some
  // launchers show a black matte); the squircle background already covers the
  // canvas, but flatten guarantees no stray alpha at the rounded corners.
  if (flatten) pipeline = pipeline.flatten({ background: '#5642e6' });
  const buf = await pipeline.png().toBuffer();
  await writeFile(join(iconsDir, outFile), buf);
  return buf.length;
}

const results = await Promise.all([
  render(baseSvg, 192, 'icon-192.png'),
  render(baseSvg, 512, 'icon-512.png'),
  render(maskableSvg, 512, 'icon-maskable-512.png'),
  render(baseSvg, 180, 'apple-touch-icon.png', { flatten: true }),
]);

const names = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
for (let i = 0; i < names.length; i++) {
  console.log(`  ${names[i].padEnd(24)} ${results[i]} bytes`);
}
console.log('Icons generated.');
