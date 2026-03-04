/**
 * Execution flow tracing — forward BFS from entry points through callees to leaves.
 *
 * Answers "what happens when a user hits POST /login?" by tracing from
 * framework entry points (routes, commands, events) through their call chains.
 */

import { openReadonlyOrFail } from './db.js';
import { paginateResult, printNdjson } from './paginate.js';
import { isTestFile, kindIcon } from './queries.js';
import { FRAMEWORK_ENTRY_PREFIXES } from './structure.js';

/**
 * Determine the entry point type from a node name based on framework prefixes.
 * @param {string} name
 * @returns {'route'|'event'|'command'|'exported'|null}
 */
export function entryPointType(name) {
  for (const prefix of FRAMEWORK_ENTRY_PREFIXES) {
    if (name.startsWith(prefix)) {
      return prefix.slice(0, -1); // 'route:', 'event:', 'command:' → 'route', 'event', 'command'
    }
  }
  return null;
}

/**
 * Query all entry points from the graph, grouped by type.
 * Entry points are nodes with framework prefixes or role = 'entry'.
 *
 * @param {string} [dbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @returns {{ entries: object[], byType: object, count: number }}
 */
export function listEntryPointsData(dbPath, opts = {}) {
  const db = openReadonlyOrFail(dbPath);
  const noTests = opts.noTests || false;

  // Find all framework-prefixed nodes
  const prefixConditions = FRAMEWORK_ENTRY_PREFIXES.map(() => 'n.name LIKE ?').join(' OR ');
  const prefixParams = FRAMEWORK_ENTRY_PREFIXES.map((p) => `${p}%`);

  let rows = db
    .prepare(
      `SELECT n.name, n.kind, n.file, n.line, n.role
       FROM nodes n
       WHERE (
         (${prefixConditions})
         OR n.role = 'entry'
       )
         AND n.kind NOT IN ('file', 'directory')
       ORDER BY n.name`,
    )
    .all(...prefixParams);

  if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

  const entries = rows.map((r) => ({
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    role: r.role,
    type: entryPointType(r.name) || (r.role === 'entry' ? 'exported' : null),
  }));

  const byType = {};
  for (const e of entries) {
    const t = e.type || 'other';
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }

  db.close();
  const base = { entries, byType, count: entries.length };
  return paginateResult(base, 'entries', { limit: opts.limit, offset: opts.offset });
}

/**
 * Forward BFS from a matched node through callees to leaves.
 *
 * @param {string} name - Node name to trace from (supports partial/prefix-stripped matching)
 * @param {string} [dbPath]
 * @param {object} [opts]
 * @param {number} [opts.depth=10]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.file]
 * @param {string} [opts.kind]
 * @returns {{ entry: object|null, depth: number, steps: object[], leaves: object[], cycles: object[], totalReached: number, truncated: boolean }}
 */
export function flowData(name, dbPath, opts = {}) {
  const db = openReadonlyOrFail(dbPath);
  const maxDepth = opts.depth || 10;
  const noTests = opts.noTests || false;

  // Phase 1: Direct LIKE match on full name
  let matchNode = findBestMatch(db, name, opts);

  // Phase 2: Prefix-stripped matching — try adding framework prefixes
  if (!matchNode) {
    for (const prefix of FRAMEWORK_ENTRY_PREFIXES) {
      matchNode = findBestMatch(db, `${prefix}${name}`, opts);
      if (matchNode) break;
    }
  }

  if (!matchNode) {
    db.close();
    return {
      entry: null,
      depth: maxDepth,
      steps: [],
      leaves: [],
      cycles: [],
      totalReached: 0,
      truncated: false,
    };
  }

  const epType = entryPointType(matchNode.name);
  const entry = {
    name: matchNode.name,
    kind: matchNode.kind,
    file: matchNode.file,
    line: matchNode.line,
    type: epType || 'exported',
    role: matchNode.role,
  };

  // Forward BFS through callees
  const visited = new Set([matchNode.id]);
  let frontier = [matchNode.id];
  const steps = [];
  const cycles = [];
  let truncated = false;

  // Track which nodes are at each depth and their depth for leaf detection
  const nodeDepths = new Map();
  const idToNode = new Map();
  idToNode.set(matchNode.id, entry);

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier = [];
    const levelNodes = [];

    for (const fid of frontier) {
      const callees = db
        .prepare(
          `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line, n.role
           FROM edges e JOIN nodes n ON e.target_id = n.id
           WHERE e.source_id = ? AND e.kind = 'calls'`,
        )
        .all(fid);

      for (const c of callees) {
        if (noTests && isTestFile(c.file)) continue;

        if (visited.has(c.id)) {
          // Cycle detected
          const fromNode = idToNode.get(fid);
          if (fromNode) {
            cycles.push({ from: fromNode.name, to: c.name, depth: d });
          }
          continue;
        }

        visited.add(c.id);
        nextFrontier.push(c.id);
        const nodeInfo = { name: c.name, kind: c.kind, file: c.file, line: c.line };
        levelNodes.push(nodeInfo);
        nodeDepths.set(c.id, d);
        idToNode.set(c.id, nodeInfo);
      }
    }

    if (levelNodes.length > 0) {
      steps.push({ depth: d, nodes: levelNodes });
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;

    if (d === maxDepth && frontier.length > 0) {
      truncated = true;
    }
  }

  // Identify leaves: visited nodes that have no outgoing 'calls' edges to other visited nodes
  // (or no outgoing calls at all)
  const leaves = [];
  for (const [id, depth] of nodeDepths) {
    const outgoing = db
      .prepare(
        `SELECT DISTINCT n.id
         FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind = 'calls'`,
      )
      .all(id);

    if (outgoing.length === 0) {
      const node = idToNode.get(id);
      if (node) {
        leaves.push({ ...node, depth });
      }
    }
  }

  db.close();
  const base = {
    entry,
    depth: maxDepth,
    steps,
    leaves,
    cycles,
    totalReached: visited.size - 1, // exclude the entry node itself
    truncated,
  };
  return paginateResult(base, 'steps', { limit: opts.limit, offset: opts.offset });
}

