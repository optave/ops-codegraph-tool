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
import { computeConfidence } from '../resolve.js';
import {
  isModuleScopedLanguage,
  resolveByGlobal,
  resolveByReceiver,
} from '../resolver/strategy.js';

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
 * Same-class `this.method()` fallback: when the call receiver is `this` and
 * the primary resolution pass found nothing, derive the enclosing class name
 * from the caller (e.g. `Logger.info` → class prefix `Logger`) and retry with
 * the qualified method name `Logger._write`. This mirrors what the native
 * Rust engine does implicitly via its class-scoped symbol table.
 *
 * NOTE: restricted to `this` only — `super.method()` targets a parent class,
 * not the enclosing class, so qualifying with the child class name would
 * produce a false edge when the child also defines a same-named method.
 *
 * Shared by the full-build (`stages/build-edges.ts`) and incremental
 * (`incremental.ts`) call-resolution pipelines so the two cannot drift out of
 * sync (#1765).
 */
export function resolveSameClassThisFallback(
  call: { name: string; receiver?: string | null },
  callerName: string | null,
  relPath: string,
  lookup: CallNodeLookup,
): Array<{ id: number; file: string; kind?: string }> {
  if (call.receiver !== 'this' || callerName == null) return [];
  return resolveSameClassQualifiedMethod(call.name, callerName, relPath, lookup);
}

/**
 * Same-class bare-call fallback: when a no-receiver call can't be resolved
 * globally, try the caller's own class as a qualifier. Handles C# static
 * sibling calls: `IsValidEmail()` inside `Validators.ValidateUser` resolves
 * to `Validators.IsValidEmail`. Skipped for JS/TS where bare calls are
 * module-scoped, not class-scoped.
 *
 * Shared by the full-build (`stages/build-edges.ts`) and incremental
 * (`incremental.ts`) call-resolution pipelines so the two cannot drift out of
 * sync (#1765).
 */
export function resolveSameClassBareCallFallback(
  call: { name: string; receiver?: string | null },
  callerName: string | null,
  relPath: string,
  lookup: CallNodeLookup,
): Array<{ id: number; file: string; kind?: string }> {
  if (call.receiver || callerName == null || isModuleScopedLanguage(relPath)) return [];
  return resolveSameClassQualifiedMethod(call.name, callerName, relPath, lookup);
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
    if (!CALLABLE_KINDS.has(def.kind)) continue;
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
 * The original logic is unchanged; only the physical location moved.
 */
export function resolveByMethodOrGlobal(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  typeMap: Map<string, unknown>,
  callerName?: string | null,
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
      const actualSource = lookup.resolveBarrel(importedFrom, targetName);
      if (actualSource) {
        targets = lookup.byNameAndFile(targetName, actualSource);
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
