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

/**
 * Compile a list of glob patterns. Invalid / empty patterns are skipped.
 */
export function compileGlobs(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue;
    try {
      out.push(globToRegex(p));
    } catch {
      // Ignore malformed patterns rather than failing the whole build.
    }
  }
  return out;
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