/**
 * Find the best matching node using the same relevance scoring as queries.js findMatchingNodes.
 */
function findBestMatch(db, name, opts = {}) {
  const kinds = opts.kind
    ? [opts.kind]
    : [
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
      ];
  const placeholders = kinds.map(() => '?').join(', ');
  const params = [`%${name}%`, ...kinds];

  let fileCondition = '';
  if (opts.file) {
    fileCondition = ' AND n.file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  const rows = db
    .prepare(
      `SELECT n.*, COALESCE(fi.cnt, 0) AS fan_in
       FROM nodes n
       LEFT JOIN (
         SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id
       ) fi ON fi.target_id = n.id
       WHERE n.name LIKE ? AND n.kind IN (${placeholders})${fileCondition}`,
    )
    .all(...params);

  const noTests = opts.noTests || false;
  const nodes = noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;

  if (nodes.length === 0) return null;

  const lowerQuery = name.toLowerCase();
  for (const node of nodes) {
    const lowerName = node.name.toLowerCase();
    const bareName = lowerName.includes('.') ? lowerName.split('.').pop() : lowerName;

    let matchScore;
    if (lowerName === lowerQuery || bareName === lowerQuery) {
      matchScore = 100;
    } else if (lowerName.startsWith(lowerQuery) || bareName.startsWith(lowerQuery)) {
      matchScore = 60;
    } else if (lowerName.includes(`.${lowerQuery}`) || lowerName.includes(`${lowerQuery}.`)) {
      matchScore = 40;
    } else {
      matchScore = 10;
    }

    const fanInBonus = Math.min(Math.log2(node.fan_in + 1) * 5, 25);
    node._relevance = matchScore + fanInBonus;
  }

  nodes.sort((a, b) => b._relevance - a._relevance);
  return nodes[0];
}

/**
 * CLI formatter — text or JSON output.
 */
export function flow(name, dbPath, opts = {}) {
  if (opts.list) {
    const data = listEntryPointsData(dbPath, {
      noTests: opts.noTests,
      limit: opts.limit,
      offset: opts.offset,
    });
    if (opts.ndjson) {
      printNdjson(data, 'entries');
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    if (data.count === 0) {
      console.log('No entry points found. Run "codegraph build" first.');
      return;
    }
    console.log(`\nEntry points (${data.count} total):\n`);
    for (const [type, entries] of Object.entries(data.byType)) {
      console.log(`  ${type} (${entries.length}):`);
      for (const e of entries) {
        console.log(`    [${kindIcon(e.kind)}] ${e.name}  ${e.file}:${e.line}`);
      }
      console.log();
    }
    return;
  }

  const data = flowData(name, dbPath, opts);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!data.entry) {
    console.log(`No matching entry point or function found for "${name}".`);
    return;
  }

  const e = data.entry;
  const typeTag = e.type !== 'exported' ? ` (${e.type})` : '';
  console.log(`\nFlow from: [${kindIcon(e.kind)}] ${e.name}${typeTag}  ${e.file}:${e.line}`);
  console.log(
    `Depth: ${data.depth}  Reached: ${data.totalReached} nodes  Leaves: ${data.leaves.length}`,
  );
  if (data.truncated) {
    console.log(`  (truncated at depth ${data.depth})`);
  }
  console.log();

  if (data.steps.length === 0) {
    console.log('  (leaf node — no callees)');
    return;
  }

  for (const step of data.steps) {
    console.log(`  depth ${step.depth}:`);
    for (const n of step.nodes) {
      const isLeaf = data.leaves.some((l) => l.name === n.name && l.file === n.file);
      const leafTag = isLeaf ? ' [leaf]' : '';
      console.log(`    [${kindIcon(n.kind)}] ${n.name}  ${n.file}:${n.line}${leafTag}`);
    }
  }

  if (data.cycles.length > 0) {
    console.log('\n  Cycles detected:');
    for (const c of data.cycles) {
      console.log(`    ${c.from} -> ${c.to} (at depth ${c.depth})`);
    }
  }
}
