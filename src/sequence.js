/**
 * Sequence diagram generation — Mermaid sequenceDiagram from call graph edges.
 *
 * Participants are files (not individual functions). Calls within the same file
 * become self-messages. This keeps diagrams readable and matches typical
 * sequence-diagram conventions.
 */

import { openReadonlyOrFail } from './db.js';
import { paginateResult, printNdjson } from './paginate.js';
import { isTestFile, kindIcon } from './queries.js';
import { FRAMEWORK_ENTRY_PREFIXES } from './structure.js';

// ─── findBestMatch (copied from flow.js — same pattern) ─────────────

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

// ─── Alias generation ────────────────────────────────────────────────

/**
 * Build short participant aliases from file paths with collision handling.
 * e.g. "src/builder.js" → "builder", but if two files share basename,
 * progressively add parent dirs: "src/builder" vs "lib/builder".
 */
function buildAliases(files) {
  const aliases = new Map();
  const basenames = new Map();

  // Group by basename
  for (const file of files) {
    const base = file
      .split('/')
      .pop()
      .replace(/\.[^.]+$/, '');
    if (!basenames.has(base)) basenames.set(base, []);
    basenames.get(base).push(file);
  }

  for (const [base, paths] of basenames) {
    if (paths.length === 1) {
      aliases.set(paths[0], base);
    } else {
      // Collision — progressively add parent dirs until aliases are unique
      for (let depth = 2; depth <= 10; depth++) {
        const trial = new Map();
        let allUnique = true;
        const seen = new Set();

        for (const p of paths) {
          const parts = p.replace(/\.[^.]+$/, '').split('/');
          const alias = parts
            .slice(-depth)
            .join('/')
            .replace(/[^a-zA-Z0-9_/-]/g, '_');
          trial.set(p, alias);
          if (seen.has(alias)) allUnique = false;
          seen.add(alias);
        }

        if (allUnique || depth === 10) {
          for (const [p, alias] of trial) {
            aliases.set(p, alias);
          }
          break;
        }
      }
    }
  }

  return aliases;
}

// ─── Core data function ──────────────────────────────────────────────

/**
 * Build sequence diagram data by BFS-forward from an entry point.
 *
 * @param {string} name - Symbol name to trace from
 * @param {string} [dbPath]
 * @param {object} [opts]
 * @param {number} [opts.depth=10]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.file]
 * @param {string} [opts.kind]
 * @param {boolean} [opts.dataflow]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @returns {{ entry, participants, messages, depth, totalMessages, truncated }}
 */
