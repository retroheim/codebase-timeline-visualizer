# Never cache a per-thread resource handle in a `thread_local!` under rayon

**Symptom:** `cargo test --release` fails intermittently — roughly 1 run in 5 —
with a `git2` error like `object not found`. The same tests pass in isolation
and pass on a re-run. Nothing in the failing test changed.

**Where:** `src/analyzer.rs`, `analyze_commits()`. Commits `dd4c8b2` (introduced)
and `7023674` (fixed).

## What happened

`analyze_commits()` diffs every commit in parallel. `git2::Repository` wraps a
raw libgit2 pointer that is not safely shareable across threads, so each rayon
worker needs its own handle. The obvious optimization is to open it once per
thread and cache it:

```rust
thread_local! {
    static REPO: RefCell<Option<Repository>> = RefCell::new(None);
}
```

That is 66% faster (32.478s to 10.935s on a 2422-commit repo) and wrong.

Rayon's thread pool is **process-global and outlives any single call.** A
`thread_local!` cache is keyed to the thread, not to the call. So:

1. `analyze_commits()` runs for repo A. Worker thread 3 opens and caches a
   handle to repo A.
2. Repo A is a test fixture in a `TempDir`. The test ends; the tempdir is
   deleted.
3. A later `analyze_commits()` runs for repo B. Rayon hands the work to the
   same pooled thread 3, which finds a cached handle — pointing at the deleted
   repo A.

The failure is intermittent because it only fires when the scheduler happens to
reuse that particular thread, which is why it reads as flakiness rather than as
a design bug.

## The fix

Use `map_init`, which scopes initialization to the parallel iterator call rather
than the thread:

```rust
oids.par_iter().map_init(
    || Repository::open(&repo_path)
        .map_err(|e| format!("failed to reopen repo in worker: {e}")),
    |repo_result, oid| { /* ... */ },
)
```

Cost: about 2 seconds (10.935s to 13.160s), still 2.5x faster than serial, and
correct. Verified at 15 clean runs of `cargo test --release` after the change,
against 1 failure in 5 before it.

## The general rule

**Any time a resource handle's lifetime is keyed to a thread, but the resource
it points at is keyed to a call, a pooled executor will eventually cross the
two.** This is not specific to `git2` or to rayon. The same shape appears with
database connections bound to a per-thread cache while the schema or tenant
varies per call, with FFI handles to a loaded file, and with any
`lazy_static`/`OnceCell` initialized from call-scoped state.

Ask: *does the cached value remain valid for every possible future caller on
this thread?* If the answer depends on what the caller is pointing at, the cache
is wrong and the initialization belongs in the call.

Places in this repo where the class could recur: any second `Repository`-touching
parallel path (there is currently only one, `src/analyzer.rs`), and any per-thread
HTTP client or repo cache added under a thread pool.
