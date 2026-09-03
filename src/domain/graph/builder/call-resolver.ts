/**
 * Shared call-edge resolution — used by both the full build pipeline
 * (build-edges.ts) and the incremental watch path (incremental.ts).
 *
 * Both callers supply a `CallNodeLookup` adapter that abstracts their
 * node-lookup mechanism (pre-loaded Maps vs. per-query SQLite statements).
 * The resolution logic lives here exactly once.
 *
 * `resolveByMethodOrGlobal` delegates its two branches to strategy helpers
 * in `../resolver/strategy.ts` to keep per-strategy complexity manageable.
 */
import { FRAMEWORK_ENTRY_PREFIXES } from '../../../graph/classifiers/roles.js';
import { CALLABLE_SYMBOL_KINDS } from '../../../shared/kinds.js';
import { computeConfidence, isSameLanguageFamily } from '../resolve.js';
import { correlatedEvidenceKey } from '../resolver/points-to.js';
import {
  attachConstructorTargets,
  isModuleScopedLanguage,
  type ResolvedCandidate,
  resolveByGlobal,
  resolveByReceiver,
  unwrapTypeEntry,
} from '../resolver/strategy.js';

// ── Public interface ─────────────────────────────────────────────────────

export interface CallNodeLookup {
  byNameAndFile(name: string, file: string): ReadonlyArray<ResolvedCandidate>;
  byName(name: string): ReadonlyArray<ResolvedCandidate>;
  isBarrel(file: string): boolean;
  /**
   * Resolve `symbolName` through `barrelFile`'s re-export chain. `name` in the
   * result is the name actually declared in the returned `file` — identical
   * to `symbolName` unless a barrel hop renamed it (`export { X as Y } from …`,
   * #1823), in which case callers must search the target file for `name`, not
   * the originally-requested `symbolName`.
   */
  resolveBarrel(barrelFile: string, symbolName: string): { file: string; name: string } | null;
  nodeId(name: string, kind: string, file: string, line: number): { id: number } | undefined;
  /**
   * True when `file` declares a function/method-kind node, other than
   * `excludeId`, whose line span encloses `line` — i.e. the node at
   * `excludeId` is nested inside another callable rather than declared at
   * module/class scope. Used by `resolveThisDispatch` (cha.ts) to tell a
   * genuine heritage-capable function declaration (#2238) apart from an
   * unrelated nested function that merely shares a base class's bare name
   * (Greptile finding on PR #2400) — a nested function can never legitimately
   * be an `extends`/prototype heritage target.
   */
  hasEnclosingCallable(file: string, line: number, excludeId: number): boolean;
}

export const RECEIVER_KINDS = new Set(['class', 'struct', 'interface', 'type', 'module']);

// Re-export so consumers that import isModuleScopedLanguage from this module
// continue to work without changes (build-edges.ts, etc.).
export { isModuleScopedLanguage };

/**
 * Collect the set of property/method names ever invoked via member-call
 * syntax (`x.name(...)`) across every file currently being processed —
 * regardless of whether the receiver `x` itself resolves to anything.
 *
 * Used as the "one hop further" liveness check for object-literal-property
 * value-refs (#1895): a function referenced as `{ resolve: someFn }` should
 * only be credited with a `calls` edge from that reference when something,
 * somewhere, actually invokes a `.resolve(...)`-shaped call — otherwise the
 * property is wired up but never read, and `someFn` is genuinely dead.
 *
 * Scope matches whatever set of files the caller passes in: the full
 * codebase for a full build (build-edges.ts's `buildCallEdgesJS`, from
 * `ctx.fileSymbols`), or just the single file being rebuilt on an incremental
 * update (incremental.ts's `buildCallEdges`, from that file's own `calls`).
 * The incremental case is a narrower, same-file view — a cross-file consumer
 * added in a different, untouched file won't be seen until the next full
 * rebuild — the same scoping trade-off already accepted elsewhere in this
 * codebase's incremental classification (`hasActiveFileSiblings` and
 * exported-via-reexport both recompute from an affected subset, not the
 * whole graph, in `graph/classifiers/roles.rs`'s incremental path — median
 * fan-in/out is a separate case, deliberately kept as a whole-graph
 * statistic even on the incremental path, for classification-threshold
 * consistency).
 *
 * Excludes `dynamicKind: 'value-ref'` calls (issue #2260): those carry a
 * `receiver` of their own now (the dispatch-table's name, set by
 * `collectObjectLiteralValueRefCall` — used for the computed-access liveness
 * pathway, see `computedDispatchTableEvidence`), but a value-ref Call is
 * itself a bare VALUE reference, never a real invocation — crediting its
 * `name` (the referenced function's own identifier) here would pollute this
 * set with a name that was never actually invoked via member-call syntax.
 */
