#!/usr/bin/env node
/**
 * Jelly vs Codegraph Call Graph Comparison
 *
 * Runs Jelly on a hand-annotated fixture directory, maps Jelly's line-number
 * function IDs to codegraph-style names, then computes precision/recall for
 * both Jelly and codegraph against the expected-edges.json ground truth.
 *
 * Usage:
 *   node scripts/compare-jelly.mjs --fixture javascript
 *   node scripts/compare-jelly.mjs --fixture typescript
 *   node scripts/compare-jelly.mjs --all
 *
 * Prerequisites:
 *   npm install @cs-au-dk/jelly  (or npx works too)
 *   codegraph must be installed (npm start or built)
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(ROOT, 'tests/benchmarks/resolution/fixtures');

// Languages Jelly supports (JS/TS only)
const JELLY_LANGUAGES = ['javascript', 'typescript'];

// Entry point file per language (Jelly needs an entry to follow imports)
const ENTRY_FILES = {
  javascript: 'index.js',
  typescript: 'index.ts',
};

// File extensions per language
const EXTENSIONS = {
  javascript: ['.js', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
};

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const allFlag = args.includes('--all');
const fixtureFlag = args.find((a, i) => args[i - 1] === '--fixture');
const jsonFlag = args.includes('--json');

const languages = allFlag
  ? JELLY_LANGUAGES
  : fixtureFlag
    ? [fixtureFlag]
    : JELLY_LANGUAGES;

// ── Jelly helpers ──────────────────────────────────────────────────────────

function findJellyBin() {
  // Try local node_modules first, then global
  const local = path.join(ROOT, 'node_modules/.bin/jelly');
  if (fs.existsSync(local)) return local;
  try {
    return execSync('which jelly', { encoding: 'utf8' }).trim();
  } catch {
    // Try npx
    return null;
  }
}

/**
 * Run Jelly on a fixture directory, return the parsed call graph JSON.
 * Returns null if Jelly is not available.
 */
