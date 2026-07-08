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
import { CALLABLE_SYMBOL_KINDS } from '../../../shared/kinds.js';
import { computeConfidence, isSameLanguageFamily } from '../resolve.js';
import {
  isModuleScopedLanguage,
  resolveByGlobal,
  resolveByReceiver,
  unwrapTypeEntry,
} from '../resolver/strategy.js';

// ── Public interface ─────────────────────────────────────────────────────

export interface CallNodeLookup {
  byNameAndFile(
    name: string,
    file: string,
  ): ReadonlyArray<{ id: number; file: string; kind?: string }>;
  byName(name: string): ReadonlyArray<{ id: number; file: string; kind?: string }>;
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
}

export const RECEIVER_KINDS = new Set(['class', 'struct', 'interface', 'type', 'module']);

// Re-export so consumers that import isModuleScopedLanguage from this module
// continue to work without changes (build-edges.ts, etc.).
export { isModuleScopedLanguage };

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
): Array<{ id: number; file: string; kind?: string }> {
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
): Array<{ id: number; file: string; kind?: string }> {
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
): { id: number; callerName: string | null } {
  // Pass 1: find the narrowest enclosing function/method.
  const fnCaller = findEnclosingCallable(lookup, call.line, definitions, relPath);

  // Prefer function/method enclosing scope over variable binding.
  // Only fall back to a variable/constant binding when the call is at
  // top-level scope (no enclosing function/method found), which handles
  // languages like Haskell where `main` is a top-level `bind` node.
  if (fnCaller) {
    return { id: fnCaller.id, callerName: fnCaller.name };
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
export function resolveByMethodOrGlobal(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
  importedOriginalNames?: ReadonlyMap<string, string>,
): ReadonlyArray<{ id: number; file: string }> {
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
    return resolveByGlobal(lookup, call, relPath, typeMap, callerName);
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
  importedOriginalNames?: ReadonlyMap<string, string>,
): { targets: Array<{ id: number; file: string }>; importedFrom: string | undefined } {
  // Flagged dynamic calls use synthetic names like '<dynamic:eval>'. Short-circuit
  // so they never accidentally match a real symbol via lookup.byName.
  if (call.name.startsWith('<dynamic:')) {
    return { targets: [], importedFrom: undefined };
  }

  const importedFrom = importedNames.get(call.name);
  // When the call site uses a renamed import binding (`import { X as Y }`),
  // the imported file's actual symbol is declared under the *original* name
  // (X) — look that up instead of the local alias the call site wrote (#1730).
  const targetName = importedOriginalNames?.get(call.name) ?? call.name;
  let targets: ReadonlyArray<{ id: number; file: string }> | undefined;

  if (importedFrom) {
    targets = lookup.byNameAndFile(targetName, importedFrom);
    if (targets.length === 0 && lookup.isBarrel(importedFrom)) {
      const resolved = lookup.resolveBarrel(importedFrom, targetName);
      if (resolved) {
        targets = lookup.byNameAndFile(resolved.name, resolved.file);
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
    const bareMatches = lookup.byNameAndFile(call.name, relPath);
    targets = call.receiver
      ? bareMatches.filter((n) => CALLABLE_SYMBOL_KINDS.has(n.kind ?? ''))
      : bareMatches;

    if (targets.length === 0) {
      targets = resolveByMethodOrGlobal(
        lookup,
        call,
        relPath,
        typeMap,
        callerName,
        importedOriginalNames,
      );
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
 *    `extends X` only links to the specific `X` this file imported.
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
): ReadonlyArray<{ id: number; file: string }> {
  const sameFileAll = lookup.byNameAndFile(name, relPath);
  const isLocalDefinition = sameFileAll.length > 0 && !importedNames.has(name);
  if (isLocalDefinition) {
    return sameFileAll.filter((n) => targetKinds.has(n.kind ?? ''));
  }

  const importedFrom = importedNames.get(name);
  if (importedFrom) {
    const importedCandidates = lookup
      .byNameAndFile(name, importedFrom)
      .filter((n) => targetKinds.has(n.kind ?? ''));
    if (importedCandidates.length > 0) return importedCandidates;
  }

  const globalCandidates = lookup
    .byName(name)
    .filter((n) => targetKinds.has(n.kind ?? '') && isSameLanguageFamily(relPath, n.file));
  return globalCandidates.length > 0 ? [globalCandidates[0]!] : [];
}