export function sequenceData(name, dbPath, opts = {}) {
  const db = openReadonlyOrFail(dbPath);
  const maxDepth = opts.depth || 10;
  const noTests = opts.noTests || false;
  const withDataflow = opts.dataflow || false;

  // Phase 1: Direct LIKE match
  let matchNode = findBestMatch(db, name, opts);

  // Phase 2: Prefix-stripped matching
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
      participants: [],
      messages: [],
      depth: maxDepth,
      totalMessages: 0,
      truncated: false,
    };
  }

  const entry = {
    name: matchNode.name,
    file: matchNode.file,
    kind: matchNode.kind,
    line: matchNode.line,
  };

  // BFS forward — track edges, not just nodes
  const visited = new Set([matchNode.id]);
  let frontier = [matchNode.id];
  const messages = [];
  const fileSet = new Set([matchNode.file]);
  const idToNode = new Map();
  idToNode.set(matchNode.id, matchNode);
  let truncated = false;

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier = [];

    for (const fid of frontier) {
      const callees = db
        .prepare(
          `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
           FROM edges e JOIN nodes n ON e.target_id = n.id
           WHERE e.source_id = ? AND e.kind = 'calls'`,
        )
        .all(fid);

      const caller = idToNode.get(fid);

      for (const c of callees) {
        if (noTests && isTestFile(c.file)) continue;

        // Always record the message (even for visited nodes — different caller path)
        fileSet.add(c.file);
        messages.push({
          from: caller.file,
          to: c.file,
          label: c.name,
          type: 'call',
          depth: d,
        });

        if (visited.has(c.id)) continue;

        visited.add(c.id);
        nextFrontier.push(c.id);
        idToNode.set(c.id, c);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;

    if (d === maxDepth && frontier.length > 0) {
      truncated = true;
    }
  }

  // Dataflow annotations: add return arrows
  if (withDataflow && messages.length > 0) {
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dataflow'")
      .get();

    if (hasTable) {
      // For each called function, check if it has return edges
      const seenReturns = new Set();
      for (const msg of [...messages]) {
        if (msg.type !== 'call') continue;
        const targetNode = [...idToNode.values()].find(
          (n) => n.name === msg.label && n.file === msg.to,
        );
        if (!targetNode) continue;

        const returnKey = `${msg.to}->${msg.from}:${msg.label}`;
        if (seenReturns.has(returnKey)) continue;

        const returns = db
          .prepare(
            `SELECT d.expression FROM dataflow d
             WHERE d.source_id = ? AND d.kind = 'returns'`,
          )
          .all(targetNode.id);

        if (returns.length > 0) {
          seenReturns.add(returnKey);
          const expr = returns[0].expression || 'result';
          messages.push({
            from: msg.to,
            to: msg.from,
            label: expr,
            type: 'return',
            depth: msg.depth,
          });
        }
      }

      // Annotate call messages with parameter names
      for (const msg of messages) {
        if (msg.type !== 'call') continue;
        const targetNode = [...idToNode.values()].find(
          (n) => n.name === msg.label && n.file === msg.to,
        );
        if (!targetNode) continue;

        const params = db
          .prepare(
            `SELECT d.expression FROM dataflow d
             WHERE d.target_id = ? AND d.kind = 'flows_to'
             ORDER BY d.param_index`,
          )
          .all(targetNode.id);

        if (params.length > 0) {
          const paramNames = params
            .map((p) => p.expression)
            .filter(Boolean)
            .slice(0, 3);
          if (paramNames.length > 0) {
            msg.label = `${msg.label}(${paramNames.join(', ')})`;
          }
        }
      }
    }
  }

  // Sort messages by depth, then call before return
  messages.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.type === 'call' && b.type === 'return') return -1;
    if (a.type === 'return' && b.type === 'call') return 1;
    return 0;
  });

  // Build participant list from files
  const aliases = buildAliases([...fileSet]);
  const participants = [...fileSet].map((file) => ({
    id: aliases.get(file),
    label: file.split('/').pop(),
    file,
  }));

  // Sort participants: entry file first, then alphabetically
  participants.sort((a, b) => {
    if (a.file === entry.file) return -1;
    if (b.file === entry.file) return 1;
    return a.file.localeCompare(b.file);
  });

  // Replace file paths with alias IDs in messages
  for (const msg of messages) {
    msg.from = aliases.get(msg.from);
    msg.to = aliases.get(msg.to);
  }

  db.close();

  const base = {
    entry,
    participants,
    messages,
    depth: maxDepth,
    totalMessages: messages.length,
    truncated,
  };
  return paginateResult(base, 'messages', { limit: opts.limit, offset: opts.offset });
}

// ─── Mermaid formatter ───────────────────────────────────────────────

/**
 * Escape special Mermaid characters in labels.
 */
function escapeMermaid(str) {
  return str.replace(/:/g, '#colon;').replace(/"/g, '#quot;');
}

/**
 * Convert sequenceData result to Mermaid sequenceDiagram syntax.
 * @param {{ participants, messages, truncated }} seqResult
 * @returns {string}
 */
export function sequenceToMermaid(seqResult) {
  const lines = ['sequenceDiagram'];

  for (const p of seqResult.participants) {
    lines.push(`    participant ${p.id} as ${escapeMermaid(p.label)}`);
  }

  for (const msg of seqResult.messages) {
    const arrow = msg.type === 'return' ? '-->>' : '->>';
    lines.push(`    ${msg.from}${arrow}${msg.to}: ${escapeMermaid(msg.label)}`);
  }

  if (seqResult.truncated) {
    lines.push(
      `    note right of ${seqResult.participants[0]?.id}: Truncated at depth ${seqResult.depth}`,
    );
  }

  return lines.join('\n');
}

// ─── CLI formatter ───────────────────────────────────────────────────

/**
 * CLI entry point — format sequence data as mermaid, JSON, or ndjson.
 */
export function sequence(name, dbPath, opts = {}) {
  const data = sequenceData(name, dbPath, opts);

  if (opts.ndjson) {
    printNdjson(data, 'messages');
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Default: mermaid format
  if (!data.entry) {
    console.log(`No matching function found for "${name}".`);
    return;
  }

  const e = data.entry;
  console.log(`\nSequence from: [${kindIcon(e.kind)}] ${e.name}  ${e.file}:${e.line}`);
  console.log(`Participants: ${data.participants.length}  Messages: ${data.totalMessages}`);
  if (data.truncated) {
    console.log(`  (truncated at depth ${data.depth})`);
  }
  console.log();

  if (data.messages.length === 0) {
    console.log('  (leaf node — no callees)');
    return;
  }

  console.log(sequenceToMermaid(data));
}
