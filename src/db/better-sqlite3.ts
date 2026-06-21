/**
 * Lazy-loaded better-sqlite3 constructor.
 *
 * Centralises the `createRequire` + cache pattern so every call site that
 * needs a JS-side SQLite handle can `import { getDatabase } from '…/db/better-sqlite3.js'`
 * instead of duplicating the boilerplate.  The native engine path (NativeDatabase /
 * rusqlite) never touches this module.
 */
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

const _require = createRequire(import.meta.url);
let _Database: typeof Database | undefined;

/** Return the `better-sqlite3` Database constructor, loading it on first call. */
export function getDatabase(): typeof Database {
  if (!_Database) {
    _Database = _require('better-sqlite3') as typeof Database;
  }
  return _Database!;
}
