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

// ── typeMap entry unwrapping ──────────────────────────────────────────────────

/**
 * Unwrap a typeMap entry to its plain string form.
 *
 * typeMap values are either a bare string (the target name) or an object of
 * shape `{ type?: string }` (some seeders attach extra metadata alongside the
 * target). This normalises both shapes to `string | null`, matching the
 * falsy-check semantics every call site previously duplicated inline.
 */
function unwrapTypeEntry(entry: unknown): string | null {
  if (!entry) return null;
  return typeof entry === 'string' ? entry : ((entry as { type?: string }).type ?? null);
}

// ── resolveByReceiver ─────────────────────────────────────────────────────────

/**
 * Steps 1-3 of the resolveByReceiver cascade: resolve the type name for a
 * concrete-object receiver.
 *
 *   1. typeMap class-scoped lookup (`ClassName.prop` key) for `this.prop` receivers.
 *   2. typeMap bare key, full-receiver key, callee-scoped rest-param key.
 *   3. Inline `new Ctor()` heuristic for un-normalised receiver text.
 */
function resolveReceiverTypeName(
  typeMap: Map<string, unknown>,
  receiver: string,
  effectiveReceiver: string,
  callerName?: string | null,
): string | null {
  // For this.prop receivers, prefer the class-scoped key (ClassName.prop) seeded by
  // handlePropWriteTypeMap / handleFieldDefTypeMap — prevents false edges when multiple
  // classes define the same property name (issues #1323, #1458).
  // Class-scoped lookup runs first so bare fallback keys (confidence 0.6) don't shadow
  // the correct per-class entry when callerName is available.
  let typeEntry: unknown;
  if (receiver.startsWith('this.') && callerName) {
    const dotIdx = callerName.lastIndexOf('.');
    if (dotIdx > -1) {
      const callerClass = callerName.slice(0, dotIdx);
      typeEntry = typeMap.get(`${callerClass}.${effectiveReceiver}`);
    }
  }
  typeEntry ??=
    typeMap.get(effectiveReceiver) ??
    typeMap.get(receiver) ??
    // Phase 8.3f: callee-scoped rest-param key (`callee::restName`) to avoid
    // same-name rest-binding collision across functions in the same file (#1358).
    (callerName ? typeMap.get(`${callerName}::${effectiveReceiver}`) : undefined);

  let typeName = unwrapTypeEntry(typeEntry);

  // Belt-and-suspenders fallback for inline new-expression receivers that
  // extractReceiverName did not normalise (e.g. raw text leaked from an
  // unhandled AST node type).  extractReceiverName already handles the common
  // `new_expression` / `parenthesized_expression(new_expression)` shapes by
  // returning the constructor name directly, so this branch is exercised only
  // by future node types or constructs that fall through to the raw-text path.
  // The uppercase-initial restriction ([A-Z_$]) is a heuristic to distinguish
  // constructors (PascalCase) from regular functions and avoids false positives
  // on `(new xmlParser()).parse()` style calls.
  if (!typeName && receiver) {
    const m = /^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/.exec(receiver);
    if (m?.[1]) typeName = m[1];
  }

  return typeName;
}

/** Step 4: typed method lookup via `TypeName.methodName` in the symbol DB. */
function resolveViaTypedMethod(
  lookup: StrategyLookup,
  typeName: string,
  call: { name: string },
  relPath: string,
): ReadonlyArray<{ id: number; file: string }> {
  return lookup
    .byName(`${typeName}.${call.name}`)
    .filter((n) => n.kind === 'method' && computeConfidence(relPath, n.file, null) >= 0.5);
}

/**
 * Step 5: prototype alias — `Foo.prototype.bar = identifier` seeds
 * typeMap['Foo.bar'] = { type: identifier }.
 * Checked after the symbol-DB lookup so an actual method definition always wins.
 */
function resolveViaPrototypeAlias(
  lookup: StrategyLookup,
  typeMap: Map<string, unknown>,
  typeName: string,
  call: { name: string },
  relPath: string,
): ReadonlyArray<{ id: number; file: string }> {
  const protoTarget = unwrapTypeEntry(typeMap.get(`${typeName}.${call.name}`));
  if (!protoTarget) return [];
  return lookup.byName(protoTarget).filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
}

/**
 * Step 6: direct qualified method lookup — `ClassName.staticMethod()` or
 * `ClassName.instanceMethod()` when the receiver is a class name with no
 * typeMap entry. Handles static method calls like `C6.staticMethod()` or
 * `D.d()` where the receiver IS the class. Matches both 'method' and
 * 'function' kinds to cover field-initializer synthetic defs.
 */
function resolveViaDirectQualifiedMethod(
  lookup: StrategyLookup,
  effectiveReceiver: string,
  call: { name: string },
  relPath: string,
): ReadonlyArray<{ id: number; file: string }> {
  const qualifiedName = `${effectiveReceiver}.${call.name}`;
  return lookup
    .byName(qualifiedName)
    .filter(
      (n) =>
        (n.kind === 'method' || n.kind === 'function') &&
        computeConfidence(relPath, n.file, null) >= 0.5,
    );
}

/**
 * Step 7: composite pts key — `obj.prop = fn` seeds typeMap['obj.prop'] = { type: 'fn' }
 * (Phase 8.3d). When a call site references `obj.prop` as a callback, resolve
 * directly to the target fn.
 */
