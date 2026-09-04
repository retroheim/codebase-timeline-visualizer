import { describe, expect, it } from 'vitest';
import { gravatarUrl, md5 } from '../md5';

// RFC 1321 test vectors.
describe('md5', () => {
  it('hashes the empty string', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('hashes "abc"', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('hashes a longer known string', () => {
    expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
  });

  it('hashes a 56-byte message (boundary for the padding block)', () => {
    expect(md5('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
  });
});

describe('gravatarUrl', () => {
  it('lowercases and trims the email before hashing', () => {
    expect(gravatarUrl('  Test@Example.com  ')).toBe(gravatarUrl('test@example.com'));
  });

  it('builds an identicon URL with the requested size', () => {
    const url = gravatarUrl('test@example.com', 128);
    expect(url).toBe('https://www.gravatar.com/avatar/55502f40dc8b7c769880b10874abc9d0?d=identicon&s=128');
  });
});
