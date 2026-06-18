/**
 * Call resolution strategy helpers — extracted from call-resolver.ts.
 *
 * `resolveByMethodOrGlobal` in call-resolver.ts dispatches to two sub-strategies:
 *   - resolveByReceiver  — receiver is a concrete object/class (not this/self/super)
 *   - resolveByGlobal    — bare call or this/self/super receiver
 *
 * Splitting them here keeps each strategy unit-testable and reduces call-resolver.ts
 * cognitive complexity from 107 to a thin dispatcher.
 *
 * This file intentionally does NOT import from ../builder/call-resolver.ts to avoid
 * a circular dependency. The StrategyLookup interface mirrors CallNodeLookup structurally
 * (TypeScript structural typing ensures compatibility without an explicit import).
 */
import { computeConfidence } from '../resolve.js';

// ── Lookup adapter (structural mirror of CallNodeLookup) ──────────────────────

/**
 * Structural mirror of `CallNodeLookup` from call-resolver.ts.
 * Any `CallNodeLookup` instance satisfies this type without explicit declaration.
 * Defined here to break the circular import that would arise from importing
 * `CallNodeLookup` directly from call-resolver.ts.
 */
export interface StrategyLookup {
  byNameAndFile(
    name: string,
    file: string,
  ): ReadonlyArray<{ id: number; file: string; kind?: string }>;
  byName(name: string): ReadonlyArray<{ id: number; file: string; kind?: string }>;
  isBarrel(file: string): boolean;
  resolveBarrel(barrelFile: string, symbolName: string): string | null;
  nodeId(name: string, kind: string, file: string, line: number): { id: number } | undefined;
}

// ── Module-scoped language detection ─────────────────────────────────────────

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

// ── resolveByReceiver ─────────────────────────────────────────────────────────

/**
 * Resolve a call site whose receiver is a concrete object reference
 * (i.e. `receiver` is present and is NOT `this`, `self`, or `super`).
 *
 * Resolution cascade:
 *   1. typeMap class-scoped lookup (`ClassName.prop` key) for `this.prop` receivers.
 *   2. typeMap bare key, full-receiver key, callee-scoped rest-param key.
 *   3. Inline `new Ctor()` heuristic for un-normalised receiver text.
 *   4. Typed method lookup via `TypeName.methodName` in symbol DB.
 *   5. Prototype alias: `Foo.prototype.bar = identifier` via typeMap.
 *   6. Direct qualified method lookup: `ClassName.staticMethod()`.
 *   7. Composite pts key: `obj.prop` → callback target function.
 */
export function resolveByReceiver(
  lookup: StrategyLookup,
  call: { name: string; receiver: string },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
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

  return [];
}

// ── resolveByGlobal ───────────────────────────────────────────────────────────

/**
 * Resolve a call site with no receiver, or whose receiver is `this`, `self`,
 * or `super`.
 *
 * Resolution cascade:
 *   1. Accessor this-dispatch via Object.defineProperty (Phase 8.3f).
 *   2. Exact global name lookup with confidence filter.
 *   3. Same-class sibling method fallback (C#/Java static siblings, this.method()).
 */
export function resolveByGlobal(
  lookup: StrategyLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
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
