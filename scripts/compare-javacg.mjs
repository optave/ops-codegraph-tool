#!/usr/bin/env node
/**
 * javacg-static vs Codegraph: Java fixture call graph comparison
 *
 * Runs javacg-static (gousiosg/java-callgraph) on the compiled fixture JAR,
 * parses its output, maps class:method names to ClassName.method form, and
 * computes precision/recall against expected-edges.json.
 *
 * javacg-static output format:
 *   M:pkg.ClassName:method(argDescriptors)  (T)pkg.ClassName:method(argDescriptors)
 * where T is: C=virtual, S=static, O=special (constructors, super), I=interface, D=dynamic
 *
 * Name mapping to expected-edges.json convention:
 *   source <init>  → ClassName.ClassName  (constructor-as-method)
 *   target <init>  → ClassName            (constructor target = class name only)
 *   other method   → ClassName.method
 *
 * Prerequisites:
 *   1. Java runtime (java -jar must work)
 *   2. javacg-static JAR — download from:
 *        https://github.com/gousiosg/java-callgraph/releases
 *      or build: `cd java-callgraph && mvn package -DskipTests`
 *      Pass via --jar or set JAVACG_JAR, or place at scripts/lib/javacg-static.jar
 *   3. Compiled fixture JAR:
 *        cd tests/benchmarks/resolution/fixtures/java && make
 *
 * Usage:
 *   node scripts/compare-javacg.mjs
 *   node scripts/compare-javacg.mjs --jar /path/to/javacg-0.1-SNAPSHOT.jar
 *   node scripts/compare-javacg.mjs --json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'tests/benchmarks/resolution/fixtures/java');

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const jsonFlag = args.includes('--json');
const jarArgIdx = args.indexOf('--jar');
const jarArgPath = jarArgIdx !== -1 ? args[jarArgIdx + 1] : null;

// ── Tool discovery ───────────────────────────────────────────────────────────

function findJavacgJar() {
  if (jarArgPath) return jarArgPath;
  if (process.env.JAVACG_JAR) return process.env.JAVACG_JAR;
  // Glob for any jar with "javacg" in the name under scripts/lib/
  const libDir = path.join(__dirname, 'lib');
  if (fs.existsSync(libDir)) {
    const jar = fs.readdirSync(libDir).find((f) => f.includes('javacg') && f.endsWith('.jar'));
    if (jar) return path.join(libDir, jar);
  }
  return null;
}

// ── Name mapping ─────────────────────────────────────────────────────────────

/**
 * Scan .java source files to build SimpleClassName → filename.java map.
 * Used to resolve file fields in the edge key format "name@file".
 *
 * Maps the first top-level type per file — inner classes are not indexed.
 * Handles common modifiers (public, abstract, final, sealed, non-sealed, strictfp)
 * and type keywords (class, interface, enum, record).
 */
function buildClassFileMap(fixtureDir) {
  const map = new Map();
  const javaFiles = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.java'));
  for (const filename of javaFiles) {
    const src = fs.readFileSync(path.join(fixtureDir, filename), 'utf8');
    // Match any combination of access/modifier keywords before the type keyword
    const m = src.match(
      /(?:(?:public|protected|private|abstract|final|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+(\w+)/,
    );
    if (m) {
      map.set(m[1], filename);
    } else {
      console.warn(`[warn] buildClassFileMap: no type declaration found in ${filename} — edges involving this file will be filtered out`);
    }
  }
  // Validate: every .java file should map to exactly one class name
  if (map.size !== javaFiles.length) {
    console.warn(
      `[warn] buildClassFileMap: ${javaFiles.length} .java files but only ${map.size} class names resolved — precision/recall may be skewed`,
    );
  }
  return map;
}

/**
 * Parse "pkg.ClassName:methodName(descriptors)" into { className, methodName }.
 * Works with both "." and "/" as package separators (javacg uses ".").
 */
function parseMethodSpec(spec) {
  // Strip argument descriptor — everything from "(" onwards
  const parenIdx = spec.indexOf('(');
  const withoutArgs = parenIdx !== -1 ? spec.slice(0, parenIdx) : spec;
  const colonIdx = withoutArgs.indexOf(':');
  if (colonIdx === -1) return null;
  const classPart = withoutArgs.slice(0, colonIdx);
  const methodName = withoutArgs.slice(colonIdx + 1);
  // Simple class name: last segment after "." or "/"
  const className = classPart.split(/[./]/).at(-1);
  if (!className) return null;
  return { className, methodName };
}

/** Source side: "<init>" method maps to ClassName.ClassName. */
function toSourceName({ className, methodName }) {
  return methodName === '<init>' ? `${className}.${className}` : `${className}.${methodName}`;
}

/** Target side: "<init>" method maps to just ClassName (constructor target). */
function toTargetName({ className, methodName }) {
  return methodName === '<init>' ? className : `${className}.${methodName}`;
}

// ── Ground truth ─────────────────────────────────────────────────────────────

function loadGroundTruth(fixtureDir) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixtureDir, 'expected-edges.json'), 'utf8'),
  );
  const set = new Set(
    manifest.edges.map(
      (e) =>
        `${e.source.name}@${path.basename(e.source.file)}→${e.target.name}@${path.basename(e.target.file)}`,
    ),
  );
  return set;
}

// ── Run javacg-static ────────────────────────────────────────────────────────

