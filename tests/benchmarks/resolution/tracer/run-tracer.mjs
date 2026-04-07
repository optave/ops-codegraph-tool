#!/usr/bin/env node

/**
 * Universal dynamic call tracer dispatcher.
 *
 * Detects the fixture language and runs the appropriate language-specific
 * tracer to capture runtime call edges.
 *
 * Usage:
 *   node tests/benchmarks/resolution/tracer/run-tracer.mjs <fixture-dir>
 *
 * Outputs dynamic-edges JSON to stdout.
 *
 * For JS/TS/TSX: uses the ESM loader hook + per-fixture driver.mjs
 * For interpreted languages: uses language-specific tracer scripts
 * For compiled languages: uses compile-and-instrument shell scripts
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const loaderHook = path.join(__dirname, 'loader-hook.mjs');
// Node's --import flag requires file:// URLs on Windows
const loaderHookURL = pathToFileURL(loaderHook).href;

const fixtureDir = process.argv[2];
if (!fixtureDir) {
  console.error('Usage: run-tracer.mjs <fixture-dir>');
  process.exit(1);
}

const absFixtureDir = path.resolve(fixtureDir);
const lang = path.basename(absFixtureDir);

// ── Tracer configuration ────────────────────────────────────────────────
// Each entry defines how to run the tracer for a given language.
//
// Types:
//   "esm-hook"    — JS/TS/TSX: node/tsx --import loader-hook.mjs driver.mjs
//   "interpreter"  — Language runtime runs a tracer script with fixture dir arg
//   "shell"        — Shell script handles compilation + instrumentation

/** @type {Record<string, {type: string, cmd?: string, args?: string[], tracer?: string, driver?: string, fallback?: string[]}>} */
const TRACERS = {
  // ── ESM Hook (JS/TS/TSX) ────────────────────────────────────────────
  javascript: {
    type: 'esm-hook',
    cmd: process.execPath,
    driver: 'driver.mjs',
  },
  typescript: {
    type: 'esm-hook',
    cmd: 'tsx',
    driver: 'driver.mjs',
  },
  tsx: {
    type: 'esm-hook',
    cmd: 'tsx',
    driver: 'driver.mjs',
  },

  // ── Interpreted languages with native tracing APIs ──────────────────
  python: {
    type: 'interpreter',
    cmd: 'python3',
    fallback: ['python', 'py'],
    tracer: 'python-tracer.py',
  },
  ruby: {
    type: 'interpreter',
    cmd: 'ruby',
    tracer: 'ruby-tracer.rb',
  },
  lua: {
    type: 'interpreter',
    cmd: 'lua',
    fallback: ['lua5.4', 'lua5.3', 'luajit'],
    tracer: 'lua-tracer.lua',
  },
  php: {
    type: 'interpreter',
    cmd: 'php',
    tracer: 'php-tracer.php',
  },
  bash: {
    type: 'shell',
    tracer: 'bash-tracer.sh',
  },
  r: {
    type: 'interpreter',
    cmd: 'Rscript',
    tracer: 'r-tracer.R',
  },
  elixir: {
    type: 'interpreter',
    cmd: 'elixir',
    tracer: 'elixir-tracer.exs',
  },
  erlang: {
    type: 'interpreter',
    cmd: 'escript',
    tracer: 'erlang-tracer.escript',
  },
  julia: {
    type: 'interpreter',
    cmd: 'julia',
    tracer: 'julia-tracer.jl',
  },
  clojure: {
    type: 'interpreter',
    cmd: 'clojure',
    tracer: 'clojure-tracer.clj',
  },

  // ── Go (compile + instrument) ──────────────────────────────────────
  go: {
    type: 'shell',
    tracer: 'go-tracer.sh',
  },

  // ── JVM languages (compile + instrument) ───────────────────────────
  java: {
    type: 'shell',
    tracer: 'jvm-tracer.sh',
    args: ['java'],
  },
  kotlin: {
    type: 'shell',
    tracer: 'jvm-tracer.sh',
    args: ['kotlin'],
  },
  scala: {
    type: 'shell',
    tracer: 'jvm-tracer.sh',
    args: ['scala'],
  },

  // ── Native / compiled languages ────────────────────────────────────
  c: { type: 'shell', tracer: 'native-tracer.sh', args: ['c'] },
  cpp: { type: 'shell', tracer: 'native-tracer.sh', args: ['cpp'] },
  rust: { type: 'shell', tracer: 'native-tracer.sh', args: ['rust'] },
  csharp: { type: 'shell', tracer: 'native-tracer.sh', args: ['csharp'] },
  fsharp: { type: 'shell', tracer: 'native-tracer.sh', args: ['fsharp'] },
  swift: { type: 'shell', tracer: 'native-tracer.sh', args: ['swift'] },
  dart: { type: 'shell', tracer: 'native-tracer.sh', args: ['dart'] },
  zig: { type: 'shell', tracer: 'native-tracer.sh', args: ['zig'] },
  haskell: { type: 'shell', tracer: 'native-tracer.sh', args: ['haskell'] },
  ocaml: { type: 'shell', tracer: 'native-tracer.sh', args: ['ocaml'] },
  gleam: { type: 'shell', tracer: 'native-tracer.sh', args: ['gleam'] },
  solidity: { type: 'shell', tracer: 'native-tracer.sh', args: ['solidity'] },

  // ── Additional languages ───────────────────────────────────────────
  objc: { type: 'shell', tracer: 'native-tracer.sh', args: ['objc'] },
  cuda: { type: 'shell', tracer: 'native-tracer.sh', args: ['cuda'] },
  groovy: {
    type: 'shell',
    tracer: 'jvm-tracer.sh',
    args: ['groovy'],
  },
  verilog: { type: 'shell', tracer: 'native-tracer.sh', args: ['verilog'] },
  hcl: { type: 'shell', tracer: 'native-tracer.sh', args: ['hcl'] },
};

