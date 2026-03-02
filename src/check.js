import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { findCycles } from './cycles.js';
import { findDbPath, openReadonlyOrFail } from './db.js';
import { matchOwners, parseCodeowners } from './owners.js';
import { isTestFile } from './queries.js';

// ─── Diff Parser ──────────────────────────────────────────────────────

/**
 * Parse unified diff output, extracting both new-side (+) and old-side (-) ranges.
 * Old-side ranges are needed for signature detection (DB line numbers = pre-change).
 *
 * @param {string} diffOutput - Raw `git diff --unified=0` output
 * @returns {{ changedRanges: Map<string, {start:number,end:number}[]>, oldRanges: Map<string, {start:number,end:number}[]>, newFiles: Set<string> }}
 */
export function parseDiffOutput(diffOutput) {
  const changedRanges = new Map();
  const oldRanges = new Map();
  const newFiles = new Set();
  let currentFile = null;
  let prevIsDevNull = false;

  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('--- /dev/null')) {
      prevIsDevNull = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      prevIsDevNull = false;
      continue;
    }
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      if (!oldRanges.has(currentFile)) oldRanges.set(currentFile, []);
      if (prevIsDevNull) newFiles.add(currentFile);
      prevIsDevNull = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = parseInt(hunkMatch[2] || '1', 10);
      if (oldCount > 0) {
        oldRanges.get(currentFile).push({ start: oldStart, end: oldStart + oldCount - 1 });
      }
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = parseInt(hunkMatch[4] || '1', 10);
      if (newCount > 0) {
        changedRanges.get(currentFile).push({ start: newStart, end: newStart + newCount - 1 });
      }
    }
  }
  return { changedRanges, oldRanges, newFiles };
}

// ─── Predicates ───────────────────────────────────────────────────────

/**
 * Predicate 1: Assert no dependency cycles involve changed files.
 */
export function checkNoNewCycles(db, changedFiles, noTests) {
  const cycles = findCycles(db, { fileLevel: true, noTests });
  const involved = cycles.filter((cycle) => cycle.some((f) => changedFiles.has(f)));
  return { passed: involved.length === 0, cycles: involved };
}

/**
 * Predicate 2: Assert no function exceeds N transitive callers.
 */
