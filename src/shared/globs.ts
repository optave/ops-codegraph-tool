/**
 * Glob → RegExp conversion utilities.
 *
 * Shared by boundary rules (`features/boundaries.ts`) and the file-collection
 * include/exclude filters (`domain/graph/builder/helpers.ts`). Keeping a single
 * implementation ensures users get consistent glob semantics everywhere.
 *
 * Supported syntax:
 *   - `**` matches any sequence of characters including `/`
 *   - `*`  matches any sequence of characters except `/`
 *   - `?`  matches a single non-slash character
 *   - other regex metacharacters are escaped literally
 *
 * Paths must use forward slashes (callers normalize before testing).
 */

/**
 * Compile a glob pattern into a `RegExp` anchored with `^…$`.
 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*' && pattern[i + 1] === '*') {
      i += 2;
      if (pattern[i] === '/') {
        // `**/` matches zero or more full path segments, preserving the
        // directory boundary before the next segment. Without this, patterns
        // like `**/foo.ts` would compile to `^.*foo\.ts$` and match
        // `barfoo.ts`, diverging from Rust `globset` semantics.
        re += '(?:[^/]+/)*';
        i++;
      } else {
        // Bare `**` (e.g. `dir/**`, or trailing) matches anything.
        re += '.*';
      }
    } else if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

const EMPTY_REGEX_LIST: readonly RegExp[] = Object.freeze([]) as readonly RegExp[];

// Compile results are cached by pattern content so a long-running host
// (watch mode, MCP server) doesn't recompile on every buildGraph call.
// Capped to avoid unbounded growth when callers pass many distinct lists.
const COMPILE_CACHE_MAX = 32;
const compileCache = new Map<string, readonly RegExp[]>();

function buildCacheKey(patterns: readonly string[]): string {
  // JSON.stringify avoids ambiguity when patterns legitimately contain any
  // single character (including control characters or separators a caller
  // might choose): ["a", "bc"] → '["a","bc"]' vs ["ab", "c"] → '["ab","c"]'.
  return JSON.stringify(patterns);
}

/**
 * Compile a list of glob patterns. Invalid / empty patterns are skipped.
 *
 * Results are memoized per pattern-content so repeated `buildGraph` calls
 * with the same include/exclude lists reuse the compiled regexes. The
 * returned array is shared across callers and must not be mutated.
 */
export function compileGlobs(patterns: readonly string[] | undefined): readonly RegExp[] {
  if (!patterns || patterns.length === 0) return EMPTY_REGEX_LIST;
  const key = buildCacheKey(patterns);
  const cached = compileCache.get(key);
  if (cached) return cached;
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue;
    try {
      out.push(globToRegex(p));
    } catch {
      // Ignore malformed patterns rather than failing the whole build.
    }
  }
  const frozen = Object.freeze(out) as readonly RegExp[];
  if (compileCache.size >= COMPILE_CACHE_MAX) {
    // FIFO eviction — Map iterates insertion order. Config pattern sets
    // are small and stable, so a simple cap is sufficient.
    const first = compileCache.keys().next().value;
    if (first !== undefined) compileCache.delete(first);
  }
  compileCache.set(key, frozen);
  return frozen;
}

/**
 * Clear the compiled-glob cache. Intended for long-running hosts that
 * need to reload config (e.g. watch mode after `.codegraphrc.json` edits)
 * and for test isolation.
 */
export function clearGlobCache(): void {
  compileCache.clear();
}

/**
 * `true` when at least one compiled pattern matches the given path.
 *
 * The path must already be normalized to forward slashes.
 */
export function matchesAny(regexes: readonly RegExp[], path: string): boolean {
  for (const re of regexes) {
    if (re.test(path)) return true;
  }
  return false;
}
