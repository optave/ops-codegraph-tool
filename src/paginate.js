/**
 * Pagination utilities for bounded, context-friendly query results.
 *
 * Offset/limit pagination — the DB is a read-only snapshot so data doesn't
 * change between pages; offset/limit is simpler and maps directly to SQL.
 */

/** Default limits applied by MCP tool handlers (not by the programmatic API). */
export const MCP_DEFAULTS = {
  list_functions: 100,
  query_function: 50,
  where: 50,
  node_roles: 100,
  list_entry_points: 100,
  export_graph: 500,
};

/** Hard cap to prevent abuse via MCP. */
export const MCP_MAX_LIMIT = 1000;

/**
 * Paginate an array.
 *
 * When `limit` is undefined the input is returned unchanged (no-op).
 *
 * @param {any[]} items
 * @param {{ limit?: number, offset?: number }} opts
 * @returns {{ items: any[], pagination?: { total: number, offset: number, limit: number, hasMore: boolean, returned: number } }}
 */
export function paginate(items, { limit, offset } = {}) {
  if (limit === undefined && limit !== 0) {
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
 *
 * @param {object} result - The result object (e.g. `{ count: 42, functions: [...] }`)
 * @param {string} field  - The array field name to paginate (e.g. `'functions'`)
 * @param {{ limit?: number, offset?: number }} opts
 * @returns {object} - Result with paginated field + `_pagination` (if active)
 */
export function paginateResult(result, field, { limit, offset } = {}) {
  if (limit === undefined && limit !== 0) {
    return result;
  }
  const arr = result[field];
  if (!Array.isArray(arr)) return result;

  const { items, pagination } = paginate(arr, { limit, offset });
  return { ...result, [field]: items, _pagination: pagination };
}