export function collectInvokedPropertyNames(
  callsList: Iterable<Iterable<{ name: string; receiver?: string; dynamicKind?: string | null }>>,
): Set<string> {
  const names = new Set<string>();
  for (const calls of callsList) {
    for (const call of calls) {
      if (call.receiver && call.dynamicKind !== 'value-ref') names.add(call.name);
    }
  }
  return names;
}

/**
 * #2088 — the receiver-CORRELATED counterpart of
 * `collectInvokedPropertyNames`. For every member call `x.name(...)`, resolve
 * `x` through the points-to map for the FILE THAT CALL IS IN to the
 * object-literal allocation sites it may refer to, and record
 * `${siteKey}|${name}` for each.
 */
export function collectInvokedPropertySites(
  fileCalls: ReadonlyMap<
    string,
    Iterable<{
      name: string;
      receiver?: string;
      dynamicKind?: string | null;
      callerName?: string | null;
    }>
  >,
  resolveReceiverSites: (
    relPath: string,
    receiver: string,
    callerName: string | null,
  ) => ReadonlyArray<string>,
): Set<string> {
  const keys = new Set<string>();
  for (const [relPath, calls] of fileCalls) {
    for (const call of calls) {
      if (!call.receiver || call.dynamicKind === 'value-ref') continue;
      for (const siteKey of resolveReceiverSites(relPath, call.receiver, call.callerName ?? null)) {
        keys.add(correlatedEvidenceKey(siteKey, call.name));
      }
    }
  }
  return keys;
}

/**
 * Shared by both the full-build (build-edges.ts) and incremental (incremental.ts)
 * same-class fallback strategies: derive the enclosing class name from the
 * caller's qualified name (the segment immediately before the final dot, e.g.
 * `Namespace.MyClass.method` → `MyClass`), then look up `ClassName.callName`
 * as a method in the same file.
 *
 * Uses lastIndexOf (not indexOf) so deeply-qualified caller names extract the
 * innermost class, not the outermost namespace.
 */
export function resolveSameClassQualifiedMethod(
  callName: string,
  callerName: string,
  relPath: string,
  lookup: CallNodeLookup,
): Array<ResolvedCandidate> {
  const lastDot = callerName.lastIndexOf('.');
  if (lastDot <= 0) return [];
  const prevDot = callerName.lastIndexOf('.', lastDot - 1);
  const className = callerName.slice(prevDot + 1, lastDot);
  return lookup
    .byNameAndFile(`${className}.${callName}`, relPath)
    .filter((n) => n.kind === 'method');
}

/**
 * Shared by both the full-build (build-edges.ts, including its native-engine
 * post-pass) and incremental (incremental.ts) `Object.defineProperty` accessor
 * fallback: when a function is registered as a getter/setter via
 * `Object.defineProperty(obj, "bar", { get: getter })`, calls to `this.X()`
 * inside `getter` resolve against `obj` (this === obj when the accessor is
 * invoked).
 *
 * `definePropertyReceivers` maps the getter/setter's own name (`callerName`)
 * to the receiver variable name (`obj`). Resolution:
 *   1. Look up `obj`'s type in the typeMap and try the qualified `Type.X`
 *      method in the same file.
 *   2. Otherwise, fall back to any same-file definition named `X` — handles
 *      plain object literals where the method isn't qualified (e.g.
 *      `const obj = { baz() {} }` defines `baz` directly).
 *
 * The fallback tier (2) is restricted to `function`/`method` kinds: a
 * getter/setter's implementation is always callable code, so an unfiltered
 * lookup could otherwise match an unrelated same-named class or variable in
 * the same file (issue #1766). Tier (1) is intentionally left unfiltered,
 * matching its pre-existing behaviour on all three call sites.
 */
export function resolveDefinePropertyAccessorTarget(
  callName: string,
  callerName: string,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
  definePropertyReceivers: ReadonlyMap<string, string>,
): Array<ResolvedCandidate> {
  const receiverVarName = definePropertyReceivers.get(callerName);
  if (!receiverVarName) return [];

  const typeName = unwrapTypeEntry(typeMap.get(receiverVarName));
  if (typeName) {
    const qualified = lookup.byNameAndFile(`${typeName}.${callName}`, relPath);
    if (qualified.length > 0) return [...qualified];
  }
  return lookup
    .byNameAndFile(callName, relPath)
    .filter((n) => n.kind === 'function' || n.kind === 'method');
}

/** Minimal call shape needed by the reflection fallbacks below. */
type ReflectionCall = {
  name: string;
  receiver?: string | null;
  dynamicKind?: string | null;
  keyExpr?: string | null;
};