function runJelly(lang, fixtureDir) {
  const jellyBin = findJellyBin();
  if (!jellyBin && !process.env.JELLY_PATH) {
    console.error('  [skip] Jelly not found — install with: npm install @cs-au-dk/jelly');
    return null;
  }

  const bin = process.env.JELLY_PATH || jellyBin;
  const entry = ENTRY_FILES[lang];
  if (!entry) {
    console.error(`  [skip] No entry file configured for ${lang}`);
    return null;
  }

  // Copy fixture to a temp dir with its own package.json so Jelly treats
  // all files as part of one package (not node_modules to be ignored)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `jelly-${lang}-`));
  const cgJson = path.join(tmpDir, 'cg.json');

  try {
    // Copy source files only (not expected-edges.json, driver.mjs)
    const exts = EXTENSIONS[lang] || ['.js'];
    const allExts = [...exts, '.mjs'];
    for (const f of fs.readdirSync(fixtureDir)) {
      if (allExts.some((e) => f.endsWith(e))) {
        fs.copyFileSync(path.join(fixtureDir, f), path.join(tmpDir, f));
      }
    }
    // Minimal package.json so Jelly treats this as a self-contained package
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: `${lang}-fixture`, version: '1.0.0', type: 'module' }),
    );

    const entryPath = path.join(tmpDir, entry);
    if (!fs.existsSync(entryPath)) {
      console.error(`  [skip] Entry file not found: ${entryPath}`);
      return null;
    }

    execFileSync(bin, ['-j', cgJson, entryPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return JSON.parse(fs.readFileSync(cgJson, 'utf8'));
  } catch (err) {
    console.error(`  [error] Jelly failed: ${err.message}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Name resolution from source ────────────────────────────────────────────

/**
 * Parse source files to build a map of (file, startLine) → function name
 * using simple regex patterns. Returns a Map<"file:line", string>.
 *
 * Handles:
 *  - Top-level functions: `function foo(`
 *  - Arrow functions:     `const foo = (`  /  `export const foo =`
 *  - Classes:             `class Foo {`
 *  - Methods:             `  methodName(` inside a class
 *  - Constructors:        `  constructor(` inside a class (→ ClassName)
 *
 * This is heuristic — good enough for the small hand-annotated fixtures.
 */
function buildNameMap(fixtureDir, lang) {
  const exts = EXTENSIONS[lang] || ['.js'];
  const nameMap = new Map(); // "filename:line" → "FunctionName"

  for (const filename of fs.readdirSync(fixtureDir)) {
    if (!exts.some((e) => filename.endsWith(e))) continue;

    const src = fs.readFileSync(path.join(fixtureDir, filename), 'utf8');
    const lines = src.split('\n');
    let currentClass = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1; // 1-based
      const key = `${filename}:${lineNo}`;

      // Class declaration
      const classMatch = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        nameMap.set(key, classMatch[1]);
        continue;
      }

      // Reset class context when we exit a class block (heuristic: closing brace at col 0)
      if (currentClass && /^\}/.test(line)) {
        currentClass = null;
      }

      // Top-level function declaration
      const funcMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/);
      if (funcMatch) {
        nameMap.set(key, funcMatch[1]);
        continue;
      }

      // Arrow function or function expression assigned to const/let/var
      const arrowMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
      if (arrowMatch && (line.includes('=>') || line.includes('function'))) {
        nameMap.set(key, arrowMatch[1]);
        continue;
      }

      // Class method or constructor (indented, followed by `(`)
      if (currentClass) {
        const ctorMatch = line.match(/^\s+constructor\s*\(/);
        if (ctorMatch) {
          nameMap.set(key, currentClass);
          continue;
        }
        const methodMatch = line.match(/^\s+(?:async\s+|static\s+|get\s+|set\s+)*(\w+)\s*\(/);
        if (methodMatch && methodMatch[1] !== 'if' && methodMatch[1] !== 'for' && methodMatch[1] !== 'while' && methodMatch[1] !== 'switch') {
          nameMap.set(key, `${currentClass}.${methodMatch[1]}`);
          continue;
        }
      }
    }
  }

  return nameMap;
}

// ── Edge comparison ────────────────────────────────────────────────────────

/**
 * Convert Jelly call graph JSON to a set of "source→target" edge strings.
 * Only includes function→function edges (fun2fun), not import-level edges.
 * Filters out module-level pseudo-functions (those without a name in nameMap).
 */
function jellyEdgesToSet(cg, fixtureDir, lang) {
  const nameMap = buildNameMap(fixtureDir, lang);
  const files = cg.files;
  const functions = cg.functions;

  function fnName(id) {
    const spec = functions[String(id)];
    if (!spec) return null;
    const parts = spec.split(':');
    const file = path.basename(files[Number(parts[0])]);
    const line = Number(parts[1]);
    return nameMap.get(`${file}:${line}`) || null;
  }

  const edges = new Set();
  for (const [callerId, calleeId] of cg.fun2fun || []) {
    const caller = fnName(callerId);
    const callee = fnName(calleeId);
    if (caller && callee && caller !== callee) {
      edges.add(`${caller}→${callee}`);
    }
  }
  return edges;
}

/**
 * Convert expected-edges.json to a set of "source→target" edge strings.
 */
function expectedEdgesToSet(fixtureDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'expected-edges.json'), 'utf8'),
  );
  return new Set(manifest.edges.map((e) => `${e.source.name}→${e.target.name}`));
}

/**
 * Compute precision/recall given a set of predicted edges and ground truth.
 */
function computeMetrics(predicted, groundTruth) {
  let tp = 0;
  const fp = [];
  const fn = [];

  for (const edge of predicted) {
    if (groundTruth.has(edge)) {
      tp++;
    } else {
      fp.push(edge);
    }
  }
  for (const edge of groundTruth) {
    if (!predicted.has(edge)) {
      fn.push(edge);
    }
  }

  const precision = predicted.size === 0 ? 0 : tp / predicted.size;
  const recall = groundTruth.size === 0 ? 0 : tp / groundTruth.size;

  return {
    precision,
    recall,
    tp,
    fp: fp.length,
    fn: fn.length,
    totalPredicted: predicted.size,
    totalExpected: groundTruth.size,
    fpEdges: fp,
    fnEdges: fn,
  };
}

// ── Codegraph baseline ─────────────────────────────────────────────────────

/**
 * Run the resolution benchmark for a single language and return metrics.
 * Shells out to vitest to capture the benchmark output.
 */
function getCodegraphMetrics(lang) {
  try {
    const result = execFileSync(
      'npx',
      [
        'vitest',
        'run',
        'tests/benchmarks/resolution/resolution-benchmark.test.ts',
        '--reporter=verbose',
        `--reporter.outputFile=/tmp/cg-bench-${lang}.txt`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          RESOLUTION_BENCH_LANG: lang,
          // Prevent artifact mode — always build from fixtures
          RESOLUTION_RESULT_JSON: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );
    // Parse from stdout — look for precision/recall lines
    // Format: "  javascript: precision=0.94 recall=0.72 TP=13 FP=1 FN=5"
    const m = result.match(new RegExp(`${lang}.*precision=([\\.\\d]+).*recall=([\\.\\d]+).*TP=(\\d+).*FP=(\\d+).*FN=(\\d+)`));
    if (m) {
      return {
        precision: Number(m[1]),
        recall: Number(m[2]),
        tp: Number(m[3]),
        fp: Number(m[4]),
        fn: Number(m[5]),
      };
    }
  } catch {
    // Benchmark failed or output format changed — not fatal
  }
  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

const results = [];

for (const lang of languages) {
  console.error(`\n── ${lang.toUpperCase()} ────────────────────────────`);

  const fixtureDir = path.join(FIXTURES_DIR, lang);
  if (!fs.existsSync(fixtureDir)) {
    console.error(`  [skip] Fixture directory not found: ${fixtureDir}`);
    continue;
  }

  // Ground truth
  const groundTruth = expectedEdgesToSet(fixtureDir);
  console.error(`  Ground truth: ${groundTruth.size} edges`);

  // Jelly
  console.error(`  Running Jelly...`);
  const cg = runJelly(lang, fixtureDir);
  let jellyMetrics = null;
  let jellyEdges = new Set();
  if (cg) {
    jellyEdges = jellyEdgesToSet(cg, fixtureDir, lang);
    jellyMetrics = computeMetrics(jellyEdges, groundTruth);
    console.error(`  Jelly: ${jellyEdges.size} named edges`);
    console.error(`    precision=${jellyMetrics.precision.toFixed(2)} recall=${jellyMetrics.recall.toFixed(2)} TP=${jellyMetrics.tp} FP=${jellyMetrics.fp} FN=${jellyMetrics.fn}`);
    if (jellyMetrics.fpEdges.length) {
      console.error(`    FP (not in ground truth):`);
      for (const e of jellyMetrics.fpEdges) console.error(`      - ${e}`);
    }
    if (jellyMetrics.fnEdges.length) {
      console.error(`    FN (missed by Jelly):`);
      for (const e of jellyMetrics.fnEdges) console.error(`      - ${e}`);
    }
  }

  results.push({ lang, groundTruth: groundTruth.size, jellyEdges: jellyEdges.size, jellyMetrics });
}

// ── Output ─────────────────────────────────────────────────────────────────

if (jsonFlag) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n\n## Jelly vs Codegraph Comparison\n');
  console.log('| Language | Ground Truth | Jelly Edges | Jelly P | Jelly R | Jelly TP/FP/FN |');
  console.log('|----------|-------------|-------------|---------|---------|----------------|');
  for (const r of results) {
    const jm = r.jellyMetrics;
    const jp = jm ? `${(jm.precision * 100).toFixed(0)}%` : 'N/A';
    const jr = jm ? `${(jm.recall * 100).toFixed(0)}%` : 'N/A';
    const jstats = jm ? `${jm.tp}/${jm.fp}/${jm.fn}` : 'N/A';
    console.log(`| ${r.lang} | ${r.groundTruth} | ${r.jellyEdges} | ${jp} | ${jr} | ${jstats} |`);
  }
}
