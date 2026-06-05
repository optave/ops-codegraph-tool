#!/usr/bin/env node
/**
 * External call graph tool comparison: Jelly + ACG vs Codegraph
 *
 * Runs Jelly and ACG on hand-annotated fixture directories, maps their
 * function IDs to codegraph-style names, then computes precision/recall for
 * each tool against the expected-edges.json ground truth.
 *
 * Tool coverage:
 *   Jelly (@cs-au-dk/jelly) — JS + TypeScript (whole-program points-to)
 *   ACG  (@persper/js-callgraph) — JavaScript only (field-based approximate)
 *
 * Usage:
 *   node scripts/compare-tools.mjs --fixture javascript
 *   node scripts/compare-tools.mjs --fixture typescript
 *   node scripts/compare-tools.mjs --all
 *   node scripts/compare-tools.mjs --all --json
 *
 * Prerequisites:
 *   npm install @cs-au-dk/jelly @persper/js-callgraph
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(ROOT, 'tests/benchmarks/resolution/fixtures');

const JELLY_LANGUAGES = ['javascript', 'typescript'];
const ACG_LANGUAGES = ['javascript']; // esprima doesn't parse TypeScript

const ENTRY_FILES = {
  javascript: 'index.js',
  typescript: 'index.ts',
};

const EXTENSIONS = {
  javascript: ['.js', '.mjs', '.cjs'],
  typescript: ['.ts', '.tsx'],
};

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const allFlag = args.includes('--all');
const fixtureArg = args.find((a, i) => args[i - 1] === '--fixture');
const jsonFlag = args.includes('--json');
const skipJelly = args.includes('--skip-jelly');
const skipAcg = args.includes('--skip-acg');

const languages = allFlag
  ? [...new Set([...JELLY_LANGUAGES, ...ACG_LANGUAGES])]
  : fixtureArg
    ? [fixtureArg]
    : [...new Set([...JELLY_LANGUAGES, ...ACG_LANGUAGES])];

// ── Tool discovery ─────────────────────────────────────────────────────────

function findBin(name, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const local = path.join(ROOT, `node_modules/.bin/${name}`);
  if (fs.existsSync(local)) return local;
  try {
    return execSync(`which ${name}`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ── Name resolution from source ────────────────────────────────────────────

/**
 * Parse source files to build a map of (file, startLine) → class-qualified name.
 * Returns a Map<"filename:line", string>.
 *
 * Heuristic — works well for the small hand-annotated fixtures.
 */
function buildNameMap(fixtureDir, lang) {
  const exts = EXTENSIONS[lang] || ['.js'];
  const nameMap = new Map();

  for (const filename of fs.readdirSync(fixtureDir)) {
    if (!exts.some((e) => filename.endsWith(e))) continue;

    const src = fs.readFileSync(path.join(fixtureDir, filename), 'utf8');
    const lines = src.split('\n');
    let currentClass = null;
    let classDepth = 0;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;
      const key = `${filename}:${lineNo}`;

      const classMatch = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        classDepth = braceDepth;
        nameMap.set(key, classMatch[1]);
      }

      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') {
          braceDepth--;
          if (currentClass && braceDepth === classDepth) currentClass = null;
        }
      }

      if (classMatch) continue;

      const funcMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/);
      if (funcMatch) { nameMap.set(key, funcMatch[1]); continue; }

      const arrowMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
      if (arrowMatch && (line.includes('=>') || line.includes('function'))) {
        nameMap.set(key, arrowMatch[1]); continue;
      }

      if (currentClass) {
        if (/^\s+constructor\s*\(/.test(line)) {
          nameMap.set(key, currentClass); continue;
        }
        const methodMatch = line.match(/^\s+(?:async\s+|static\s+|(?:get|set)\s+)*(\w+)\s*\(/);
        if (methodMatch) {
          const mname = methodMatch[1];
          if (!['if', 'for', 'while', 'switch', 'catch'].includes(mname)) {
            nameMap.set(key, `${currentClass}.${mname}`);
          }
        }
      }
    }
  }

  return nameMap;
}

