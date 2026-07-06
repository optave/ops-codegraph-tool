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
import { DEFAULTS } from '../../../infrastructure/config.js';
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
 * Seed the pts map from locally-defined functions, imported names, and
 * fnRefBindings (direct assignment aliases: `const fn = handler`).
 *
 * Returns the seeded pts map and the base constraint list built from
 * fnRefBindings (member-expression aliases: `const fn = obj.method`).
 */
function buildThisAssignmentMap(
  fnRefBindings: readonly FnRefBinding[],
  definitionNames: ReadonlySet<string>,
  importedNames: ReadonlyMap<string, string>,
): { pts: PointsToMap; constraints: Array<{ lhs: string; rhsKey: string }> } {
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

  return { pts, constraints };
}

/**
 * Phase 8.3c: parameter-flow constraints.
 *
 * For each call f(x) at argIndex i where f is locally defined, add
 * constraint: pts(f::paramName_i) ⊇ pts(x). This makes the pts solver
 * inter-procedural within the module so that `fn()` inside `f` resolves
 * to the concrete function passed at each call site.
 *
 * Keys are scoped as "callee::paramName" to prevent name collisions: bare
 * parameter names like `fn`, `cb`, and `callback` appear in many functions
 * within the same file. Without scoping, pts(fn) from runA and runB would
 * merge into a single set, producing spurious call edges. The scoped key is
 * resolved in buildFileCallEdges by combining the enclosing caller's name
 * with the call's name (see callerName::call.name lookup there).
 *
 * Scope: intra-module only (definitionParams contains local defs only).
 *
 * Appends to `constraints`.
 */
function buildParamFlowConstraints(
  constraints: Array<{ lhs: string; rhsKey: string }>,
  paramBindings?: readonly ParamBinding[],
  definitionParams?: ReadonlyMap<string, readonly string[]>,
): void {
  if (!paramBindings || !definitionParams) return;
  for (const { callee, argIndex, argName } of paramBindings) {
    const params = definitionParams.get(callee);
    if (!params || argIndex >= params.length) continue;
    const paramName = params[argIndex];
    if (paramName) constraints.push({ lhs: `${callee}::${paramName}`, rhsKey: argName });
  }
}

/**
 * Phase 8.3e: array-element bindings — seed concrete elements and wildcard.
 *
 * `arr[0]` etc. are seeded from literal arrays; `arr[*]` collects all elements.
 *
 * Mutates `pts` (seeds per-index entries) and appends to `constraints`.
 */
