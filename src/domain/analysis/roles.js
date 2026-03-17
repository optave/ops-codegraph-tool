import { openReadonlyOrFail } from '../../db/index.js';
import { warn } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';

export function rolesData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const filterRole = opts.role || null;
    const filterFile = opts.file || null;

    const conditions = ['role IS NOT NULL'];
    const params = [];

    // When noTests + filtering for 'dead', also include 'test-only' candidates
    // (they are stored as non-dead roles but may need reclassification)
    if (filterRole && filterRole !== 'test-only') {
      conditions.push('role = ?');
      params.push(filterRole);
    } else if (filterRole === 'test-only') {
      // test-only is not stored in DB; we need all symbols to reclassify
      // Fetch everything and filter after reclassification
    }
    if (filterFile) {
      conditions.push('file LIKE ?');
      params.push(`%${filterFile}%`);
    }

    let rows = db
      .prepare(
        `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
      )
      .all(...params);

    if (noTests) {
      rows = rows.filter((r) => !isTestFile(r.file));
    }

    if (noTests || filterRole === 'test-only') {
      // Reclassify symbols whose only callers are in test files as 'test-only'.
      // A symbol that has fanIn > 0 at build time (all edges) but fanIn === 0
      // when test-file callers are excluded should be 'test-only' instead of
      // whatever role it was assigned with the full graph.
      const testOnlyIds = _findTestOnlyCalledIds(db);
      for (const r of rows) {
        if (testOnlyIds.has(`${r.name}\0${r.file}\0${r.line}`)) {
          r.role = 'test-only';
        }
      }
    }

    // If we were asked for a specific role, filter now (after reclassification)
    if (filterRole) {
      rows = rows.filter((r) => r.role === filterRole);
    }

    const summary = {};
    for (const r of rows) {
      summary[r.role] = (summary[r.role] || 0) + 1;
    }

    const hc = new Map();
    const symbols = rows.map((r) => normalizeSymbol(r, db, hc));
    const base = { count: symbols.length, summary, symbols };
    return paginateResult(base, 'symbols', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

/**
 * Find node keys (name\0file\0line) for symbols whose callers are ALL in test files.
 * These symbols have fanIn > 0 in the full graph but would have fanIn === 0
 * if test-file edges were excluded.
 */
function _findTestOnlyCalledIds(db) {
  const hasTestNodes = db
    .prepare(
      `SELECT 1 FROM nodes WHERE file LIKE '%.test.%' OR file LIKE '%.spec.%' OR file LIKE '%__tests__%' LIMIT 1`,
    )
    .get();
  if (!hasTestNodes) {
    warn(
      'No test-file nodes in the graph — cannot determine test-only callers. Rebuild without -T to include test files.',
    );
    return new Set();
  }

  // Get all non-test symbols that have at least one caller
  const rows = db
    .prepare(
      `SELECT target.name, target.file, target.line,
              caller.file AS caller_file
       FROM edges e
       JOIN nodes target ON e.target_id = target.id
       JOIN nodes caller ON e.source_id = caller.id
       WHERE e.kind = 'calls'
         AND target.kind NOT IN ('file', 'directory')`,
    )
    .all();

  // Group callers by target symbol
  const callersByTarget = new Map();
  for (const r of rows) {
    const key = `${r.name}\0${r.file}\0${r.line}`;
    if (!callersByTarget.has(key))
      callersByTarget.set(key, { hasTestCaller: false, hasNonTestCaller: false });
    const entry = callersByTarget.get(key);
    if (isTestFile(r.caller_file)) {
      entry.hasTestCaller = true;
    } else {
      entry.hasNonTestCaller = true;
    }
  }

  // Return keys where ALL callers are in test files
  const result = new Set();
  for (const [key, entry] of callersByTarget) {
    if (entry.hasTestCaller && !entry.hasNonTestCaller) {
      result.add(key);
    }
  }
  return result;
}
