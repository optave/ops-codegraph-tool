#!/usr/bin/env node

import { Command } from 'commander';
import { buildGraph } from './builder.js';
import { queryName, impactAnalysis, moduleMap, fileDeps, fnDeps, fnImpact, diffImpact } from './queries.js';
import { buildEmbeddings, search, MODELS } from './embedder.js';
import { watchProject } from './watcher.js';
import { exportDOT, exportMermaid, exportJSON } from './export.js';
import { findCycles, formatCycles } from './cycles.js';
import { findDbPath } from './db.js';
import { setVerbose } from './logger.js';
import path from 'path';
import Database from 'better-sqlite3';
import fs from 'fs';

const program = new Command();
program
  .name('codegraph')
  .description('Local code dependency graph tool')
  .version('1.2.0')
  .option('-v, --verbose', 'Enable verbose/debug output')
  .option('--engine <engine>', 'Parser engine: native, wasm, or auto (default: auto)', 'auto')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setVerbose(true);
  });

program
  .command('build [dir]')
  .description('Parse repo and build graph in .codegraph/graph.db')
  .option('--no-incremental', 'Force full rebuild (ignore file hashes)')
  .action(async (dir, opts) => {
    const root = path.resolve(dir || '.');
    const engine = program.opts().engine;
    await buildGraph(root, { incremental: opts.incremental, engine });
  });

program
  .command('query <name>')
  .description('Find a function/class, show callers and callees')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    queryName(name, opts.db, { json: opts.json });
  });

program
  .command('impact <file>')
  .description('Show what depends on this file (transitive)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-j, --json', 'Output as JSON')
  .action((file, opts) => {
    impactAnalysis(file, opts.db, { json: opts.json });
  });

program
  .command('map')
  .description('High-level module overview with most-connected nodes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-n, --limit <number>', 'Number of top nodes', '20')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    moduleMap(opts.db, parseInt(opts.limit), { json: opts.json });
  });

program
  .command('deps <file>')
  .description('Show what this file imports and what imports it')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-j, --json', 'Output as JSON')
  .action((file, opts) => {
    fileDeps(file, opts.db, { json: opts.json });
  });

program
  .command('fn <name>')
  .description('Function-level dependencies: callers, callees, and transitive call chain')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    fnDeps(name, opts.db, { depth: parseInt(opts.depth), noTests: !opts.tests, json: opts.json });
  });

program
  .command('fn-impact <name>')
  .description('Function-level impact: what functions break if this one changes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Max transitive depth', '5')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    fnImpact(name, opts.db, { depth: parseInt(opts.depth), noTests: !opts.tests, json: opts.json });
  });

program
  .command('diff-impact [ref]')
  .description('Show impact of git changes (unstaged, staged, or vs a ref)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--staged', 'Analyze staged changes instead of unstaged')
  .option('--depth <n>', 'Max transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((ref, opts) => {
    diffImpact(opts.db, { ref, staged: opts.staged, depth: parseInt(opts.depth), noTests: !opts.tests, json: opts.json });
  });

// ─── New commands ────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export dependency graph as DOT (Graphviz), Mermaid, or JSON')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-f, --format <format>', 'Output format: dot, mermaid, json', 'dot')
  .option('--functions', 'Function-level graph instead of file-level')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action((opts) => {
    const db = new Database(findDbPath(opts.db), { readonly: true });
    const exportOpts = { fileLevel: !opts.functions };

    let output;
    switch (opts.format) {
      case 'mermaid':
        output = exportMermaid(db, exportOpts);
        break;
      case 'json':
        output = JSON.stringify(exportJSON(db), null, 2);
        break;
      case 'dot':
      default:
        output = exportDOT(db, exportOpts);
        break;
    }

    db.close();

    if (opts.output) {
      fs.writeFileSync(opts.output, output, 'utf-8');
      console.log(`Exported ${opts.format} to ${opts.output}`);
    } else {
      console.log(output);
    }
  });

program
  .command('cycles')
  .description('Detect circular dependencies in the codebase')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--functions', 'Function-level cycle detection')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    const db = new Database(findDbPath(opts.db), { readonly: true });
    const cycles = findCycles(db, { fileLevel: !opts.functions });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ cycles, count: cycles.length }, null, 2));
    } else {
      console.log(formatCycles(cycles));
    }
  });

program
  .command('mcp')
  .description('Start MCP (Model Context Protocol) server for AI assistant integration')
  .option('-d, --db <path>', 'Path to graph.db')
  .action(async (opts) => {
    const { startMCPServer } = await import('./mcp.js');
    await startMCPServer(opts.db);
  });

// ─── Embedding commands ─────────────────────────────────────────────────

program
  .command('models')
  .description('List available embedding models')
  .action(() => {
    console.log('\nAvailable embedding models:\n');
    for (const [key, config] of Object.entries(MODELS)) {
      const def = key === 'minilm' ? ' (default)' : '';
      console.log(`  ${key.padEnd(12)} ${String(config.dim).padStart(4)}d  ${config.desc}${def}`);
    }
    console.log('\nUsage: codegraph embed --model <name>');
    console.log('       codegraph search "query" --model <name>\n');
  });

program
  .command('embed [dir]')
  .description('Build semantic embeddings for all functions/methods/classes (requires prior `build`)')
  .option('-m, --model <name>', 'Embedding model: minilm (default), jina-small, jina-base, jina-code, nomic, nomic-v1.5, bge-large. Run `codegraph models` for details', 'minilm')
  .action(async (dir, opts) => {
    const root = path.resolve(dir || '.');
    await buildEmbeddings(root, opts.model);
  });

program
  .command('search <query>')
  .description('Semantic search: find functions by natural language description')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-m, --model <name>', 'Override embedding model (auto-detects from DB)')
  .option('-n, --limit <number>', 'Max results', '15')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('--min-score <score>', 'Minimum similarity threshold', '0.2')
  .option('-k, --kind <kind>', 'Filter by kind: function, method, class')
  .option('--file <pattern>', 'Filter by file path pattern')
  .option('--rrf-k <number>', 'RRF k parameter for multi-query ranking', '60')
  .action(async (query, opts) => {
    await search(query, opts.db, {
      limit: parseInt(opts.limit),
      noTests: !opts.tests,
      minScore: parseFloat(opts.minScore),
      model: opts.model,
      kind: opts.kind,
      filePattern: opts.file,
      rrfK: parseInt(opts.rrfK)
    });
  });

program
  .command('watch [dir]')
  .description('Watch project for file changes and incrementally update the graph')
  .action(async (dir) => {
    const root = path.resolve(dir || '.');
    await watchProject(root);
  });

program.parse();