function buildArrayElemConstraints(
  pts: PointsToMap,
  constraints: Array<{ lhs: string; rhsKey: string }>,
  arrayElemBindings?: readonly ArrayElemBinding[],
): void {
  if (!arrayElemBindings || arrayElemBindings.length === 0) return;
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

/**
 * Build a per-array index count from arrayElemBindings for precise
 * per-index spread-argument constraints.
 */
function computeArrayMaxIndex(
  arrayElemBindings: readonly ArrayElemBinding[] | undefined,
): Map<string, number> {
  const arrayMaxIndex = new Map<string, number>();
  for (const { arrayName, index } of arrayElemBindings ?? []) {
    const cur = arrayMaxIndex.get(arrayName) ?? -1;
    if (index > cur) arrayMaxIndex.set(arrayName, index);
  }
  return arrayMaxIndex;
}

/**
 * Push spread-argument constraints for one callee: precise per-element
 * constraints when the source array's max index is known, otherwise a
 * wildcard constraint for every parameter at/after startIndex.
 */
function pushSpreadArgConstraintsForCallee(
  constraints: Array<{ lhs: string; rhsKey: string }>,
  callee: string,
  params: readonly string[],
  arrayName: string,
  startIndex: number,
  maxIdx: number,
): void {
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

/**
 * Phase 8.3e: spread-argument constraints.
 *
 * f(...arr) → pts[f::param_i] ⊇ pts[arr[i]] for each known element.
 *
 * Appends to `constraints`.
 */
function buildSpreadArgConstraints(
  constraints: Array<{ lhs: string; rhsKey: string }>,
  spreadArgBindings?: readonly SpreadArgBinding[],
  arrayElemBindings?: readonly ArrayElemBinding[],
  definitionParams?: ReadonlyMap<string, readonly string[]>,
): void {
  if (!spreadArgBindings || spreadArgBindings.length === 0 || !definitionParams) return;
  const arrayMaxIndex = computeArrayMaxIndex(arrayElemBindings);

  for (const { callee, arrayName, startIndex } of spreadArgBindings) {
    const params = definitionParams.get(callee);
    if (!params) continue;
    const maxIdx = arrayMaxIndex.get(arrayName) ?? -1;
    pushSpreadArgConstraintsForCallee(constraints, callee, params, arrayName, startIndex, maxIdx);
  }
}

/**
 * Phase 8.3e: for-of iteration constraints.
 *
 * `for (const x of arr)` inside `outer` → pts[outer::x] ⊇ pts[arr[*]]
 *
 * Appends to `constraints`.
 */
function buildForOfConstraints(
  constraints: Array<{ lhs: string; rhsKey: string }>,
  forOfBindings?: readonly ForOfBinding[],
): void {
  if (!forOfBindings) return;
  for (const { varName, sourceName, enclosingFunc } of forOfBindings) {
    constraints.push({ lhs: `${enclosingFunc}::${varName}`, rhsKey: `${sourceName}[*]` });
  }
}

/**
 * Phase 8.3e: Array.from / callback constraints.
 *
 * Array.from(source, cb) → pts[cb::param0] ⊇ pts[source[*]]
 *
 * Appends to `constraints`.
 */
function buildArrayCallbackConstraints(
  constraints: Array<{ lhs: string; rhsKey: string }>,
  arrayCallbackBindings?: readonly ArrayCallbackBinding[],
  definitionParams?: ReadonlyMap<string, readonly string[]>,
): void {
  if (!arrayCallbackBindings || !definitionParams) return;
  for (const { sourceName, calleeName } of arrayCallbackBindings) {
    const params = definitionParams.get(calleeName);
    if (!params || params.length === 0) continue;
    constraints.push({ lhs: `${calleeName}::${params[0]}`, rhsKey: `${sourceName}[*]` });
  }
}

/**
 * Append parameter-flow and array/spread/forOf/callback constraints (Phases 8.3c and 8.3e).
 *
 * Delegates to one named helper per binding kind (buildParamFlowConstraints,
 * buildArrayElemConstraints, buildSpreadArgConstraints, buildForOfConstraints,
 * buildArrayCallbackConstraints) — each handler owns exactly one binding kind's
 * guard + iteration + constraint-push shape, called in the same order the
 * original inline blocks ran in (none of the blocks read state written by an
 * earlier one, so extraction does not change solver input order).
 *
 * Mutates `pts` (seeds array-element entries) and appends to `constraints`.
 */
function buildParamAndArrayConstraints(
  pts: PointsToMap,
  constraints: Array<{ lhs: string; rhsKey: string }>,
  paramBindings?: readonly ParamBinding[],
  definitionParams?: ReadonlyMap<string, readonly string[]>,
  arrayElemBindings?: readonly ArrayElemBinding[],
  spreadArgBindings?: readonly SpreadArgBinding[],
  forOfBindings?: readonly ForOfBinding[],
  arrayCallbackBindings?: readonly ArrayCallbackBinding[],
): void {
  buildParamFlowConstraints(constraints, paramBindings, definitionParams);
  buildArrayElemConstraints(pts, constraints, arrayElemBindings);
  buildSpreadArgConstraints(constraints, spreadArgBindings, arrayElemBindings, definitionParams);
  buildForOfConstraints(constraints, forOfBindings);
  buildArrayCallbackConstraints(constraints, arrayCallbackBindings, definitionParams);
}

/**
 * Seed pts entries for object-rest parameter dispatch (Phase 8.3f).
 *
 * `function f({ ...rest }) {}` + `f(obj)` + `const obj = { prop: fn }` →
 * seeds pts["rest.prop"] = {"fn"} so that `rest.prop()` resolves to `fn`.
 *
 * Mutates `pts` in place.
 */
function buildObjectRestConstraints(
  pts: PointsToMap,
  definitionNames: ReadonlySet<string>,
  importedNames: ReadonlyMap<string, string>,
  paramBindings: readonly ParamBinding[],
  objectRestParamBindings: readonly ObjectRestParamBinding[],
  objectPropBindings: readonly ObjectPropBinding[],
): void {
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

/**
 * Append higher-order constraints to the constraint list based on how
 * function values flow through call sites, arrays, for-of loops, callbacks,
 * and object rest-param destructuring.
 *
 * Coordinates buildParamAndArrayConstraints (Phase 8.3c/e) and
 * buildObjectRestConstraints (Phase 8.3f).
 *
 * Mutates `pts` (seeds array-element and object-rest entries) and appends to `constraints`.
 */
function appendAdvancedConstraints(
  pts: PointsToMap,
  constraints: Array<{ lhs: string; rhsKey: string }>,
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
): void {
  buildParamAndArrayConstraints(
    pts,
    constraints,
    paramBindings,
    definitionParams,
    arrayElemBindings,
    spreadArgBindings,
    forOfBindings,
    arrayCallbackBindings,
  );

  if (objectRestParamBindings && objectPropBindings && paramBindings) {
    buildObjectRestConstraints(
      pts,
      definitionNames,
      importedNames,
      paramBindings,
      objectRestParamBindings,
      objectPropBindings,
    );
  }
}

/**
 * Run the fixed-point solver: propagate pts sets through constraints until
 * no new information flows (or `maxIterations` is reached).
 *
 * Mutates `pts` in place.
 */
function buildCallSiteTypeMap(
  pts: PointsToMap,
  constraints: ReadonlyArray<{ lhs: string; rhsKey: string }>,
  maxIterations: number,
): void {
  for (let iter = 0; iter < maxIterations; iter++) {
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
}

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
 * @param maxIterations         - fixed-point iteration cap before bailing out (prevents
 *                                divergence). Defaults to `DEFAULTS.analysis.pointsToMaxIterations`;
 *                                callers that already hold a resolved `CodegraphConfig` (e.g.
 *                                `buildPointsToMapForFile` in `stages/build-edges.ts`) pass the
 *                                user-configured value through explicitly. Mirrored by
 *                                `MAX_SOLVER_ITERATIONS` in the native Rust solver (`stages/build_edges.rs`).
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
  maxIterations: number = DEFAULTS.analysis.pointsToMaxIterations,
): PointsToMap {
  const { pts, constraints } = buildThisAssignmentMap(
    fnRefBindings,
    definitionNames,
    importedNames,
  );

  appendAdvancedConstraints(
    pts,
    constraints,
    definitionNames,
    importedNames,
    paramBindings,
    definitionParams,
    arrayElemBindings,
    spreadArgBindings,
    forOfBindings,
    arrayCallbackBindings,
    objectRestParamBindings,
    objectPropBindings,
  );

  if (constraints.length === 0) return pts;

  buildCallSiteTypeMap(pts, constraints, maxIterations);

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