function runJavacg(javacgJar, fixtureDir) {
  const fixtureJar = path.join(fixtureDir, 'fixture.jar');
  if (!fs.existsSync(fixtureJar)) {
    console.error(`fixture.jar not found at ${fixtureJar}`);
    console.error(`Build it with: cd ${fixtureDir} && make`);
    process.exit(1);
  }
  try {
    return execFileSync('java', ['-jar', javacgJar, fixtureJar], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // javacg-static may exit non-zero but still produce useful stdout
    if (err.stdout?.trim()) return err.stdout;
    console.error(`javacg-static failed: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Parse javacg-static text output into a Set of edge keys.
 *
 * Line format:
 *   M:pkg.Class:method(args)  (T)pkg.Class:method(args)
 *
 * Only edges where both class names appear in classFileMap are included —
 * this filters out JDK / stdlib calls (HashMap, String, System.out, etc.).
 */
function parseJavacgOutput(output, classFileMap) {
  // M: caller (T) callee — the space between caller and (T) may vary
  // T values: C=virtual, S=static, O=special (constructors/super), I=interface, D=dynamic (invokedynamic)
  const lineRe = /^M:(\S+)\s+\(([CSOID])\)(\S+)$/;
  const edges = new Set();

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('M:')) continue;

    const m = line.match(lineRe);
    if (!m) continue;

    const [, sourceSpec, , targetSpec] = m;

    const sourceParsed = parseMethodSpec(sourceSpec);
    const targetParsed = parseMethodSpec(targetSpec);
    if (!sourceParsed || !targetParsed) continue;

    const sourceFile = classFileMap.get(sourceParsed.className);
    const targetFile = classFileMap.get(targetParsed.className);
    // Skip edges to/from classes outside the fixture (JDK, etc.)
    if (!sourceFile || !targetFile) continue;

    const sourceName = toSourceName(sourceParsed);
    const targetName = toTargetName(targetParsed);

    const key = `${sourceName}@${sourceFile}→${targetName}@${targetFile}`;
    // Skip self-edges (e.g. recursive calls not in expected-edges)
    if (sourceName === targetName && sourceFile === targetFile) continue;
    edges.add(key);
  }
  return edges;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

function computeMetrics(predicted, groundTruth) {
  let tp = 0;
  const fp = [];
  const fn = [];
  for (const edge of predicted) (groundTruth.has(edge) ? tp++ : fp.push(edge));
  for (const edge of groundTruth) if (!predicted.has(edge)) fn.push(edge);
  return {
    precision: predicted.size === 0 ? 0 : tp / predicted.size,
    recall: groundTruth.size === 0 ? 0 : tp / groundTruth.size,
    tp,
    fp: fp.length,
    fn: fn.length,
    totalPredicted: predicted.size,
    totalExpected: groundTruth.size,
    fpEdges: fp,
    fnEdges: fn,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

const javacgJar = findJavacgJar();
if (!javacgJar) {
  console.error('javacg-static JAR not found.');
  console.error('Download from: https://github.com/gousiosg/java-callgraph/releases');
  console.error('Then use one of:');
  console.error('  node scripts/compare-javacg.mjs --jar /path/to/javacg-0.1-SNAPSHOT.jar');
  console.error('  JAVACG_JAR=/path/to/javacg-0.1-SNAPSHOT.jar node scripts/compare-javacg.mjs');
  console.error('  cp /path/to/javacg-0.1-SNAPSHOT.jar scripts/lib/javacg-static.jar');
  process.exit(1);
}

const classFileMap = buildClassFileMap(FIXTURE_DIR);
const groundTruth = loadGroundTruth(FIXTURE_DIR);

console.error(`\n── JAVA ──────────────────────────────────────────────────`);
console.error(`  Ground truth: ${groundTruth.size} edges`);
console.error(`  Running javacg-static on fixture.jar...`);

const rawOutput = runJavacg(javacgJar, FIXTURE_DIR);
const predictedEdges = parseJavacgOutput(rawOutput, classFileMap);

console.error(`  javacg-static: ${predictedEdges.size} named benchmark edges`);

const metrics = computeMetrics(predictedEdges, groundTruth);

console.error(
  `  precision=${metrics.precision.toFixed(2)} recall=${metrics.recall.toFixed(2)} ` +
    `TP=${metrics.tp} FP=${metrics.fp} FN=${metrics.fn}`,
);

if (metrics.fpEdges.length) {
  console.error(`  FP (edges not in expected-edges.json):`);
  for (const e of metrics.fpEdges) console.error(`    - ${e}`);
}
if (metrics.fnEdges.length) {
  console.error(`  FN (expected edges missed):`);
  for (const e of metrics.fnEdges) console.error(`    - ${e}`);
}

if (jsonFlag) {
  console.log(
    JSON.stringify(
      {
        java: {
          groundTruth: groundTruth.size,
          javacgEdges: predictedEdges.size,
          metrics,
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log('\n## javacg-static vs expected-edges.json Ground Truth\n');
  console.log('| Language | Tool | Precision | Recall | TP | FP | FN |');
  console.log('|----------|------|:---------:|:------:|---:|---:|---:|');
  console.log(
    `| Java | javacg-static (CHA) | ${(metrics.precision * 100).toFixed(0)}% | ` +
      `${(metrics.recall * 100).toFixed(0)}% | ${metrics.tp} | ${metrics.fp} | ${metrics.fn} |`,
  );
}