function resolveViaCompositePtsKey(
  lookup: StrategyLookup,
  typeMap: Map<string, unknown>,
  call: { name: string; receiver: string },
  relPath: string,
): ReadonlyArray<{ id: number; file: string }> {
  const ptsTarget = unwrapTypeEntry(typeMap.get(`${call.receiver}.${call.name}`));
  if (!ptsTarget) return [];
  return lookup.byName(ptsTarget).filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
}

/**
 * Resolve a call site whose receiver is a concrete object reference
 * (i.e. `receiver` is present and is NOT `this`, `self`, or `super`).
 *
 * Resolution cascade (see the per-step helpers above for the numbered steps):
 *   1-3. resolveReceiverTypeName    — typeMap lookups + `new Ctor()` heuristic.
 *   4.   resolveViaTypedMethod      — typed method lookup in symbol DB.
 *   5.   resolveViaPrototypeAlias   — prototype alias via typeMap.
 *   6.   resolveViaDirectQualifiedMethod — direct qualified method lookup.
 *   7.   resolveViaCompositePtsKey  — composite pts key → callback target function.
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

  const typeName = resolveReceiverTypeName(typeMap, call.receiver, effectiveReceiver, callerName);

  if (typeName) {
    const typed = resolveViaTypedMethod(lookup, typeName, call, relPath);
    if (typed.length > 0) return typed;

    const viaPrototype = resolveViaPrototypeAlias(lookup, typeMap, typeName, call, relPath);
    if (viaPrototype.length > 0) return viaPrototype;
  } else {
    const direct = resolveViaDirectQualifiedMethod(lookup, effectiveReceiver, call, relPath);
    if (direct.length > 0) return direct;
  }

  const viaComposite = resolveViaCompositePtsKey(lookup, typeMap, call, relPath);
  if (viaComposite.length > 0) return viaComposite;

  return [];
}

// ── resolveByGlobal ───────────────────────────────────────────────────────────

/**
 * Step 1: accessor this-dispatch via Object.defineProperty (Phase 8.3f).
 *
 * When a plain function (no class prefix) is registered as a get/set accessor
 * for `obj` via Object.defineProperty, typeMap seeds 'callerName:this' = 'obj'.
 * We then resolve this.method() → typeMap['obj.method'] → the concrete
 * definition. Only applies to a bare (non-qualified) callerName + `this`
 * receiver; runs before the broad exact-name lookup to avoid false positives
 * from unrelated same-file definitions.
 */
function resolveViaAccessorThisDispatch(
  lookup: StrategyLookup,
  typeMap: Map<string, unknown>,
  call: { name: string; receiver?: string | null },
  relPath: string,
  callerName?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
  if (!(call.receiver === 'this' && callerName && !callerName.includes('.'))) return [];
  const objName = unwrapTypeEntry(typeMap.get(`${callerName}:this`));
  if (!objName) return [];
  const targetFn = unwrapTypeEntry(typeMap.get(`${objName}.${call.name}`));
  if (!targetFn) return [];
  return lookup.byName(targetFn).filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
}

/**
 * Step 3: same-class sibling method fallback via callerName.
 *
 * e.g. `this.area()` inside `Shape.describe` → try `Shape.area`. Also covers
 * no-receiver calls inside class methods, e.g. `IsValidEmail(x)` inside
 * `Validators.ValidateUser` → try `Validators.IsValidEmail` (C#/Java static
 * siblings). This seeds the initial edge that runChaPostPass later expands to
 * subclass overrides.
 *
 * For JS/TS, bare (no-receiver) calls are module-scoped — there is no
 * implicit class binding. Skip the same-class fallback for bare calls in
 * those languages to prevent false positives (e.g. `flush()` inside
 * `Processor.run` must not resolve to `Processor.flush`). this.method()
 * calls are unaffected: they still reach the fallback because
 * `call.receiver === 'this'` is truthy, not a bare call.
 */
function resolveViaSameClassSibling(
  lookup: StrategyLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  callerName?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
  const isBareCall = !call.receiver;
  if (!callerName || (isBareCall && isModuleScopedLanguage(relPath))) return [];
  const dotIdx = callerName.lastIndexOf('.');
  if (dotIdx <= -1) return [];
  // Extract only the segment immediately before the method name so that
  // 'Namespace.ClassName.method' yields 'ClassName', not 'Namespace.ClassName'.
  // Symbols are stored under their bare class name, not their qualified path.
  const prevDot = callerName.lastIndexOf('.', dotIdx - 1);
  const callerClass = callerName.slice(prevDot + 1, dotIdx);
  const qualifiedName = `${callerClass}.${call.name}`;
  return lookup
    .byName(qualifiedName)
    .filter((t) => t.kind === 'method' && computeConfidence(relPath, t.file, null) >= 0.5);
}

/**
 * Resolve a call site with no receiver, or whose receiver is `this`, `self`,
 * or `super`.
 *
 * Resolution cascade:
 *   1. resolveViaAccessorThisDispatch — Object.defineProperty this-dispatch (Phase 8.3f).
 *   2. Exact global name lookup with confidence filter.
 *   3. resolveViaSameClassSibling — same-class sibling method fallback.
 */
export function resolveByGlobal(
  lookup: StrategyLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
): ReadonlyArray<{ id: number; file: string }> {
  const viaAccessor = resolveViaAccessorThisDispatch(lookup, typeMap, call, relPath, callerName);
  if (viaAccessor.length > 0) return viaAccessor;

  const exact = lookup
    .byName(call.name)
    .filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
  if (exact.length > 0) return exact;

  const sameClass = resolveViaSameClassSibling(lookup, call, relPath, callerName);
  if (sameClass.length > 0) return sameClass;

  return exact; // empty
}
