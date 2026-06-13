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
import type {
  ArrayCallbackBinding,
  ArrayElemBinding,
  FnRefBinding,
  ForOfBinding,
  ObjectPropBinding,
  ObjectRestParamBinding,
  ParamBinding,
  SpreadArgBinding,
} from '../../../types.js';

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
 * @param fnRefBindings         - identifier/member-expr bindings from the extractor
 * @param definitionNames       - locally-defined callable names in this file
 * @param importedNames         - names imported into this file (name → resolved file)
 * @param paramBindings         - call-site arg→param bindings (Phase 8.3c)
 * @param definitionParams      - per-function ordered parameter names (Phase 8.3c)
 * @param arrayElemBindings     - array literal element bindings (Phase 8.3e)
 * @param spreadArgBindings     - spread-argument bindings (Phase 8.3e)
 * @param forOfBindings         - for-of iteration variable bindings (Phase 8.3e)
 * @param arrayCallbackBindings - Array.from/callback bindings (Phase 8.3e)
 */
export function buildPointsToMap(
  fnRefBindings: readonly FnRefBinding[],
  definitionNames: ReadonlySet<string>,
  importedNames: ReadonlyMap<string, string>,
  paramBindings?: readonly ParamBinding[],
  definitionParams?: ReadonlyMap<string, readonly string[]>,
  arrayElemBindings?: readonly ArrayElemBinding[],
  spreadArgBindings?: readonly SpreadArgBinding[],
  forOfBindings?: readonly ForOfBinding[],
  arrayCallbackBindings?: readonly ArrayCallbackBinding[],
  objectRestParamBindings?: readonly ObjectRestParamBinding[],
  objectPropBindings?: readonly ObjectPropBinding[],
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

  // Phase 8.3e: array-element bindings — seed concrete elements and wildcard.
  // `arr[0]` etc. are seeded from literal arrays; `arr[*]` collects all elements.
  if (arrayElemBindings && arrayElemBindings.length > 0) {
    for (const { arrayName, index, elemName } of arrayElemBindings) {
      const elemKey = `${arrayName}[${index}]`;
      const wildcardKey = `${arrayName}[*]`;
      // Seed the per-index entry if the elemName is a concrete function.
      if (!pts.has(elemKey)) pts.set(elemKey, new Set());
      pts.get(elemKey)!.add(elemName);
      // Wildcard: array[*] collects all element targets for imprecise spread/for-of.
      constraints.push({ lhs: wildcardKey, rhsKey: elemKey });
    }
  }

  // Phase 8.3e: spread-argument constraints.
  // f(...arr) → pts[f::param_i] ⊇ pts[arr[i]] for each known element.
  if (spreadArgBindings && spreadArgBindings.length > 0 && definitionParams) {
    // Build a per-array index count from arrayElemBindings for precise per-index constraints.
    const arrayMaxIndex = new Map<string, number>();
    for (const { arrayName, index } of arrayElemBindings ?? []) {
      const cur = arrayMaxIndex.get(arrayName) ?? -1;
      if (index > cur) arrayMaxIndex.set(arrayName, index);
    }

    for (const { callee, arrayName, startIndex } of spreadArgBindings) {
      const params = definitionParams.get(callee);
      if (!params) continue;
      const maxIdx = arrayMaxIndex.get(arrayName) ?? -1;
      if (maxIdx >= 0) {
        // Precise: per-element constraints.
        for (let i = 0; i <= maxIdx; i++) {
          const paramIdx = startIndex + i;
          if (paramIdx >= params.length) break;
          constraints.push({ lhs: `${callee}::${params[paramIdx]}`, rhsKey: `${arrayName}[${i}]` });
        }
      } else {
        // Unknown array size: all params at/after startIndex get the wildcard.
        for (let j = startIndex; j < params.length; j++) {
          constraints.push({ lhs: `${callee}::${params[j]}`, rhsKey: `${arrayName}[*]` });
        }
      }
    }
  }

  // Phase 8.3e: for-of iteration constraints.
  // `for (const x of arr)` inside `outer` → pts[outer::x] ⊇ pts[arr[*]]
  if (forOfBindings) {
    for (const { varName, sourceName, enclosingFunc } of forOfBindings) {
      constraints.push({ lhs: `${enclosingFunc}::${varName}`, rhsKey: `${sourceName}[*]` });
    }
  }

  // Phase 8.3e: Array.from / callback constraints.
  // Array.from(source, cb) → pts[cb::param0] ⊇ pts[source[*]]
  if (arrayCallbackBindings && definitionParams) {
    for (const { sourceName, calleeName } of arrayCallbackBindings) {
      const params = definitionParams.get(calleeName);
      if (!params || params.length === 0) continue;
      constraints.push({ lhs: `${calleeName}::${params[0]}`, rhsKey: `${sourceName}[*]` });
    }
  }

  // Phase 8.3f: object-rest parameter dispatch.
  // `function f({ ...rest }) {}` + `f(obj)` + `const obj = { prop: fn }` →
  // seed pts["rest.prop"] = {"fn"} so that `rest.prop()` resolves to `fn`.
  if (objectRestParamBindings && objectPropBindings && paramBindings) {
    // Index paramBindings: "callee::argIndex" → argName[] (O(|paramBindings|) build,
    // O(1) lookup — avoids scanning paramBindings for each rest binding).
    const paramByCalleeIdx = new Map<string, string[]>();
    for (const { callee, argIndex, argName } of paramBindings) {
      const k = `${callee}::${argIndex}`;
      const list = paramByCalleeIdx.get(k);
      if (list) list.push(argName);
      else paramByCalleeIdx.set(k, [argName]);
    }

    // Index objectPropBindings: objectName → {propName, valueName}[]
    const propsByObject = new Map<string, Array<{ propName: string; valueName: string }>>();
    for (const { objectName, propName, valueName } of objectPropBindings) {
      const list = propsByObject.get(objectName);
      if (list) list.push({ propName, valueName });
      else propsByObject.set(objectName, [{ propName, valueName }]);
    }

    for (const { callee, restName, argIndex } of objectRestParamBindings) {
      const argNames = paramByCalleeIdx.get(`${callee}::${argIndex}`) ?? [];
      for (const argName of argNames) {
        const props = propsByObject.get(argName) ?? [];
        for (const { propName, valueName } of props) {
          if (!definitionNames.has(valueName) && !importedNames.has(valueName)) continue;
          const key = `${restName}.${propName}`;
          if (!pts.has(key)) pts.set(key, new Set());
          pts.get(key)!.add(valueName);
        }
      }
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
