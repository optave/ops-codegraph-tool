# Incremental vs Full Builds

Codegraph defaults to incremental builds — only re-parsing files whose content has changed. This is fast (sub-second for small changes) and correct for most workflows. But some analysis data is only fully refreshed on a full rebuild, and understanding the difference helps you get accurate results.

---

## How incremental builds work

Codegraph uses a three-tier change detection strategy:

1. **Tier 0 — Journal:** If `codegraph watch` was running, a change journal records exactly which files were touched. The next build reads the journal — zero filesystem scanning.
2. **Tier 1 — mtime + size:** Without a journal, codegraph stats every file and compares mtime + size against stored values. Files that match are skipped without reading content.
3. **Tier 2 — Hash:** Files that fail the mtime/size check are read and MD5-hashed. Only files whose hash actually changed get re-parsed.

After detecting changes, the build pipeline runs these stages on the changed files:

- **Parse** — re-parse changed files with tree-sitter
- **Insert nodes** — purge old nodes for changed files, insert new definitions
- **Reverse-dependency cascade** — find files that import the changed files, rebuild their outgoing edges
- **Resolve imports** — re-resolve imports for changed files (and related barrel/re-export files)
- **Build edges** — rebuild call edges, scoped to changed files and their targets
- **Structure metrics** — update per-file metrics (fast path for ≤5 changed files)
- **Role classification** — reclassify roles for changed files' symbols
- **Analysis** — recompute AST nodes, complexity, CFG, and dataflow for changed files only

## What incremental builds skip

Some operations are **only run on full rebuilds** for performance reasons:

| Operation | Why it's skipped incrementally |
|-----------|-------------------------------|
| **Advisory checks** (orphaned embeddings, stale embeddings, unused exports) | These scan the entire DB — ~40-60ms cost that isn't worth paying on every small change |
| **Directory-level cohesion metrics** | For ≤5 changed files, directory-level metrics won't meaningfully shift — skipped to save ~8ms |
| **Build metadata persistence** | For ≤3 changed files, skipped to avoid WAL fsync overhead |
| **Incremental drift detection** | Compares node/edge counts vs previous build to detect corruption — only meaningful after a full rebuild |
| **Global repo registry update** | Repo is already registered from the initial full build |

### The practical impact

The most important thing to understand: **complexity, dataflow, and CFG data for files you didn't directly edit won't update incrementally.** If you refactor `utils.ts` and that changes the behavior of functions in `handler.ts` (which imports `utils.ts`), the edges from `handler.ts` are rebuilt (via the reverse-dependency cascade), but `handler.ts`'s complexity metrics and dataflow edges are not recomputed.

For most workflows — querying callers, checking impact, finding dead code — incremental builds are perfectly accurate. The staleness only matters for analysis-heavy queries (`complexity`, `dataflow`, `cfg`) on files that weren't directly modified.

---

## When to run a full rebuild

```bash
codegraph build --no-incremental
```

### You should run a full rebuild when:

**After large refactors or branch merges.** Moving, renaming, or deleting many files can leave stale edges or orphaned nodes. The reverse-dependency cascade handles most cases correctly, but a full rebuild guarantees a clean slate.

**If analysis data seems stale.** If `codegraph complexity` or `codegraph dataflow` returns results that don't match the current code, a full rebuild will recompute everything from scratch.

**After upgrading codegraph.** Engine changes, schema migrations, or major version bumps trigger an automatic full rebuild. But if you skip versions or aren't sure, `--no-incremental` is the safe choice.

**Periodically, if you rely on analysis queries.** If your workflow heavily uses `complexity`, `dataflow`, `cfg`, `communities --drift`, or `roles --role dead`, schedule a weekly full rebuild (or after major merges to main) to keep the data fresh.

**Before publishing audit results.** If you're generating reports with `codegraph audit`, `codegraph triage`, or `codegraph check` for CI or stakeholders, run a full rebuild first so the numbers reflect reality.

