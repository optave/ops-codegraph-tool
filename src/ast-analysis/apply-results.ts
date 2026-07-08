/**
 * DB-free result-merging logic shared between the ast-analysis engine
 * (`ast-analysis/engine.ts`, main thread) and the WASM parse worker
 * (`domain/wasm-worker-entry.ts`, `worker_threads` thread).
 *
 * `walkWithVisitors` returns plain-data `WalkResults`; these functions take
 * that data plus a file's `Definition[]` and merge complexity/CFG results
 * back onto the matching definitions. No DB handle, no parser-global state
 * — safe to run on either side of the worker-thread boundary.
 *
 * Extracted per issue #1850 to eliminate a near-verbatim duplicate that had
 * independently carried the same bug in both copies (issue #1743).
 */
import type { CfgBlock, CfgEdge, Definition, TreeSitterNode, WalkResults } from '../types.js';
import { computeLOCMetrics, computeMaintainabilityIndex } from './metrics.js';

interface ComplexityFuncResult {
  funcNode: TreeSitterNode;
  funcName: string | null;
  metrics: {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    halstead?: { volume: number; difficulty: number; effort: number; bugs: number };
  };
}

interface CfgFuncResult {
  funcNode: TreeSitterNode;
  blocks: CfgBlock[];
  edges: CfgEdge[];
  cyclomatic?: number;
}

/** Check if a definition has a real function body (not a type signature). */
export function hasFuncBody(d: {
  name: string;
  kind: string;
  line: number;
  endLine?: number | null;
}): boolean {
  return (
    (d.kind === 'function' || d.kind === 'method') &&
    d.line > 0 &&
    d.endLine != null &&
    d.endLine > d.line &&
    !d.name.includes('.')
  );
}

/** Index per-function results by start line for O(1) lookup. */
export function indexByLine<T extends { funcNode: TreeSitterNode }>(
  results: T[],
): Map<number, T[]> {
  const byLine = new Map<number, T[]>();
  for (const r of results) {
    if (!r.funcNode) continue;
    const line = r.funcNode.startPosition.row + 1;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)?.push(r);
  }
  return byLine;
}

/** Find the best matching result for a definition by line + name. */
export function matchResultToDef<T extends { funcNode: TreeSitterNode }>(
  candidates: T[] | undefined,
  defName: string,
): T | undefined {
  if (!candidates) return undefined;
  if (candidates.length === 1) return candidates[0];
  return (
    candidates.find((r) => {
      const n = r.funcNode.childForFieldName('name');
      return n && n.text === defName;
    }) ?? candidates[0]
  );
}

/** Merge visitor-walk complexity results onto `defs`, matched by line + name. */
export function storeComplexityResults(
  results: WalkResults,
  defs: Definition[],
  langId: string,
): void {
  const byLine = indexByLine((results.complexity || []) as ComplexityFuncResult[]);
  for (const def of defs) {
    if ((def.kind === 'function' || def.kind === 'method') && def.line && !def.complexity) {
      const funcResult = matchResultToDef(byLine.get(def.line), def.name);
      if (!funcResult) continue;
      const { metrics } = funcResult;
      const loc = computeLOCMetrics(funcResult.funcNode, langId);
      const volume = metrics.halstead ? metrics.halstead.volume : 0;
      const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
      const mi = computeMaintainabilityIndex(volume, metrics.cyclomatic, loc.sloc, commentRatio);
      def.complexity = {
        cognitive: metrics.cognitive,
        cyclomatic: metrics.cyclomatic,
        maxNesting: metrics.maxNesting,
        halstead: metrics.halstead,
        loc,
        maintainabilityIndex: mi,
      };
    }
  }
}

/**
 * Merge visitor-walk CFG blocks/edges onto `defs`, matched by line + name.
 *
 * Intentionally does NOT touch `def.complexity.cyclomatic`: cyclomatic
 * complexity is computed once, correctly, from the AST DFS walk (which
 * counts short-circuit logical operators, optional chaining, and nested
 * function bodies — see `storeComplexityResults`, above). The CFG's
 * block/edge count (`edges - blocks + 2`) does NOT model any of those, so
 * using it to overwrite the AST-derived cyclomatic silently corrupts the
 * metric for any function using `&&`/`||`/`??`/`?.` or containing a closure
 * (issue #1743) — CFG blocks/edges are stored here purely for CFG
 * queries/visualization (`codegraph cfg`), not as a complexity source.
 */
export function storeCfgResults(results: WalkResults, defs: Definition[]): void {
  const byLine = indexByLine((results.cfg || []) as CfgFuncResult[]);
  for (const def of defs) {
    if (
      (def.kind === 'function' || def.kind === 'method') &&
      def.line &&
      !def.cfg?.blocks?.length
    ) {
      const cfgResult = matchResultToDef(byLine.get(def.line), def.name);
      if (!cfgResult) continue;
      def.cfg = { blocks: cfgResult.blocks, edges: cfgResult.edges };
    }
  }
}
