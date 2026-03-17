/**
 * Match a file path against a glob pattern.
 * Supports *, **, and ? wildcards. Zero dependencies.
 */
export function globMatch(filePath, pattern) {
  // Normalize separators to forward slashes
  const normalized = filePath.replace(/\\/g, '/');
  // Escape regex specials except glob chars
  let regex = pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace ** first (matches any path segment), then * and ?
  regex = regex.replace(/\*\*/g, '\0');
  regex = regex.replace(/\*/g, '[^/]*');
  regex = regex.replace(/\0/g, '.*');
  regex = regex.replace(/\?/g, '[^/]');
  try {
    return new RegExp(`^${regex}$`).test(normalized);
  } catch {
    // Malformed pattern — fall back to substring match
    return normalized.includes(pattern);
  }
}

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;

/**
 * Apply post-query filters (glob pattern, noTests) to a set of rows.
 * Mutates nothing — returns a new filtered array.
 * @param {Array} rows - Rows with at least a `file` property
 * @param {object} opts
 * @param {string} [opts.filePattern] - Glob pattern (only applied if it contains glob chars)
 * @param {boolean} [opts.noTests] - Exclude test/spec files
 * @returns {Array}
 */
export function applyFilters(rows, opts = {}) {
  let filtered = rows;
  const fp = opts.filePattern;
  const fpArr = Array.isArray(fp) ? fp : fp ? [fp] : [];
  if (fpArr.length > 0) {
    filtered = filtered.filter((row) =>
      fpArr.some((p) => {
        const patternIsGlob = /[*?[\]]/.test(p);
        return patternIsGlob ? globMatch(row.file, p) : row.file.includes(p);
      }),
    );
  }
  if (opts.noTests) {
    filtered = filtered.filter((row) => !TEST_PATTERN.test(row.file));
  }
  return filtered;
}
