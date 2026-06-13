#!/usr/bin/env node
/**
 * Import Jelly micro-test fixtures into codegraph's benchmark suite.
 *
 * Reads .js + .json pairs from Jelly's tests/micro/ (pre-downloaded or fetched
 * live), converts the position-based Jelly call graph format into codegraph's
 * expected-edges.json format, and writes each test as a fixture subdirectory.
 *
 * Output: tests/benchmarks/resolution/fixtures/jelly-micro/{testname}/
 *   {testname}.js          — original Jelly source
 *   expected-edges.json    — converted ground truth
 *
 * Usage:
 *   # From pre-downloaded raw directory (fastest)
 *   node scripts/import-jelly-micro.mjs --src /tmp/jelly-micro-raw
 *
 *   # Fetch directly from GitHub (requires network)
 *   node scripts/import-jelly-micro.mjs --fetch
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tests/benchmarks/resolution/fixtures/jelly-micro');

const JELLY_RAW = 'https://raw.githubusercontent.com/cs-au-dk/jelly/master/tests/micro';
const JELLY_API = 'https://api.github.com/repos/cs-au-dk/jelly/contents/tests/micro';

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const srcArg = args.find((a, i) => args[i - 1] === '--src');
const fetchFlag = args.includes('--fetch');
const dryRun = args.includes('--dry-run');

// ── Fetch helpers ────────────────────────────────────────────────────────────

function fetchText(url, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    client.get(url, { headers: { 'User-Agent': 'codegraph-benchmark' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft === 0) {
          reject(new Error(`Too many redirects: ${url}`));
          return;
        }
        resolve(fetchText(res.headers.location, redirectsLeft - 1));
        return;
      }
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          resolve(body);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Name mapping ─────────────────────────────────────────────────────────────

/**
 * Build a Map<"startLine:startCol", name> for all functions in a JS source.
 *
 * Extends the basic regex approach with:
 * - Object method shorthand:  { foo() {} }
 * - Object property fn:       { foo: function() {} }
 * - Prototype assignment:     Foo.prototype.bar = function() {}
 * - Class static blocks:      static { ... }
 *
 * Functions that cannot be named receive the label "<anon@line:col>".
 */
