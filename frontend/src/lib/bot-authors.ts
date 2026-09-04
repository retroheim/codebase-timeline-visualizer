// Identifies commits/contributors that are automated (CI/App bots, AI
// coding assistants) rather than a human author, so the leaderboard can
// default to showing them as one grouped "Automated" line instead of
// drowning out human contributors with a dozen individual bot/model rows.

const BOT_SUFFIX = /\[bot\]$/i;
// Any Claude model variant — "Claude", "Claude Opus 5", "Claude Sonnet 4.6",
// "Claude Opus 4.7 (1M context)", etc. — all share this prefix.
const CLAUDE_PREFIX = /^claude\b/i;
// Named AI coding assistants that don't follow either convention above.
// Not exhaustive by design — extend as new ones show up in the wild rather
// than trying to enumerate every possible AI tool up front.
const KNOWN_BOT_NAMES = new Set(
  ['codesmith', 'copilot', 'github-copilot', 'chatgpt', 'gpt-4', 'gpt-5', 'codex', 'cursor', 'devin', 'gemini', 'jules'].map((s) =>
    s.toLowerCase()
  )
);

export function isBotAuthor(name: string): boolean {
  const trimmed = name.trim();
  if (BOT_SUFFIX.test(trimmed)) return true;
  if (CLAUDE_PREFIX.test(trimmed)) return true;
  return KNOWN_BOT_NAMES.has(trimmed.toLowerCase());
}
