/**
 * Phase 8.5: Class Hierarchy Analysis (CHA) + Rapid Type Analysis (RTA)
 *
 * CHA resolves virtual/interface method dispatch to all known concrete
 * implementations.  RTA refines the CHA set by filtering out types that are
 * never instantiated in the program (no `new X()` anywhere in the codebase).
 *
 * Used by:
 *   - buildFileCallEdges (WASM/JS path)  — inline during per-file edge building,
 *     context built in-memory from all parsed fileSymbols (buildChaContext)
 *   - buildChaPostPass (native path)     — JS post-pass on top of native edges,
 *     context built in-memory from all parsed fileSymbols (buildChaContext)
 *   - incremental rebuild (watch mode)   — post-pass on top of a single-file
 *     rebuild's edges, context built from already-persisted DB state
 *     (buildChaContextFromDb) since only the rebuilt file + its reverse deps
 *     are held in memory, not the whole project (#1852)
 */

import type { BetterSqlite3Database, ClassRelation, ExtractorOutput } from '../../../types.js';
import type { CallNodeLookup } from './call-resolver.js';

// ── CHA context ──────────────────────────────────────────────────────────────

export interface ChaContext {
  /** interface/class name → concrete classes that implement or extend it */
  readonly implementors: ReadonlyMap<string, readonly string[]>;
  /** class name → direct parent class name (from `extends`) */
  readonly parents: ReadonlyMap<string, string>;
  /** RTA: class names that appear in `new X()` anywhere in the project */
  readonly instantiatedTypes: ReadonlySet<string>;
}

export const EMPTY_CHA_CONTEXT: ChaContext = {
  implementors: new Map(),
  parents: new Map(),
  instantiatedTypes: new Set(),
};

/**
 * Record a class's `implements` relationship into the implementors map
 * (interface/class name → concrete classes that implement it).
 */
function recordImplements(cls: ClassRelation, implementors: Map<string, string[]>): void {
  if (!cls.implements) return;
  let list = implementors.get(cls.implements);
  if (!list) {
    list = [];
    implementors.set(cls.implements, list);
  }
  if (!list.includes(cls.name)) list.push(cls.name);
}

/**
 * Record a class's `extends` relationship into both the parents map (child →
 * direct parent, for this/super hierarchy walking) and the implementors map
 * (parent → children, for CHA dispatch expansion via extends).
 */
function recordExtends(
  cls: ClassRelation,
  implementors: Map<string, string[]>,
  parents: Map<string, string>,
): void {
  if (!cls.extends) return;
  // child → parent (for this/super hierarchy walking)
  if (!parents.has(cls.name)) parents.set(cls.name, cls.extends);
  // parent → children (for CHA dispatch expansion via extends)
  let list = implementors.get(cls.extends);
  if (!list) {
    list = [];
    implementors.set(cls.extends, list);
  }
  if (!list.includes(cls.name)) list.push(cls.name);
}

/**
 * RTA: collect instantiated class names for one file's symbols — the Phase
 * 8.5 dedicated `newExpressions` list (all `new X()` in the file), plus the
 * constructor-confidence typeMap fallback (confidence >= 0.9) that covers
 * codebases that haven't been re-parsed since Phase 8.5 was added.
 */
function collectInstantiatedTypes(symbols: ExtractorOutput, instantiatedTypes: Set<string>): void {
  if (symbols.newExpressions) {
    for (const typeName of symbols.newExpressions) {
      instantiatedTypes.add(typeName);
    }
  }
  if (symbols.typeMap instanceof Map) {
    for (const entry of symbols.typeMap.values()) {
      if (typeof entry !== 'string' && entry.confidence >= 0.9) {
        instantiatedTypes.add(entry.type);
      }
    }
  }
}

/**
 * Build the CHA context from all parsed file symbols.
 *
 * Must be called AFTER cross-file return-type propagation so that typeMap
 * confidence values reflect propagated types (used for RTA seeding).
 */
export function buildChaContext(fileSymbols: ReadonlyMap<string, ExtractorOutput>): ChaContext {
  const implementors = new Map<string, string[]>();
  const parents = new Map<string, string>();
  const instantiatedTypes = new Set<string>();

  for (const symbols of fileSymbols.values()) {
    for (const cls of symbols.classes) {
      recordImplements(cls, implementors);
      recordExtends(cls, implementors, parents);
    }
    collectInstantiatedTypes(symbols, instantiatedTypes);
  }

  return { implementors, parents, instantiatedTypes };
}

/**
 * Build the CHA context by querying already-persisted DB state instead of
 * scanning in-memory fileSymbols.
 *
 * Used by the incremental single-file rebuild path (`buildCallEdges` in
 * `builder/incremental.ts`), where only the rebuilt file + its reverse deps
 * are held in memory — the class hierarchy (`extends`/`implements` edges)
 * and RTA instantiation evidence needed for correct CHA/RTA dispatch,
 * however, span the whole project and must come from the DB (#1852).
 *
 * RTA evidence is read from `calls` edges targeting `class`-kind nodes:
 * `new X()` is extracted as an ordinary call to `X` (see extractors'
 * `handleNewExpr`/equivalent), so a resolved constructor call already leaves
 * this evidence in the DB regardless of which engine or build (full or
 * incremental) wrote it — no separate `newExpressions` bookkeeping needed.
 *
 * Unlike `runPostNativeCha`'s DB-driven CHA post-pass (`stages/native-orchestrator.ts`),
 * this does not fall back to treating every class as instantiated when no RTA
 * evidence exists anywhere — it stays consistent with `resolveChaTargets`'
 * always-strict filtering, matching the semantics `buildChaContext` (in-memory)
 * already gives the WASM/JS full-build path.
 */
