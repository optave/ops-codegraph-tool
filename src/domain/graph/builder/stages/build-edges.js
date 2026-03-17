/**
 * Stage: buildEdges
 *
 * Builds import, call, receiver, extends, and implements edges.
 * Uses pre-loaded node lookup maps (N+1 optimization).
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getNodeId } from '../../../../db/index.js';
import { loadNative } from '../../../../infrastructure/native.js';
import { computeConfidence } from '../../resolve.js';
import { BUILTIN_RECEIVERS, batchInsertEdges } from '../helpers.js';
import { getResolved, isBarrelFile, resolveBarrelExport } from './resolve-imports.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function buildEdges(ctx) {
  const { db, fileSymbols, barrelOnlyFiles, rootDir, engineName } = ctx;

  const getNodeIdStmt = {
    get: (name, kind, file, line) => {
      const id = getNodeId(db, name, kind, file, line);
      return id != null ? { id } : undefined;
    },
  };

  // Pre-load all nodes into lookup maps
  const allNodes = db
    .prepare(
      `SELECT id, name, kind, file, line FROM nodes WHERE kind IN ('function','method','class','interface','struct','type','module','enum','trait','record','constant')`,
    )
    .all();
  ctx.nodesByName = new Map();
  for (const node of allNodes) {
    if (!ctx.nodesByName.has(node.name)) ctx.nodesByName.set(node.name, []);
    ctx.nodesByName.get(node.name).push(node);
  }
  ctx.nodesByNameAndFile = new Map();
  for (const node of allNodes) {
    const key = `${node.name}|${node.file}`;
    if (!ctx.nodesByNameAndFile.has(key)) ctx.nodesByNameAndFile.set(key, []);
    ctx.nodesByNameAndFile.get(key).push(node);
  }

  const t0 = performance.now();
  const buildEdgesTx = db.transaction(() => {
    const allEdgeRows = [];

    // ── Import edges ────────────────────────────────────────────────
    for (const [relPath, symbols] of fileSymbols) {
      if (barrelOnlyFiles.has(relPath)) continue;
      const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
      if (!fileNodeRow) continue;
      const fileNodeId = fileNodeRow.id;

      for (const imp of symbols.imports) {
        const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
        const targetRow = getNodeIdStmt.get(resolvedPath, 'file', resolvedPath, 0);
        if (targetRow) {
          const edgeKind = imp.reexport
            ? 'reexports'
            : imp.typeOnly
              ? 'imports-type'
              : imp.dynamicImport
                ? 'dynamic-imports'
                : 'imports';
          allEdgeRows.push([fileNodeId, targetRow.id, edgeKind, 1.0, 0]);

          if (!imp.reexport && isBarrelFile(ctx, resolvedPath)) {
            const resolvedSources = new Set();
            for (const name of imp.names) {
              const cleanName = name.replace(/^\*\s+as\s+/, '');
              const actualSource = resolveBarrelExport(ctx, resolvedPath, cleanName);
              if (
                actualSource &&
                actualSource !== resolvedPath &&
                !resolvedSources.has(actualSource)
              ) {
                resolvedSources.add(actualSource);
                const actualRow = getNodeIdStmt.get(actualSource, 'file', actualSource, 0);
                if (actualRow) {
                  allEdgeRows.push([
                    fileNodeId,
                    actualRow.id,
                    edgeKind === 'imports-type'
                      ? 'imports-type'
                      : edgeKind === 'dynamic-imports'
                        ? 'dynamic-imports'
                        : 'imports',
                    0.9,
                    0,
                  ]);
                }
              }
            }
          }
        }
      }
    }

    // ── Call/receiver/extends/implements edges ───────────────────────
    const native = engineName === 'native' ? loadNative() : null;
    if (native?.buildCallEdges) {
      const nativeFiles = [];
      for (const [relPath, symbols] of fileSymbols) {
        if (barrelOnlyFiles.has(relPath)) continue;
        const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
        if (!fileNodeRow) continue;

        const importedNames = [];
        for (const imp of symbols.imports) {
          const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
          for (const name of imp.names) {
            const cleanName = name.replace(/^\*\s+as\s+/, '');
            let targetFile = resolvedPath;
            if (isBarrelFile(ctx, resolvedPath)) {
              const actual = resolveBarrelExport(ctx, resolvedPath, cleanName);
              if (actual) targetFile = actual;
            }
            importedNames.push({ name: cleanName, file: targetFile });
          }
        }

        nativeFiles.push({
          file: relPath,
          fileNodeId: fileNodeRow.id,
          definitions: symbols.definitions.map((d) => ({
            name: d.name,
            kind: d.kind,
            line: d.line,
            endLine: d.endLine ?? null,
          })),
          calls: symbols.calls,
          importedNames,
          classes: symbols.classes,
        });
      }

      const nativeEdges = native.buildCallEdges(nativeFiles, allNodes, [...BUILTIN_RECEIVERS]);
      for (const e of nativeEdges) {
        allEdgeRows.push([e.sourceId, e.targetId, e.kind, e.confidence, e.dynamic]);
      }
    } else {
      // JS fallback
      for (const [relPath, symbols] of fileSymbols) {
        if (barrelOnlyFiles.has(relPath)) continue;
        const fileNodeRow = getNodeIdStmt.get(relPath, 'file', relPath, 0);
        if (!fileNodeRow) continue;

        const importedNames = new Map();
        for (const imp of symbols.imports) {
          const resolvedPath = getResolved(ctx, path.join(rootDir, relPath), imp.source);
          for (const name of imp.names) {
            const cleanName = name.replace(/^\*\s+as\s+/, '');
            importedNames.set(cleanName, resolvedPath);
          }
        }

        const seenCallEdges = new Set();
        for (const call of symbols.calls) {
          if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;
          let caller = null;
          let callerSpan = Infinity;
          for (const def of symbols.definitions) {
            if (def.line <= call.line) {
              const end = def.endLine || Infinity;
              if (call.line <= end) {
                const span = end - def.line;
                if (span < callerSpan) {
                  const row = getNodeIdStmt.get(def.name, def.kind, relPath, def.line);
                  if (row) {
                    caller = row;
                    callerSpan = span;
                  }
                }
              } else if (!caller) {
                const row = getNodeIdStmt.get(def.name, def.kind, relPath, def.line);
                if (row) caller = row;
              }
            }
          }
          if (!caller) caller = fileNodeRow;

          const isDynamic = call.dynamic ? 1 : 0;
          let targets;
          const importedFrom = importedNames.get(call.name);

          if (importedFrom) {
            targets = ctx.nodesByNameAndFile.get(`${call.name}|${importedFrom}`) || [];
            if (targets.length === 0 && isBarrelFile(ctx, importedFrom)) {
              const actualSource = resolveBarrelExport(ctx, importedFrom, call.name);
              if (actualSource) {
                targets = ctx.nodesByNameAndFile.get(`${call.name}|${actualSource}`) || [];
              }
            }
          }
          if (!targets || targets.length === 0) {
            targets = ctx.nodesByNameAndFile.get(`${call.name}|${relPath}`) || [];
            if (targets.length === 0) {
              const methodCandidates = (ctx.nodesByName.get(call.name) || []).filter(
                (n) => n.name.endsWith(`.${call.name}`) && n.kind === 'method',
              );
              if (methodCandidates.length > 0) {
                targets = methodCandidates;
              } else if (
                !call.receiver ||
                call.receiver === 'this' ||
                call.receiver === 'self' ||
                call.receiver === 'super'
              ) {
                targets = (ctx.nodesByName.get(call.name) || []).filter(
                  (n) => computeConfidence(relPath, n.file, null) >= 0.5,
                );
              }
            }
          }

          if (targets.length > 1) {
            targets.sort((a, b) => {
              const confA = computeConfidence(relPath, a.file, importedFrom);
              const confB = computeConfidence(relPath, b.file, importedFrom);
              return confB - confA;
            });
          }

          for (const t of targets) {
            const edgeKey = `${caller.id}|${t.id}`;
            if (t.id !== caller.id && !seenCallEdges.has(edgeKey)) {
              seenCallEdges.add(edgeKey);
              const confidence = computeConfidence(relPath, t.file, importedFrom);
              allEdgeRows.push([caller.id, t.id, 'calls', confidence, isDynamic]);
            }
          }

          // Receiver edge
          if (
            call.receiver &&
            !BUILTIN_RECEIVERS.has(call.receiver) &&
            call.receiver !== 'this' &&
            call.receiver !== 'self' &&
            call.receiver !== 'super'
          ) {
            const receiverKinds = new Set(['class', 'struct', 'interface', 'type', 'module']);
            const samefile = ctx.nodesByNameAndFile.get(`${call.receiver}|${relPath}`) || [];
            const candidates =
              samefile.length > 0 ? samefile : ctx.nodesByName.get(call.receiver) || [];
            const receiverNodes = candidates.filter((n) => receiverKinds.has(n.kind));
            if (receiverNodes.length > 0 && caller) {
              const recvTarget = receiverNodes[0];
              const recvKey = `recv|${caller.id}|${recvTarget.id}`;
              if (!seenCallEdges.has(recvKey)) {
                seenCallEdges.add(recvKey);
                allEdgeRows.push([caller.id, recvTarget.id, 'receiver', 0.7, 0]);
              }
            }
          }
        }

        // Class extends edges
        for (const cls of symbols.classes) {
          if (cls.extends) {
            const sourceRow = (ctx.nodesByNameAndFile.get(`${cls.name}|${relPath}`) || []).find(
              (n) => n.kind === 'class',
            );
            const targetCandidates = ctx.nodesByName.get(cls.extends) || [];
            const targetRows = targetCandidates.filter((n) => n.kind === 'class');
            if (sourceRow) {
              for (const t of targetRows) {
                allEdgeRows.push([sourceRow.id, t.id, 'extends', 1.0, 0]);
              }
            }
          }

          if (cls.implements) {
            const sourceRow = (ctx.nodesByNameAndFile.get(`${cls.name}|${relPath}`) || []).find(
              (n) => n.kind === 'class',
            );
            const targetCandidates = ctx.nodesByName.get(cls.implements) || [];
            const targetRows = targetCandidates.filter(
              (n) => n.kind === 'interface' || n.kind === 'class',
            );
            if (sourceRow) {
              for (const t of targetRows) {
                allEdgeRows.push([sourceRow.id, t.id, 'implements', 1.0, 0]);
              }
            }
          }
        }
      }
    }

    batchInsertEdges(db, allEdgeRows);
  });
  buildEdgesTx();
  ctx.timing.edgesMs = performance.now() - t0;
}
