# `db.prepare()` Migration Audit

> **Phase 6.16** — Audit of all direct `better-sqlite3` `.prepare()` calls.
> Goal: every call routes through either `Repository` or `NativeDatabase` methods.

## Summary

| Tier | Layer | Files | Calls | Status |
|------|-------|-------|-------|--------|
| 0 | DB infrastructure | 4 | 7 | Done (repository + migrations) |
| 0 | Starter migrations | 2 | 3 | Done (6.16 PR) |
| 1 | Build pipeline | 7 | 52 | Next — ctx.nativeDb available |
| 2 | Domain analysis | 8 | 29 | Requires NativeDatabase in read path |
| 3 | Features | 14 | 94 | Requires NativeDatabase in read path |
| 3 | Shared utilities | 3 | 9 | Requires NativeDatabase in read path |
| — | **Total** | **43** | **194** | — |

## Tier 0 — Already Abstracted

These are either inside the Repository pattern or in schema migration code.

| File | Calls | Notes |
|------|-------|-------|
| `db/repository/build-stmts.ts` | 3 | Repository layer |
| `db/repository/cfg.ts` | 1 | Repository layer |
| `db/migrations.ts` | 3 | Schema DDL — keep as-is |

## Tier 0 — Starter Migrations (6.16 PR)

Converted to `nativeDb` dispatch in the 6.16 PR:

| File | Calls | What |
|------|-------|------|
| `domain/graph/builder/stages/detect-changes.ts` | 2 | file_hashes probe + full read |
| `domain/graph/builder/stages/build-structure.ts` | 1 | file node count |

## Tier 1 — Build Pipeline (ctx.nativeDb available)

These run during the build pipeline where `ctx.nativeDb` is already open.
Migrate using the same `ctx.nativeDb ? nativeDb.queryAll/queryGet(...) : db.prepare(...)` pattern.

| File | Calls | What |
|------|-------|------|
| `domain/graph/builder/stages/build-structure.ts` | 10 | dir metrics, role UPDATEs, line counts |
| `domain/graph/builder/stages/detect-changes.ts` | 7 | journal queries, mtime checks, CFG count |
| `domain/graph/builder/incremental.ts` | 6 | incremental rebuild queries |
| `domain/graph/builder/stages/build-edges.ts` | 5 | edge dedup, containment edges |
| `domain/graph/builder/stages/finalize.ts` | 5 | build metadata, embedding count |
| `domain/graph/builder/stages/resolve-imports.ts` | 4 | import resolution lookups |
| `domain/graph/builder/stages/insert-nodes.ts` | 3 | node insertion (JS fallback path) |
| `domain/graph/builder/stages/collect-files.ts` | 2 | file collection queries |
| `domain/graph/builder/helpers.ts` | 2 | utility queries |
| `domain/graph/watcher.ts` | 9 | watch mode incremental |

## Tier 2 — Domain Analysis (query-time, read-only)

These run in the query pipeline which currently uses `openReadonlyOrFail()` (better-sqlite3 only).
Migrating these requires adding NativeDatabase to the read path.

| File | Calls | What |
|------|-------|------|
| `domain/analysis/module-map.ts` | 20 | Module map queries (heaviest file) |
| `domain/analysis/symbol-lookup.ts` | 2 | Symbol search |
| `domain/analysis/dependencies.ts` | 2 | Dependency queries |
| `domain/analysis/diff-impact.ts` | 1 | Diff impact analysis |
| `domain/analysis/exports.ts` | 1 | Export analysis |
| `domain/analysis/fn-impact.ts` | 1 | Function impact |
| `domain/analysis/roles.ts` | 1 | Role queries |
| `domain/search/generator.ts` | 4 | Embedding generation |
| `domain/search/stores/fts5.ts` | 1 | FTS5 search |
| `domain/search/search/keyword.ts` | 1 | Keyword search |
| `domain/search/search/prepare.ts` | 1 | Search preparation |

## Tier 3 — Features Layer (query-time, read-only)

Same dependency as Tier 2 — requires NativeDatabase in the read path.

| File | Calls | What |
|------|-------|------|
| `features/structure.ts` | 21 | Structure analysis (heaviest) |
| `features/export.ts` | 13 | Graph export |
| `features/dataflow.ts` | 10 | Dataflow analysis |
| `features/structure-query.ts` | 9 | Structure queries |
| `features/audit.ts` | 7 | Audit command |
| `features/cochange.ts` | 6 | Co-change analysis |
| `features/branch-compare.ts` | 4 | Branch comparison |
| `features/check.ts` | 3 | CI check predicates |
| `features/owners.ts` | 3 | CODEOWNERS integration |
| `features/cfg.ts` | 2 | Control flow graph |
| `features/ast.ts` | 2 | AST queries |
| `features/manifesto.ts` | 2 | Rule engine |
| `features/sequence.ts` | 2 | Sequence diagrams |
| `features/complexity.ts` | 1 | Complexity metrics |
| `features/boundaries.ts` | 1 | Architecture boundaries |
| `features/shared/find-nodes.ts` | 1 | Shared node finder |

## Tier 3 — Shared Utilities

| File | Calls | What |
|------|-------|------|
| `shared/generators.ts` | 4 | Generator utilities |
| `shared/hierarchy.ts` | 4 | Hierarchy traversal |
| `shared/normalize.ts` | 1 | Normalization helpers |

## Migration Recipe

### For Tier 1 (build pipeline):
```typescript
// Before:
const row = db.prepare('SELECT ...').get(...args);

// After:
const sql = 'SELECT ...';
const row = ctx.nativeDb
  ? ctx.nativeDb.queryGet(sql, [...args])
  : db.prepare(sql).get(...args);
```

### For Tiers 2-3 (query pipeline):
Requires adding a `nativeDb` parameter to query-path functions, or opening
a NativeDatabase in `openReadonlyOrFail()`. This is phase 6.17+ work.

## Decision Log

- **`iterate()` stays on better-sqlite3**: rusqlite can't stream across FFI. Only used by `iterateFunctionNodes` — bounded row counts.
- **Migrations stay as-is**: Schema DDL runs once, no performance concern.
- **Features/analysis layers blocked on read-path NativeDatabase**: These only have a better-sqlite3 handle via `openReadonlyOrFail()`. Adding NativeDatabase to the read path is a phase 6.17 prerequisite.