function buildNameMap(src, filename) {
  const lines = src.split('\n');
  const nameMap = new Map(); // "line:col" → name (1-based line, 1-based col)

  let currentClass = null;
  let classDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Class declaration
    const classMatch = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      currentClass = classMatch[1];
      classDepth = braceDepth;
    }

    // Count braces
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (currentClass !== null && braceDepth === classDepth) {
          currentClass = null;
        }
      }
    }

    if (classMatch) {
      // Class itself: name the position of the opening brace
      // Jelly assigns the class-level function to the line of "class Foo {"
      nameMap.set(`${lineNo}:1`, classMatch[1]);
      continue;
    }

    // Top-level named function declaration
    const funcDecl = line.match(/^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+(\w+)\s*[\(<]/);
    if (funcDecl) {
      nameMap.set(`${lineNo}:1`, funcDecl[1]);
      continue;
    }

    // Variable assignment: const/let/var foo = function/() =>
    const varDecl = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/);
    if (varDecl && (line.includes('=>') || line.includes('function'))) {
      nameMap.set(`${lineNo}:1`, varDecl[1]);
      continue;
    }

    // Prototype assignment: Foo.prototype.bar = function() {}
    const protoMatch = line.match(/^\s*(\w+)\.prototype\.(\w+)\s*=\s*function/);
    if (protoMatch) {
      nameMap.set(`${lineNo}:1`, `${protoMatch[1]}.${protoMatch[2]}`);
      continue;
    }

    // Static property assignment: Foo.bar = function() {}
    const staticPropMatch = line.match(/^\s*(\w+)\.(\w+)\s*=\s*function/);
    if (staticPropMatch) {
      nameMap.set(`${lineNo}:1`, `${staticPropMatch[1]}.${staticPropMatch[2]}`);
      continue;
    }

    // Class methods (inside class body)
    if (currentClass !== null) {
      // constructor
      if (/^\s+constructor\s*\(/.test(line)) {
        nameMap.set(`${lineNo}:1`, currentClass);
        continue;
      }
      // static block: static { ... }
      if (/^\s+static\s*\{/.test(line)) {
        nameMap.set(`${lineNo}:1`, `${currentClass}.<static>`);
        continue;
      }
      // static property with initializer: static foo = ...
      const staticProp = line.match(/^\s+static\s+(\w+)\s*=/);
      if (staticProp && (line.includes('=>') || line.includes('function') || line.includes('('))) {
        nameMap.set(`${lineNo}:1`, `${currentClass}.${staticProp[1]}`);
        continue;
      }
      // Named method (including async, static, get/set, generator)
      const methodMatch = line.match(
        /^\s+(?:(?:static|async|get|set)\s+)*(?:\*\s*)?(\w+)\s*\(/
      );
      if (methodMatch) {
        const mname = methodMatch[1];
        if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'new'].includes(mname)) {
          nameMap.set(`${lineNo}:1`, `${currentClass}.${mname}`);
          continue;
        }
      }
      // Class field arrow: foo = () => {}
      const fieldArrow = line.match(/^\s+(\w+)\s*=\s*(?:async\s+)?\(/);
      if (fieldArrow) {
        nameMap.set(`${lineNo}:1`, `${currentClass}.${fieldArrow[1]}`);
        continue;
      }
    }

    // Object shorthand method: { foo() {} } or { async foo() {} }
    const objMethod = line.match(/^\s+(?:async\s+)?(\w+)\s*\(.*\)\s*\{/);
    if (objMethod && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(objMethod[1])) {
      nameMap.set(`${lineNo}:1`, objMethod[1]);
      continue;
    }

    // Object property: foo: function() {} or foo: () => {}
    const objProp = line.match(/^\s+(\w+)\s*:\s*(?:async\s+)?(?:function|\(|[a-zA-Z_$].*=>)/);
    if (objProp) {
      nameMap.set(`${lineNo}:1`, objProp[1]);
      continue;
    }
  }

  return nameMap;
}

// ── Jelly → expected-edges conversion ────────────────────────────────────────

const SCHEMA = '../../../expected-edges.schema.json';

/**
 * Convert a Jelly .json call graph + .js source to codegraph expected-edges format.
 *
 * Jelly function spec: "fileIdx:startLine:startCol:endLine:endCol" (1-based lines)
 * We map each function to a name using buildNameMap. Unmapped functions get
 * the label "<anon@line:col>".
 *
 * The "module root" function (always index 0 in Jelly) represents the top-level
 * script scope. We label it "<root>" so edges from it are trackable.
 *
 * Returns { edges, stats } where stats has namedEdges, anonEdges, totalEdges counts.
 */
function convertJellyGraph(jellyJson, jsSrc, jsFilename) {
  const { files, functions, fun2fun } = jellyJson;
  if (!files || !functions || !fun2fun) return { edges: [], stats: {} };

  const nameMap = buildNameMap(jsSrc, jsFilename);

  // Map function index → { name, file }
  function resolveFunc(idx) {
    const spec = functions[idx];
    if (!spec) return null;
    const parts = spec.split(':');
    const fileIdx = Number(parts[0]);
    const startLine = Number(parts[1]);
    const startCol = Number(parts[2]);
    const file = path.basename(files[fileIdx] || jsFilename);

    // Try name map (keyed by "line:1" — col is always normalised to 1 on insert)
    const name = nameMap.get(`${startLine}:1`);
    if (name) return { name, file };

    // Module root: Jelly always puts it at the very start (line 1 or similar)
    if (idx === 0) return { name: '<root>', file };

    // Anonymous
    return { name: `<anon@${startLine}:${startCol}>`, file };
  }

  const edges = [];
  let namedEdges = 0;
  let anonEdges = 0;

  for (const [callerIdx, calleeIdx] of fun2fun) {
    const caller = resolveFunc(callerIdx);
    const callee = resolveFunc(calleeIdx);
    if (!caller || !callee) continue;
    if (caller.name === callee.name && caller.file === callee.file) continue;

    const isNamed =
      !caller.name.startsWith('<anon') &&
      !callee.name.startsWith('<anon') &&
      caller.name !== '<root>' &&
      callee.name !== '<root>';

    if (isNamed) namedEdges++;
    else anonEdges++;

    edges.push({
      source: { name: caller.name, file: caller.file },
      target: { name: callee.name, file: callee.file },
      kind: 'calls',
      mode: 'static',
    });
  }

  return {
    edges,
    stats: {
      total: fun2fun.length,
      withNames: namedEdges,
      withAnon: anonEdges,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let pairs = [];

  if (srcArg) {
    // Load from local directory
    const jsFiles = fs.readdirSync(srcArg).filter((f) => f.endsWith('.js'));
    for (const jsFile of jsFiles) {
      const base = path.basename(jsFile, '.js');
      const jsonPath = path.join(srcArg, `${base}.json`);
      if (fs.existsSync(jsonPath)) {
        pairs.push({
          name: base,
          jsContent: fs.readFileSync(path.join(srcArg, jsFile), 'utf8'),
          jsonContent: fs.readFileSync(jsonPath, 'utf8'),
          jsFilename: jsFile,
        });
      }
    }
  } else if (fetchFlag) {
    console.error('Fetching directory listing from GitHub...');
    const listing = JSON.parse(await fetchText(JELLY_API));
    const jsFiles = listing.filter((f) => f.type === 'file' && f.name.endsWith('.js'));
    const jsonNames = new Set(
      listing.filter((f) => f.name.endsWith('.json')).map((f) => f.name.replace('.json', ''))
    );

    for (const jsFile of jsFiles) {
      const base = jsFile.name.replace('.js', '');
      if (!jsonNames.has(base)) continue;
      console.error(`  Fetching ${jsFile.name}...`);
      const jsContent = await fetchText(`${JELLY_RAW}/${jsFile.name}`);
      const jsonContent = await fetchText(`${JELLY_RAW}/${base}.json`);
      pairs.push({ name: base, jsContent, jsonContent, jsFilename: jsFile.name });
    }
  } else {
    console.error('Usage: --src <dir>  or  --fetch');
    process.exit(1);
  }

  console.error(`\nConverting ${pairs.length} Jelly tests...`);

  const summary = [];
  let totalNamed = 0;
  let totalAnon = 0;

  for (const { name, jsContent, jsonContent, jsFilename } of pairs) {
    let jellyGraph;
    try {
      jellyGraph = JSON.parse(jsonContent);
    } catch {
      console.error(`  [skip] ${name}: invalid JSON`);
      continue;
    }

    const { edges, stats } = convertJellyGraph(jellyGraph, jsContent, jsFilename);

    if (!dryRun) {
      const testDir = path.join(OUT_DIR, name);
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, jsFilename), jsContent);
      fs.writeFileSync(
        path.join(testDir, 'expected-edges.json'),
        JSON.stringify(
          {
            $schema: SCHEMA,
            language: 'javascript',
            description: `Jelly micro-test: ${name}`,
            source: 'https://github.com/cs-au-dk/jelly/blob/master/tests/micro/' + jsFilename,
            edges,
          },
          null,
          2,
        ),
      );
    }

    totalNamed += stats.withNames ?? 0;
    totalAnon += stats.withAnon ?? 0;
    summary.push({ name, total: stats.total, named: stats.withNames, anon: stats.withAnon });
    console.error(
      `  ${name.padEnd(30)} ${stats.total ?? 0} edges (${stats.withNames ?? 0} named, ${stats.withAnon ?? 0} anon)`,
    );
  }

  console.error(
    `\nDone: ${pairs.length} tests, ${totalNamed + totalAnon} total edges (${totalNamed} named, ${totalAnon} anon)`,
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
