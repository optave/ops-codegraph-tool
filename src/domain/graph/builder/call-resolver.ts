/**
 * Shared call-edge resolution — used by both the full build pipeline
 * (build-edges.ts) and the incremental watch path (incremental.ts).
 *
 * Both callers supply a `CallNodeLookup` adapter that abstracts their
 * node-lookup mechanism (pre-loaded Maps vs. per-query SQLite statements).
 * The resolution logic lives here exactly once.
 */
import { computeConfidence } from '../resolve.js';

// ── Public interface ─────────────────────────────────────────────────────

export interface CallNodeLookup {
  byNameAndFile(
    name: string,
    file: string,
  ): ReadonlyArray<{ id: number; file: string; kind?: string }>;
  byName(name: string): ReadonlyArray<{ id: number; file: string; kind?: string }>;
  isBarrel(file: string): boolean;
  resolveBarrel(barrelFile: string, symbolName: string): string | null;
  nodeId(name: string, kind: string, file: string, line: number): { id: number } | undefined;
}

export const RECEIVER_KINDS = new Set(['class', 'struct', 'interface', 'type', 'module']);

/**
 * Languages where bare `foo()` calls inside a class method are lexically scoped
 * to the module, not the class — there is no implicit this/class binding.
 * For these languages, the same-class fallback must not run for bare (no-receiver)
 * calls that found no exact same-file match.
 */
const MODULE_SCOPED_BARE_CALL_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

export function isModuleScopedLanguage(relPath: string): boolean {
  const ext = relPath.slice(relPath.lastIndexOf('.'));
  return MODULE_SCOPED_BARE_CALL_EXTENSIONS.has(ext);
}

// ── Shared resolution functions ──────────────────────────────────────────

/**
 * Callable definition kinds — variable/constant bindings are NOT callable
 * in the function-as-enclosing-scope sense (they are local declarations, not
 * function bodies). Top-level variable bindings (e.g. Haskell `main = do …`)
 * are handled separately as a fallback tier.
 */
const CALLABLE_KINDS = new Set(['function', 'method']);

/**
 * Variable-like binding kinds that may act as top-level callers when no
 * enclosing function/method exists (e.g. Haskell top-level `main` is a
 * `bind` node → kind `variable`).  Local variable declarations inside a
 * function body must NOT win over the enclosing function.
 */
const TOP_LEVEL_BINDING_KINDS = new Set(['variable', 'constant']);

export function findCaller(
  lookup: CallNodeLookup,
  call: { line: number },
  definitions: ReadonlyArray<{
    name: string;
    kind: string;
    line: number;
    endLine?: number | null;
  }>,
  relPath: string,
  fileNodeRow: { id: number },
): { id: number; callerName: string | null } {
  // Pass 1: find the narrowest enclosing function/method.
  let fnCaller: { id: number } | null = null;
  let fnCallerName: string | null = null;
  let fnCallerSpan = Infinity;

  // Pass 2: find the widest (outermost) enclosing variable/constant binding.
  // Used as fallback when no function/method encloses the call site
  // (e.g. Haskell `main = do …` is a `bind` node with kind `variable`).
  // We pick the WIDEST span (outermost binding), not the narrowest, so that
  // nested `let` bindings inside `main`'s do-block do not shadow `main`
  // itself as the attributing caller.  The outermost enclosing variable is
  // the "function-like" top-level binding.
  let varCaller: { id: number } | null = null;
  let varCallerName: string | null = null;
  let varCallerSpan = -1; // looking for WIDEST span, so start at -1

  for (const def of definitions) {
    if (def.line <= call.line) {
      const end = def.endLine ?? Infinity;
      if (call.line <= end) {
        const span = end === Infinity ? Infinity : end - def.line;
        if (CALLABLE_KINDS.has(def.kind)) {
          if (span < fnCallerSpan) {
            const row = lookup.nodeId(def.name, def.kind, relPath, def.line);
            if (row) {
              fnCaller = row;
              fnCallerName = def.name;
              fnCallerSpan = span;
            }
          }
        } else if (TOP_LEVEL_BINDING_KINDS.has(def.kind)) {
          if (span > varCallerSpan) {
            const row = lookup.nodeId(def.name, def.kind, relPath, def.line);
            if (row) {
              varCaller = row;
              varCallerName = def.name;
              varCallerSpan = span;
            }
          }
        }
      }
    }
  }

  // Prefer function/method enclosing scope over variable binding.
  // If a function/method encloses the call, use it — local variable
  // declarations inside the function body must not shadow it.
  // Only fall back to a variable/constant binding when the call is at
  // top-level scope (no enclosing function/method found), which handles
  // languages like Haskell where `main` is a top-level `bind` node.
  if (fnCaller) {
    return { ...fnCaller, callerName: fnCallerName };
  }
  if (varCaller) {
    return { ...varCaller, callerName: varCallerName };
  }
  return { ...fileNodeRow, callerName: null };
}

