import { openReadonlyOrFail, openRepo, type Repository, resolveDbConfig } from '../../db/index.js';
import { DEFAULTS, loadConfig } from '../../infrastructure/config.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../../types.js';

/**
 * Open a readonly DB connection, run `fn`, and close the DB on completion.
 * Eliminates the duplicated `openReadonlyOrFail` + `try/finally/db.close()` pattern
 * that appears in every analysis query function.
 *
 * Resolves the config once and passes it to `fn` so callers that also need
 * `resolveAnalysisOpts` can reuse it as `opts.config` instead of triggering a
 * second `loadConfig()` for the same rootDir (#1763 review).
 */
export function withReadonlyDb<T>(
  customDbPath: string | undefined,
  fn: (db: BetterSqlite3Database, config: CodegraphConfig) => T,
): T {
  const config = resolveDbConfig(customDbPath);
  const busyTimeoutMs = config.db?.busyTimeoutMs ?? DEFAULTS.db.busyTimeoutMs;
  const db = openReadonlyOrFail(customDbPath, busyTimeoutMs);
  try {
    return fn(db, config);
  } finally {
    db.close();
  }
}

/**
 * Open a Repository (native-first, falling back to better-sqlite3), run `fn`,
 * and close on completion. Mirrors `withReadonlyDb` but routes queries through
 * the native Rust engine when available.
 */
export function withRepo<T>(
  customDbPath: string | undefined,
  fn: (repo: InstanceType<typeof Repository>) => T,
): T {
  const { repo, close } = openRepo(customDbPath);
  try {
    return fn(repo);
  } finally {
    close();
  }
}

/**
 * Resolve common analysis options into a normalized form.
 * Shared across fn-impact, context, dependencies, and exports modules.
 */
export function resolveAnalysisOpts(opts: { noTests?: boolean; config?: CodegraphConfig }): {
  noTests: boolean;
  config: CodegraphConfig;
  displayOpts: Record<string, unknown>;
} {
  const noTests = opts.noTests || false;
  const config = opts.config || loadConfig();
  const displayOpts = config.display || {};
  return { noTests, config, displayOpts };
}
