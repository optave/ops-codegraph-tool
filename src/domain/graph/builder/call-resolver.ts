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
): ReadonlyArray<{ id: number; file: string }> {
  if (call.receiver) {
    const typeEntry = typeMap.get(call.receiver);
    const typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : (typeEntry as { type?: string }).type
      : null;
    if (typeName) {
      const typed = lookup.byName(`${typeName}.${call.name}`).filter((n) => n.kind === 'method');
      if (typed.length > 0) return typed;
    }
  }
  if (
    !call.receiver ||
    call.receiver === 'this' ||
    call.receiver === 'self' ||
    call.receiver === 'super'
  ) {
    return lookup.byName(call.name).filter((t) => computeConfidence(relPath, t.file, null) >= 0.5);
  }
  return [];
}

export function resolveCallTargets(
  lookup: CallNodeLookup,
  call: { name: string; receiver?: string | null },
  relPath: string,
  importedNames: Map<string, string>,
  typeMap: Map<string, unknown>,
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
      targets = resolveByMethodOrGlobal(lookup, call, relPath, typeMap);
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
