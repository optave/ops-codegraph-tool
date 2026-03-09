import { EVERY_EDGE_KIND } from '../queries.js';

// ─── Validation Helpers ─────────────────────────────────────────────

const SAFE_ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
const SAFE_COLUMN_RE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i;

function validateAlias(alias) {
  if (!SAFE_ALIAS_RE.test(alias)) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
}

function validateColumn(column) {
  if (!SAFE_COLUMN_RE.test(column)) {
    throw new Error(`Invalid SQL column: ${column}`);
  }
}

function validateEdgeKind(edgeKind) {
  if (!EVERY_EDGE_KIND.includes(edgeKind)) {
    throw new Error(
      `Invalid edge kind: ${edgeKind} (expected one of ${EVERY_EDGE_KIND.join(', ')})`,
    );
  }
}

// ─── Standalone Helpers ──────────────────────────────────────────────

/**
 * Return a SQL AND clause that excludes test/spec/stories files.
 * Returns empty string when disabled.
 * @param {string} [column='n.file'] - Column to filter on
 * @param {boolean} [enabled=true] - No-op when false
 */
export function testFilterSQL(column = 'n.file', enabled = true) {
  if (!enabled) return '';
  validateColumn(column);
  return `AND ${column} NOT LIKE '%.test.%'
       AND ${column} NOT LIKE '%.spec.%'
       AND ${column} NOT LIKE '%__test__%'
       AND ${column} NOT LIKE '%__tests__%'
       AND ${column} NOT LIKE '%.stories.%'`;
}

/**
 * Build IN (?, ?, ?) placeholders and params array for a kind filter.
 * @param {string[]} kinds
 * @returns {{ placeholders: string, params: string[] }}
 */
export function kindInClause(kinds) {
  return {
    placeholders: kinds.map(() => '?').join(', '),
    params: [...kinds],
  };
}

/**
 * Return a LEFT JOIN subquery for fan-in (incoming edge count).
 * @param {string} [edgeKind='calls'] - Edge kind to count
 * @param {string} [alias='fi'] - Subquery alias
 */
export function fanInJoinSQL(edgeKind = 'calls', alias = 'fi') {
  validateEdgeKind(edgeKind);
  validateAlias(alias);
  return `LEFT JOIN (
    SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = '${edgeKind}' GROUP BY target_id
  ) ${alias} ON ${alias}.target_id = n.id`;
}

/**
 * Return a LEFT JOIN subquery for fan-out (outgoing edge count).
 * @param {string} [edgeKind='calls'] - Edge kind to count
 * @param {string} [alias='fo'] - Subquery alias
 */
export function fanOutJoinSQL(edgeKind = 'calls', alias = 'fo') {
  validateEdgeKind(edgeKind);
  validateAlias(alias);
  return `LEFT JOIN (
    SELECT source_id, COUNT(*) AS cnt FROM edges WHERE kind = '${edgeKind}' GROUP BY source_id
  ) ${alias} ON ${alias}.source_id = n.id`;
}

// ─── NodeQuery Fluent Builder ────────────────────────────────────────

/**
 * Fluent builder for the common `SELECT ... FROM nodes n WHERE ...` pattern.
 * Not an ORM — complex queries (BFS, correlated subqueries) stay as raw SQL.
 */
export class NodeQuery {
  #selectCols = 'n.*';
  #joins = [];
  #conditions = [];
  #params = [];
  #orderByClause = '';
  #limitValue = null;

  /** Set SELECT columns (default: `n.*`). */
  select(cols) {
    this.#selectCols = cols;
    return this;
  }

  /** WHERE n.kind IN (?, ?, ...) */
  kinds(kindArray) {
    if (!kindArray || kindArray.length === 0) return this;
    const { placeholders, params } = kindInClause(kindArray);
    this.#conditions.push(`n.kind IN (${placeholders})`);
    this.#params.push(...params);
    return this;
  }

