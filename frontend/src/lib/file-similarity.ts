import type { TreeNode } from './file-tree';

/**
 * How much each signal contributes to whether two files in the same
 * directory get grouped together. Co-change coupling is weighted highest —
 * files actually edited together in the same commits are the strongest
 * relationship signal a git history can offer, stronger than a naming
 * convention. Extension and name-stem are cheap, reliable secondary signals
 * (every `.rs` file in an otherwise-unrelated directory, or an impl/test
 * pair) that catch real relationships coupling alone misses — e.g. a file
 * that's genuinely related but was only just added and has barely any
 * commit history of its own yet.
 */
// The threshold must exceed any *one* signal's weight on its own. Grouping
// is transitive (union-find) — if a weak, common signal like "shares an
// extension" were sufficient by itself, two genuinely unrelated pairs that
// each independently share just an extension with a third file would chain
// through it into one giant group (this bit an early version: `auth.rs`
// paired with `auth_test.rs`, `db.rs` paired with `db_test.rs`, and
// `auth.rs`-`db.rs` sharing only an extension was enough to fuse both pairs
// into one, destroying the distinction). Coupling is the one signal
// specific enough to stand alone (two files genuinely edited together in
// most of the same commits, not just "somewhere in the same directory").
// Extension/stem matches alone stay sub-threshold and only tip a pair over
// in combination with each other or with modest coupling. A directory full
// of same-type files with no real coupling between any of them still reads
// as clustered-with-a-descriptive-name in the end — that comes from the
// caller's catch-all fallback (see `collapseClusters`) computing
// `commonExtension` over the leftover pile, not from grouping them here.
const WEIGHT_COUPLING = 0.5;
const WEIGHT_EXTENSION = 0.25;
const WEIGHT_STEM = 0.25;
const SIMILARITY_THRESHOLD = 0.4;

// A directory with an implausibly large number of direct file children
// (generated code, vendored assets) would make the pairwise O(n^2)
// comparison below expensive for no real benefit — past this many files,
// skip similarity clustering and let every file come back as its own group;
// the caller's existing "too many children" fallback already bounds the
// resulting clutter with one catch-all cluster.
const MAX_SIMILARITY_CANDIDATES = 500;

// Suffixes stripped before comparing stems, so `foo.ts` and `foo.test.ts`
// (or `foo_test.rs`) are recognized as the same underlying unit even though
// their raw filenames differ.
const TEST_SUFFIXES = [/\.test$/, /\.spec$/, /_test$/, /_spec$/];

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i);
}

function stemOf(name: string): string {
  const ext = extensionOf(name);
  let stem = ext ? name.slice(0, -ext.length) : name;
  for (const suffix of TEST_SUFFIXES) stem = stem.replace(suffix, '');
  return stem;
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const v of small) if (big.has(v)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function similarity(a: TreeNode, b: TreeNode, commitSetByPath: ReadonlyMap<string, Set<number>>): number {
  const coupling = jaccard(commitSetByPath.get(a.path) ?? new Set(), commitSetByPath.get(b.path) ?? new Set());
  const extA = extensionOf(a.name);
  const sameExtension = extA !== '' && extA === extensionOf(b.name) ? 1 : 0;
  const stemA = stemOf(a.name);
  const sameStem = stemA !== '' && stemA === stemOf(b.name) ? 1 : 0;
  return WEIGHT_COUPLING * coupling + WEIGHT_EXTENSION * sameExtension + WEIGHT_STEM * sameStem;
}

/**
 * Union-find every file in `files` — assumed to already be siblings in one
 * directory, this never compares across directories — into groups by
 * pairwise similarity (co-change coupling + shared extension + shared name
 * stem, blended into one score). A file with nothing similar nearby comes
 * back as its own group of one; the caller decides what to do with those.
 */
export function groupBySimilarity(
  files: TreeNode[],
  commitSetByPath: ReadonlyMap<string, Set<number>>
): TreeNode[][] {
  if (files.length > MAX_SIMILARITY_CANDIDATES) return files.map((f) => [f]);

  const parent = files.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      if (similarity(files[i], files[j], commitSetByPath) >= SIMILARITY_THRESHOLD) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) parent[ri] = rj;
      }
    }
  }

  const groups = new Map<number, TreeNode[]>();
  files.forEach((f, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(f);
    else groups.set(root, [f]);
  });
  return [...groups.values()];
}

/**
 * The extension every member of the group shares, if they all share one —
 * used to give a cluster a more descriptive name than a bare file count.
 */
export function commonExtension(files: TreeNode[]): string | null {
  const ext = extensionOf(files[0]?.name ?? '');
  if (ext === '') return null;
  return files.every((f) => extensionOf(f.name) === ext) ? ext : null;
}