export function buildChaContextFromDb(db: BetterSqlite3Database): ChaContext {
  const hierarchyRows = db
    .prepare(`
      SELECT src.name AS child_name, tgt.name AS parent_name, e.kind AS edge_kind
      FROM edges e
      JOIN nodes src ON e.source_id = src.id
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind IN ('extends', 'implements')
    `)
    .all() as Array<{ child_name: string; parent_name: string; edge_kind: string }>;
  if (hierarchyRows.length === 0) return EMPTY_CHA_CONTEXT;

  const implementors = new Map<string, string[]>();
  const parents = new Map<string, string>();
  for (const row of hierarchyRows) {
    let list = implementors.get(row.parent_name);
    if (!list) {
      list = [];
      implementors.set(row.parent_name, list);
    }
    if (!list.includes(row.child_name)) list.push(row.child_name);
    if (row.edge_kind === 'extends' && !parents.has(row.child_name)) {
      parents.set(row.child_name, row.parent_name);
    }
  }

  const rtaRows = db
    .prepare(`
      SELECT DISTINCT tgt.name
      FROM edges e
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind = 'calls' AND tgt.kind = 'class'
    `)
    .all() as Array<{ name: string }>;
  const instantiatedTypes = new Set(rtaRows.map((r) => r.name));

  return { implementors, parents, instantiatedTypes };
}

// ── this / self / super resolution ──────────────────────────────────────────

/**
 * Resolve `this.method()`, `self.method()`, or `super.method()` through the
 * class hierarchy of the calling method.
 *
 * callerName must be a qualified method name ("ClassName.callerFn") for the
 * class context to be determinable.  Returns [] for plain functions.
 *
 * For `super`, resolution starts from the parent of the caller's class.
 * For `this`/`self`, resolution starts from the caller's own class and walks
 * up the inheritance chain (supporting inherited method lookup).
 *
 * When `callerFile` is provided, same-file method nodes are preferred: if the
 * hierarchy walk finds a qualified method that exists in both the caller's own
 * file AND in unrelated files (e.g. a class named `A` that appears in multiple
 * fixture files), only the same-file nodes are returned.  This prevents
 * cross-fixture false edges caused by accidental name collisions across
 * unrelated files in the same project build.  When no same-file nodes exist,
 * all found nodes are returned as before.
 */
export function resolveThisDispatch(
  methodName: string,
  callerName: string | null,
  receiver: 'this' | 'self' | 'super',
  chaCtx: ChaContext,
  lookup: CallNodeLookup,
  callerFile?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
  if (!callerName) return [];
  const dotIdx = callerName.indexOf('.');
  if (dotIdx === -1) return [];

  const callerClass = callerName.slice(0, dotIdx);
  const startClass = receiver === 'super' ? chaCtx.parents.get(callerClass) : callerClass;
  if (!startClass) return [];

  // Walk up the hierarchy; the visited set guards against cycles in malformed data.
  let current: string | undefined = startClass;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const qualified = `${current}.${methodName}`;
    const found = lookup.byName(qualified).filter((n) => n.kind === 'method');
    if (found.length > 0) {
      // When the caller's file is known, prefer same-file nodes to avoid
      // emitting cross-file edges to identically-named methods in unrelated
      // files.  Only fall back to the full set when no same-file node exists.
      if (callerFile && found.some((n) => n.file === callerFile)) {
        return found.filter((n) => n.file === callerFile);
      }
      return found;
    }
    current = chaCtx.parents.get(current);
  }
  return [];
}

// ── CHA dispatch expansion ───────────────────────────────────────────────────

/**
 * CHA + RTA: given a receiver type (class or interface), return all concrete
 * method implementations reachable via the class hierarchy.
 *
 * Only returns methods on types that are actually instantiated somewhere in
 * the project (RTA filter).  Returns [] when no concrete instantiated type
 * overrides the given method.
 *
 * BFS over the implementors map handles multi-level hierarchies (e.g.
 * IFoo → AbstractFoo → ConcreteFoo) so that abstract intermediate classes
 * are transparently skipped while their concrete subclasses are still reached.
 */
export function resolveChaTargets(
  typeName: string,
  methodName: string,
  chaCtx: ChaContext,
  lookup: CallNodeLookup,
): ReadonlyArray<{ id: number; file: string }> {
  const results: Array<{ id: number; file: string }> = [];

  const queue: string[] = [typeName];
  const visited = new Set<string>();
  visited.add(typeName);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = chaCtx.implementors.get(current);
    if (!children?.length) continue;

    for (const cls of children) {
      if (visited.has(cls)) continue;
      visited.add(cls);

      if (chaCtx.instantiatedTypes.has(cls)) {
        const qualified = `${cls}.${methodName}`;
        const found = lookup.byName(qualified).filter((n) => n.kind === 'method');
        results.push(...found);
      }

      // Traverse even non-instantiated classes — they may have instantiated subclasses.
      queue.push(cls);
    }
  }

  return results;
}
