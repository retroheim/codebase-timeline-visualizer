# Counting diff lines with `Diff::foreach` instead of materializing `Patch`

**Problem:** per-commit line stats via `git2::Patch::from_diff(...).line_stats()`
cost 13.160s on a 2422-commit repo, and `Patch` builds the full textual diff for
every delta when all we want is two integers.

**Where:** `src/analyzer.rs`, `extract_commit_data()`. Commit `022c8b5`, with the
test added in `0fa90f7`.

## The approach

Make one `Diff::foreach()` pass and tally line origins directly, and tell libgit2
not to produce context it will never be asked for:

```rust
let mut diff_opts = git2::DiffOptions::new();
diff_opts.context_lines(0).interhunk_lines(0);
```

Result: 13.160s to 6.211s, a 53% cut on top of the already-parallelized
baseline, and 5.2x against the original 32.478s.

## The trap

`Diff::foreach` gives you a file callback and a line callback, but the line
callback does **not** tell you which delta it belongs to in a usable way. The
correlation depends on an ordering guarantee: the file callback fires once per
delta, in delta order, before that delta's hunk and line callbacks. So the file
callback records the current index and the line callback reads it:

```rust
let next_idx = Cell::new(0usize);
let current_idx = Cell::new(None::<usize>);
```

**Nothing in the type system holds this together.** The compiler cannot tell you
that a refactor reordered the callbacks, moved the increment, or reused an index
— it will happily attribute one file's added lines to another file, silently, and
the totals will still look plausible.

## What makes it safe

`line_stats_match_known_diff` in `src/analyzer.rs` pins exact `lines_added` /
`lines_removed` values for three known commits in a synthetic fixture repo. It
exists because a code review noticed the optimization had shipped with no test
asserting the numbers it produced — the counter was correct, but nothing would
have caught it becoming incorrect.

**If you touch the `foreach` block, the pinned values in that test are the
contract.** Do not update them to match new output; work out why the output
changed first.

Worth extending the fixture with a delete, a rename, and a merge commit — the
current one is a linear three-commit history of plain adds, which is the shape
least likely to expose a correlation bug.
