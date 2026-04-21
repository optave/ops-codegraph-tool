# Snapshot & parallel-worktree incremental-build audit

**Date:** 2026-04-21
**Framing:** comparison pass against [omnigraph.dev](https://www.omnigraph.dev/), focused on our snapshot design and incremental-build behavior when multiple Claude Code worktrees run against the same repo in parallel.
**Outcome:** 3 correctness bugs filed (#995, #996, #997). One proposed optimization (content-addressed parse cache) evaluated and rejected against the current performance profile. No architectural rewrite justified.

---

## 0. TL;DR

- **Each worktree does get its own `.codegraph/graph.db`** — `git rev-parse --show-toplevel` returns the *worktree* path in linked worktrees. Verified locally. So "two worktrees corrupt each other's DB" is not a real risk.
- **The framing of "structural failure in incremental updates" was overblown.** Incremental builds within a single worktree work correctly. What's actually imperfect: concurrent writers to the same worktree's journal/snapshot files, and first-build-in-new-worktree doesn't amortize work other worktrees already did.
- **3 real bugs found and filed** — all about non-atomic file operations:
  - #995 — snapshot save TOCTOU race
  - #996 — journal append isn't locked
  - #997 — journal header lags appended entries during watch → silent performance cliff
- **Omnigraph's "commits are snapshots, branches are references" model does not fit us** — it couples graph freshness to git commits, which breaks the "graph tracks your working tree live" invariant that is codegraph's whole point.
- **Content-addressed parse cache (R1 below)** was the most promising omnigraph-inspired optimization, but parsing is ~10% of build time. A cache would save ~10% on first-build-in-new-worktree and near-zero on incremental/watch. **Not worth the engineering cost.** Rejected.
- **Honest scope limit:** omnigraph's public docs are thin on internals. Claims about their concurrency model and merge semantics come from marketing pages, not source. Calibrate the "what to learn" findings accordingly.

---

## 1. What I verified vs. what I inferred

| Claim | Source | Confidence |
|---|---|---|
| Linked worktree gets its own DB | Ran `git rev-parse --show-toplevel` in worktree → returned worktree path | **Verified** |
| Worktree and main each have independent ~30 MB `.codegraph/` dirs | `ls -la` in both locations | **Verified** |
| Advisory lock warns but never blocks | `src/db/connection.ts:112-130` — reads PID, calls `warn()`, writes own PID, proceeds | **Verified** |
| Snapshots are `VACUUM INTO` to `.codegraph/snapshots/<name>.db` | `src/features/snapshot.ts:18-60` | **Verified** |
| Snapshots have no git identity | Name regex `^[a-zA-Z0-9_-]+$`; no git calls in the file | **Verified** |
| Journal header + append are separate writes, with no coordination | `src/domain/graph/journal.ts:62-83` vs `85-105` | **Verified** |
| Parsing is ~10% of full-build time | User-provided benchmark | **Verified (external)** |
| Omnigraph uses Lance + Arrow + DataFusion + Cedar | Omnigraph landing page | **Per marketing** |
| Omnigraph branches are copy-on-write, "no locks" | Omnigraph landing page | **Per marketing — no source dive** |
| Omnigraph merge conflict semantics | — | **Not documented publicly** |

---

## 2. What's actually in our code

### 2.1 Snapshot (`src/features/snapshot.ts`)

```text
snapshotSave(name)    → VACUUM INTO .codegraph/snapshots/<name>.db   (lines 27-61)
snapshotRestore(name) → copyFileSync over graph.db + wipe WAL/SHM    (lines 67-88)
snapshotList/Delete   → flat dir listing                             (lines 97-131)
```

Real correctness issue: `existsSync` → `unlinkSync` → `VACUUM INTO` is a three-step TOCTOU race. Filed as **#995**.

Separately, snapshot name is free-form — no HEAD/branch/dirty-state binding. Two worktrees running `snapshot save main` from different commits silently overwrite each other with `--force`. This is a UX gap, not a correctness bug.

### 2.2 Change journal (`src/domain/graph/journal.ts`)

Format:
```
# codegraph-journal v1 <timestamp>
path/to/changed-file.ts
DELETED path/to/gone.ts
```

Two real issues:

- **#996** — `appendJournalEntries()` uses unlocked `fs.appendFileSync`. Concurrent writers (e.g. watcher + manual build) can interleave lines, producing corrupt entries.
- **#997** — Watcher appends entries but never updates the header timestamp; only builder's finalize does. Result: after a watch session, journal entries are newer than the header, Tier 0 journal-check bails, next build falls through to the expensive Tier 1/2 scan. Silent performance cliff.

### 2.3 Advisory "lock" (`src/db/connection.ts:112-130`)

```ts
if (pid && pid !== process.pid && isProcessAlive(pid)) {
  warn(`Another process (PID ${pid}) may be using this database. Proceeding with caution.`);
}
// ... then writes own PID anyway
```

Not a lock — a log line. SQLite's WAL `busy_timeout = 5000` (`connection.ts:169`) provides actual DB-level serialization. The informational lock file doesn't cover surrounding file operations (journal, snapshot directory). Discussed in #996.

### 2.4 Per-worktree isolation is correct — but each worktree starts cold

- Every linked worktree has its own `.codegraph/` (verified). DB isolation is fine.
- But every new worktree re-parses every file, re-resolves every import, re-hashes, and re-embeds — even though most files are byte-identical to another worktree's parse output.
- For a 3-file branch off main, first build costs the same as indexing from scratch.
- This is an amortization gap, not a structural failure. It is the thing omnigraph's "copy-on-write branches" would address if ported — see §3.

### 2.5 Registry (`src/infrastructure/registry.ts`)

Keyed by `path.basename(absRoot)` with `-2`/`-3` auto-suffix collision handling. Two worktrees register as two unrelated "repos" rather than one repo with two worktrees. UX imperfection, not a bug.

---

## 3. What omnigraph does differently

Sourced from [omnigraph.dev](https://www.omnigraph.dev/) and [ModernRelay/omnigraph README](https://github.com/ModernRelay/omnigraph). Deep internals not publicly documented; quotations below are from their marketing pages.

### 3.1 Storage model

- **Lance** immutable versioned columnar format — every write produces a new version, old versions stay addressable.
- **Arrow** for in-memory columnar execution.
- **DataFusion** for query planning.
- Net effect: snapshots, versioning, time-travel are the storage format, not features layered on top.

### 3.2 Git-style semantics

```bash
omnigraph branch create --from main feature-x ./repo.omni
omnigraph branch merge  feature-x --into main ./repo.omni
```

- Branches are references to versions, not disk copies ("copy-on-write branching eliminates locks," per marketing — mechanism not public).
- Every mutation is a commit.
- Merge exists as a first-class operation (conflict semantics not documented).

### 3.3 Why the model doesn't fit us

Codegraph's core value prop is **"the graph tracks your on-disk working tree in real time, committed or not."** You edit a file, save, and `codegraph audit --quick <target>` reflects the change. You can run `fn-impact` on uncommitted code.

Omnigraph's model couples graph state to commits. To port it faithfully, we'd have to either:
- Auto-commit on every save (bad — pollutes git history), or
- Accept a gap between disk and graph state (defeats dogfooding).

So the full model is off the table. The question became: **can we take a single useful piece** without breaking the live-dev invariant? See next section.

---

## 4. Proposed R1 — and why it's rejected

### The idea

Content-addressed parse cache at `~/.codegraph/cache/symbols/<sha256>.json`:

1. Hash each file.
2. Look up `sha256 + parser_version` in cache.
3. Hit → skip tree-sitter, reuse cached symbols/edges.
4. Miss → parse, extract, store in cache.

Key property: cache key is content hash of on-disk bytes, **not** a commit SHA. This preserves the "graph tracks working tree live" invariant — dirty files cache just as well as committed ones. No git coupling.

### Why I initially ranked it #1

The "first-build-in-new-worktree is cold" problem is real, and tree-sitter parses are content-pure (same bytes → same AST), so the cache is a correct-by-construction optimization with no invalidation complexity.

### Why it's rejected

**Parsing is ~10% of full-build time** (user-provided benchmark).

- First-build-in-new-worktree: cache saves ~10%. Real but modest.
- Incremental builds: cache saves ~0% — incremental already skips unchanged files, so the parses it runs are genuine cache misses too.
- Watch mode: ~0% — same reason.

A content-addressed cache needs: directory layout, hash scheme with parser-version keying, LRU/TTL for size management, cross-platform path handling, test coverage. Call it a few hundred LOC plus ongoing ops concerns. Shipping that for ≤10% on one narrow scenario is a bad trade.

### If first-build-in-new-worktree latency is the actual pain point

The remaining 90% lives in: import resolution (`domain/graph/resolve.ts`, 6-level priority resolver), DB writes (batch size, transaction boundaries, indexes), and embeddings (if enabled, often dominates). Profile one of those and there's a real target. Separate investigation from this audit.

---

## 5. Recommendations

| ID | Action | Status |
|---|---|---|
| **A1** | Fix #995 — snapshot save TOCTOU race. Use `<name>.db.tmp-<pid>` + atomic rename, or a real file lock. | **Do** |
| **A2** | Fix #996 — lock journal mutations (or replace with a per-line append-only log). | **Do** |
| **A3** | Fix #997 — watcher updates journal header in the same critical section as entry appends. | **Do** |
| ~~R1~~ | ~~Content-addressed parse cache.~~ | **Rejected** — 10% parse share |
| R3 | Bind snapshot names to git identity + metadata + GC. | Nice-to-have. Not urgent. |
| R4 | Share more than parses across worktrees (resolved edges, embeddings) by content hash. | Speculative — conditional on verifying content-purity. Not recommended now. |
| R5 | Replace SQLite-as-materialized-graph with append-only versioned store. | Long-horizon, out of scope. |

---

## 6. Honest gaps

- I did not read omnigraph's source. Their concurrency model, merge semantics, and on-disk layout are guessed from marketing pages.
- The 10% parse-time figure is one data point, not a profile. Embedding-enabled builds will skew differently.
- I did not audit whether resolved edges are content-pure (R4 hinges on this). Probably not — resolution depends on sibling files.
- The 3 filed bugs are individually small. Together they matter because the "multi-worktree + watcher + manual build" workflow is the documented use case (CLAUDE.md "Parallel Sessions"), and that's exactly when the races fire.

---

## Sources

- [Omnigraph landing page](https://www.omnigraph.dev/)
- [Omnigraph docs index](https://www.omnigraph.dev/docs)
- [ModernRelay/omnigraph on GitHub](https://github.com/ModernRelay/omnigraph)
- Filed issues: [#995](https://github.com/optave/ops-codegraph-tool/issues/995), [#996](https://github.com/optave/ops-codegraph-tool/issues/996), [#997](https://github.com/optave/ops-codegraph-tool/issues/997)
- Local code:
  - `src/features/snapshot.ts:18-131`
  - `src/domain/graph/journal.ts:5-105`
  - `src/db/connection.ts:102-141, 160-225, 262-299`
  - `.claude/hooks/enrich-context.sh:32-34`