export function checkMaxBlastRadius(db, changedRanges, threshold, noTests, maxDepth) {
  const violations = [];
  let maxFound = 0;

  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = db
      .prepare(
        `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
      )
      .all(file);

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const endLine = def.end_line || (defs[i + 1] ? defs[i + 1].line - 1 : 999999);
      let overlaps = false;
      for (const range of ranges) {
        if (range.start <= endLine && range.end >= def.line) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) continue;

      // BFS transitive callers
      const visited = new Set([def.id]);
      let frontier = [def.id];
      let totalCallers = 0;
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
              totalCallers++;
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }

      if (totalCallers > maxFound) maxFound = totalCallers;
      if (totalCallers > threshold) {
        violations.push({
          name: def.name,
          kind: def.kind,
          file: def.file,
          line: def.line,
          transitiveCallers: totalCallers,
        });
      }
    }
  }

  return { passed: violations.length === 0, maxFound, threshold, violations };
}

/**
 * Predicate 3: Assert no function declaration lines were modified.
 * Uses old-side hunk ranges (which correspond to DB line numbers from last build).
 */
export function checkNoSignatureChanges(db, oldRanges, noTests) {
  const violations = [];

  for (const [file, ranges] of oldRanges) {
    if (ranges.length === 0) continue;
    if (noTests && isTestFile(file)) continue;

    const defs = db
      .prepare(
        `SELECT name, kind, file, line FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
      )
      .all(file);

    for (const def of defs) {
      for (const range of ranges) {
        if (def.line >= range.start && def.line <= range.end) {
          violations.push({
            name: def.name,
            kind: def.kind,
            file: def.file,
            line: def.line,
          });
          break;
        }
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

/**
 * Predicate 4: Assert no cross-owner boundary violations among changed files.
 */
export function checkNoBoundaryViolations(db, changedFiles, repoRoot, noTests) {
  const parsed = parseCodeowners(repoRoot);
  if (!parsed) {
    return { passed: true, violations: [], note: 'No CODEOWNERS file found — skipped' };
  }

  const changedSet = changedFiles instanceof Set ? changedFiles : new Set(changedFiles);
  const edges = db
    .prepare(
      `SELECT e.kind AS edgeKind,
              s.file AS srcFile, t.file AS tgtFile
       FROM edges e
       JOIN nodes s ON e.source_id = s.id
       JOIN nodes t ON e.target_id = t.id
       WHERE e.kind = 'calls'`,
    )
    .all();

  const violations = [];
  for (const e of edges) {
    if (noTests && (isTestFile(e.srcFile) || isTestFile(e.tgtFile))) continue;
    if (!changedSet.has(e.srcFile) && !changedSet.has(e.tgtFile)) continue;

    const srcOwners = matchOwners(e.srcFile, parsed.rules).sort().join(',');
    const tgtOwners = matchOwners(e.tgtFile, parsed.rules).sort().join(',');
    if (srcOwners !== tgtOwners) {
      violations.push({
        from: e.srcFile,
        to: e.tgtFile,
        edgeKind: e.edgeKind,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Run validation predicates against git changes.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} opts
 * @param {string} [opts.ref] - Git ref to diff against
 * @param {boolean} [opts.staged] - Analyze staged changes
 * @param {boolean} [opts.cycles] - Enable cycles predicate
 * @param {number} [opts.blastRadius] - Blast radius threshold
 * @param {boolean} [opts.signatures] - Enable signatures predicate
 * @param {boolean} [opts.boundaries] - Enable boundaries predicate
 * @param {number} [opts.depth] - Max BFS depth (default: 3)
 * @param {boolean} [opts.noTests] - Exclude test files
 * @returns {{ predicates: object[], summary: object, passed: boolean }}
 */
export function checkData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);

  try {
    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');
    const noTests = opts.noTests || false;
    const maxDepth = opts.depth || 3;

    // Load config defaults for check predicates
    const config = loadConfig(repoRoot);
    const checkConfig = config.check || {};

    // Resolve which predicates are enabled: CLI flags ?? config ?? built-in defaults
    const enableCycles = opts.cycles ?? checkConfig.cycles ?? true;
    const enableSignatures = opts.signatures ?? checkConfig.signatures ?? true;
    const enableBoundaries = opts.boundaries ?? checkConfig.boundaries ?? true;
    const blastRadiusThreshold = opts.blastRadius ?? checkConfig.blastRadius ?? null;

    // Verify git repo
    let checkDir = repoRoot;
    let isGitRepo = false;
    while (checkDir) {
      if (fs.existsSync(path.join(checkDir, '.git'))) {
        isGitRepo = true;
        break;
      }
      const parent = path.dirname(checkDir);
      if (parent === checkDir) break;
      checkDir = parent;
    }
    if (!isGitRepo) {
      return { error: `Not a git repository: ${repoRoot}` };
    }

    // Run git diff
    let diffOutput;
    try {
      const args = opts.staged
        ? ['diff', '--cached', '--unified=0', '--no-color']
        : ['diff', opts.ref || 'HEAD', '--unified=0', '--no-color'];
      diffOutput = execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { error: `Failed to run git diff: ${e.message}` };
    }

    if (!diffOutput.trim()) {
      return {
        predicates: [],
        summary: { total: 0, passed: 0, failed: 0, changedFiles: 0, newFiles: 0 },
        passed: true,
      };
    }

    const { changedRanges, oldRanges, newFiles } = parseDiffOutput(diffOutput);
    if (changedRanges.size === 0) {
      return {
        predicates: [],
        summary: { total: 0, passed: 0, failed: 0, changedFiles: 0, newFiles: 0 },
        passed: true,
      };
    }

    const changedFiles = new Set(changedRanges.keys());

    // Execute enabled predicates
    const predicates = [];

    if (enableCycles) {
      const result = checkNoNewCycles(db, changedFiles, noTests);
      predicates.push({ name: 'cycles', ...result });
    }

    if (blastRadiusThreshold != null) {
      const result = checkMaxBlastRadius(
        db,
        changedRanges,
        blastRadiusThreshold,
        noTests,
        maxDepth,
      );
      predicates.push({ name: 'blast-radius', ...result });
    }

    if (enableSignatures) {
      const result = checkNoSignatureChanges(db, oldRanges, noTests);
      predicates.push({ name: 'signatures', ...result });
    }

    if (enableBoundaries) {
      const result = checkNoBoundaryViolations(db, changedFiles, repoRoot, noTests);
      predicates.push({ name: 'boundaries', ...result });
    }

    const passedCount = predicates.filter((p) => p.passed).length;
    const failedCount = predicates.length - passedCount;

    return {
      predicates,
      summary: {
        total: predicates.length,
        passed: passedCount,
        failed: failedCount,
        changedFiles: changedFiles.size,
        newFiles: newFiles.size,
      },
      passed: failedCount === 0,
    };
  } finally {
    db.close();
  }
}

// ─── CLI Display ──────────────────────────────────────────────────────

/**
 * CLI formatter — prints check results and exits with code 1 on failure.
 */
export function check(customDbPath, opts = {}) {
  const data = checkData(customDbPath, opts);

  if (data.error) {
    console.error(data.error);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    if (!data.passed) process.exit(1);
    return;
  }

  console.log('\n# Check Results\n');

  if (data.predicates.length === 0) {
    console.log('  No changes detected.\n');
    return;
  }

  console.log(
    `  Changed files: ${data.summary.changedFiles}  New files: ${data.summary.newFiles}\n`,
  );

  for (const pred of data.predicates) {
    const icon = pred.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${pred.name}`);

    if (!pred.passed) {
      if (pred.name === 'cycles' && pred.cycles) {
        for (const cycle of pred.cycles.slice(0, 10)) {
          console.log(`         ${cycle.join(' -> ')}`);
        }
        if (pred.cycles.length > 10) {
          console.log(`         ... and ${pred.cycles.length - 10} more`);
        }
      }
      if (pred.name === 'blast-radius' && pred.violations) {
        for (const v of pred.violations.slice(0, 10)) {
          console.log(
            `         ${v.name} (${v.kind}) at ${v.file}:${v.line} — ${v.transitiveCallers} callers (max: ${pred.threshold})`,
          );
        }
        if (pred.violations.length > 10) {
          console.log(`         ... and ${pred.violations.length - 10} more`);
        }
      }
      if (pred.name === 'signatures' && pred.violations) {
        for (const v of pred.violations.slice(0, 10)) {
          console.log(`         ${v.name} (${v.kind}) at ${v.file}:${v.line}`);
        }
        if (pred.violations.length > 10) {
          console.log(`         ... and ${pred.violations.length - 10} more`);
        }
      }
      if (pred.name === 'boundaries' && pred.violations) {
        for (const v of pred.violations.slice(0, 10)) {
          console.log(`         ${v.from} -> ${v.to} (${v.edgeKind})`);
        }
        if (pred.violations.length > 10) {
          console.log(`         ... and ${pred.violations.length - 10} more`);
        }
      }
    }
    if (pred.note) {
      console.log(`         ${pred.note}`);
    }
  }

  const s = data.summary;
  console.log(`\n  ${s.total} predicates | ${s.passed} passed | ${s.failed} failed\n`);

  if (!data.passed) {
    process.exit(1);
  }
}