/**
 * Shared by both the full-build (build-edges.ts) and incremental
 * (incremental.ts) paths: RES-4, Kotlin member callable reference —
 * `Greeter::greet` emits `{ name: 'greet', receiver: 'Greeter', dynamicKind:
 * 'reflection' }`. The receiver is the class qualifier (not a typeMap
 * variable), so the primary resolver would find a same-named top-level
 * function via `byNameAndFile('greet', relPath)` before the qualified form
 * is tried. Prefer `Greeter.greet` in the same file first; callers fall
 * through to the normal resolution path only when this returns nothing.
 */
export function resolveKotlinReflectionPreQualified(
  call: ReflectionCall,
  relPath: string,
  lookup: CallNodeLookup,
): ReadonlyArray<ResolvedCandidate> {
  if (
    call.dynamicKind === 'reflection' &&
    call.receiver &&
    !call.keyExpr &&
    !isModuleScopedLanguage(relPath)
  ) {
    return lookup
      .byNameAndFile(`${call.receiver}.${call.name}`, relPath)
      .filter((n) => n.kind === 'method' || n.kind === 'function');
  }
  return [];
}

/**
 * Shared by both the full-build (build-edges.ts) and incremental
 * (incremental.ts) paths: RES-3, reflection with a literal method name —
 * JVM `getMethod("name")` / `invokeMethod("name")`. Java/Scala/Groovy
 * methods are stored as class-qualified names (e.g. `Reflection.greet`), so
 * `lookup.byNameAndFile('greet', relPath)` finds nothing. When
 * `dynamicKind === 'reflection'` and `keyExpr` is set (a string-literal
 * method name was captured), try the qualified form:
 *   1. `typeMap[receiver]` → resolved type → lookup `resolvedType.keyExpr`
 *      (type-annotated local).
 *   2. `callerName`'s class prefix → `CallerClass.keyExpr` (same-class
 *      sibling, e.g. Groovy `obj`).
 * Scoped to non-JS/TS files to avoid interfering with the JS reflection path.
 */
export function resolveReflectionKeyExprFallback(
  call: ReflectionCall,
  callerName: string | null,
  relPath: string,
  typeMap: Map<string, unknown>,
  lookup: CallNodeLookup,
): Array<ResolvedCandidate> {
  if (
    call.dynamicKind !== 'reflection' ||
    !call.keyExpr ||
    !call.receiver ||
    isModuleScopedLanguage(relPath)
  ) {
    return [];
  }
  const resolvedType = unwrapTypeEntry(typeMap.get(call.receiver));
  if (resolvedType) {
    const qualified = lookup
      .byNameAndFile(`${resolvedType}.${call.keyExpr}`, relPath)
      .filter((n) => n.kind === 'method' || n.kind === 'function');
    if (qualified.length > 0) return qualified;
  }
  if (callerName != null) {
    const lastDot = callerName.lastIndexOf('.');
    if (lastDot > 0) {
      const prevDot = callerName.lastIndexOf('.', lastDot - 1);
      const callerClass = callerName.slice(prevDot + 1, lastDot);
      const qualified = lookup
        .byNameAndFile(`${callerClass}.${call.keyExpr}`, relPath)
        .filter((n) => n.kind === 'method' || n.kind === 'function');
      if (qualified.length > 0) return qualified;
    }
  }
  return [];
}

// ── Shared resolution functions ──────────────────────────────────────────

/**
 * Variable-like binding kinds that may act as top-level callers when no
 * enclosing function/method exists (e.g. Haskell top-level `main` is a
 * `bind` node → kind `variable`).  Local variable declarations inside a
 * function body must NOT win over the enclosing function.
 */
const TOP_LEVEL_BINDING_KINDS = new Set(['variable', 'constant']);

type Def = { name: string; kind: string; line: number; endLine?: number | null };
type CallerMatch = { id: number; name: string } | null;