export function resolveByMethodOrGlobal(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
  if (call.receiver) {
    // Strip "this." so `this.repo.method()` resolves via typeMap["repo"]
    // (or the "this.repo" key seeded directly by the TSC property-declaration enricher).
    const effectiveReceiver = call.receiver.startsWith('this.')
      ? call.receiver.slice('this.'.length)
      : call.receiver;
    // For this.prop receivers, prefer the class-scoped key (ClassName.prop) seeded by
    // handlePropWriteTypeMap / handleFieldDefTypeMap — prevents false edges when multiple
    // classes define the same property name (issues #1323, #1458).
    // Class-scoped lookup runs first so bare fallback keys (confidence 0.6) don't shadow
    // the correct per-class entry when callerName is available.
    let typeEntry: unknown;
    if (call.receiver.startsWith('this.') && callerName) {
      const dotIdx = callerName.lastIndexOf('.');
      if (dotIdx > -1) {
        const callerClass = callerName.slice(0, dotIdx);
        typeEntry = typeMap.get(`${callerClass}.${effectiveReceiver}`);
      }
    }
    typeEntry ??=
      typeMap.get(effectiveReceiver) ??
      typeMap.get(call.receiver) ??
      // Phase 8.3f: callee-scoped rest-param key (`callee::restName`) to avoid
      // same-name rest-binding collision across functions in the same file (#1358).
      (callerName ? typeMap.get(`${callerName}::${effectiveReceiver}`) : undefined);
    let typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : (typeEntry as { type?: string }).type
      : null;

    // Belt-and-suspenders fallback for inline new-expression receivers that
    // extractReceiverName did not normalise (e.g. raw text leaked from an
    // unhandled AST node type).  extractReceiverName already handles the common
    // `new_expression` / `parenthesized_expression(new_expression)` shapes by
    // returning the constructor name directly, so this branch is exercised only
    // by future node types or constructs that fall through to the raw-text path.
    // The uppercase-initial restriction ([A-Z_$]) is a heuristic to distinguish
    // constructors (PascalCase) from regular functions and avoids false positives
    // on `(new xmlParser()).parse()` style calls.
    if (!typeName && call.receiver) {
      const m = /^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/.exec(call.receiver);
      if (m?.[1]) typeName = m[1];
    }

    if (typeName) {
      const typed = lookup
        .byName(`${typeName}.${call.name}`)
        .filter((n) => n.kind === 'method' && computeConfidence(relPath, n.file, null) >= 0.5);
      if (typed.length > 0) return typed;

      // Prototype alias: `Foo.prototype.bar = identifier` seeds typeMap['Foo.bar'] = { type: identifier }.
      // Checked after the symbol-DB lookup so an actual method definition always wins.
      const protoEntry = typeMap.get(`${typeName}.${call.name}`);
      const protoTarget = protoEntry
        ? typeof protoEntry === 'string'
          ? protoEntry
          : (protoEntry as { type?: string }).type
        : null;
      if (protoTarget) {
        const resolved = lookup
          .byName(protoTarget)
          .filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
        if (resolved.length > 0) return resolved;
      }
    }

    // Direct qualified method lookup: ClassName.staticMethod() or ClassName.instanceMethod()
    // when the receiver is a class name with no typeMap entry. Handles static method calls
    // like `C6.staticMethod()` or `D.d()` where the receiver IS the class.
    // Matches both 'method' and 'function' kinds to cover field-initializer synthetic defs.
    if (!typeName) {
      const qualifiedName = `${effectiveReceiver}.${call.name}`;
      const direct = lookup
        .byName(qualifiedName)
        .filter(
          (n) =>
            (n.kind === 'method' || n.kind === 'function') &&
            computeConfidence(relPath, n.file, null) >= 0.5,
        );
      if (direct.length > 0) return direct;
    }

    // Phase 8.3d: composite pts key — `obj.prop = fn` seeds typeMap['obj.prop'] = { type: 'fn' }.
    // When a call site references `obj.prop` as a callback, resolve directly to the target fn.
    const compositeEntry = typeMap.get(`${call.receiver}.${call.name}`);
    const ptsTarget = compositeEntry
      ? typeof compositeEntry === 'string'
        ? compositeEntry
        : (compositeEntry as { type?: string }).type
      : null;
    if (ptsTarget) {
      const resolved = lookup
        .byName(ptsTarget)
        .filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
      if (resolved.length > 0) return resolved;
    }
  }
  if (
    !call.receiver ||
    call.receiver === 'this' ||
    call.receiver === 'self' ||
    call.receiver === 'super'
  ) {
    // Phase 8.3f: accessor this-dispatch via Object.defineProperty.
    // When a plain function (no class prefix) is registered as a get/set accessor for `obj`
    // via Object.defineProperty, typeMap seeds 'callerName:this' = 'obj'.
    // We then resolve this.method() → typeMap['obj.method'] → the concrete definition.
    // This runs before the broad exact-name lookup to avoid false positives from
    // unrelated same-file definitions.
    if (call.receiver === 'this' && callerName && !callerName.includes('.')) {
      const accessorThisEntry = typeMap.get(`${callerName}:this`);
      const objName = accessorThisEntry
        ? typeof accessorThisEntry === 'string'
          ? accessorThisEntry
          : (accessorThisEntry as { type?: string }).type
        : null;
      if (objName) {
        const objMethodEntry = typeMap.get(`${objName}.${call.name}`);
        const targetFn = objMethodEntry
          ? typeof objMethodEntry === 'string'
            ? objMethodEntry
            : (objMethodEntry as { type?: string }).type
          : null;
        if (targetFn) {
          const resolved = lookup
            .byName(targetFn)
            .filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
          if (resolved.length > 0) return resolved;
        }
      }
    }

    const exact = lookup
      .byName(call.name)
      .filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
    if (exact.length > 0) return exact;

    // Try same-class method lookup via callerName.
    // e.g. `this.area()` inside `Shape.describe` → try `Shape.area`.
    // Also covers no-receiver calls inside class methods, e.g. `IsValidEmail(x)` inside
    // `Validators.ValidateUser` → try `Validators.IsValidEmail` (C#/Java static siblings).
    // This seeds the initial edge that runChaPostPass later expands to subclass overrides.
    //
    // For JS/TS, bare (no-receiver) calls are module-scoped — there is no implicit class
    // binding. Skip the same-class fallback for bare calls in those languages to prevent
    // false positives (e.g. `flush()` inside `Processor.run` must not resolve to
    // `Processor.flush`). this.method() calls are unaffected: they still reach the fallback
    // because `call.receiver === 'this'` is truthy, not a bare call.
    const isBareCall = !call.receiver;
    if (callerName && !(isBareCall && isModuleScopedLanguage(relPath))) {
      const dotIdx = callerName.lastIndexOf('.');
      if (dotIdx > -1) {
        // Extract only the segment immediately before the method name so that
        // 'Namespace.ClassName.method' yields 'ClassName', not 'Namespace.ClassName'.
        // Symbols are stored under their bare class name, not their qualified path.
        const prevDot = callerName.lastIndexOf('.', dotIdx - 1);
        const callerClass = callerName.slice(prevDot + 1, dotIdx);
        const qualifiedName = `${callerClass}.${call.name}`;
        const sameClass = lookup
          .byName(qualifiedName)
          .filter((t) => t.kind === 'method' && computeConfidence(relPath, t.file, null) >= 0.5);
        if (sameClass.length > 0) return sameClass;
      }
    }
    return exact; // empty
  }
  return [];
}

