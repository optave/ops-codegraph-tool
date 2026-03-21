/**
 * Pagination utilities for bounded, context-friendly query results.
 *
 * Offset/limit pagination — the DB is a read-only snapshot so data doesn't
 * change between pages; offset/limit is simpler and maps directly to SQL.
 */

export interface PaginationMeta {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  returned: number;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination?: PaginationMeta;
}

export interface PaginateOpts {
  limit?: number;
  offset?: number;
}

/** Default limits applied by MCP tool handlers (not by the programmatic API). */
export const MCP_DEFAULTS: Record<string, number> = {
  list_functions: 100,
  query: 10,
  where: 50,
  node_roles: 100,
  export_graph: 500,
  fn_impact: 5,
  context: 5,
  explain: 10,
  file_deps: 20,
  file_exports: 20,
  diff_impact: 30,
  impact_analysis: 20,
  semantic_search: 20,
  execution_flow: 50,
  hotspots: 20,
  co_changes: 20,
  complexity: 30,
  manifesto: 50,
  communities: 20,
  structure: 30,
  triage: 20,
  ast_query: 50,
};

/**
 * Get MCP page-size defaults, optionally merged with config overrides.
 */
export function getMcpDefaults(configDefaults?: Record<string, number>): Record<string, number> {
  if (!configDefaults) return MCP_DEFAULTS;
  return { ...MCP_DEFAULTS, ...configDefaults };
}

/** Hard cap to prevent abuse via MCP. */
export const MCP_MAX_LIMIT = 1000;

/**
 * Paginate an array.
 *
 * When `limit` is undefined the input is returned unchanged (no-op).
 */
export function paginate<T>(items: T[], { limit, offset }: PaginateOpts = {}): PaginatedResult<T> {
  if (limit === undefined) {
    return { items };
  }
  const total = items.length;
  const off = Math.max(0, Math.min(offset || 0, total));
  const lim = Math.max(0, limit);
  const page = items.slice(off, off + lim);
  return {
    items: page,
    pagination: {
      total,
      offset: off,
      limit: lim,
      hasMore: off + lim < total,
      returned: page.length,
    },
  };
}

/**
 * Apply pagination to a named array field on a result object.
 *
 * When `limit` is undefined the result is returned unchanged (backward compat).
 * When active, `_pagination` metadata is added to the result.
 */
export function paginateResult<T extends Record<string, unknown>>(
  result: T,
  field: string,
  { limit, offset }: PaginateOpts = {},
): T & { _pagination?: PaginationMeta } {
  if (limit === undefined) {
    return result;
  }
  const arr = result[field];
  if (!Array.isArray(arr)) return result;

  const { items, pagination } = paginate(arr, { limit, offset });
  return { ...result, [field]: items, _pagination: pagination };
}

/**
 * Print data as newline-delimited JSON (NDJSON).
 *
 * Emits a `_meta` line with pagination info (if present), then one JSON
 * line per item in the named array field.
 */
export function printNdjson(
  data: Record<string, unknown> & { _pagination?: PaginationMeta },
  field: string,
): void {
  if (data._pagination) console.log(JSON.stringify({ _meta: data._pagination }));
  const items = data[field];
  if (Array.isArray(items)) {
    for (const item of items) console.log(JSON.stringify(item));
  }
}
