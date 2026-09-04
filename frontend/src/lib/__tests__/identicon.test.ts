import { describe, expect, it } from 'vitest';
import { localIdenticonUrl } from '../identicon';

describe('localIdenticonUrl', () => {
  it('produces an inline SVG data URI, so nothing is fetched', () => {
    const url = localIdenticonUrl('a@example.com');
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(url)).toContain('<svg');
  });

  it('is deterministic for the same email', () => {
    expect(localIdenticonUrl('a@example.com')).toBe(localIdenticonUrl('a@example.com'));
  });

  it('normalizes case and surrounding whitespace like Gravatar does', () => {
    expect(localIdenticonUrl('  A@Example.COM  ')).toBe(localIdenticonUrl('a@example.com'));
  });

  it('gives different people different images', () => {
    expect(localIdenticonUrl('a@example.com')).not.toBe(localIdenticonUrl('b@example.com'));
  });

  it('is horizontally symmetric, which is what makes it read as a face', () => {
    const svg = decodeURIComponent(localIdenticonUrl('symmetry@example.com'));
    const cells = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1"/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    for (const [x, y] of cells) {
      const mirrored = 4 - x;
      expect(cells.some(([mx, my]) => mx === mirrored && my === y)).toBe(true);
    }
  });

  it('honors the requested pixel size', () => {
    expect(decodeURIComponent(localIdenticonUrl('a@example.com', 32))).toContain('width="32"');
  });

  it('handles an empty email without throwing', () => {
    expect(() => localIdenticonUrl('')).not.toThrow();
  });
});