// ── Helpers ─────────────────────────────────────────────────────────────

function findCommand(primary, fallbacks = []) {
  const candidates = [primary, ...fallbacks];
  for (const cmd of candidates) {
    try {
      // Cross-platform: try to spawn the command with --version or similar
      // 'which' works on Unix, 'where' on Windows, execFileSync with just the name tests PATH
      if (process.platform === 'win32') {
        execSync(`where ${cmd}`, { stdio: 'ignore' });
      } else {
        execSync(`command -v ${cmd}`, { stdio: 'ignore' });
      }
      return cmd;
    } catch {
      // Not found, try next
    }
  }
  return null;
}

function runTracer(cmd, args, cwd, timeout = 30_000) {
  try {
    const result = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result;
  } catch (e) {
    console.error(`Tracer failed for ${lang}: ${e.message}`);
    if (e.stderr) console.error(e.stderr.toString().slice(0, 500));
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const config = TRACERS[lang];
if (!config) {
  console.error(`No tracer configured for language: ${lang}`);
  console.error(`Supported languages: ${Object.keys(TRACERS).sort().join(', ')}`);
  process.exit(1);
}

let result = null;

switch (config.type) {
  case 'esm-hook': {
    const driverPath = path.join(absFixtureDir, config.driver);
    if (!fs.existsSync(driverPath)) {
      console.error(`No ${config.driver} found in ${absFixtureDir}`);
      process.exit(1);
    }
    // For ESM hook: use process.execPath directly for node, findCommand for tsx
    const cmd =
      config.cmd === process.execPath
        ? process.execPath
        : findCommand(config.cmd, config.fallback || []);
    if (!cmd) {
      console.error(`Runtime not found: ${config.cmd}`);
      process.stdout.write(JSON.stringify({ edges: [], error: `${config.cmd} not available` }));
      process.exit(0);
    }
    result = runTracer(cmd, ['--import', loaderHookURL, driverPath], absFixtureDir);
    break;
  }

  case 'interpreter': {
    const tracerPath = path.join(__dirname, config.tracer);
    const cmd = findCommand(config.cmd, config.fallback || []);
    if (!cmd) {
      console.error(`Runtime not found: ${config.cmd} (needed for ${lang} tracing)`);
      process.stdout.write(JSON.stringify({ edges: [], error: `${config.cmd} not available` }));
      process.exit(0);
    }
    result = runTracer(cmd, [tracerPath, absFixtureDir], absFixtureDir);
    break;
  }

  case 'shell': {
    const tracerPath = path.join(__dirname, config.tracer);
    const shellCmd = findCommand('bash', ['sh']);
    if (!shellCmd) {
      process.stdout.write(JSON.stringify({ edges: [], error: 'bash not available' }));
      process.exit(0);
    }
    const args = [tracerPath, absFixtureDir, ...(config.args || [])];
    result = runTracer(shellCmd, args, absFixtureDir, 60_000);
    break;
  }
}

if (result) {
  // Validate JSON output
  try {
    const parsed = JSON.parse(result);
    process.stdout.write(JSON.stringify(parsed, null, 2));
  } catch {
    // Try to extract JSON from mixed output (some tracers print to stdout)
    const jsonMatch = result.match(/\{[\s\S]*"edges"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        process.stdout.write(JSON.stringify(parsed, null, 2));
      } catch {
        console.error(`Failed to parse tracer output for ${lang}`);
        process.stdout.write(JSON.stringify({ edges: [], error: 'invalid tracer output' }));
      }
    } else {
      console.error(`No JSON edges found in tracer output for ${lang}`);
      process.stdout.write(JSON.stringify({ edges: [], error: 'no JSON in output' }));
    }
  }
} else {
  process.stdout.write(JSON.stringify({ edges: [], error: 'tracer execution failed' }));
}

process.stdout.write('\n');
