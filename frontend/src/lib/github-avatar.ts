import { gravatarUrl } from './md5';
import { localIdenticonUrl } from './identicon';

/**
 * Avatar resolution sends data to third parties: an MD5 of the commit author's
 * email to Gravatar, and the repository slug plus commit SHA to GitHub's API.
 * That is usually fine and occasionally not — analyzing a private repo on a
 * monitored network, say. `?avatars=local` turns all of it off and renders a
 * deterministic offline identicon instead.
 *
 * Read once at module load: the setting cannot change without a reload, and
 * re-parsing the URL per avatar would be wasted work.
 */
const externalAvatarsEnabled = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('avatars') !== 'local';
  } catch {
    return true;
  }
})();

export function usesExternalAvatars(): boolean {
  return externalAvatarsEnabled;
}

const NOREPLY_RE = /^(?:\d+\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/i;
const USERNAME_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

// Author-login resolution, cached per (repo, sha) and per email/name so a
// resize or re-render never re-issues the same lookup.
const loginCache = new Map<string, string | null>();
const imageLoadCache = new Map<string, boolean>();

function parseNoreplyLogin(email: string): string | null {
  const match = NOREPLY_RE.exec(email.trim());
  return match ? match[1] : null;
}

function githubAvatarUrl(login: string, size = 96): string {
  return `https://github.com/${login}.png?size=${size}`;
}

// GitHub's avatar route (github.com/{login}.png) is public and unauthenticated
// even for private repos — but it 404s for names that aren't real accounts,
// so verify before trusting a guess (never show a broken image, never risk
// pointing at a URL that just happens to construct).
function imageLoads(url: string): Promise<boolean> {
  if (imageLoadCache.has(url)) return Promise.resolve(imageLoadCache.get(url)!);
  return new Promise((resolve) => {
    const img = new Image();
    // Only the first outcome counts. Without this, a slow image that loads
    // after the 4s timeout still runs `settle(true)` and rewrites the cache —
    // or worse, the timeout fires after a successful load and downgrades a
    // known-good URL to `false` for the rest of the session.
    let settled = false;
    let timer = 0;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      imageLoadCache.set(url, ok);
      resolve(ok);
    };
    timer = window.setTimeout(() => settle(false), 4000);
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    img.src = url;
  });
}

// Resolve a contributor's real GitHub avatar, trying progressively less
// certain sources:
//  1. The commit email, when it's the noreply pattern — instant, exact.
//  2. GitHub's commit API — the same account-resolution GitHub itself uses
//     to attribute a commit/PR (`.author.login`), for repos it can reach
//     unauthenticated. Private repos 404 here with no way around it client-side.
//  3. The git author's display name as a candidate username — many people's
//     git name literally is their handle — but only if that avatar genuinely
//     loads, so a name that isn't anyone's account just falls through.
export async function resolveGithubAvatar(
  githubRepo: string | null,
  email: string,
  sha: string,
  authorName: string
): Promise<string | null> {
  if (!externalAvatarsEnabled) return null;

  const noreplyLogin = parseNoreplyLogin(email);
  if (noreplyLogin) return githubAvatarUrl(noreplyLogin);

  if (githubRepo) {
    const cacheKey = `${githubRepo}#${sha}`;
    if (loginCache.has(cacheKey)) {
      const cached = loginCache.get(cacheKey);
      if (cached) return githubAvatarUrl(cached);
    } else {
      try {
        const res = await fetch(`https://api.github.com/repos/${githubRepo}/commits/${sha}`, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (res.ok) {
          const login: string | undefined = (await res.json())?.author?.login;
          loginCache.set(cacheKey, login ?? null);
          if (login) return githubAvatarUrl(login);
        } else if (res.status === 404) {
          // Only a 404 is a definitive "this commit has no linked account".
          // The unauthenticated API allows 60 requests/hour, so on a repo with
          // many contributors a 403 rate-limit is routine — caching that as a
          // permanent negative would blank those avatars for the whole session
          // even after the limit resets.
          loginCache.set(cacheKey, null);
        }
      } catch {
        // Network blip: leave the cache untouched so a later render retries.
      }
    }
  }

  const candidate = authorName.trim().replace(/\s+/g, '-');
  if (USERNAME_RE.test(candidate)) {
    const url = githubAvatarUrl(candidate);
    if (await imageLoads(url)) return url;
  }

  return null;
}

// Instant placeholder while the real avatar resolves (or for repos with no
// GitHub remote at all) — Gravatar's identicon fallback, same as what
// GitHub itself shows for commit authors without a linked/public avatar.
export function placeholderAvatarUrl(email: string): string {
  return externalAvatarsEnabled ? gravatarUrl(email, 96) : localIdenticonUrl(email, 96);
}