// ── Jelly ──────────────────────────────────────────────────────────────────

function runJelly(lang, fixtureDir) {
  const bin = findBin('jelly', 'JELLY_PATH');
  if (!bin) {
    console.error('  [skip] Jelly not found — install with: npm install @cs-au-dk/jelly');
    return null;
  }

  const entry = ENTRY_FILES[lang];
  if (!entry) { console.error(`  [skip] No Jelly entry for ${lang}`); return null; }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `jelly-${lang}-`));
  const cgJson = path.join(tmpDir, 'cg.json');

  try {
    const allExts = [...(EXTENSIONS[lang] || ['.js']), '.mjs'];
    for (const f of fs.readdirSync(fixtureDir)) {
      if (allExts.some((e) => f.endsWith(e)))
        fs.copyFileSync(path.join(fixtureDir, f), path.join(tmpDir, f));
    }
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: `${lang}-fixture`, version: '1.0.0', type: 'module' }),
    );

    const entryPath = path.join(tmpDir, entry);
    if (!fs.existsSync(entryPath)) { console.error(`  [skip] Entry not found: ${entry}`); return null; }

    execFileSync(bin, ['-j', cgJson, entryPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(fs.readFileSync(cgJson, 'utf8'));
  } catch (err) {
    console.error(`  [error] Jelly failed: ${err.message}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

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
    if (caller && callee && caller !== callee) edges.add(`${caller}→${callee}`);
  }
  return edges;
}

// ── ACG (@persper/js-callgraph) ────────────────────────────────────────────

/**
 * Run js-callgraph (ACG) on a fixture directory.
 * Returns a Set of "caller→callee" edge strings, or null if unavailable.
 *
 * ACG uses the Feldthaus et al. ICSE 2013 field-based approximate algorithm.
 * It only supports CommonJS/plain-JS (not TypeScript or native ESM).
 * The fixture is copied to a temp dir without "type":"module" in package.json.
 *
 * Output line format:
 *   'funcName' (file.js@line:startOffset-endOffset) -> 'funcName' (file.js@line:start-end)
 *   'funcName' (file.js@line:start-end) -> 'funcName' (Native)
 */
function runAcg(lang, fixtureDir) {
  if (!ACG_LANGUAGES.includes(lang)) {
    console.error(`  [skip] ACG does not support ${lang} (esprima cannot parse TypeScript)`);
    return null;
  }

  const bin = findBin('js-callgraph', 'ACG_PATH');
  if (!bin) {
    console.error('  [skip] ACG not found — install with: npm install @persper/js-callgraph');
    return null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `acg-${lang}-`));

  try {
    // Copy JS source files (skip driver.mjs and non-source files)
    const exts = EXTENSIONS[lang] || ['.js'];
    for (const f of fs.readdirSync(fixtureDir)) {
      if (exts.some((e) => f.endsWith(e)) && f !== 'driver.mjs')
        fs.copyFileSync(path.join(fixtureDir, f), path.join(tmpDir, f));
    }
    // No "type":"module" — ACG uses esprima which requires CJS-style parsing
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: `${lang}-fixture`, version: '1.0.0' }),
    );

    const stdout = execFileSync(bin, ['--cg', tmpDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return acgOutputToSet(stdout, fixtureDir, lang);
  } catch (err) {
    // ACG exits non-zero when it encounters parse errors; still capture stdout
    if (err.stdout) return acgOutputToSet(err.stdout, fixtureDir, lang);
    console.error(`  [error] ACG failed: ${err.message}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Build a lookup from (basename, unqualifiedName) → Set<qualifiedName>.
 *
 * ACG provides function names directly (e.g. "createUser") but not class
 * prefixes. This map lets us resolve "createUser in service.js" →
 * "UserService.createUser" using the same source scan as buildNameMap.
 *
 * The value is a Set to handle the case where multiple classes in the same
 * file share a method name (e.g. Shape.area + Circle.area + Rectangle.area
 * all in hierarchy.ts). Callers should try all candidates rather than
 * assuming a 1:1 mapping.
 */
function buildAcgNameLookup(fixtureDir, lang) {
  const exts = EXTENSIONS[lang] || ['.js'];
  // Map: "basename:unqualifiedName" → Set<"qualifiedName">
  const lookup = new Map();

  /** Add a (key → value) entry, accumulating into the existing Set if any. */
  function add(key, value) {
    const existing = lookup.get(key);
    if (existing) existing.add(value);
    else lookup.set(key, new Set([value]));
  }

  for (const filename of fs.readdirSync(fixtureDir)) {
    if (!exts.some((e) => filename.endsWith(e))) continue;
    const src = fs.readFileSync(path.join(fixtureDir, filename), 'utf8');
    const lines = src.split('\n');
    let currentClass = null;
    let classDepth = 0;
    let braceDepth = 0;

    for (const line of lines) {
      const classMatch = line.match(/^\s*(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        classDepth = braceDepth;
        // "ClassName" as an unqualified name refers to the class itself (constructor call sites)
        add(`${filename}:${classMatch[1]}`, classMatch[1]);
      }
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') {
          braceDepth--;
          if (currentClass && braceDepth === classDepth) currentClass = null;
        }
      }
      if (classMatch) continue;

      const funcMatch = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*[(<]/);
      if (funcMatch) { add(`${filename}:${funcMatch[1]}`, funcMatch[1]); continue; }

      if (currentClass) {
        // constructor → ClassName (ACG labels constructors as "constructor" in the source)
        if (/^\s+constructor\s*\(/.test(line)) {
          add(`${filename}:constructor`, currentClass); continue;
        }
        const methodMatch = line.match(/^\s+(?:async\s+|static\s+|(?:get|set)\s+)*(\w+)\s*\(/);
        if (methodMatch) {
          const mname = methodMatch[1];
          if (!['if', 'for', 'while', 'switch', 'catch'].includes(mname))
            add(`${filename}:${mname}`, `${currentClass}.${mname}`);
        }
      }
    }
  }
  return lookup;
}

/**
 * Parse ACG text output into a set of "source→target" edge strings.
 *
 * ACG output format:
 *   'funcName' (file.js@line:startByte-endByte) -> 'funcName' (file.js@line:startByte-endByte)
 *   'funcName' (file.js@line:...) -> 'funcName' (Native)
 *
 * The position in the source tuple is the CALL SITE for the caller (i.e. the
 * byte range of the call expression inside the caller function body) — NOT the
 * declaration line. So we use the function name directly for the lookup.
 */
function acgOutputToSet(stdout, fixtureDir, lang) {
  const lookup = buildAcgNameLookup(fixtureDir, lang);

  // 'funcName' (file.js@line:start-end) -> 'funcName' (file.js@line:start-end)
  const edgeRe = /^'(\w+)'\s+\((\S+?)@\d+:[^)]+\)\s+->\s+'(\w+)'\s+\((\S+?)@\d+:[^)]+\)/;
  const edges = new Set();

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Warning') || line.startsWith('Error') || line.startsWith('at ') || line.startsWith('---')) continue;
    if (line.includes('(Native)')) continue;

    const m = line.match(edgeRe);
    if (!m) continue;

    const [, callerFunc, callerFile, calleeFunc, calleeFile] = m;
    const callerBase = path.basename(callerFile);
    const calleeBase = path.basename(calleeFile);

    const callerCandidates = lookup.get(`${callerBase}:${callerFunc}`);
    const calleeCandidates = lookup.get(`${calleeBase}:${calleeFunc}`);

    if (!callerCandidates || !calleeCandidates) continue;
    for (const callerName of callerCandidates) {
      for (const calleeName of calleeCandidates) {
        if (callerName !== calleeName) edges.add(`${callerName}→${calleeName}`);
      }
    }
  }
  return edges;
}

// ── Shared metrics ─────────────────────────────────────────────────────────

function expectedEdgesToSet(fixtureDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected-edges.json'), 'utf8'));
  return new Set(manifest.edges.map((e) => `${e.source.name}→${e.target.name}`));
}

function computeMetrics(predicted, groundTruth) {
  let tp = 0;
  const fp = [];
  const fn = [];
  for (const edge of predicted) (groundTruth.has(edge) ? tp++ : fp.push(edge));
  for (const edge of groundTruth) if (!predicted.has(edge)) fn.push(edge);
  return {
    precision: predicted.size === 0 ? 0 : tp / predicted.size,
    recall: groundTruth.size === 0 ? 0 : tp / groundTruth.size,
    tp, fp: fp.length, fn: fn.length,
    totalPredicted: predicted.size,
    totalExpected: groundTruth.size,
    fpEdges: fp, fnEdges: fn,
  };
}

function logMetrics(label, edges, metrics) {
  console.error(`  ${label}: ${edges.size} named edges`);
  console.error(`    precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} TP=${metrics.tp} FP=${metrics.fp} FN=${metrics.fn}`);
  if (metrics.fpEdges.length) {
    console.error(`    FP:`);
    for (const e of metrics.fpEdges) console.error(`      - ${e}`);
  }
  if (metrics.fnEdges.length) {
    console.error(`    FN:`);
    for (const e of metrics.fnEdges) console.error(`      - ${e}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const results = [];

for (const lang of languages) {
  console.error(`\n── ${lang.toUpperCase()} ────────────────────────────`);

  const fixtureDir = path.join(FIXTURES_DIR, lang);
  if (!fs.existsSync(fixtureDir)) {
    console.error(`  [skip] Fixture not found: ${fixtureDir}`);
    continue;
  }

  const groundTruth = expectedEdgesToSet(fixtureDir);
  console.error(`  Ground truth: ${groundTruth.size} edges`);

  // Jelly
  let jellyMetrics = null;
  let jellyEdges = new Set();
  if (!skipJelly && JELLY_LANGUAGES.includes(lang)) {
    console.error(`  Running Jelly...`);
    const cg = runJelly(lang, fixtureDir);
    if (cg) {
      jellyEdges = jellyEdgesToSet(cg, fixtureDir, lang);
      jellyMetrics = computeMetrics(jellyEdges, groundTruth);
      logMetrics('Jelly', jellyEdges, jellyMetrics);
    }
  }

  // ACG
  let acgMetrics = null;
  let acgEdges = new Set();
  if (!skipAcg && ACG_LANGUAGES.includes(lang)) {
    console.error(`  Running ACG...`);
    const acgResult = runAcg(lang, fixtureDir);
    if (acgResult) {
      acgEdges = acgResult;
      acgMetrics = computeMetrics(acgEdges, groundTruth);
      logMetrics('ACG', acgEdges, acgMetrics);
    }
  }

  results.push({ lang, groundTruth: groundTruth.size, jellyEdges: jellyEdges.size, jellyMetrics, acgEdges: acgEdges.size, acgMetrics });
}

// ── Output ─────────────────────────────────────────────────────────────────

if (jsonFlag) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log('\n## Jelly + ACG vs expected-edges.json Ground Truth\n');
  console.log('| Language | Ground Truth | Tool | Edges | Precision | Recall | TP/FP/FN |');
  console.log('|----------|-------------|------|-------|:---------:|:------:|----------|');
  for (const r of results) {
    const fmt = (m, n) => m
      ? `| ${r.lang} | ${r.groundTruth} | ${n} | ${n === 'Jelly' ? r.jellyEdges : r.acgEdges} | ${(m.precision * 100).toFixed(0)}% | ${(m.recall * 100).toFixed(0)}% | ${m.tp}/${m.fp}/${m.fn} |`
      : null;
    if (r.jellyMetrics) console.log(fmt(r.jellyMetrics, 'Jelly'));
    if (r.acgMetrics) console.log(fmt(r.acgMetrics, 'ACG'));
  }
}
