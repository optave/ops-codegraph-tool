import { DbError } from '../shared/errors.js';
import { DEAD_ROLE_PREFIX, EVERY_EDGE_KIND } from '../shared/kinds.js';
import type { BetterSqlite3Database, NativeDatabase } from '../types.js';

// ─── Validation Helpers ─────────────────────────────────────────────

const SAFE_ALIAS_RE = /^[a-z_][a-z0-9_]*$/i;
const SAFE_COLUMN_RE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/i;
// Matches: column, table.column, column ASC, table.column DESC
const SAFE_ORDER_TERM_RE = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?\s*(?:asc|desc)?$/i;
// Matches safe SELECT expressions: column refs, *, table.*, COALESCE(...) AS alias
const SAFE_SELECT_TOKEN_RE =
  /^(?:[a-z_][a-z0-9_]*(?:\.[a-z_*][a-z0-9_]*)?\s*(?:as\s+[a-z_][a-z0-9_]*)?|[a-z_]+\([^)]*\)\s*(?:as\s+[a-z_][a-z0-9_]*)?)$/i;

function validateAlias(alias: string): void {
  if (!SAFE_ALIAS_RE.test(alias)) {
    throw new DbError(`Invalid SQL alias: ${alias}`);
  }
}

function validateColumn(column: string): void {
  if (!SAFE_COLUMN_RE.test(column)) {
    throw new DbError(`Invalid SQL column: ${column}`);
  }
}

function validateOrderBy(clause: string): void {
  const terms = clause.split(',').map((t) => t.trim());
  for (const term of terms) {
    if (!SAFE_ORDER_TERM_RE.test(term)) {
      throw new DbError(`Invalid ORDER BY term: ${term}`);
    }
  }
}

function splitTopLevelCommas(str: string): string[] {
  const parts: string[] = [];
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

function validateSelectCols(cols: string): void {
  const tokens = splitTopLevelCommas(cols);
  for (const token of tokens) {
    if (!SAFE_SELECT_TOKEN_RE.test(token)) {
      throw new DbError(`Invalid SELECT expression: ${token}`);
    }
  }
}

function validateEdgeKind(edgeKind: string): void {
  if (!EVERY_EDGE_KIND.includes(edgeKind as never)) {
    throw new DbError(
      `Invalid edge kind: ${edgeKind} (expected one of ${EVERY_EDGE_KIND.join(', ')})`,
    );
  }
}

/** Runtime-validate that every param is string, number, or null before sending to nativeDb. */
function validateNativeParams(params: (string | number)[]): Array<string | number | null> {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p !== null && typeof p !== 'string' && typeof p !== 'number') {
      throw new DbError(`NodeQuery param[${i}] has unsupported type: ${typeof p}`);
    }
  }
  return params as Array<string | number | null>;
}

// ─── LIKE Escaping ──────────────────────────────────────────────────

/** Escape LIKE wildcards in a literal string segment. */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, '\\$&');
}

/**
 * Normalize a file filter value (string, string[], or falsy) into a flat array.
 * Returns an empty array when the input is falsy.
 */
export function normalizeFileFilter(file: string | string[] | undefined | null): string[] {
  if (!file) return [];
  return Array.isArray(file) ? file : [file];
}

/**
 * Build a SQL condition + params for a multi-value file LIKE filter.
 * Returns `{ sql: '', params: [] }` when the filter is empty.
 */
export function buildFileConditionSQL(
  file: string | string[],
  column = 'file',
): { sql: string; params: string[] } {
  validateColumn(column);
  const files = normalizeFileFilter(file);
  if (files.length === 0) return { sql: '', params: [] };
  if (files.length === 1) {
    return {
      sql: ` AND ${column} LIKE ? ESCAPE '\\'`,
      params: [`%${escapeLike(files[0] as string)}%`],
    };
  }
  const clauses = files.map(() => `${column} LIKE ? ESCAPE '\\'`);
  return {
    sql: ` AND (${clauses.join(' OR ')})`,
    params: files.map((f) => `%${escapeLike(f)}%`),
  };
}

/**
 * Commander option accumulator for repeatable `--file` flag.
 * Use as: `['-f, --file <path>', 'Scope to file (partial match, repeatable)', collectFile]`
 */
export function collectFile(val: string, acc?: string[]): string[] {
  acc = acc || [];
  acc.push(val);
  return acc;
}

// ─── Standalone Helpers ──────────────────────────────────────────────

/**
 * Return a SQL AND clause that excludes test/spec/stories files.
 * Returns empty string when disabled.
 */
export function testFilterSQL(column = 'n.file', enabled = true): string {
  if (!enabled) return '';
  validateColumn(column);
  return `AND ${column} NOT LIKE '%.test.%'
       AND ${column} NOT LIKE '%.spec.%'
       AND ${column} NOT LIKE '%__test__%'
       AND ${column} NOT LIKE '%__tests__%'
       AND ${column} NOT LIKE '%.stories.%'`;
}

/** Build IN (?, ?, ?) placeholders and params array for a kind filter. */
export function kindInClause(kinds: string[]): { placeholders: string; params: string[] } {
  return {
    placeholders: kinds.map(() => '?').join(', '),
    params: [...kinds],
  };
}

/**
 * Return a LEFT JOIN subquery for fan-in (incoming edge count).
 */
export function fanInJoinSQL(edgeKind = 'calls', alias = 'fi'): string {
  validateEdgeKind(edgeKind);
  validateAlias(alias);
  return `LEFT JOIN (
    SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = '${edgeKind}' GROUP BY target_id
  ) ${alias} ON ${alias}.target_id = n.id`;
}

