import {
  findDistinctCallers,
  findFileNodes,
  findImportDependents,
  findImportSources,
  findImportTargets,
  findNodesByFile,
  openReadonlyOrFail,
} from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import { isTestFile } from '../../infrastructure/test-filter.js';

/** Symbol kinds meaningful for a file brief — excludes parameters, properties, constants. */
const BRIEF_KINDS = new Set([
  'function',
  'method',
  'class',
  'interface',
  'type',
  'struct',
  'enum',
  'trait',
  'record',
  'module',
]);

/**
 * Compute file risk tier from symbol roles and max fan-in.
 * @param {{ role: string|null, callerCount: number }[]} symbols
 * @returns {'high'|'medium'|'low'}
 */
function computeRiskTier(symbols, highThreshold = 10, mediumThreshold = 3) {
  let maxCallers = 0;
  let hasCoreRole = false;
  for (const s of symbols) {
    if (s.callerCount > maxCallers) maxCallers = s.callerCount;
    if (s.role === 'core') hasCoreRole = true;
  }
  if (maxCallers >= highThreshold || hasCoreRole) return 'high';
  if (maxCallers >= mediumThreshold) return 'medium';
  return 'low';
}

/**
 * BFS to count transitive callers for a single node.
 * Lightweight variant — only counts, does not collect details.
 */
function countTransitiveCallers(db, startId, noTests, maxDepth = 5) {
  const visited = new Set([startId]);
  let frontier = [startId];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier = [];
    for (const fid of frontier) {
      const callers = findDistinctCallers(db, fid);
      for (const c of callers) {
        if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
          visited.add(c.id);
          nextFrontier.push(c.id);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return visited.size - 1;
}

/**
 * Count transitive file-level import dependents via BFS.
 * Depth-bounded to match countTransitiveCallers and keep hook latency predictable.
 */
function countTransitiveImporters(db, fileNodeIds, noTests, maxDepth = 5) {
  const visited = new Set(fileNodeIds);
  let frontier = [...fileNodeIds];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier = [];
    for (const current of frontier) {
      const dependents = findImportDependents(db, current);
      for (const dep of dependents) {
        if (!visited.has(dep.id) && (!noTests || !isTestFile(dep.file))) {
          visited.add(dep.id);
          nextFrontier.push(dep.id);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return visited.size - fileNodeIds.length;
}

/**
 * Produce a token-efficient file brief: symbols with roles and caller counts,
 * importer info with transitive count, and file risk tier.
 *
 * @param {string} file - File path (partial match)
 * @param {string} customDbPath - Path to graph.db
 * @param {{ noTests?: boolean }} opts
 * @returns {{ file: string, results: object[] }}
 */
export function briefData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const config = opts.config || loadConfig();
    const callerDepth = config.analysis?.briefCallerDepth ?? 5;
    const importerDepth = config.analysis?.briefImporterDepth ?? 5;
    const highRiskCallers = config.analysis?.briefHighRiskCallers ?? 10;
    const mediumRiskCallers = config.analysis?.briefMediumRiskCallers ?? 3;
    const fileNodes = findFileNodes(db, `%${file}%`);
    if (fileNodes.length === 0) {
      return { file, results: [] };
    }

    const results = fileNodes.map((fn) => {
      // Direct importers
      let importedBy = findImportSources(db, fn.id);
      if (noTests) importedBy = importedBy.filter((i) => !isTestFile(i.file));
      const directImporters = [...new Set(importedBy.map((i) => i.file))];

      // Transitive importer count
      const totalImporterCount = countTransitiveImporters(db, [fn.id], noTests, importerDepth);

      // Direct imports
      let importsTo = findImportTargets(db, fn.id);
      if (noTests) importsTo = importsTo.filter((i) => !isTestFile(i.file));

      // Symbol definitions with roles and caller counts
      const defs = findNodesByFile(db, fn.file).filter((d) => BRIEF_KINDS.has(d.kind));
      const symbols = defs.map((d) => {
        const callerCount = countTransitiveCallers(db, d.id, noTests, callerDepth);
        return {
          name: d.name,
          kind: d.kind,
          line: d.line,
          role: d.role || null,
          callerCount,
        };
      });

      const riskTier = computeRiskTier(symbols, highRiskCallers, mediumRiskCallers);

      return {
        file: fn.file,
        risk: riskTier,
        imports: importsTo.map((i) => i.file),
        importedBy: directImporters,
        totalImporterCount,
        symbols,
      };
    });

    return { file, results };
  } finally {
    db.close();
  }
}
