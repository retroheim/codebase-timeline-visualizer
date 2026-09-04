// Offline identicon: a deterministic 5x5 mirrored block pattern rendered as an
// inline SVG data URI. Exists so `?avatars=local` can show something
// recognisable per contributor without sending anything — not even a hashed
// email — to Gravatar or GitHub.

import { md5 } from './md5';

const GRID = 5;
const HALF = Math.ceil(GRID / 2); // left half plus the centre column; mirrored

/**
 * Deterministic identicon for an email. Same input always yields the same
 * image, and the image never leaves the page.
 */
export function localIdenticonUrl(email: string, size = 96): string {
  const hash = md5(email.trim().toLowerCase());
  const bytes: number[] = [];
  for (let i = 0; i < hash.length; i += 2) bytes.push(parseInt(hash.slice(i, i + 2), 16));

  // Last bytes pick the hue so colour and pattern don't derive from the same
  // bits — otherwise similar patterns tend to come out similar colours too.
  const hue = ((bytes[15] << 8) | bytes[14]) % 360;
  const fill = `hsl(${hue} 62% 58%)`;
  const bg = `hsl(${hue} 30% 16%)`;

  let cells = '';
  for (let col = 0; col < HALF; col += 1) {
    for (let row = 0; row < GRID; row += 1) {
      // One bit per cell from the first 15 bytes; bit 0 is arbitrary but
      // stable, which is all an identicon needs.
      if ((bytes[col * GRID + row] & 1) === 0) continue;
      const mirrored = GRID - 1 - col;
      cells += `<rect x="${col}" y="${row}" width="1" height="1"/>`;
      if (mirrored !== col) cells += `<rect x="${mirrored}" y="${row}" width="1" height="1"/>`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${GRID} ${GRID}">` +
    `<rect width="${GRID}" height="${GRID}" fill="${bg}"/>` +
    `<g fill="${fill}">${cells}</g>` +
    `</svg>`;

  // encodeURIComponent rather than base64: no btoa unicode pitfalls, and the
  // result stays readable in devtools.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
