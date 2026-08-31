// Genera los íconos PWA (PNG reales) rasterizando un SVG coherente con el
// favicon: cuadrado rojo FIREtech (#F00728) redondeado con "F" blanca bold.
//
// Uso (una sola vez, desde frontend/):
//   npm run icons        (o: node scripts/generate-icons.mjs)
//
// Escribe en public/:
//   icon-192.png, icon-512.png            → manifest (purpose: any)
//   icon-maskable-192.png, -512.png       → manifest (purpose: maskable,
//                                            glifo reducido a la zona segura)
//   apple-touch-icon.png (180)            → iOS home screen (sin esquinas
//                                            redondeadas: iOS las aplica)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const RED = '#F00728';
const WHITE = '#FFFFFF';

/**
 * SVG del ícono a viewBox 100x100.
 * @param {object} opts
 * @param {number} opts.radius  radio de esquina (0 = cuadrado pleno)
 * @param {number} opts.glyph   tamaño de la "F" (font-size en unidades viewBox)
 */
function iconSvg({ radius, glyph }) {
  const baseline = 50 + glyph * 0.355; // centrado óptico de la "F" bold
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${radius}" fill="${RED}"/>
  <text x="50" y="${baseline}" text-anchor="middle"
        font-family="Arial,Helvetica,sans-serif" font-weight="bold"
        font-size="${glyph}" fill="${WHITE}">F</text>
</svg>`;
}

// - normal: esquinas redondeadas como el favicon (rx 7/32 ≈ 22)
// - maskable: lienzo completo (el SO recorta), glifo en la zona segura (80%)
// - apple: cuadrado pleno, iOS redondea por su cuenta
const VARIANTS = [
  { file: 'icon-192.png', size: 192, svg: iconSvg({ radius: 22, glyph: 66 }) },
  { file: 'icon-512.png', size: 512, svg: iconSvg({ radius: 22, glyph: 66 }) },
  { file: 'icon-maskable-192.png', size: 192, svg: iconSvg({ radius: 0, glyph: 52 }) },
  { file: 'icon-maskable-512.png', size: 512, svg: iconSvg({ radius: 0, glyph: 52 }) },
  { file: 'apple-touch-icon.png', size: 180, svg: iconSvg({ radius: 0, glyph: 62 }) },
];

await mkdir(outDir, { recursive: true });

for (const { file, size, svg } of VARIANTS) {
  const png = await sharp(Buffer.from(svg), { density: 300 })
    .resize(size, size)
    .png()
    .toBuffer();
  await writeFile(join(outDir, file), png);
  console.log(`✓ public/${file} (${size}×${size}, ${png.length} bytes)`);
}
