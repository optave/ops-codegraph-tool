import { openReadonlyOrFail } from '../../db/index.js';
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
