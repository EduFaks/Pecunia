// Generates the PWA / home-screen PNG icons from the Plume mark.
// Source of truth for the geometry is web/public/favicon.svg — the path data
// below is that exact mark. Run with: npm run gen-icons
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const GROUND = "#0a0a0b";
const INK = "#fafafa";
const STROKE_WIDTH = 3.5;
const VIEWBOX = 48;
const CORNER_RADIUS = 11;

// The Plume: spine + vane, exactly as in favicon.svg.
const SPINE_D = "M15 40 C21 30 28 20 36 10";
const VANE_D = "M36 10 C40 18 38 27 31 32 C26 35 20 35 16 33";

// The same geometry as control-point tuples, for bounds sampling.
const CURVES = [
  [[15, 40], [21, 30], [28, 20], [36, 10]], // spine
  [[36, 10], [40, 18], [38, 27], [31, 32]], // vane, first segment
  [[31, 32], [26, 35], [20, 35], [16, 33]], // vane, second segment
];

const plume = (transform = "") => `
  <g ${transform} fill="none" stroke="${INK}" stroke-width="${STROKE_WIDTH}"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="${SPINE_D}"/>
    <path d="${VANE_D}"/>
  </g>`;

// Bounding box of the stroked glyph, via cubic sampling.
function glyphBounds() {
  const cubicAt = ([p0, p1, p2, p3], t) => {
    const u = 1 - t;
    const at = (i) =>
      u * u * u * p0[i] +
      3 * u * u * t * p1[i] +
      3 * u * t * t * p2[i] +
      t * t * t * p3[i];
    return [at(0), at(1)];
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const curve of CURVES) {
    for (let i = 0; i <= 100; i += 1) {
      const [x, y] = cubicAt(curve, i / 100);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX + STROKE_WIDTH,
    height: maxY - minY + STROKE_WIDTH,
  };
}

const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">`;

// Standard icon: Plume on the dark rounded ground (matches favicon.svg).
const roundedIcon = `${svgOpen}
  <rect width="${VIEWBOX}" height="${VIEWBOX}" rx="${CORNER_RADIUS}" fill="${GROUND}"/>
  ${plume()}
</svg>`;

// Apple touch icon: full-bleed dark square (iOS applies its own corner mask;
// a transparent-cornered PNG would get hard black corners instead).
const appleIcon = `${svgOpen}
  <rect width="${VIEWBOX}" height="${VIEWBOX}" fill="${GROUND}"/>
  ${plume()}
</svg>`;

// Maskable icon: full-bleed dark square with the Plume scaled and centered
// into the central 60% (~20% safe-zone padding per side), so Android's
// circle/squircle masks never clip the mark.
const SAFE_FRACTION = 0.6;
const { cx, cy, width, height } = glyphBounds();
const scale = (VIEWBOX * SAFE_FRACTION) / Math.max(width, height);
const center = VIEWBOX / 2;
const maskableIcon = `${svgOpen}
  <rect width="${VIEWBOX}" height="${VIEWBOX}" fill="${GROUND}"/>
  ${plume(
    `transform="translate(${center} ${center}) scale(${scale.toFixed(4)}) translate(${(-cx).toFixed(3)} ${(-cy).toFixed(3)})"`,
  )}
</svg>`;

async function render(svg, size, filename) {
  const density = (72 * size) / VIEWBOX;
  await sharp(Buffer.from(svg), { density })
    .resize(size, size)
    .png()
    .toFile(join(PUBLIC_DIR, filename));
  console.log(`wrote public/${filename} (${size}x${size})`);
}

await render(roundedIcon, 192, "icon-192.png");
await render(roundedIcon, 512, "icon-512.png");
await render(maskableIcon, 512, "icon-maskable-512.png");
await render(appleIcon, 180, "apple-touch-icon.png");
