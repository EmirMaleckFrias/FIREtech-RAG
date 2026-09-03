// Genera los íconos de marca a partir del logo real: el árbol de Alzheimer
// Project sobre un disco/cuadrado claro.
//
// Uso (desde frontend/):
//   npm run icons        (o: node scripts/generate-icons.mjs)
//
// Escribe en public/:
//   arbol-marca.png                        → el árbol recortado, con alfa.
//                                            Lo usa el avatar del asistente.
//   favicon.png (32)                       → pestaña del navegador
//   icon-192.png, icon-512.png             → manifest (purpose: any)
//   icon-maskable-192.png, -512.png        → manifest (purpose: maskable,
//                                             glifo en la zona segura)
//   apple-touch-icon.png (180)             → iOS (sin esquinas redondeadas:
//                                             iOS las aplica)
//
// POR QUÉ EL FONDO ES CLARO Y NO EL MORADO DE MARCA: el árbol del logo es
// morado oscuro. Sobre el morado #3D1974 se desvanece y a 26 px es una
// mancha; sobre blanco se lee como un árbol incluso a ese tamaño. Se
// comprobó rasterizando las dos variantes a 26/32/48/96 px antes de elegir.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const LOGO = join(publicDir, 'alzheimer-project.png');

// El logo son dos piezas apiladas: el árbol arriba y el wordmark
// "ALZHEIMER PROJECT" abajo, separados por una banda de píxeles totalmente
// transparentes. Ese corte está en el 60.6% de la altura (fila 381 de 629),
// medido sobre el canal alfa. Se recorta ahí y luego se aprieta con trim()
// para quitar el margen sobrante, así que un logo nuevo de proporciones
// parecidas sigue funcionando sin tocar este número.
const CORTE_ARBOL = 0.606;

const { height, width } = await sharp(LOGO).metadata();
// extract y trim NO se encadenan en el mismo pipeline: sharp los aplica en un
// orden que hace fallar el recorte ("extract_area: bad extract area"). Dos
// pasos separados, con el buffer intermedio.
const banda = await sharp(LOGO)
  .extract({ left: 0, top: 0, width, height: Math.round(height * CORTE_ARBOL) })
  .png()
  .toBuffer();
const arbol = await sharp(banda).trim().png().toBuffer();

await mkdir(publicDir, { recursive: true });
await writeFile(join(publicDir, 'arbol-marca.png'), arbol);
const meta = await sharp(arbol).metadata();
console.log(`✓ public/arbol-marca.png (${meta.width}×${meta.height})`);

const CLARO = { r: 255, g: 255, b: 255, alpha: 1 };

/**
 * Compone el árbol centrado sobre un fondo claro.
 * @param {object} o
 * @param {number} o.size    lado del PNG final
 * @param {number} o.radius  radio de esquina en unidades del lado (0 = pleno)
 * @param {number} o.inset   proporción del lado que ocupa el árbol
 */
async function icono({ size, radius, inset }) {
  const lado = Math.round(size * inset);
  const glifo = await sharp(arbol)
    .resize(lado, lado, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const g = await sharp(glifo).metadata();

  const fondo =
    radius > 0
      ? await sharp(
          Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
              `<rect width="${size}" height="${size}" rx="${Math.round(size * radius)}" fill="#FFFFFF"/>` +
              `</svg>`,
          ),
        )
          .png()
          .toBuffer()
      : await sharp({
          create: { width: size, height: size, channels: 4, background: CLARO },
        })
          .png()
          .toBuffer();

  return sharp(fondo)
    .composite([
      {
        input: glifo,
        left: Math.round((size - g.width) / 2),
        top: Math.round((size - g.height) / 2),
      },
    ])
    .png()
    .toBuffer();
}

const VARIANTS = [
  { file: 'favicon.png', size: 32, radius: 0.22, inset: 0.86 },
  { file: 'icon-192.png', size: 192, radius: 0.22, inset: 0.8 },
  { file: 'icon-512.png', size: 512, radius: 0.22, inset: 0.8 },
  // maskable: el SO recorta hasta un 20% por lado, así que el árbol se queda
  // en la zona segura y el fondo llega al borde.
  { file: 'icon-maskable-192.png', size: 192, radius: 0, inset: 0.6 },
  { file: 'icon-maskable-512.png', size: 512, radius: 0, inset: 0.6 },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, inset: 0.8 },
];

for (const { file, ...opts } of VARIANTS) {
  const png = await icono(opts);
  await writeFile(join(publicDir, file), png);
  console.log(`✓ public/${file} (${opts.size}×${opts.size}, ${png.length} bytes)`);
}