export function resolveCallTargets(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  importedNames: Map<string, string>,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
): { targets: Array<{ id: number; file: string }>; importedFrom: string | undefined } {
  const importedFrom = importedNames.get(call.name);
  let targets: ReadonlyArray<{ id: number; file: string }> | undefined;

  if (importedFrom) {
    targets = lookup.byNameAndFile(call.name, importedFrom);
    if (targets.length === 0 && lookup.isBarrel(importedFrom)) {
      const actualSource = lookup.resolveBarrel(importedFrom, call.name);
      if (actualSource) {
        targets = lookup.byNameAndFile(call.name, actualSource);
      }
    }
  }

  if (!targets || targets.length === 0) {
    targets = lookup.byNameAndFile(call.name, relPath);
    if (targets.length === 0) {
      targets = resolveByMethodOrGlobal(lookup, call, relPath, typeMap, callerName);
    }
  }

  const resolved = [...(targets ?? [])];
  if (resolved.length > 1) {
    resolved.sort((a, b) => {
      const confA = computeConfidence(relPath, a.file, importedFrom ?? null);
      const confB = computeConfidence(relPath, b.file, importedFrom ?? null);
      return confB - confA;
    });
  }
  return { targets: resolved, importedFrom };
}

/**
 * Resolve the receiver-type edge for a call site.
 * Returns the edge tuple to insert, or null if nothing matched or the edge
 * was already seen.  Callers are responsible for the actual DB/array insert.
 *
 * Receiver resolution:
 * 1. Look up same-file nodes for `effectiveReceiver` (unfiltered by kind).
 * 2. If any same-file node exists AND `effectiveReceiver` is not in `importedNames`
 *    (i.e. it is a locally-defined symbol, not an import artifact), apply
 *    RECEIVER_KINDS and return the filtered set — no global fallback.
 *    A local `function C(){}` means this file owns `C`; no cross-file class
 *    should win over it (issue #1539).
 * 3. If the same-file node IS an import artifact (e.g. destructured require),
 *    or no same-file node exists at all, fall back to global candidates filtered
 *    by RECEIVER_KINDS.  This preserves the pre-#1539 behaviour for cases where
 *    an imported name appears as kind='function' in the importer file.
 */