### You don't need a full rebuild when:

- You edited a few files and want to check impact — incremental handles this perfectly
- You're querying callers, paths, or dependencies — edge data is always current for changed files
- `codegraph watch` is running — it maintains a change journal for efficient incremental updates
- You just ran `git pull` and the `post-git-ops.sh` hook is active — it already ran a full rebuild for you

---

## Automatic full rebuild triggers

Codegraph forces a full rebuild automatically when it detects:

1. **Engine change** — switching between `native` and `wasm` (different parsers may produce slightly different node boundaries)
2. **Schema version change** — a DB migration was applied (new tables, columns, or indexes)
3. **Codegraph version change** — a new release may change extraction or resolution logic

These are detected from build metadata stored in the SQLite database. You don't need to remember to force a rebuild after upgrading — it happens automatically.

---

## Recommended rebuild schedule

| Workflow | Rebuild strategy |
|----------|-----------------|
| **Solo developer, daily work** | Incremental (default). Full rebuild weekly or after large merges. |
| **CI pipeline** | Full rebuild on main branch builds. Incremental on PR branches (with graph cache). |
| **AI agent sessions** | Incremental via hooks (automatic). Full rebuild at session start if the graph is older than a day. |
| **Before audits or reports** | Always full rebuild. |
| **After codegraph upgrade** | Automatic (version mismatch triggers full rebuild). |

---

## Checking build freshness

Use `codegraph stats` to see when the graph was last built and what engine was used:

```bash
codegraph stats
```

The output includes the build timestamp, engine, and node/edge counts. If the `built_at` timestamp is old relative to your recent changes, consider a full rebuild.

---

## Configuration

Disable incremental builds globally via `.codegraphrc.json`:

```json
{
  "build": {
    "incremental": false
  }
}
```

This forces every `codegraph build` to be a full rebuild. Not recommended for daily use (it's slower), but useful if you want to guarantee freshness in CI or automated pipelines.

The CLI flag `--no-incremental` overrides the config for a single invocation:

```bash
codegraph build --no-incremental   # Full rebuild this time only
codegraph build                     # Back to incremental (per config)
```

---

## Claude Code hooks and incremental builds

If you use the codegraph Claude Code hooks (see [hooks examples](../examples/claude-code-hooks/)), the hooks automatically manage full vs incremental builds using a **staleness marker** (`.codegraph/last-full-build`):

### How the staleness check works

1. **`update-graph.sh`** fires on every Edit/Write. It checks the marker file:
   - **Missing or older than 24 hours** → runs `codegraph build --no-incremental` (full rebuild, ~3.5s), then updates the marker
   - **Fresh (< 24 hours)** → runs `codegraph build` (incremental, ~1.5s)
2. **`post-git-ops.sh`** fires after `git merge/rebase/pull`. It always runs a full rebuild and updates the marker.

This means:
- The **first edit** of a new session (or after a long break) triggers a one-time full rebuild — complexity, dataflow, and cohesion data are refreshed for all files
- **Every subsequent edit** in the same session stays incremental (fast)
- **After merging main** into your branch, `post-git-ops.sh` does a full rebuild and resets the staleness clock

You never need to manually run `codegraph build --no-incremental` — the hooks handle it. The 24-hour threshold ensures analysis data never drifts more than a day behind, while keeping the per-edit overhead minimal.

### Customizing the staleness threshold

The default threshold is 86400 seconds (24 hours). To change it, edit the `STALE_SECONDS` variable in `update-graph.sh`:

```bash
STALE_SECONDS=43200  # 12 hours — more aggressive freshness
STALE_SECONDS=172800 # 48 hours — less frequent full rebuilds
```

For projects where you rarely use analysis queries (complexity, dataflow), a longer threshold reduces overhead. For projects where analysis accuracy matters, shorten it.

You can also add a periodic full rebuild to your git hooks. See [recommended-practices.md](./recommended-practices.md#periodic-full-rebuilds) for examples.