  /** Add 5 NOT LIKE conditions to exclude test files. No-op when enabled is falsy. */
  excludeTests(enabled) {
    if (!enabled) return this;
    this.#conditions.push(
      `n.file NOT LIKE '%.test.%'`,
      `n.file NOT LIKE '%.spec.%'`,
      `n.file NOT LIKE '%__test__%'`,
      `n.file NOT LIKE '%__tests__%'`,
      `n.file NOT LIKE '%.stories.%'`,
    );
    return this;
  }

  /** WHERE n.file LIKE ? (no-op if falsy). */
  fileFilter(file) {
    if (!file) return this;
    this.#conditions.push('n.file LIKE ?');
    this.#params.push(`%${file}%`);
    return this;
  }

  /** WHERE n.kind = ? (no-op if falsy). */
  kindFilter(kind) {
    if (!kind) return this;
    this.#conditions.push('n.kind = ?');
    this.#params.push(kind);
    return this;
  }

  /** WHERE n.role = ? (no-op if falsy). */
  roleFilter(role) {
    if (!role) return this;
    this.#conditions.push('n.role = ?');
    this.#params.push(role);
    return this;
  }

  /** WHERE n.name LIKE ? (no-op if falsy). */
  nameLike(pattern) {
    if (!pattern) return this;
    this.#conditions.push('n.name LIKE ?');
    this.#params.push(`%${pattern}%`);
    return this;
  }

  /** Raw WHERE condition escape hatch. */
  where(sql, ...params) {
    this.#conditions.push(sql);
    this.#params.push(...params);
    return this;
  }

  /** Add fan-in LEFT JOIN subquery. */
  withFanIn(edgeKind = 'calls') {
    this.#joins.push(fanInJoinSQL(edgeKind));
    return this;
  }

  /** Add fan-out LEFT JOIN subquery. */
  withFanOut(edgeKind = 'calls') {
    this.#joins.push(fanOutJoinSQL(edgeKind));
    return this;
  }

  /** LEFT JOIN function_complexity. */
  withComplexity() {
    this.#joins.push('LEFT JOIN function_complexity fc ON fc.node_id = n.id');
    return this;
  }

  /** LEFT JOIN file_commit_counts. */
  withChurn() {
    this.#joins.push('LEFT JOIN file_commit_counts fcc ON n.file = fcc.file');
    return this;
  }

  /** Raw JOIN escape hatch. */
  join(sql) {
    this.#joins.push(sql);
    return this;
  }

  /** ORDER BY clause. */
  orderBy(clause) {
    this.#orderByClause = clause;
    return this;
  }

  /** LIMIT ?. */
  limit(n) {
    if (n == null) return this;
    this.#limitValue = n;
    return this;
  }

  /** Build the SQL and params without executing. */
  build() {
    const joins = this.#joins.length > 0 ? `\n       ${this.#joins.join('\n       ')}` : '';
    const where =
      this.#conditions.length > 0 ? `\n       WHERE ${this.#conditions.join(' AND ')}` : '';
    const orderBy = this.#orderByClause ? `\n       ORDER BY ${this.#orderByClause}` : '';

    let limitClause = '';
    const params = [...this.#params];
    if (this.#limitValue != null) {
      limitClause = '\n       LIMIT ?';
      params.push(this.#limitValue);
    }

    const sql = `SELECT ${this.#selectCols}\n       FROM nodes n${joins}${where}${orderBy}${limitClause}`;
    return { sql, params };
  }

  /** Execute and return all rows. */
  all(db) {
    const { sql, params } = this.build();
    return db.prepare(sql).all(...params);
  }

  /** Execute and return first row. */
  get(db) {
    const { sql, params } = this.build();
    return db.prepare(sql).get(...params);
  }

  /** Execute and return an iterator. */
  iterate(db) {
    const { sql, params } = this.build();
    return db.prepare(sql).iterate(...params);
  }
}
