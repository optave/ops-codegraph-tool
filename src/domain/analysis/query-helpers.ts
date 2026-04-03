import { openReadonlyOrFail, openRepo, type Repository } from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../../types.js';

/**
 * Open a readonly DB connection, run `fn`, and close the DB on completion.
 * Eliminates the duplicated `openReadonlyOrFail` + `try/finally/db.close()` pattern
 * that appears in every analysis query function.
 */
export function withReadonlyDb<T>(
  customDbPath: string | undefined,
  fn: (db: BetterSqlite3Database) => T,
): T {
  const db = openReadonlyOrFail(customDbPath);
  try {
    return fn(db);
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