/**
 * Return a LEFT JOIN subquery for fan-out (outgoing edge count).
 */
export function fanOutJoinSQL(edgeKind = 'calls', alias = 'fo'): string {
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
  #joins: string[] = [];
  #conditions: string[] = [];
  #params: (string | number)[] = [];
  #orderByClause = '';
  #limitValue: number | null = null;

  /** Set SELECT columns (default: `n.*`). */
  select(cols: string): this {
    validateSelectCols(cols);
    this.#selectCols = cols;
    return this;
  }

  /** WHERE n.kind IN (?, ?, ...) */
  kinds(kindArray: string[] | undefined | null): this {
    if (!kindArray || kindArray.length === 0) return this;
    const { placeholders, params } = kindInClause(kindArray);
    this.#conditions.push(`n.kind IN (${placeholders})`);
    this.#params.push(...params);
    return this;
  }

  /** Add 5 NOT LIKE conditions to exclude test files. No-op when enabled is falsy. */
  excludeTests(enabled: boolean | undefined): this {
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

  /** WHERE n.file LIKE ? (no-op if falsy). Accepts a single string or string[]. */
  fileFilter(file: string | string[] | undefined | null): this {
    const files = normalizeFileFilter(file);
    if (files.length === 0) return this;
    if (files.length === 1) {
      this.#conditions.push("n.file LIKE ? ESCAPE '\\'");
      this.#params.push(`%${escapeLike(files[0] as string)}%`);
    } else {
      const clauses = files.map(() => "n.file LIKE ? ESCAPE '\\'");
      this.#conditions.push(`(${clauses.join(' OR ')})`);
      this.#params.push(...files.map((f) => `%${escapeLike(f)}%`));
    }
    return this;
  }

  /** WHERE n.kind = ? (no-op if falsy). */
  kindFilter(kind: string | undefined | null): this {
    if (!kind) return this;
    this.#conditions.push('n.kind = ?');
    this.#params.push(kind);
    return this;
  }

  /** WHERE n.role = ? (no-op if falsy). 'dead' matches all dead-* sub-roles. */
  roleFilter(role: string | undefined | null): this {
    if (!role) return this;
    if (role === DEAD_ROLE_PREFIX) {
      this.#conditions.push('n.role LIKE ?');
      this.#params.push(`${DEAD_ROLE_PREFIX}%`);
    } else {
      this.#conditions.push('n.role = ?');
      this.#params.push(role);
    }
    return this;
  }

  /** WHERE n.name LIKE ? (no-op if falsy). Escapes LIKE wildcards in the value. */
  nameLike(pattern: string | undefined | null): this {
    if (!pattern) return this;
    this.#conditions.push("n.name LIKE ? ESCAPE '\\'");
    this.#params.push(`%${escapeLike(pattern)}%`);
    return this;
  }

  /** Raw WHERE condition escape hatch. */
  where(sql: string, ...params: (string | number)[]): this {
    this.#conditions.push(sql);
    this.#params.push(...params);
    return this;
  }

  /** Add fan-in LEFT JOIN subquery. */
  withFanIn(edgeKind = 'calls'): this {
    return this._join(fanInJoinSQL(edgeKind));
  }

  /** Add fan-out LEFT JOIN subquery. */
  withFanOut(edgeKind = 'calls'): this {
    return this._join(fanOutJoinSQL(edgeKind));
  }

  /** LEFT JOIN function_complexity. */
  withComplexity(): this {
    return this._join('LEFT JOIN function_complexity fc ON fc.node_id = n.id');
  }

  /** LEFT JOIN file_commit_counts. */
  withChurn(): this {
    return this._join('LEFT JOIN file_commit_counts fcc ON n.file = fcc.file');
  }

  /** @internal Raw JOIN — internal use only; external callers should use withFanIn/withFanOut/withComplexity/withChurn. */
  _join(sql: string): this {
    this.#joins.push(sql);
    return this;
  }

  /** ORDER BY clause. */
  orderBy(clause: string): this {
    validateOrderBy(clause);
    this.#orderByClause = clause;
    return this;
  }

  /** LIMIT ?. */
  limit(n: number | undefined | null): this {
    if (n == null) return this;
    this.#limitValue = n;
    return this;
  }

  /** Build the SQL and params without executing. */
  build(): { sql: string; params: (string | number)[] } {
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

  /** Execute and return all rows. When `nativeDb` is provided, dispatches through rusqlite. */
  all<TRow = Record<string, unknown>>(
    db: BetterSqlite3Database,
    nativeDb?: NativeDatabase,
  ): TRow[] {
    const { sql, params } = this.build();
    if (nativeDb) {
      return nativeDb.queryAll(sql, validateNativeParams(params)) as TRow[];
    }
    return db.prepare<TRow>(sql).all(...params) as TRow[];
  }

  /** Execute and return first row. When `nativeDb` is provided, dispatches through rusqlite. */
  get<TRow = Record<string, unknown>>(
    db: BetterSqlite3Database,
    nativeDb?: NativeDatabase,
  ): TRow | undefined {
    const { sql, params } = this.build();
    if (nativeDb) {
      return (nativeDb.queryGet(sql, validateNativeParams(params)) ?? undefined) as
        | TRow
        | undefined;
    }
    return db.prepare<TRow>(sql).get(...params) as TRow | undefined;
  }

  /** Execute and return an iterator. */
  iterate<TRow = Record<string, unknown>>(db: BetterSqlite3Database): IterableIterator<TRow> {
    const { sql, params } = this.build();
    return db.prepare<TRow>(sql).iterate(...params) as IterableIterator<TRow>;
  }
}