export function resolveReceiverEdge(
  lookup: CallNodeLookup,
  call: { name: string; receiver: string },
  caller: { id: number },
  relPath: string,
  typeMap: Map<string, unknown>,
  seenCallEdges: Set<string>,
  importedNames: ReadonlyMap<string, string>,
): { callerId: number; receiverId: number; confidence: number } | null {
  const typeEntry = typeMap.get(call.receiver);
  const typeName = typeEntry
    ? typeof typeEntry === 'string'
      ? typeEntry
      : ((typeEntry as { type?: string }).type ?? null)
    : null;
  const typeConfidence =
    typeEntry && typeof typeEntry !== 'string'
      ? ((typeEntry as { confidence?: number }).confidence ?? null)
      : null;
  const effectiveReceiver = typeName || call.receiver;
  // Block global fallback only when the same-file node is a local definition,
  // not when it's an import artifact (e.g. `const { C } = require(…)` seeds a
  // kind='function' node in the importer but the real class lives elsewhere).
  const sameFileAll = lookup.byNameAndFile(effectiveReceiver, relPath);
  const isLocalDefinition = sameFileAll.length > 0 && !importedNames?.has(effectiveReceiver);
  const sameFileCandidates = sameFileAll.filter((n) => RECEIVER_KINDS.has(n.kind ?? ''));
  const candidates = isLocalDefinition
    ? sameFileCandidates
    : lookup.byName(effectiveReceiver).filter((n) => RECEIVER_KINDS.has(n.kind ?? ''));
  if (candidates.length === 0) return null;
  const recvTarget = candidates[0]!;
  const recvKey = `recv|${caller.id}|${recvTarget.id}`;
  if (seenCallEdges.has(recvKey)) return null;
  seenCallEdges.add(recvKey);
  return {
    callerId: caller.id,
    receiverId: recvTarget.id,
    confidence: typeConfidence ?? (typeName ? 0.9 : 0.7),
  };
}
