/**
 * Branch structural diff – compare code structure between two git refs.
 *
 * Builds separate codegraph databases for each ref using git worktrees,
 * then diffs at the symbol level to show added/removed/changed symbols
 * and transitive caller impact.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { buildGraph } from '../domain/graph/builder.js';
import { kindIcon } from '../domain/queries.js';
import { isTestFile } from '../infrastructure/test-filter.js';

// ─── Git Helpers ────────────────────────────────────────────────────────

function validateGitRef(repoRoot, ref) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return sha;
  } catch {
    return null;
  }
}

function getChangedFilesBetweenRefs(repoRoot, base, target) {
  const output = execFileSync('git', ['diff', '--name-only', `${base}..${target}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  if (!output) return [];
  return output.split('\n').filter(Boolean);
}

function createWorktree(repoRoot, ref, dir) {
  execFileSync('git', ['worktree', 'add', '--detach', dir, ref], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function removeWorktree(repoRoot, dir) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // Fallback: remove directory and prune
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      execFileSync('git', ['worktree', 'prune'], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Symbol Loading ─────────────────────────────────────────────────────

function makeSymbolKey(kind, file, name) {
  return `${kind}::${file}::${name}`;
}

function loadSymbolsFromDb(dbPath, changedFiles, noTests) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const symbols = new Map();

    if (changedFiles.length === 0) {
      return symbols;
    }

    // Query nodes in changed files
    const placeholders = changedFiles.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line
         FROM nodes n
         WHERE n.file IN (${placeholders})
           AND n.kind NOT IN ('file', 'directory')
         ORDER BY n.file, n.line`,
      )
      .all(...changedFiles);

    // Compute fan_in and fan_out for each node
    const fanInStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM edges WHERE target_id = ? AND kind = 'calls'`,
    );
    const fanOutStmt = db.prepare(
      `SELECT COUNT(*) AS cnt FROM edges WHERE source_id = ? AND kind = 'calls'`,
    );

    for (const row of rows) {
      if (noTests && isTestFile(row.file)) continue;

      const lineCount = row.end_line ? row.end_line - row.line + 1 : 0;
      const fanIn = fanInStmt.get(row.id).cnt;
      const fanOut = fanOutStmt.get(row.id).cnt;
      const key = makeSymbolKey(row.kind, row.file, row.name);

      symbols.set(key, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        lineCount,
        fanIn,
        fanOut,
      });
    }

    return symbols;
  } finally {
    db.close();
  }
}

// ─── Caller BFS ─────────────────────────────────────────────────────────

function loadCallersFromDb(dbPath, nodeIds, maxDepth, noTests) {
  if (nodeIds.length === 0) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const allCallers = new Set();

    for (const startId of nodeIds) {
      const visited = new Set([startId]);
      let frontier = [startId];

      for (let d = 1; d <= maxDepth; d++) {
        const nextFrontier = [];
        for (const fid of frontier) {
          const callers = db
            .prepare(
              `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
               FROM edges e JOIN nodes n ON e.source_id = n.id
               WHERE e.target_id = ? AND e.kind = 'calls'`,
            )
            .all(fid);

          for (const c of callers) {
            if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
              visited.add(c.id);
              nextFrontier.push(c.id);
              allCallers.add(
                JSON.stringify({ name: c.name, kind: c.kind, file: c.file, line: c.line }),
              );
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }
    }

    return [...allCallers].map((s) => JSON.parse(s));
  } finally {
    db.close();
  }
}

// ─── Symbol Comparison ──────────────────────────────────────────────────

function compareSymbols(baseSymbols, targetSymbols) {
  const added = [];
  const removed = [];
  const changed = [];

  // Added: in target but not base
  for (const [key, sym] of targetSymbols) {
    if (!baseSymbols.has(key)) {
      added.push(sym);
    }
  }

  // Removed: in base but not target
  for (const [key, sym] of baseSymbols) {
    if (!targetSymbols.has(key)) {
      removed.push(sym);
    }
  }

  // Changed: in both but with different metrics
  for (const [key, baseSym] of baseSymbols) {
    const targetSym = targetSymbols.get(key);
    if (!targetSym) continue;

    const lineCountDelta = targetSym.lineCount - baseSym.lineCount;
    const fanInDelta = targetSym.fanIn - baseSym.fanIn;
    const fanOutDelta = targetSym.fanOut - baseSym.fanOut;

    if (lineCountDelta !== 0 || fanInDelta !== 0 || fanOutDelta !== 0) {
      changed.push({
        name: baseSym.name,
        kind: baseSym.kind,
        file: baseSym.file,
        base: {
          line: baseSym.line,
          lineCount: baseSym.lineCount,
          fanIn: baseSym.fanIn,
          fanOut: baseSym.fanOut,
        },
        target: {
          line: targetSym.line,
          lineCount: targetSym.lineCount,
          fanIn: targetSym.fanIn,
          fanOut: targetSym.fanOut,
        },
        changes: {
          lineCount: lineCountDelta,
          fanIn: fanInDelta,
          fanOut: fanOutDelta,
        },
      });
    }
  }

  return { added, removed, changed };
}

// ─── Main Data Function ─────────────────────────────────────────────────

export async function branchCompareData(baseRef, targetRef, opts = {}) {
  const repoRoot = opts.repoRoot || process.cwd();
  const maxDepth = opts.depth || 3;
  const noTests = opts.noTests || false;
  const engine = opts.engine || 'wasm';

  // Check if this is a git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { error: 'Not a git repository' };
  }

  // Validate refs
  const baseSha = validateGitRef(repoRoot, baseRef);
  if (!baseSha) return { error: `Invalid git ref: "${baseRef}"` };

  const targetSha = validateGitRef(repoRoot, targetRef);
  if (!targetSha) return { error: `Invalid git ref: "${targetRef}"` };

  // Get changed files
  const changedFiles = getChangedFilesBetweenRefs(repoRoot, baseSha, targetSha);

  if (changedFiles.length === 0) {
    return {
      baseRef,
      targetRef,
      baseSha,
      targetSha,
      changedFiles: [],
      added: [],
      removed: [],
      changed: [],
      summary: {
        added: 0,
        removed: 0,
        changed: 0,
        totalImpacted: 0,
        filesAffected: 0,
      },
    };
  }

  // Create temp dir for worktrees
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bc-'));
  const baseDir = path.join(tmpBase, 'base');
  const targetDir = path.join(tmpBase, 'target');

  try {
    // Create worktrees
    createWorktree(repoRoot, baseSha, baseDir);
    createWorktree(repoRoot, targetSha, targetDir);

    // Build graphs
    await buildGraph(baseDir, { engine, skipRegistry: true });
    await buildGraph(targetDir, { engine, skipRegistry: true });

    const baseDbPath = path.join(baseDir, '.codegraph', 'graph.db');
    const targetDbPath = path.join(targetDir, '.codegraph', 'graph.db');

    // Normalize file paths for comparison (relative to worktree root)
    const normalizedFiles = changedFiles.map((f) => f.replace(/\\/g, '/'));

    // Load symbols from both DBs
    const baseSymbols = loadSymbolsFromDb(baseDbPath, normalizedFiles, noTests);
    const targetSymbols = loadSymbolsFromDb(targetDbPath, normalizedFiles, noTests);

    // Compare
    const { added, removed, changed } = compareSymbols(baseSymbols, targetSymbols);

    // BFS for transitive callers of removed/changed symbols in base graph
    const removedIds = removed.map((s) => s.id).filter(Boolean);
    const changedIds = changed
      .map((s) => {
        const baseSym = baseSymbols.get(makeSymbolKey(s.kind, s.file, s.name));
        return baseSym?.id;
      })
      .filter(Boolean);

    const removedImpact = loadCallersFromDb(baseDbPath, removedIds, maxDepth, noTests);
    const changedImpact = loadCallersFromDb(baseDbPath, changedIds, maxDepth, noTests);

    // Attach impact to removed/changed
    for (const sym of removed) {
      const symCallers = loadCallersFromDb(baseDbPath, sym.id ? [sym.id] : [], maxDepth, noTests);
      sym.impact = symCallers;
    }
    for (const sym of changed) {
      const baseSym = baseSymbols.get(makeSymbolKey(sym.kind, sym.file, sym.name));
      const symCallers = loadCallersFromDb(
        baseDbPath,
        baseSym?.id ? [baseSym.id] : [],
        maxDepth,
        noTests,
      );
      sym.impact = symCallers;
    }

    // Summary
    const allImpacted = new Set();
    for (const c of removedImpact) allImpacted.add(`${c.file}:${c.name}`);
    for (const c of changedImpact) allImpacted.add(`${c.file}:${c.name}`);

    const impactedFiles = new Set();
    for (const key of allImpacted) impactedFiles.add(key.split(':')[0]);

    // Remove id fields from output (internal only)
    const cleanAdded = added.map(({ id, ...rest }) => rest);
    const cleanRemoved = removed.map(({ id, ...rest }) => rest);

    return {
      baseRef,
      targetRef,
      baseSha,
      targetSha,
      changedFiles: normalizedFiles,
      added: cleanAdded,
      removed: cleanRemoved,
      changed,
      summary: {
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        totalImpacted: allImpacted.size,
        filesAffected: impactedFiles.size,
      },
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    // Clean up worktrees
    removeWorktree(repoRoot, baseDir);
    removeWorktree(repoRoot, targetDir);
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Mermaid Output ─────────────────────────────────────────────────────

export function branchCompareMermaid(data) {
  if (data.error) return data.error;
  if (data.added.length === 0 && data.removed.length === 0 && data.changed.length === 0) {
    return 'flowchart TB\n    none["No structural differences detected"]';
  }

  const lines = ['flowchart TB'];
  let nodeCounter = 0;
  const nodeIdMap = new Map();

  function nodeId(key) {
    if (!nodeIdMap.has(key)) {
      nodeIdMap.set(key, `n${nodeCounter++}`);
    }
    return nodeIdMap.get(key);
  }

  // Added subgraph (green)
  if (data.added.length > 0) {
    lines.push('    subgraph sg_added["Added"]');
    for (const sym of data.added) {
      const key = `added::${sym.kind}::${sym.file}::${sym.name}`;
      const nid = nodeId(key, sym.name);
      lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_added fill:#e8f5e9,stroke:#4caf50');
  }

  // Removed subgraph (red)
  if (data.removed.length > 0) {
    lines.push('    subgraph sg_removed["Removed"]');
    for (const sym of data.removed) {
      const key = `removed::${sym.kind}::${sym.file}::${sym.name}`;
      const nid = nodeId(key, sym.name);
      lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_removed fill:#ffebee,stroke:#f44336');
  }

  // Changed subgraph (orange)
  if (data.changed.length > 0) {
    lines.push('    subgraph sg_changed["Changed"]');
    for (const sym of data.changed) {
      const key = `changed::${sym.kind}::${sym.file}::${sym.name}`;
      const nid = nodeId(key, sym.name);
      lines.push(`        ${nid}["[${kindIcon(sym.kind)}] ${sym.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_changed fill:#fff3e0,stroke:#ff9800');
  }

  // Impacted callers subgraph (purple)
  const allImpacted = new Map();
  for (const sym of [...data.removed, ...data.changed]) {
    if (!sym.impact) continue;
    for (const c of sym.impact) {
      const key = `impact::${c.kind}::${c.file}::${c.name}`;
      if (!allImpacted.has(key)) allImpacted.set(key, c);
    }
  }

  if (allImpacted.size > 0) {
    lines.push('    subgraph sg_impact["Impacted Callers"]');
    for (const [key, c] of allImpacted) {
      const nid = nodeId(key, c.name);
      lines.push(`        ${nid}["[${kindIcon(c.kind)}] ${c.name}"]`);
    }
    lines.push('    end');
    lines.push('    style sg_impact fill:#f3e5f5,stroke:#9c27b0');
  }

  // Edges: removed/changed -> impacted callers
  for (const sym of [...data.removed, ...data.changed]) {
    if (!sym.impact) continue;
    const prefix = data.removed.includes(sym) ? 'removed' : 'changed';
    const symKey = `${prefix}::${sym.kind}::${sym.file}::${sym.name}`;
    for (const c of sym.impact) {
      const callerKey = `impact::${c.kind}::${c.file}::${c.name}`;
      if (nodeIdMap.has(symKey) && nodeIdMap.has(callerKey)) {
        lines.push(`    ${nodeIdMap.get(symKey)} -.-> ${nodeIdMap.get(callerKey)}`);
      }
    }
  }

  return lines.join('\n');
}
