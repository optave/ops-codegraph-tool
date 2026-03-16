/**
 * Sequence diagram generation – Mermaid sequenceDiagram from call graph edges.
 *
 * Participants are files (not individual functions). Calls within the same file
 * become self-messages. This keeps diagrams readable and matches typical
 * sequence-diagram conventions.
 */

import { findCallees, openReadonlyOrFail } from './db.js';
import { isTestFile } from './infrastructure/test-filter.js';
import { paginateResult } from './paginate.js';
import { findMatchingNodes } from './queries.js';
import { FRAMEWORK_ENTRY_PREFIXES } from './structure.js';

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
            .join('_')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
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
  try {
    const maxDepth = opts.depth || 10;
    const noTests = opts.noTests || false;
    const withDataflow = opts.dataflow || false;

    // Phase 1: Direct LIKE match
    let matchNode = findMatchingNodes(db, name, opts)[0] ?? null;

    // Phase 2: Prefix-stripped matching
    if (!matchNode) {
      for (const prefix of FRAMEWORK_ENTRY_PREFIXES) {
        matchNode = findMatchingNodes(db, `${prefix}${name}`, opts)[0] ?? null;
        if (matchNode) break;
      }
    }

    if (!matchNode) {
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
        const callees = findCallees(db, fid);

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
        // Only mark truncated if at least one frontier node has further callees
        const hasMoreCalls = frontier.some((fid) => findCallees(db, fid).length > 0);
        if (hasMoreCalls) truncated = true;
      }
    }

    // Dataflow annotations: add return arrows
    if (withDataflow && messages.length > 0) {
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dataflow'")
        .get();

      if (hasTable) {
        // Build name|file lookup for O(1) target node access
        const nodeByNameFile = new Map();
        for (const n of idToNode.values()) {
          nodeByNameFile.set(`${n.name}|${n.file}`, n);
        }

        const getReturns = db.prepare(
          `SELECT d.expression FROM dataflow d
         WHERE d.source_id = ? AND d.kind = 'returns'`,
        );
        const getFlowsTo = db.prepare(
          `SELECT d.expression FROM dataflow d
         WHERE d.target_id = ? AND d.kind = 'flows_to'
         ORDER BY d.param_index`,
        );

        // For each called function, check if it has return edges
        const seenReturns = new Set();
        for (const msg of [...messages]) {
          if (msg.type !== 'call') continue;
          const targetNode = nodeByNameFile.get(`${msg.label}|${msg.to}`);
          if (!targetNode) continue;

          const returnKey = `${msg.to}->${msg.from}:${msg.label}`;
          if (seenReturns.has(returnKey)) continue;

          const returns = getReturns.all(targetNode.id);

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
          const targetNode = nodeByNameFile.get(`${msg.label}|${msg.to}`);
          if (!targetNode) continue;

          const params = getFlowsTo.all(targetNode.id);

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

    const base = {
      entry,
      participants,
      messages,
      depth: maxDepth,
      totalMessages: messages.length,
      truncated,
    };
    const result = paginateResult(base, 'messages', { limit: opts.limit, offset: opts.offset });
    if (opts.limit !== undefined || opts.offset !== undefined) {
      const activeFiles = new Set(result.messages.flatMap((m) => [m.from, m.to]));
      result.participants = result.participants.filter((p) => activeFiles.has(p.id));
    }
    return result;
  } finally {
    db.close();
  }
}

// Re-export Mermaid renderer from presentation layer
export { sequenceToMermaid } from './presentation/sequence-renderer.js';
