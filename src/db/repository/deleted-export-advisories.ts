/**
 * Deleted-export advisories — a durable, purge-order-independent record of
 * exported function/method/class definitions lost when a file is deleted in
 * its entirety, for deletions whose exports still have an external
 * consumer at the moment the file is removed.
 *
 * `checkNoDeletedExportsInUse` (features/check.ts) can only see this via a
 * live query while the deleted file's `nodes`/`edges` rows still exist in
 * the DB. Those rows are purged by the very next `codegraph build`
 * (`detectChanges` stage) regardless of whether `codegraph check` has run
 * yet — `check` never triggers a rebuild itself, so whether it can still see
 * a deleted file's exports depends entirely on external orchestration
 * ordering. This module lets the build pipeline snapshot the pre-purge
 * state into a durable table, at the exact point `detectChanges` computes
 * the removed-file set, so `check` can fall back to it once the live rows
 * are gone. See issue #1938.
 */
import type { BetterSqlite3Database, ExternalConsumerRow } from '../../types.js';
import { findExternalConsumers } from './edges.js';
import { findExportedDefinitions } from './nodes.js';

export interface DeletedExportAdvisoryEntry {
  file: string;
  name: string;
  kind: string;
  line: number;
  consumers: ExternalConsumerRow[];
}

interface DeletedExportAdvisoryRow {
  file: string;
  name: string;
  kind: string;
  line: number;
  consumer_name: string;
  consumer_file: string;
  consumer_line: number;
}

/**
 * `deleted_export_advisories` was only added in migration v21 — probe for it
 * rather than assuming it exists, matching the try/catch pattern used
 * throughout `build-stmts.ts` for other optional tables. A DB opened
 * read-only via `openReadonlyOrFail` (as `check` does) never runs
 * migrations, so an older DB genuinely may not have this table yet.
 */
function hasAdvisoryTable(db: BetterSqlite3Database): boolean {
  try {
    db.prepare('SELECT 1 FROM deleted_export_advisories LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshots, for each deleted export that still has an external consumer,
 * one row per consumer — captured by `detectChanges` BEFORE the build
 * pipeline purges the deleted file's `nodes`/`edges` rows.
 *
 * Replaces any pre-existing advisory rows for the same files first. This
 * keeps a single up-to-date snapshot per file rather than accumulating
 * duplicates: the `file_hashes` row for a removed file is intentionally
 * never purged on the incremental path (`purgeHashes: false` — see
 * `purgeAndAddReverseDeps`), so a subsequent build keeps re-detecting the
 * same file as "removed" and would otherwise re-run this capture every
 * time. In practice this is a no-op after the first capture — querying live
 * `nodes` for an already-purged file naturally returns nothing — but
 * replacing first keeps this correct even if that changes.
 */
export function recordDeletedExportAdvisories(
  db: BetterSqlite3Database,
  removedFiles: string[],
): void {
  if (removedFiles.length === 0 || !hasAdvisoryTable(db)) return;

  const deleteStmt = db.prepare('DELETE FROM deleted_export_advisories WHERE file = ?');
  const insertStmt = db.prepare(
    `INSERT INTO deleted_export_advisories
       (file, name, kind, line, consumer_name, consumer_file, consumer_line, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    const now = Date.now();
    for (const file of removedFiles) {
      deleteStmt.run(file);
      const defs = findExportedDefinitions(db, file);
      for (const def of defs) {
        const consumers = findExternalConsumers(db, def.id, file);
        for (const consumer of consumers) {
          insertStmt.run(
            file,
            def.name,
            def.kind,
            def.line,
            consumer.name,
            consumer.file,
            consumer.line,
            now,
          );
        }
      }
    }
  });
  tx();
}

/**
 * Clears advisory rows for files that are no longer deleted — e.g. a
 * previously-removed file reappearing under the same path (a revert, or an
 * unrelated new file created at the same location). Called for every file
 * about to be (re)inserted by the build pipeline, so a resolved deletion
 * never lingers to misattribute a stale violation to whatever now lives at
 * that path (#1938).
 */
export function clearDeletedExportAdvisories(db: BetterSqlite3Database, files: string[]): void {
  if (files.length === 0 || !hasAdvisoryTable(db)) return;
  const stmt = db.prepare('DELETE FROM deleted_export_advisories WHERE file = ?');
  const tx = db.transaction(() => {
    for (const file of files) stmt.run(file);
  });
  tx();
}

/**
 * Reads persisted deleted-export advisories for `files`, grouped back into
 * one entry per (file, name, kind, line) with its consumer list — the
 * inverse of `recordDeletedExportAdvisories`'s one-row-per-consumer layout.
 *
 * `excludeConsumerFiles` mirrors the live-DB path's identical filter
 * (`checkNoDeletedExportsInUse`): a consumer that is itself part of the same
 * deletion batch being checked right now isn't a caller left dangling by the
 * diff. This is applied here (against the *current* check invocation's
 * deleted-file set) rather than baked in at capture time, since the set of
 * files being deleted "together" from `check`'s point of view can differ
 * from the build-time removed-file batch that originally captured the
 * advisory.
 */
export function getDeletedExportAdvisories(
  db: BetterSqlite3Database,
  files: string[],
  excludeConsumerFiles: Set<string>,
): DeletedExportAdvisoryEntry[] {
  if (files.length === 0 || !hasAdvisoryTable(db)) return [];

  const placeholders = files.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT file, name, kind, line, consumer_name, consumer_file, consumer_line
       FROM deleted_export_advisories
       WHERE file IN (${placeholders})
       ORDER BY file, line`,
    )
    .all(...files) as DeletedExportAdvisoryRow[];

  const grouped = new Map<string, DeletedExportAdvisoryEntry>();
  for (const row of rows) {
    if (excludeConsumerFiles.has(row.consumer_file)) continue;
    const key = `${row.file}|${row.name}|${row.kind}|${row.line}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { file: row.file, name: row.name, kind: row.kind, line: row.line, consumers: [] };
      grouped.set(key, entry);
    }
    entry.consumers.push({
      name: row.consumer_name,
      file: row.consumer_file,
      line: row.consumer_line,
    });
  }
  return [...grouped.values()].filter((e) => e.consumers.length > 0);
}
