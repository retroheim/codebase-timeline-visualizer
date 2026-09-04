import { describe, expect, it } from 'vitest';
import { isBotAuthor } from '../bot-authors';

describe('isBotAuthor', () => {
  it('recognizes GitHub App bots by their [bot] suffix', () => {
    expect(isBotAuthor('blacksmith-sh[bot]')).toBe(true);
    expect(isBotAuthor('dependabot[bot]')).toBe(true);
  });

  it('recognizes any Claude model variant', () => {
    expect(isBotAuthor('Claude')).toBe(true);
    expect(isBotAuthor('Claude Opus 5')).toBe(true);
    expect(isBotAuthor('Claude Sonnet 4.6')).toBe(true);
    expect(isBotAuthor('Claude Opus 4.7 (1M context)')).toBe(true);
  });

  it('recognizes known named AI assistants case-insensitively', () => {
    expect(isBotAuthor('Codesmith')).toBe(true);
    expect(isBotAuthor('codesmith')).toBe(true);
    expect(isBotAuthor('Copilot')).toBe(true);
  });

  it('does not flag ordinary human names', () => {
    expect(isBotAuthor('Alice')).toBe(false);
    expect(isBotAuthor('retroheim')).toBe(false);
    expect(isBotAuthor('Kissou')).toBe(false);
  });

  it('does not false-positive on a human name that merely contains a bot-ish substring', () => {
    expect(isBotAuthor('Robert')).toBe(false);
    expect(isBotAuthor('Coppola')).toBe(false);
  });
});
