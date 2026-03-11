/**
 * pre-commit-checks.js — Consolidated pre-commit codegraph checks.
 * Single Node.js process that runs all checks and returns structured JSON.
 *
 * Usage: node pre-commit-checks.js <WORK_ROOT> <EDITED_FILES> <STAGED_FILES>
 *
 * Output JSON: { action: "deny"|"allow", reason?: string, context?: string[] }
 *
 * Checks (in order):
 *   1. Cycles + Signatures (via checkData) — cycles block; signatures warn with risk level + caller count
 *   2. Dead exports (blocking) — blocks if edited src/ files have unused exports
 *   3. Diff-impact (informational) — shows blast radius of staged changes
 */

const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const editedRaw = process.argv[3] || '';
const stagedRaw = process.argv[4] || '';

const edited = new Set(editedRaw.split('\n').filter(Boolean));
const staged = stagedRaw.split('\n').filter(Boolean);
const output = { action: 'allow', context: [] };

try {
  const { checkData } = require(path.join(root, 'src/check.js'));
  const { openReadonlyOrFail } = require(path.join(root, 'src/db.js'));
  const { exportsData, diffImpactData } = require(path.join(root, 'src/queries.js'));

  // ── 1. Cycles + Signatures (via checkData) ──
  const data = checkData(undefined, {
    staged: true,
    noTests: true,
    boundaries: false,
  });

  if (data && !data.error && data.predicates) {
    // Cycle check (blocking)
    const cyclesPred = data.predicates.find(p => p.name === 'cycles');
    if (cyclesPred && !cyclesPred.passed && cyclesPred.cycles?.length && edited.size > 0) {
      const relevant = cyclesPred.cycles.filter(
        cycle => cycle.some(f => edited.has(f))
      );
      if (relevant.length > 0) {
        const summary = relevant.slice(0, 5).map(c => c.join(' -> ')).join('\n  ');
        const extra = relevant.length > 5 ? '\n  ... and ' + (relevant.length - 5) + ' more' : '';
        output.action = 'deny';
        output.reason = 'BLOCKED: Circular dependencies detected involving files you edited:\n  ' + summary + extra + '\nFix the cycles before committing.';
      }
    }

    // Signature warning (informational, only if not already denied)
    if (output.action !== 'deny') {
      const sigPred = data.predicates.find(p => p.name === 'signatures');
      if (sigPred && !sigPred.passed && sigPred.violations?.length) {
        let db;
        try {
          db = openReadonlyOrFail();
          const stmtNode = db.prepare(
            'SELECT id, role FROM nodes WHERE name = ? AND file = ? AND line = ?'
          );
          const stmtCallers = db.prepare(
            "SELECT DISTINCT n.id FROM edges e JOIN nodes n ON e.source_id = n.id WHERE e.target_id = ? AND e.kind = 'calls'"
          );

          const lines = [];
          for (const v of sigPred.violations) {
            const node = stmtNode.get(v.name, v.file, v.line);
            const role = node?.role || 'unknown';

            let callerCount = 0;
            if (node) {
              const visited = new Set([node.id]);
              let frontier = [node.id];
              for (let d = 0; d < 3; d++) {
                const next = [];
                for (const fid of frontier) {
                  for (const c of stmtCallers.all(fid)) {
                    if (!visited.has(c.id)) {
                      visited.add(c.id);
                      next.push(c.id);
                      callerCount++;
                    }
                  }
                }
                frontier = next;
                if (!frontier.length) break;
              }
            }

            const risk = role === 'core' ? 'HIGH' : role === 'utility' ? 'MEDIUM' : 'LOW';
            lines.push(risk + ': ' + v.name + ' (' + v.kind + ') [' + role + '] at ' + v.file + ':' + v.line + ' — ' + callerCount + ' transitive callers');
          }

          if (lines.length > 0) {
            output.context.push('[codegraph] Signature changes:\n  ' + lines.join('\n  '));
          }
        } finally {
          if (db) db.close();
        }
      }
    }
  }

  // ── 2. Dead exports (blocking, only if not already denied) ──
  if (output.action !== 'deny' && edited.size > 0) {
    const srcFiles = staged.filter(f =>
      /^src\/.*\.(js|ts|tsx)$/.test(f) && edited.has(f)
    );

    if (srcFiles.length > 0) {
      // Build public API set (index.js re-exports + dynamic imports)
      const publicAPI = new Set();
      try {
        const indexSrc = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
        for (const m of indexSrc.matchAll(/export\s*\{([^}]+)\}/g)) {
          for (const part of m[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) publicAPI.add(name);
          }
        }
        if (/export\s+default\b/.test(indexSrc)) publicAPI.add('default');

        // Scan for dynamic import() consumers
        const srcDir = path.join(root, 'src');
        function scanDynamic(dir) {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            if (ent.isDirectory()) { scanDynamic(path.join(dir, ent.name)); continue; }
            if (!/\.(js|ts|tsx)$/.test(ent.name)) continue;
            try {
              const src = fs.readFileSync(path.join(dir, ent.name), 'utf8');
              for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*(?:await\s+)?import\s*\(['"]/gs)) {
                for (const part of m[1].split(',')) {
                  const name = part.trim().split(/\s+as\s+/).pop().trim().split('\n').pop().trim();
                  if (name && /^\w+$/.test(name)) publicAPI.add(name);
                }
              }
              for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:await\s+)?import\s*\(['"]/g)) {
                publicAPI.add(m[1]);
              }
            } catch {}
          }
        }
        scanDynamic(srcDir);
      } catch {}

      const dead = [];
      for (const file of srcFiles) {
        try {
          const data = exportsData(file, undefined, { noTests: true, unused: true });
          if (data && data.results) {
            for (const r of data.results) {
              if (publicAPI.has(r.name)) continue;
              dead.push(r.name + ' (' + data.file + ':' + r.line + ')');
            }
          }
        } catch {}
      }

      if (dead.length > 0) {
        output.action = 'deny';
        output.reason = 'BLOCKED: Dead exports (zero consumers) detected in files you edited: ' +
          dead.join(', ') +
          '. Either add consumers, remove the exports, or verify these are intentionally public API.';
      }
    }
  }

  // ── 3. Diff-impact (informational, only if not denied) ──
  if (output.action !== 'deny') {
    try {
      const impact = diffImpactData(undefined, { staged: true, noTests: true });
      if (impact && !impact.error) {
        const lines = [];
        const files = impact.files || impact.results || [];
        for (const f of files) {
          const affected = f.affectedSymbols || f.affected || [];
          if (affected.length > 0) {
            lines.push(f.file + ': ' + affected.length + ' affected symbol(s)');
          }
        }
        if (lines.length > 0) {
          output.context.push('[codegraph diff-impact] Blast radius:\n  ' + lines.join('\n  '));
        }
      }
    } catch {}
  }
} catch (e) {
  // Non-fatal — allow commit if checks themselves fail
}

process.stdout.write(JSON.stringify(output));
