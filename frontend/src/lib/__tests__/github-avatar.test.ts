import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeholderAvatarUrl, resolveGithubAvatar, usesExternalAvatars } from '../github-avatar';

// `Image` is stubbed rather than relying on happy-dom's actual image
// loading (unreliable/network-shaped) — tests drive onload/onerror directly
// so the "does this candidate username's avatar actually exist" branch in
// resolveGithubAvatar is deterministic.
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private _src = '';
  set src(value: string) {
    this._src = value;
    queueMicrotask(() => {
      if (FakeImage.shouldLoad) this.onload?.();
      else this.onerror?.();
    });
  }
  get src(): string {
    return this._src;
  }
  static shouldLoad = true;
}

describe('usesExternalAvatars / placeholderAvatarUrl (default: external enabled)', () => {
  it('reports external avatars enabled by default', () => {
    expect(usesExternalAvatars()).toBe(true);
  });

  it('returns a gravatar URL', () => {
    expect(placeholderAvatarUrl('alice@example.com')).toContain('gravatar.com');
  });
});

describe('resolveGithubAvatar', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage);
    FakeImage.shouldLoad = true;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resolves a noreply email directly, without any network call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('should not be called')))
    );
    const url = await resolveGithubAvatar(null, '12345+octocat@users.noreply.github.com', 'sha1', 'Octo Cat');
    expect(url).toBe('https://github.com/octocat.png?size=96');
  });

  it('resolves a noreply email with no numeric id prefix', async () => {
    const url = await resolveGithubAvatar(null, 'octocat@users.noreply.github.com', 'sha1', 'Octo Cat');
    expect(url).toBe('https://github.com/octocat.png?size=96');
  });

  it('resolves via the GitHub commits API when the login is present', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ author: { login: 'octocat' } }) })
    );
    vi.stubGlobal('fetch', fetchMock);

    const url = await resolveGithubAvatar('owner/repo', 'a@b.com', 'sha1', 'Some Name');
    expect(url).toBe('https://github.com/octocat.png?size=96');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/commits/sha1',
      expect.objectContaining({ headers: { Accept: 'application/vnd.github+json' } })
    );
  });

  it('caches a successful API lookup and does not re-fetch for the same repo+sha', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ author: { login: 'cached-user' } }) })
    );
    vi.stubGlobal('fetch', fetchMock);

    await resolveGithubAvatar('owner/cache-repo', 'a@b.com', 'sha-cache', 'Some Name');
    await resolveGithubAvatar('owner/cache-repo', 'a@b.com', 'sha-cache', 'Some Name');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls through to the author-name candidate when the API 404s, and caches the negative', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);
    FakeImage.shouldLoad = true;

    const url = await resolveGithubAvatar('owner/repo-404', 'a@b.com', 'sha-404', 'Some-Name');
    expect(url).toBe('https://github.com/Some-Name.png?size=96');

    // Negative result is cached — a second call for the same repo+sha
    // shouldn't hit the network again.
    await resolveGithubAvatar('owner/repo-404', 'a@b.com', 'sha-404', 'Some-Name');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a non-404 failure (e.g. rate limit), so a later call retries', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchMock);
    FakeImage.shouldLoad = false;

    await resolveGithubAvatar('owner/rate-limited', 'a@b.com', 'sha-403', 'Weird Name!!');
    await resolveGithubAvatar('owner/rate-limited', 'a@b.com', 'sha-403', 'Weird Name!!');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache a network error, so a later call retries', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', fetchMock);
    FakeImage.shouldLoad = false;

    await resolveGithubAvatar('owner/offline-repo', 'a@b.com', 'sha-net', 'name');
    await resolveGithubAvatar('owner/offline-repo', 'a@b.com', 'sha-net', 'name');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the author name as a candidate username when it loads', async () => {
    FakeImage.shouldLoad = true;
    const url = await resolveGithubAvatar(null, 'a@b.com', 'sha1', 'Real Name');
    expect(url).toBe('https://github.com/Real-Name.png?size=96');
  });

  it('returns null when the candidate username does not look like a valid GitHub login', async () => {
    const url = await resolveGithubAvatar(null, 'a@b.com', 'sha1', '!!!not a valid login!!!');
    expect(url).toBeNull();
  });

  it('returns null when the candidate avatar image fails to load', async () => {
    FakeImage.shouldLoad = false;
    // A name unused by any other test in this file — `imageLoads` caches by
    // URL, so reusing a candidate name that already resolved `true`
    // elsewhere would hit that cache instead of exercising this path.
    const url = await resolveGithubAvatar(null, 'a@b.com', 'sha1', 'Fails To Load');
    expect(url).toBeNull();
  });

  it('returns null (not stuck) when the candidate image never fires load or error', async () => {
    vi.useFakeTimers();
    class HangingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        // never resolves — exercises the 4s timeout fallback in imageLoads
      }
    }
    vi.stubGlobal('Image', HangingImage);

    const promise = resolveGithubAvatar(null, 'a@b.com', 'sha1', 'Never Resolves');
    await vi.advanceTimersByTimeAsync(4001);
    expect(await promise).toBeNull();
  });
});

describe('avatars disabled via ?avatars=local', () => {
  it('resolveGithubAvatar short-circuits to null, and placeholderAvatarUrl uses an identicon', async () => {
    history.replaceState(null, '', '?avatars=local');
    vi.resetModules();
    const fetchMock = vi.fn(() => Promise.reject(new Error('should not be called')));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../github-avatar');
    expect(mod.usesExternalAvatars()).toBe(false);
    expect(mod.placeholderAvatarUrl('a@b.com')).not.toContain('gravatar.com');

    const url = await mod.resolveGithubAvatar('owner/repo', 'octocat@users.noreply.github.com', 'sha1', 'name');
    expect(url).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    history.replaceState(null, '', '/');
    vi.resetModules();
    vi.unstubAllGlobals();
  });
});