/** True when `name` is a synthetic framework-dispatch placeholder (`route:`/`event:`/`command:`-prefixed). */
function isFrameworkEntryName(name: string): boolean {
  return FRAMEWORK_ENTRY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Find the narrowest enclosing function/method definition for `callLine`.
 * Returns the DB node and name, or null if none encloses the call.
 */
function findEnclosingCallable(
  lookup: CallNodeLookup,
  callLine: number,
  definitions: ReadonlyArray<Def>,
  relPath: string,
): CallerMatch {
  let best: CallerMatch = null;
  let bestSpan = Infinity;
  for (const def of definitions) {
    if (!CALLABLE_SYMBOL_KINDS.has(def.kind)) continue;
    if (def.line > callLine) continue;
    const end = def.endLine ?? Infinity;
    if (callLine > end) continue;
    const span = end === Infinity ? Infinity : end - def.line;
    if (span < bestSpan) {
      const row = lookup.nodeId(def.name, def.kind, relPath, def.line);
      if (row) {
        best = { ...row, name: def.name };
        bestSpan = span;
      }
    }
  }
  return best;
}

/**
 * Find the class context of the nearest enclosing REAL (non-synthetic)
 * method for `callLine`, for use ONLY as a `this`/`self`/`super` resolution
 * fallback when the call's ATTRIBUTED caller (from `findEnclosingCallable`)
 * is itself a synthetic framework-dispatch placeholder (`route:`/`event:`/
 * `command:`-prefixed — e.g. `extractCallbackDefinition`'s
 * `event:${eventName}` for an EventEmitter `.on('event', callback)`
 * registration) and therefore carries no class/`this` context of its own
 * (issue #2259 — `w.on('message', (msg) => this.onMessage(msg))` inside a
 * class method: `this.onMessage` can never resolve if the only context
 * available is `event:message`'s own classless name).
 *
 * Deliberately does NOT change which node the call's edge is SOURCED
 * from — `findEnclosingCallable` still attributes the call to the
 * synthetic placeholder unchanged, so flow/sequence traversal starting
 * from that entry point keeps seeing the callback's own calls (Greptile
 * review, PR #2444). This function only supplies an ADDITIONAL class name
 * for `resolveViaSameClassSibling` to try when the caller's own name has
 * no dot to derive a class from.
 *
 * Picks the NARROWEST enclosing real method (like `findEnclosingCallable`
 * itself), so a callback nested inside nested classes/methods resolves
 * against the innermost one — the correct `this` binding at that point.
 */
function findEnclosingClassHint(callLine: number, definitions: ReadonlyArray<Def>): string | null {
  let best: string | null = null;
  let bestSpan = Infinity;
  for (const def of definitions) {
    if (def.kind !== 'method' || isFrameworkEntryName(def.name)) continue;
    if (def.line > callLine) continue;
    const end = def.endLine ?? Infinity;
    if (callLine > end) continue;
    const dotIdx = def.name.lastIndexOf('.');
    if (dotIdx <= 0) continue;
    const span = end === Infinity ? Infinity : end - def.line;
    if (span < bestSpan) {
      best = def.name.slice(0, dotIdx);
      bestSpan = span;
    }
  }
  return best;
}

/**
 * Find the widest (outermost) enclosing variable/constant binding for `callLine`.
 * Used as fallback for top-level bindings (e.g. Haskell `main = do …`).
 * We pick the WIDEST span so that nested `let` bindings inside `main`'s
 * do-block do not shadow `main` itself as the attributing caller.
 */
function findEnclosingBinding(
  lookup: CallNodeLookup,
  callLine: number,
  definitions: ReadonlyArray<Def>,
  relPath: string,
): CallerMatch {
  let best: CallerMatch = null;
  let bestSpan = -1; // looking for WIDEST span, so start at -1
  for (const def of definitions) {
    if (!TOP_LEVEL_BINDING_KINDS.has(def.kind)) continue;
    if (def.line > callLine) continue;
    const end = def.endLine ?? Infinity;
    if (callLine > end) continue;
    const span = end === Infinity ? Infinity : end - def.line;
    if (span > bestSpan) {
      const row = lookup.nodeId(def.name, def.kind, relPath, def.line);
      if (row) {
        best = { ...row, name: def.name };
        bestSpan = span;
      }
    }
  }
  return best;
}

export function findCaller(
  lookup: CallNodeLookup,
  call: { line: number },
  definitions: ReadonlyArray<Def>,
  relPath: string,
  fileNodeRow: { id: number },
): { id: number; callerName: string | null; enclosingClassHint?: string | null } {
  // Pass 1: find the narrowest enclosing function/method.
  const fnCaller = findEnclosingCallable(lookup, call.line, definitions, relPath);

  // Prefer function/method enclosing scope over variable binding.
  // Only fall back to a variable/constant binding when the call is at
  // top-level scope (no enclosing function/method found), which handles
  // languages like Haskell where `main` is a top-level `bind` node.
  if (fnCaller) {
    // A synthetic framework-dispatch placeholder (issue #2259) has no
    // class/`this` context of its own — supply the nearest REAL enclosing
    // method's class as a fallback for `this`/`self`/`super` resolution,
    // without changing the edge's source (see findEnclosingClassHint).
    const enclosingClassHint = isFrameworkEntryName(fnCaller.name)
      ? findEnclosingClassHint(call.line, definitions)
      : null;
    return { id: fnCaller.id, callerName: fnCaller.name, enclosingClassHint };
  }

  // Pass 2: find the widest (outermost) enclosing variable/constant binding.
  const varCaller = findEnclosingBinding(lookup, call.line, definitions, relPath);
  if (varCaller) {
    return { id: varCaller.id, callerName: varCaller.name };
  }

  return { ...fileNodeRow, callerName: null };
}

/**
 * Dispatcher for call-site resolution.
 *
 * Delegates to two strategy helpers (in `../resolver/strategy.ts`) to keep
 * each branch independently readable and under the complexity threshold:
 *   - resolveByReceiver  — receiver is a concrete object/class reference
 *   - resolveByGlobal    — bare call, or this/self/super receiver
 *
 * `importedOriginalNames` is forwarded to `resolveByReceiver` so a receiver
 * that is itself a renamed import binding (`import { X as Y }; Y.method()`)
 * resolves against the declared name `X` rather than the local alias `Y`
 * (#1825). `resolveByGlobal` has no receiver-qualifier lookups, so it does
 * not need it.
 */
/**
 * True when `callerName`'s class-name prefix is a real class/struct/
 * interface/etc.-kind declaration in the same file — i.e. a `super` call
 * inside it is syntactically guaranteed to have a real `extends` target
 * `resolveThisDispatch`'s CHA ancestor walk (cha.ts) can verify (issue
 * #2244). False for an object-literal method using dynamic prototype
 * linkage (`Object.setPrototypeOf`, `obj.__proto__ = ...`) — those have no
 * static `extends` clause for CHA to check at all, so the bare/global
 * fallback below remains the only signal available and must still apply.
 */
function callerHasRealClassAncestor(
  callerName: string | null | undefined,
  relPath: string,
  lookup: CallNodeLookup,
): boolean {
  if (!callerName) return false;
  const dotIdx = callerName.lastIndexOf('.');
  if (dotIdx <= 0) return false;
  const callerClass = callerName.slice(0, dotIdx);
  return lookup.byNameAndFile(callerClass, relPath).some((n) => RECEIVER_KINDS.has(n.kind ?? ''));
}

export function resolveByMethodOrGlobal(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
  importedOriginalNames?: ReadonlyMap<string, string>,
  enclosingClassHint?: string | null,
): ReadonlyArray<ResolvedCandidate> {
  // `super`/`super.method()` inside a REAL class is never resolvable by a
  // same-name/global lookup (resolveByGlobal): unlike `this`, where a
  // same-file or best-confidence same-named declaration is often genuinely
  // correct, `super` specifically means "the caller's real ancestor's
  // method" — a coincidentally same-named declaration anywhere else has no
  // static relationship to that ancestor and must never win. Only
  // `resolveThisDispatch`'s CHA-aware ancestor walk (cha.ts, run as a
  // post-pass) can verify that relationship, so super is deferred to it
  // entirely rather than resolved (possibly wrongly) here (issue #2244).
  //
  // This does NOT apply when the caller isn't a real class at all (an
  // object-literal method linked to its "ancestor" via
  // `Object.setPrototypeOf`/`__proto__ =`, jelly-micro's super/super3
  // fixtures) — CHA has no static `extends` clause to walk there, so the
  // fallback below is the only heuristic available and must still run.
  if (call.receiver === 'super' && callerHasRealClassAncestor(callerName, relPath, lookup)) {
    return [];
  }
  if (
    call.receiver &&
    call.receiver !== 'this' &&
    call.receiver !== 'self' &&
    call.receiver !== 'super'
  ) {
    return resolveByReceiver(
      lookup,
      call as { name: string; receiver: string },
      relPath,
      typeMap,
      callerName,
      importedOriginalNames,
    );
  }
  if (
    !call.receiver ||
    call.receiver === 'this' ||
    call.receiver === 'self' ||
    call.receiver === 'super'
  ) {
    return resolveByGlobal(lookup, call, relPath, typeMap, callerName, enclosingClassHint);
  }
  return [];
}

export function resolveCallTargets(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null; accessorRead?: 'get' | 'set' },
  relPath: string,
  importedNames: Map<string, string>,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
  importedOriginalNames?: ReadonlyMap<string, string>,
  namespaceImports?: ReadonlyMap<string, string>,
  enclosingClassHint?: string | null,
): {
  targets: Array<ResolvedCandidate>;
  importedFrom: string | undefined;
} {
  // Flagged dynamic calls use synthetic names like '<dynamic:eval>'. Short-circuit
  // so they never accidentally match a real symbol via lookup.byName.
  if (call.name.startsWith('<dynamic:')) {
    return { targets: [], importedFrom: undefined };
  }

  // #2030: a property-read call tagged with the accessor kind it needs
  // carries its *resolved class name* as `receiver` (see
  // collectAccessorPropertyRead in extractors/javascript.ts, and the native
  // mirror handle_accessor_property_read) — resolve directly against the
  // qualified `receiver.name`, filtered to the DB's `accessor_kind` column.
  // This deliberately bypasses the rest of this function's directory-
  // proximity confidence scoring: kind-plus-exact-qualified-name match is a
  // strictly stronger disambiguator than proximity (proximity exists only to
  // arbitrate when nothing stronger is available — see resolveExactGlobalMatch
  // in resolver/strategy.ts for that precedent), and a real cross-file
  // accessor can legitimately live many directories away from the read site
  // (the #2030 repro itself: src/features/sequence.ts ↔
  // src/db/repository/sqlite-repository.ts). An unconfirmed candidate is
  // dropped outright — never falls through to the general cascade below,
  // which could otherwise resolve to an unrelated same-named non-accessor
  // method/field, the exact false-positive class #1893's same-file registry
  // was designed to prevent.
  if (call.accessorRead && call.receiver) {
    // The resolved class name can itself be a renamed import binding
    // (`import { Original as Alias }` — the extractor's typeMap only knows
    // the local alias), so de-alias before building the qualified lookup key
    // exactly like the general cascade below does (#1825).
    const dealiasedClassName = importedOriginalNames?.get(call.receiver) ?? call.receiver;
    const qualified = `${dealiasedClassName}.${call.name}`;
    // When the class is a known import, commit to the specific file it
    // resolves to rather than falling through to the unscoped global lookup
    // below — otherwise an unrelated same-qualified-name accessor in a
    // completely different file could "confirm" a read it has nothing to do
    // with, whenever two files coincidentally declare the same class+property
    // name pair. This scoped result is authoritative: an empty (or
    // wrong-kind) match here means "no", not "keep looking elsewhere" — the
    // unscoped global fallback below is reserved for when the class isn't a
    // known import in this file at all (e.g. an ambient/global type).
    //
    // `importedNames` is keyed by the *local* binding as written in this
    // file's own import statement (`call.receiver` — e.g. 'Alias' for
    // `import { Original as Alias }`), not the de-aliased original name —
    // looking it up under `dealiasedClassName` would always miss for a
    // renamed import and silently fall through to the unscoped lookup this
    // whole branch exists to avoid.
    const accessorImportedFrom = importedNames.get(call.receiver);
    if (accessorImportedFrom) {
      const scoped = lookup
        .byNameAndFile(qualified, accessorImportedFrom)
        .filter((n) => n.accessorKind === call.accessorRead);
      return { targets: [...scoped], importedFrom: undefined };
    }
    const targets = lookup.byName(qualified).filter((n) => n.accessorKind === call.accessorRead);
    return { targets: [...targets], importedFrom: undefined };
  }

  // A call through a module namespace binding (`import lib as L; L.f()`,
  // `from pkg import submod; submod.f()`) names a module, not a value, so the
  // target is simply `call.name` as declared in that module's file. Resolved
  // ahead of the general cascade because the cascade has nothing to work with
  // here: `call.name` is not itself an imported binding, and the receiver has
  // no type to look up — which is why every such call previously resolved to
  // nothing and left the callee reported as dead (#2387).
  //
  // Scoped to the module's own file and authoritative: a miss means the module
  // does not declare that name, not "keep looking". Falling through would let
  // an unrelated same-named function elsewhere in the project claim the call.
  const namespaceFile = call.receiver ? namespaceImports?.get(call.receiver) : undefined;
  if (namespaceFile) {
    return {
      targets: [...lookup.byNameAndFile(call.name, namespaceFile)],
      importedFrom: undefined,
    };
  }

  const importedFrom = importedNames.get(call.name);
  // When the call site uses a renamed import binding (`import { X as Y }`),
  // the imported file's actual symbol is declared under the *original* name
  // (X) — look that up instead of the local alias the call site wrote (#1730).
  const targetName = importedOriginalNames?.get(call.name) ?? call.name;
  // Tracks the name actually used to find `targets`. Usually equal to
  // `targetName`, but a barrel hop that itself renames the export
  // (`export { Foo as Bar } from './foo'`, resolved below) reports the name
  // truly declared in the origin file — the constructor-attribution lookup
  // must key on that name, not the call site's (possibly barrel-aliased)
  // `targetName`, or it builds a qualified name that doesn't exist (#1892).
  let resolvedClassName = targetName;
  let targets: ReadonlyArray<ResolvedCandidate> | undefined;

  if (importedFrom) {
    targets = lookup.byNameAndFile(targetName, importedFrom);
    if (targets.length === 0 && lookup.isBarrel(importedFrom)) {
      const barrelResolved = lookup.resolveBarrel(importedFrom, targetName);
      if (barrelResolved) {
        targets = lookup.byNameAndFile(barrelResolved.name, barrelResolved.file);
        resolvedClassName = barrelResolved.name;
      }
    }
  }

  if (!targets || targets.length === 0) {
    // Same-file bare-name lookup. A receiver — concrete (`obj.x()`) or
    // `this`/`self`/`super` — means the call is logically "invoke a member of
    // some instance", which a class/interface/struct/etc. declaration can
    // never satisfy; restrict those to definitively callable kinds so an
    // unrelated same-file type declaration that merely shares the call's name
    // can never pre-empt a legitimate target that a more specific resolution
    // tier (receiver typing, the Object.defineProperty accessor fallback,
    // etc.) would otherwise find. A genuinely bare call (no receiver at all)
    // is left unfiltered: at this layer it is indistinguishable from a `new
    // ClassName()` constructor invocation, which legitimately targets a
    // class-kind definition — kind-filtering it would break constructor-call
    // resolution (#1888).
    // `super` inside a REAL class is excluded from the bare same-file lookup
    // entirely (issue #2244) — see resolveByMethodOrGlobal's matching
    // comment for why a coincidentally same-named same-file declaration
    // must never satisfy it there, and for why that exclusion does NOT
    // apply to a non-class caller (object-literal dynamic prototype linkage).
    const bareMatches =
      call.receiver === 'super' && callerHasRealClassAncestor(callerName, relPath, lookup)
        ? []
        : lookup.byNameAndFile(call.name, relPath);
    const kindFilteredBare = call.receiver
      ? bareMatches.filter((n) => CALLABLE_SYMBOL_KINDS.has(n.kind ?? ''))
      : bareMatches;
    targets = kindFilteredBare;

    const hasConcreteReceiver =
      !!call.receiver &&
      call.receiver !== 'this' &&
      call.receiver !== 'self' &&
      call.receiver !== 'super';

    // A concrete-receiver call still needs type-aware confirmation even when
    // the kind-filtered bare lookup already found something: the bare lookup
    // only rules out non-callable kinds (#1888), not a coincidentally
    // same-named function/method elsewhere in the file that has no static
    // relationship to the receiver at all (#2025) — e.g. an unrelated
    // top-level `function method()` pre-empting `obj.method()` when `obj`'s
    // type resolves to a class that also declares `method`.
    if (targets.length === 0 || hasConcreteReceiver) {
      const viaReceiverOrGlobal = resolveByMethodOrGlobal(
        lookup,
        call,
        relPath,
        typeMap,
        callerName,
        importedOriginalNames,
        enclosingClassHint,
      );
      if (targets.length === 0) {
        targets = viaReceiverOrGlobal;
      } else if (viaReceiverOrGlobal.length > 0) {
        // Prefer the type-aware result UNLESS it's simply a different node
        // representation of the exact declaration the bare match already
        // found. Same file + line alone is NOT sufficient to prove that: two
        // wholly unrelated declarations can coincidentally share one
        // physical source line (e.g. `function method() {} class Widget {
        // method() {} }` written on one line), and file+line-only comparison
        // would incorrectly treat the type-aware `Widget.method` match as
        // "the same declaration" as the unrelated bare `method` and keep the
        // wrong one (#2025 follow-up caught by review).
        //
        // The only *intentional* same-file-and-line double-representation in
        // the codebase is #1517's computed-key object-literal methods,
        // extracted by extractObjectLiteralFunctions/extract_object_literal_functions:
        // a bare node (kind `method`) and a qualified `obj.method` node (kind
        // `function`) are pushed from the identical AST node, in that exact
        // kind pairing. Requiring that specific pairing — not just matching
        // coordinates — distinguishes the deliberate #1517 duplicate from a
        // coincidental same-line collision between two real, distinct
        // declarations.
        //
        // When every type-aware match does pair up with a bare `method` node
        // this way, resolve to exactly those paired bare nodes — NOT the
        // original bare lookup result wholesale. `targets` can contain
        // additional, wholly unrelated same-named bare matches elsewhere in
        // the file (a second collision independent of the #1517 pairing);
        // keeping the whole array would attach a bogus extra `calls` edge to
        // that unrelated declaration (review finding on #2227).
        const bareMethodByLocation = new Map<string, ResolvedCandidate>();
        for (const n of targets) {
          if (n.kind === 'method') bareMethodByLocation.set(`${n.file}:${n.line}`, n);
        }
        const pairedBareTargets: ResolvedCandidate[] = [];
        const isSameDeclaration = viaReceiverOrGlobal.every((n) => {
          if (n.kind !== 'function') return false;
          const paired = bareMethodByLocation.get(`${n.file}:${n.line}`);
          if (!paired) return false;
          pairedBareTargets.push(paired);
          return true;
        });
        if (!isSameDeclaration) {
          targets = viaReceiverOrGlobal;
        } else {
          targets = [...new Set(pairedBareTargets)];
        }
      }
    }
  }

  let resolved = [...(targets ?? [])];
  // #1892: `new ClassName()` / bare `ClassName()` (keyword-less languages)
  // always resolves as a bare (no-receiver) call — augment any class-kind
  // match with the class's own constructor method, if it declares one.
  // Uses `resolvedClassName` (not `targetName`) so a barrel rename doesn't
  // make the qualified constructor lookup miss (see comment above).
  if (!call.receiver) {
    resolved = attachConstructorTargets(lookup, resolved, resolvedClassName);
  }
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
 *
 * `importedNames` is only ever probed with `.has()` here — the classification
 * only needs key presence, never the value — so callers may pass either the
 * plain ESM `importedNames` map (`string` values) or the richer per-name
 * `BarrelExportResolution` map `buildImportArtifactNames` builds for CJS
 * `require()` bindings (#2071). The value type is intentionally untyped
 * (`unknown`) to reflect that.
 */
export function resolveReceiverEdge(
  lookup: CallNodeLookup,
  call: { name: string; receiver: string },
  caller: { id: number; callerName?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  seenCallEdges: Set<string>,
  importedNames: ReadonlyMap<string, unknown>,
): { callerId: number; receiverId: number; confidence: number } | null {
  // Function-scoped key (`callerName::receiver`) checked before the bare key
  // so a same-named local/parameter in a DIFFERENT function in this file
  // can't shadow the entry seeded for the function actually making this call
  // (#2235; mirrors resolveReceiverTypeName in resolver/strategy.ts).
  const typeEntry =
    (caller.callerName ? typeMap.get(`${caller.callerName}::${call.receiver}`) : undefined) ??
    typeMap.get(call.receiver);
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
  // Cross-language candidates are never legitimate receiver targets (#1783) —
  // a `new Foo()` in one language can't statically resolve to an unrelated
  // same-named class in another. Only the global (cross-file) branch needs
  // the check: sameFileCandidates are already scoped to relPath itself.
  const candidates = isLocalDefinition
    ? sameFileCandidates
    : lookup
        .byName(effectiveReceiver)
        .filter((n) => RECEIVER_KINDS.has(n.kind ?? '') && isSameLanguageFamily(relPath, n.file));
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

/**
 * Resolve the target(s) of a class-hierarchy heritage clause (`extends X` /
 * `implements Y`) to actual node candidates.
 *
 * Previously this resolved by a bare, unscoped name lookup across the entire
 * graph, so common type names (`Repository`, `User`, …) produced false
 * cross-file — even cross-language — hierarchy edges whenever an unrelated
 * declaration happened to share the name (#1812).
 *
 * Mirrors `resolveReceiverEdge`'s priority order:
 * 1. Same-file declaration, when `name` is not itself an import artifact —
 *    a locally-declared class/interface owns the name in its own file.
 * 2. The file's actually-resolved import for `name` (barrel-traced), so
 *    `extends X` only links to the specific `X` this file imported. For a
 *    renamed import (`import { Base as MyBase }`), the imported file stores
 *    the symbol under its original exported name, not the local alias — so
 *    the lookup uses `importedOriginalNames` to resolve `MyBase` back to
 *    `Base` before searching, mirroring `resolveCallTargets` (#1730).
 * 3. Last resort: a same-language-family global-by-name match (never
 *    cross-language, per #1783) — and only the single first candidate, since
 *    a heritage clause names exactly one type and an unscoped match set is
 *    the ambiguity this function exists to eliminate.
 */
export function resolveHierarchyTargets(
  lookup: CallNodeLookup,
  name: string,
  relPath: string,
  importedNames: ReadonlyMap<string, string>,
  targetKinds: ReadonlySet<string>,
  importedOriginalNames?: ReadonlyMap<string, string>,
): ReadonlyArray<ResolvedCandidate> {
  const sameFileAll = lookup.byNameAndFile(name, relPath);
  const isLocalDefinition = sameFileAll.length > 0 && !importedNames.has(name);
  if (isLocalDefinition) {
    return sameFileAll.filter((n) => targetKinds.has(n.kind ?? ''));
  }

  const importedFrom = importedNames.get(name);
  if (importedFrom) {
    const targetName = importedOriginalNames?.get(name) ?? name;
    const importedCandidates = lookup
      .byNameAndFile(targetName, importedFrom)
      .filter((n) => targetKinds.has(n.kind ?? ''));
    if (importedCandidates.length > 0) return importedCandidates;
  }

  const globalCandidates = lookup
    .byName(name)
    .filter((n) => targetKinds.has(n.kind ?? '') && isSameLanguageFamily(relPath, n.file));
  return globalCandidates.length > 0 ? [globalCandidates[0]!] : [];
}
