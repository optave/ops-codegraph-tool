/**
 * Phase 8.5: Class Hierarchy Analysis (CHA) + Rapid Type Analysis (RTA)
 *
 * CHA resolves virtual/interface method dispatch to all known concrete
 * implementations.  RTA refines the CHA set by filtering out types that are
 * never instantiated in the program (no `new X()` anywhere in the codebase).
 *
 * Used by:
 *   - buildFileCallEdges (WASM/JS path) — inline during per-file edge building
 *   - buildChaPostPass (native path)    — JS post-pass on top of native edges
 */

import type { ExtractorOutput } from '../../../types.js';
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
      if (cls.implements) {
        let list = implementors.get(cls.implements);
        if (!list) {
          list = [];
          implementors.set(cls.implements, list);
        }
        if (!list.includes(cls.name)) list.push(cls.name);
      }
      if (cls.extends) {
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
    }

    // RTA: Phase 8.5 dedicated newExpressions list (all `new X()` in the file)
    if (symbols.newExpressions) {
      for (const typeName of symbols.newExpressions) {
        instantiatedTypes.add(typeName);
      }
    }
    // RTA fallback: constructor-confidence typeMap entries (confidence >= 0.9)
    // covers codebases that haven't been re-parsed since Phase 8.5 was added.
    if (symbols.typeMap instanceof Map) {
      for (const entry of symbols.typeMap.values()) {
        if (typeof entry !== 'string' && entry.confidence >= 0.9) {
          instantiatedTypes.add(entry.type);
        }
      }
    }
  }

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
