#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Command } from 'commander';
import { buildGraph } from './builder.js';
import { findCycles, formatCycles } from './cycles.js';
import { findDbPath } from './db.js';
import { buildEmbeddings, MODELS, search } from './embedder.js';
import { exportDOT, exportJSON, exportMermaid } from './export.js';
import { setVerbose } from './logger.js';
import {
  ALL_SYMBOL_KINDS,
  context,
  diffImpact,
  explain,
  fileDeps,
  fnDeps,
  fnImpact,
  impactAnalysis,
  moduleMap,
  queryName,
  stats,
  where,
} from './queries.js';
import {
  listRepos,
  pruneRegistry,
  REGISTRY_PATH,
  registerRepo,
  unregisterRepo,
} from './registry.js';
import { watchProject } from './watcher.js';

const __cliDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const pkg = JSON.parse(fs.readFileSync(path.join(__cliDir, '..', 'package.json'), 'utf-8'));

const program = new Command();
program
  .name('codegraph')
  .description('Local code dependency graph tool')
  .version(pkg.version)
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
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    queryName(name, opts.db, { noTests: !opts.tests, json: opts.json });
  });

program
  .command('impact <file>')
  .description('Show what depends on this file (transitive)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((file, opts) => {
    impactAnalysis(file, opts.db, { noTests: !opts.tests, json: opts.json });
  });

program
  .command('map')
  .description('High-level module overview with most-connected nodes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-n, --limit <number>', 'Number of top nodes', '20')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    moduleMap(opts.db, parseInt(opts.limit, 10), { noTests: !opts.tests, json: opts.json });
  });

program
  .command('stats')
  .description('Show graph health overview: nodes, edges, languages, cycles, hotspots, embeddings')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    stats(opts.db, { noTests: !opts.tests, json: opts.json });
  });

program
  .command('deps <file>')
  .description('Show what this file imports and what imports it')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((file, opts) => {
    fileDeps(file, opts.db, { noTests: !opts.tests, json: opts.json });
  });

program
  .command('fn <name>')
  .description('Function-level dependencies: callers, callees, and transitive call chain')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Transitive caller depth', '3')
  .option('-f, --file <path>', 'Scope search to functions in this file (partial match)')
  .option('-k, --kind <kind>', 'Filter to a specific symbol kind')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    fnDeps(name, opts.db, {
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noTests: !opts.tests,
      json: opts.json,
    });
  });

program
  .command('fn-impact <name>')
  .description('Function-level impact: what functions break if this one changes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Max transitive depth', '5')
  .option('-f, --file <path>', 'Scope search to functions in this file (partial match)')
  .option('-k, --kind <kind>', 'Filter to a specific symbol kind')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    fnImpact(name, opts.db, {
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noTests: !opts.tests,
      json: opts.json,
    });
  });

program
  .command('context <name>')
  .description('Full context for a function: source, deps, callers, tests, signature')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Include callee source up to N levels deep', '0')
  .option('-f, --file <path>', 'Scope search to functions in this file (partial match)')
  .option('-k, --kind <kind>', 'Filter to a specific symbol kind')
  .option('--no-source', 'Metadata only (skip source extraction)')
  .option('--include-tests', 'Include test source code')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    context(name, opts.db, {
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noSource: !opts.source,
      noTests: !opts.tests,
      includeTests: opts.includeTests,
      json: opts.json,
    });
  });

program
  .command('explain <target>')
  .description('Structural summary of a file or function (no LLM needed)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((target, opts) => {
    explain(target, opts.db, { noTests: !opts.tests, json: opts.json });
  });

program
  .command('where [name]')
  .description('Find where a symbol is defined and used (minimal, fast lookup)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-f, --file <path>', 'File overview: list symbols, imports, exports')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action((name, opts) => {
    if (!name && !opts.file) {
      console.error('Provide a symbol name or use --file <path>');
      process.exit(1);
    }
    const target = opts.file || name;
    where(target, opts.db, { file: !!opts.file, noTests: !opts.tests, json: opts.json });
  });

