/**
 * Shared renderer for transitive-caller "impact levels" — the `{ level -> entries[] }`
 * map produced by `bfsTransitiveCallers` (see domain/analysis/fn-impact.js).
 *
 * Both `codegraph audit` (presentation/audit.js) and `codegraph fn-impact`
 * (presentation/queries-cli/impact.js) render this same shape and must stay
 * visually identical — this module is the single source of truth for that format.
 */

import { kindIcon } from '../domain/queries.js';

/** A single transitive-caller entry within one impact-level bucket. */
export interface ImpactLevelRef {
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface RenderImpactLevelsOpts {
  /**
   * Message printed when there are no levels at all. Pass `null` to print nothing
   * (e.g. when the caller already reports a "0" count immediately above).
   * Default: "  No callers found."
   */
  emptyMessage?: string | null;
  /** Max entries shown per level before truncating with "... and N more". Default: 20. */
  limit?: number;
}

/**
 * Render a transitive-caller level map as indented, icon-prefixed bullet lists —
 * one block per BFS level, with deeper levels indented further:
 *
 *   -- Level 1 (2 functions):
 *       ^ f caller  src/a.ts:10
 *       ^ m Caller.method  src/b.ts:20
 *   ---- Level 2 (1 functions):
 *         ^ f transitiveCaller  src/c.ts:5
 */
export function renderImpactLevels(
  levels: Record<string, ImpactLevelRef[]>,
  opts: RenderImpactLevelsOpts = {},
): void {
  const { emptyMessage = '  No callers found.', limit = 20 } = opts;

  if (Object.keys(levels).length === 0) {
    if (emptyMessage) console.log(emptyMessage);
    return;
  }

  for (const [level, fns] of Object.entries(levels).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const l = parseInt(level, 10);
    console.log(`  ${'--'.repeat(l)} Level ${level} (${fns.length} functions):`);
    for (const f of fns.slice(0, limit)) {
      console.log(`    ${'  '.repeat(l)}^ ${kindIcon(f.kind)} ${f.name}  ${f.file}:${f.line}`);
    }
    if (fns.length > limit) console.log(`    ... and ${fns.length - limit} more`);
  }
}
