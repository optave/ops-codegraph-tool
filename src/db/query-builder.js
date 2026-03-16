import { DbError } from '../errors.js';
import { EVERY_EDGE_KIND } from '../kinds.js';

// ─── Validation Helpers ─────────────────────────────────────────────

const SAFE_ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
const SAFE_COLUMN_RE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i;
// Matches: column, table.column, column ASC, table.column DESC
const SAFE_ORDER_TERM_RE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?\s*(?:asc|desc)?$/i;
// Matches safe SELECT expressions: column refs, *, table.*, COALESCE(...) AS alias
const SAFE_SELECT_TOKEN_RE =
  /^(?:[a-z_][a-z0-9_]*(?:\.[a-z_*][a-z0-9_]*)?\s*(?:as\s+[a-z_][a-z0-9_]*)?|[a-z_]+\([^)]*\)\s*(?:as\s+[a-z_][a-z0-9_]*)?)$/i;

function validateAlias(alias) {
  if (!SAFE_ALIAS_RE.test(alias)) {
    throw new DbError(`Invalid SQL alias: ${alias}`);
  }
}

function validateColumn(column) {
  if (!SAFE_COLUMN_RE.test(column)) {
    throw new DbError(`Invalid SQL column: ${column}`);
  }
}

function validateOrderBy(clause) {
  const terms = clause.split(',').map((t) => t.trim());
  for (const term of terms) {
    if (!SAFE_ORDER_TERM_RE.test(term)) {
      throw new DbError(`Invalid ORDER BY term: ${term}`);
    }
  }
}

function splitTopLevelCommas(str) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') depth--;
    else if (str[i] === ',' && depth === 0) {
      parts.push(str.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(str.slice(start).trim());
  return parts;
}

function validateSelectCols(cols) {
  const tokens = splitTopLevelCommas(cols);
  for (const token of tokens) {
    if (!SAFE_SELECT_TOKEN_RE.test(token)) {
      throw new DbError(`Invalid SELECT expression: ${token}`);
    }
  }
}

function validateEdgeKind(edgeKind) {
  if (!EVERY_EDGE_KIND.includes(edgeKind)) {
    throw new DbError(
      `Invalid edge kind: ${edgeKind} (expected one of ${EVERY_EDGE_KIND.join(', ')})`,
    );
  }
}

// ─── LIKE Escaping ──────────────────────────────────────────────────

/** Escape LIKE wildcards in a literal string segment. */
export function escapeLike(s) {
  return s.replace(/[%_\\]/g, '\\$&');
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
    validateSelectCols(cols);
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

  /** WHERE n.file LIKE ? (no-op if falsy). Escapes LIKE wildcards in the value. */
  fileFilter(file) {
    if (!file) return this;
    this.#conditions.push("n.file LIKE ? ESCAPE '\\'");
    this.#params.push(`%${escapeLike(file)}%`);
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

  /** WHERE n.name LIKE ? (no-op if falsy). Escapes LIKE wildcards in the value. */
  nameLike(pattern) {
    if (!pattern) return this;
    this.#conditions.push("n.name LIKE ? ESCAPE '\\'");
    this.#params.push(`%${escapeLike(pattern)}%`);
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
    return this._join(fanInJoinSQL(edgeKind));
  }

  /** Add fan-out LEFT JOIN subquery. */
  withFanOut(edgeKind = 'calls') {
    return this._join(fanOutJoinSQL(edgeKind));
  }

  /** LEFT JOIN function_complexity. */
  withComplexity() {
    return this._join('LEFT JOIN function_complexity fc ON fc.node_id = n.id');
  }

  /** LEFT JOIN file_commit_counts. */
  withChurn() {
    return this._join('LEFT JOIN file_commit_counts fcc ON n.file = fcc.file');
  }

  /** @private Raw JOIN — internal use only; external callers should use withFanIn/withFanOut/withComplexity/withChurn. */
  _join(sql) {
    this.#joins.push(sql);
    return this;
  }

  /** ORDER BY clause. */
  orderBy(clause) {
    validateOrderBy(clause);
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