program
  .command('diff-impact [ref]')
  .description('Show impact of git changes (unstaged, staged, or vs a ref)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--staged', 'Analyze staged changes instead of unstaged')
  .option('--depth <n>', 'Max transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .option('-f, --format <format>', 'Output format: text, mermaid, json', 'text')
  .action((ref, opts) => {
    diffImpact(opts.db, {
      ref,
      staged: opts.staged,
      depth: parseInt(opts.depth, 10),
      noTests: !opts.tests,
      json: opts.json,
      format: opts.format,
    });
  });

// ─── New commands ────────────────────────────────────────────────────────

program
  .command('export')
  .description('Export dependency graph as DOT (Graphviz), Mermaid, or JSON')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-f, --format <format>', 'Output format: dot, mermaid, json', 'dot')
  .option('--functions', 'Function-level graph instead of file-level')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action((opts) => {
    const db = new Database(findDbPath(opts.db), { readonly: true });
    const exportOpts = { fileLevel: !opts.functions, noTests: !opts.tests };

    let output;
    switch (opts.format) {
      case 'mermaid':
        output = exportMermaid(db, exportOpts);
        break;
      case 'json':
        output = JSON.stringify(exportJSON(db, exportOpts), null, 2);
        break;
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
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    const db = new Database(findDbPath(opts.db), { readonly: true });
    const cycles = findCycles(db, { fileLevel: !opts.functions, noTests: !opts.tests });
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
  .option('--multi-repo', 'Enable access to all registered repositories')
  .option('--repos <names>', 'Comma-separated list of allowed repo names (restricts access)')
  .action(async (opts) => {
    const { startMCPServer } = await import('./mcp.js');
    const mcpOpts = {};
    mcpOpts.multiRepo = opts.multiRepo || !!opts.repos;
    if (opts.repos) {
      mcpOpts.allowedRepos = opts.repos.split(',').map((s) => s.trim());
    }
    await startMCPServer(opts.db, mcpOpts);
  });

// ─── Registry commands ──────────────────────────────────────────────────

const registry = program.command('registry').description('Manage the multi-repo project registry');

registry
  .command('list')
  .description('List all registered repositories')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    pruneRegistry();
    const repos = listRepos();
    if (opts.json) {
      console.log(JSON.stringify(repos, null, 2));
    } else if (repos.length === 0) {
      console.log(`No repositories registered.\nRegistry: ${REGISTRY_PATH}`);
    } else {
      console.log(`Registered repositories (${REGISTRY_PATH}):\n`);
      for (const r of repos) {
        const dbExists = fs.existsSync(r.dbPath);
        const status = dbExists ? '' : ' [DB missing]';
        console.log(`  ${r.name}${status}`);
        console.log(`    Path: ${r.path}`);
        console.log(`    DB:   ${r.dbPath}`);
        console.log();
      }
    }
  });

registry
  .command('add <dir>')
  .description('Register a project directory')
  .option('-n, --name <name>', 'Custom name (defaults to directory basename)')
  .action((dir, opts) => {
    const absDir = path.resolve(dir);
    const { name, entry } = registerRepo(absDir, opts.name);
    console.log(`Registered "${name}" → ${entry.path}`);
  });

registry
  .command('remove <name>')
  .description('Unregister a repository by name')
  .action((name) => {
    const removed = unregisterRepo(name);
    if (removed) {
      console.log(`Removed "${name}" from registry.`);
    } else {
      console.error(`Repository "${name}" not found in registry.`);
      process.exit(1);
    }
  });

registry
  .command('prune')
  .description('Remove stale registry entries (missing directories or idle beyond TTL)')
  .option('--ttl <days>', 'Days of inactivity before pruning (default: 30)', '30')
  .action((opts) => {
    const pruned = pruneRegistry(undefined, parseInt(opts.ttl, 10));
    if (pruned.length === 0) {
      console.log('No stale entries found.');
    } else {
      for (const entry of pruned) {
        const tag = entry.reason === 'expired' ? 'expired' : 'missing';
        console.log(`Pruned "${entry.name}" (${entry.path}) [${tag}]`);
      }
      console.log(`\nRemoved ${pruned.length} stale ${pruned.length === 1 ? 'entry' : 'entries'}.`);
    }
  });

// ─── Embedding commands ─────────────────────────────────────────────────

program
  .command('models')
  .description('List available embedding models')
  .action(() => {
    console.log('\nAvailable embedding models:\n');
    for (const [key, config] of Object.entries(MODELS)) {
      const def = key === 'nomic-v1.5' ? ' (default)' : '';
      console.log(`  ${key.padEnd(12)} ${String(config.dim).padStart(4)}d  ${config.desc}${def}`);
    }
    console.log('\nUsage: codegraph embed --model <name>');
    console.log('       codegraph search "query" --model <name>\n');
  });

program
  .command('embed [dir]')
  .description(
    'Build semantic embeddings for all functions/methods/classes (requires prior `build`)',
  )
  .option(
    '-m, --model <name>',
    'Embedding model: minilm, jina-small, jina-base, jina-code, nomic, nomic-v1.5 (default), bge-large. Run `codegraph models` for details',
    'nomic-v1.5',
  )
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
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--min-score <score>', 'Minimum similarity threshold', '0.2')
  .option('-k, --kind <kind>', 'Filter by kind: function, method, class')
  .option('--file <pattern>', 'Filter by file path pattern')
  .option('--rrf-k <number>', 'RRF k parameter for multi-query ranking', '60')
  .action(async (query, opts) => {
    await search(query, opts.db, {
      limit: parseInt(opts.limit, 10),
      noTests: !opts.tests,
      minScore: parseFloat(opts.minScore),
      model: opts.model,
      kind: opts.kind,
      filePattern: opts.file,
      rrfK: parseInt(opts.rrfK, 10),
    });
  });

program
  .command('structure [dir]')
  .description(
    'Show project directory structure with hierarchy, cohesion scores, and per-file metrics',
  )
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Max directory depth')
  .option('--sort <metric>', 'Sort by: cohesion | fan-in | fan-out | density | files', 'files')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('-j, --json', 'Output as JSON')
  .action(async (dir, opts) => {
    const { structureData, formatStructure } = await import('./structure.js');
    const data = structureData(opts.db, {
      directory: dir,
      depth: opts.depth ? parseInt(opts.depth, 10) : undefined,
      sort: opts.sort,
      noTests: !opts.tests,
    });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatStructure(data));
    }
  });

