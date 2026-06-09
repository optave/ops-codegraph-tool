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

// ── Shared resolution functions ──────────────────────────────────────────

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
  let caller: { id: number } | null = null;
  let callerName: string | null = null;
  let callerSpan = Infinity;
  for (const def of definitions) {
    if (def.line <= call.line) {
      const end = def.endLine || Infinity;
      if (call.line <= end) {
        const span = end - def.line;
        if (span < callerSpan) {
          const row = lookup.nodeId(def.name, def.kind, relPath, def.line);
          if (row) {
            caller = row;
            callerName = def.name;
            callerSpan = span;
          }
        }
      }
    }
  }
  return { ...(caller ?? fileNodeRow), callerName };
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
    // For this.prop receivers, also try the class-scoped key (ClassName.prop) seeded by
    // handlePropWriteTypeMap — prevents false edges when multiple classes define the same
    // property name (issue #1323).
    let typeEntry =
      typeMap.get(effectiveReceiver) ??
      typeMap.get(call.receiver) ??
      // Phase 8.3f: callee-scoped rest-param key (`callee::restName`) to avoid
      // same-name rest-binding collision across functions in the same file (#1358).
      (callerName ? typeMap.get(`${callerName}::${effectiveReceiver}`) : undefined);
    if (!typeEntry && call.receiver.startsWith('this.') && callerName) {
      const dotIdx = callerName.lastIndexOf('.');
      if (dotIdx > -1) {
        const callerClass = callerName.slice(0, dotIdx);
        typeEntry = typeMap.get(`${callerClass}.${effectiveReceiver}`);
      }
    }
    let typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : (typeEntry as { type?: string }).type
      : null;

    // Handle inline new-expression receivers: `(new Foo).bar()` or `(new Foo()).bar()`.
    // extractReceiverName returns the raw node text for non-identifier nodes, so `(new A).t()`
    // produces receiver='(new A)'. Extract the constructor name directly.
    // The regex intentionally restricts to uppercase-initial names ([A-Z_$]) as a heuristic
    // to distinguish constructors (PascalCase) from regular functions — avoiding false positives
    // on `(new xmlParser()).parse()` style calls which are rare in practice.
    if (!typeName && call.receiver) {
      const m = /^\(?\s*new\s+([A-Z_$][A-Za-z0-9_$]*)/.exec(call.receiver);
      if (m?.[1]) typeName = m[1];
    }

    if (typeName) {
      const typed = lookup.byName(`${typeName}.${call.name}`).filter((n) => n.kind === 'method');
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
        .filter((n) => n.kind === 'method' || n.kind === 'function');
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
    if (callerName) {
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
 * Receiver resolution collects all same-file candidates first (no kind
 * filter), falls back to global candidates only when the same-file set is
 * entirely empty, then filters the chosen set by RECEIVER_KINDS.  This
 * matches the native Rust build path: if a file imports a name that happens
 * to be emitted as `kind='function'` in the importer, the same-file set is
 * non-empty and blocks the global fallback, so no receiver edge is emitted.
 * Keeping this behaviour identical to the Rust path maintains engine parity.
 */
export function resolveReceiverEdge(
  lookup: CallNodeLookup,
  call: { name: string; receiver: string },
  caller: { id: number },
  relPath: string,
  typeMap: Map<string, unknown>,
  seenCallEdges: Set<string>,
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
  // Filter-before: apply RECEIVER_KINDS to same-file candidates first, then
  // fall back to global candidates (also filtered) only when same-file yields
  // nothing.  This prevents an imported name emitted as kind='function' in the
  // importing file from blocking the fallback to the actual class/struct/etc.
  // node in the defining file.
  const sameFileCandidates = lookup
    .byNameAndFile(effectiveReceiver, relPath)
    .filter((n) => RECEIVER_KINDS.has(n.kind ?? ''));
  const candidates =
    sameFileCandidates.length > 0
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
