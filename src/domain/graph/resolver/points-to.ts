/**
 * Phase 8.3 — Lightweight field-based points-to analysis for JS/TS.
 *
 * Resolves higher-order function calls where a named variable is an alias for
 * a function that the syntactic extractor cannot connect directly. Common
 * patterns resolved:
 *
 *   const fn = handler;        arr.map(fn)        → edge to handler
 *   const fn = obj.method;     router.use(fn)     → edge to obj.method
 *   const m = authMiddleware;  app.use(m)         → edge to authMiddleware
 *
 * Algorithm: Andersen-style inclusion-based analysis with allocation-site
 * abstraction and fixed-point constraint propagation.
 *
 * Field-based (not field-sensitive): all instances of obj.field are treated as
 * a single abstract location, matching ACG's sweet spot of 99% precision.
 *
 * Scope: intra-module + cross-module via importedNames (the importedNames map
 * that build-edges.ts already builds per file is the cross-module link — if
 * a variable aliases an imported name, resolveCallTargets follows it).
 */
import type { FnRefBinding, ParamBinding } from '../../../types.js';

export type PointsToMap = Map<string, Set<string>>;

/**
 * Maximum fixed-point iterations before bailing out (prevents divergence).
 * Mirrors `DEFAULTS.analysis.pointsToMaxIterations` in config.ts.
 * TODO(Phase 8.3): thread config through buildPointsToMap so this can be tuned
 * per-repo via `.codegraphrc.json` (tracked alongside typePropagationDepth).
 */
const MAX_SOLVER_ITERATIONS = 50;

/**
 * Build a points-to map for one file.
 *
 * Seeds concrete function names (locally-defined functions + imported names),
 * then propagates assignments through fixed-point iteration until stable.
 *
 * Each "concrete target" in a pts set is a name that `resolveCallTargets` can
 * look up — either a locally-defined function name (found via byNameAndFile) or
 * an imported name (found via importedNames → byNameAndFile in the source file).
 *
 * @param fnRefBindings    - identifier/member-expr bindings from the extractor
 * @param definitionNames  - locally-defined callable names in this file
 * @param importedNames    - names imported into this file (name → resolved file)
 * @param paramBindings    - call-site arg→param bindings (Phase 8.3c)
 * @param definitionParams - per-function ordered parameter names (Phase 8.3c)
 */
export function buildPointsToMap(
  fnRefBindings: readonly FnRefBinding[],
  definitionNames: ReadonlySet<string>,
  importedNames: ReadonlyMap<string, string>,
  paramBindings?: readonly ParamBinding[],
  definitionParams?: ReadonlyMap<string, readonly string[]>,
): PointsToMap {
  const pts: PointsToMap = new Map();

  // Seed: each locally-defined function points to itself.
  for (const name of definitionNames) {
    pts.set(name, new Set([name]));
  }

  // Seed: each imported name points to itself (importedNames resolves it to
  // the source file when resolveCallTargets is called with that name).
  for (const name of importedNames.keys()) {
    if (!pts.has(name)) pts.set(name, new Set([name]));
  }

  // Build constraint list: pts(lhs) ⊇ pts(rhsKey).
  // For member expressions (const fn = obj.method), key is "obj.method".
  // These composite keys won't be in pts unless a prior statement seeded them
  // (e.g. handlers.auth = authMiddleware); they produce no flow otherwise,
  // which is safe — no false edges.
  const constraints: Array<{ lhs: string; rhsKey: string }> = fnRefBindings.map((b) => ({
    lhs: b.lhs,
    rhsKey: b.rhsReceiver ? `${b.rhsReceiver}.${b.rhs}` : b.rhs,
  }));

  // Phase 8.3c: parameter-flow constraints.
  // For each call f(x) at argIndex i where f is locally defined, add
  // constraint: pts(f::paramName_i) ⊇ pts(x). This makes the pts solver
  // inter-procedural within the module so that `fn()` inside `f` resolves
  // to the concrete function passed at each call site.
  //
  // Keys are scoped as "callee::paramName" to prevent name collisions: bare
  // parameter names like `fn`, `cb`, and `callback` appear in many functions
  // within the same file. Without scoping, pts(fn) from runA and runB would
  // merge into a single set, producing spurious call edges. The scoped key is
  // resolved in buildFileCallEdges by combining the enclosing caller's name
  // with the call's name (see callerName::call.name lookup there).
  //
  // Scope: intra-module only (definitionParams contains local defs only).
  if (paramBindings && definitionParams) {
    for (const { callee, argIndex, argName } of paramBindings) {
      const params = definitionParams.get(callee);
      if (!params || argIndex >= params.length) continue;
      const paramName = params[argIndex];
      if (paramName) constraints.push({ lhs: `${callee}::${paramName}`, rhsKey: argName });
    }
  }

  if (constraints.length === 0) return pts;

  // Fixed-point iteration: propagate pts sets until no new information flows.
  for (let iter = 0; iter < MAX_SOLVER_ITERATIONS; iter++) {
    let changed = false;
    for (const { lhs, rhsKey } of constraints) {
      const rhsPts = pts.get(rhsKey);
      if (!rhsPts || rhsPts.size === 0) continue;
      let lhsPts = pts.get(lhs);
      if (!lhsPts) {
        lhsPts = new Set();
        pts.set(lhs, lhsPts);
      }
      const before = lhsPts.size;
      for (const target of rhsPts) lhsPts.add(target);
      if (lhsPts.size !== before) changed = true;
    }
    if (!changed) break;
  }

  return pts;
}

/**
 * Return the concrete function names that `callName` flows to, excluding
 * itself to prevent circular self-reference edges.
 *
 * Returns an empty array when callName is not in the pts map (i.e., it is
 * not an alias — the caller should fall back to normal resolution failure).
 */
export function resolveViaPointsTo(callName: string, pts: PointsToMap): string[] {
  const targets = pts.get(callName);
  if (!targets) return [];
  return [...targets].filter((t) => t !== callName);
}