program
  .command('hotspots')
  .description(
    'Find structural hotspots: files or directories with extreme fan-in, fan-out, or symbol density',
  )
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-n, --limit <number>', 'Number of results', '10')
  .option('--metric <metric>', 'fan-in | fan-out | density | coupling', 'fan-in')
  .option('--level <level>', 'file | directory', 'file')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('-j, --json', 'Output as JSON')
  .action(async (opts) => {
    const { hotspotsData, formatHotspots } = await import('./structure.js');
    const data = hotspotsData(opts.db, {
      metric: opts.metric,
      level: opts.level,
      limit: parseInt(opts.limit, 10),
      noTests: !opts.tests,
    });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatHotspots(data));
    }
  });

program
  .command('watch [dir]')
  .description('Watch project for file changes and incrementally update the graph')
  .action(async (dir) => {
    const root = path.resolve(dir || '.');
    const engine = program.opts().engine;
    await watchProject(root, { engine });
  });

program
  .command('info')
  .description('Show codegraph engine info and diagnostics')
  .action(async () => {
    const { isNativeAvailable, loadNative } = await import('./native.js');
    const { getActiveEngine } = await import('./parser.js');

    const engine = program.opts().engine;
    const { name: activeName, version: activeVersion } = getActiveEngine({ engine });
    const nativeAvailable = isNativeAvailable();

    console.log('\nCodegraph Diagnostics');
    console.log('====================');
    console.log(`  Version       : ${program.version()}`);
    console.log(`  Node.js       : ${process.version}`);
    console.log(`  Platform      : ${process.platform}-${process.arch}`);
    console.log(`  Native engine : ${nativeAvailable ? 'available' : 'unavailable'}`);
    if (nativeAvailable) {
      const native = loadNative();
      const nativeVersion =
        typeof native.engineVersion === 'function' ? native.engineVersion() : 'unknown';
      console.log(`  Native version: ${nativeVersion}`);
    }
    console.log(`  Engine flag   : --engine ${engine}`);
    console.log(`  Active engine : ${activeName}${activeVersion ? ` (v${activeVersion})` : ''}`);
    console.log();
  });

program.parse();
