#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { buildGraph } from './builder.js';
import { loadConfig } from './config.js';
import { findCycles, formatCycles } from './cycles.js';
import { openReadonlyOrFail } from './db.js';
import {
  buildEmbeddings,
  DEFAULT_MODEL,
  EMBEDDING_STRATEGIES,
  MODELS,
  search,
} from './embedder.js';
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
  roles,
  stats,
  symbolPath,
  VALID_ROLES,
  where,
} from './queries.js';
import {
  listRepos,
  pruneRegistry,
  REGISTRY_PATH,
  registerRepo,
  unregisterRepo,
} from './registry.js';
import { snapshotDelete, snapshotList, snapshotRestore, snapshotSave } from './snapshot.js';
import { checkForUpdates, printUpdateNotification } from './update-check.js';
import { watchProject } from './watcher.js';

const __cliDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const pkg = JSON.parse(fs.readFileSync(path.join(__cliDir, '..', 'package.json'), 'utf-8'));

const config = loadConfig(process.cwd());

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
  })
  .hook('postAction', async (_thisCommand, actionCommand) => {
    const name = actionCommand.name();
    if (name === 'mcp' || name === 'watch') return;
    if (actionCommand.opts().json) return;
    try {
      const result = await checkForUpdates(pkg.version);
      if (result) printUpdateNotification(result.current, result.latest);
    } catch {
      /* never break CLI */
    }
  });

/**
 * Resolve the effective noTests value: CLI flag > config > false.
 * Commander sets opts.tests to false when --no-tests is passed.
 * When --include-tests is passed, always return false (include tests).
 * Otherwise, fall back to config.query.excludeTests.
 */
function resolveNoTests(opts) {
  if (opts.includeTests) return false;
  if (opts.tests === false) return true;
  return config.query?.excludeTests || false;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .option('--limit <number>', 'Max results to return')
  .option('--offset <number>', 'Skip N results (default: 0)')
  .option('--ndjson', 'Newline-delimited JSON output')
  .action((name, opts) => {
    queryName(name, opts.db, {
      noTests: resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  });

program
  .command('impact <file>')
  .description('Show what depends on this file (transitive)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action((file, opts) => {
    impactAnalysis(file, opts.db, { noTests: resolveNoTests(opts), json: opts.json });
  });

program
  .command('map')
  .description('High-level module overview with most-connected nodes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-n, --limit <number>', 'Number of top nodes', '20')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    moduleMap(opts.db, parseInt(opts.limit, 10), {
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('stats')
  .description('Show graph health overview: nodes, edges, languages, cycles, hotspots, embeddings')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (opts) => {
    await stats(opts.db, { noTests: resolveNoTests(opts), json: opts.json });
  });

program
  .command('deps <file>')
  .description('Show what this file imports and what imports it')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action((file, opts) => {
    fileDeps(file, opts.db, { noTests: resolveNoTests(opts), json: opts.json });
  });

program
  .command('fn <name>')
  .description('Function-level dependencies: callers, callees, and transitive call chain')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Transitive caller depth', '3')
  .option('-f, --file <path>', 'Scope search to functions in this file (partial match)')
  .option('-k, --kind <kind>', 'Filter to a specific symbol kind')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
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
      noTests: resolveNoTests(opts),
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
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
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
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('path <from> <to>')
  .description('Find shortest path between two symbols (A calls...calls B)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--max-depth <n>', 'Maximum BFS depth', '10')
  .option('--kinds <kinds>', 'Comma-separated edge kinds to follow (default: calls)')
  .option('--reverse', 'Follow edges backward (B is called by...called by A)')
  .option('--from-file <path>', 'Disambiguate source symbol by file (partial match)')
  .option('--to-file <path>', 'Disambiguate target symbol by file (partial match)')
  .option('-k, --kind <kind>', 'Filter both symbols by kind')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action((from, to, opts) => {
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    symbolPath(from, to, opts.db, {
      maxDepth: parseInt(opts.maxDepth, 10),
      edgeKinds: opts.kinds ? opts.kinds.split(',').map((s) => s.trim()) : undefined,
      reverse: opts.reverse,
      fromFile: opts.fromFile,
      toFile: opts.toFile,
      kind: opts.kind,
      noTests: resolveNoTests(opts),
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
  .option('--with-test-source', 'Include test source code')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
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
      noTests: resolveNoTests(opts),
      includeTests: opts.withTestSource,
      json: opts.json,
    });
  });

program
  .command('explain <target>')
  .description('Structural summary of a file or function (no LLM needed)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Recursively explain dependencies up to N levels deep', '0')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action((target, opts) => {
    explain(target, opts.db, {
      depth: parseInt(opts.depth, 10),
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('where [name]')
  .description('Find where a symbol is defined and used (minimal, fast lookup)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-f, --file <path>', 'File overview: list symbols, imports, exports')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .option('--limit <number>', 'Max results to return')
  .option('--offset <number>', 'Skip N results (default: 0)')
  .option('--ndjson', 'Newline-delimited JSON output')
  .action((name, opts) => {
    if (!name && !opts.file) {
      console.error('Provide a symbol name or use --file <path>');
      process.exit(1);
    }
    const target = opts.file || name;
    where(target, opts.db, {
      file: !!opts.file,
      noTests: resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  });

program
  .command('diff-impact [ref]')
  .description('Show impact of git changes (unstaged, staged, or vs a ref)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--staged', 'Analyze staged changes instead of unstaged')
  .option('--depth <n>', 'Max transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .option('-f, --format <format>', 'Output format: text, mermaid, json', 'text')
  .action((ref, opts) => {
    diffImpact(opts.db, {
      ref,
      staged: opts.staged,
      depth: parseInt(opts.depth, 10),
      noTests: resolveNoTests(opts),
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
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('--min-confidence <score>', 'Minimum edge confidence threshold (default: 0.5)', '0.5')
  .option('--direction <dir>', 'Flowchart direction for Mermaid: TB, LR, RL, BT', 'LR')
  .option('-o, --output <file>', 'Write to file instead of stdout')
  .action((opts) => {
    const db = openReadonlyOrFail(opts.db);
    const exportOpts = {
      fileLevel: !opts.functions,
      noTests: resolveNoTests(opts),
      minConfidence: parseFloat(opts.minConfidence),
      direction: opts.direction,
    };

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
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    const db = openReadonlyOrFail(opts.db);
    const cycles = findCycles(db, { fileLevel: !opts.functions, noTests: resolveNoTests(opts) });
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
  .option('--exclude <names>', 'Comma-separated repo names to preserve from pruning')
  .option('--dry-run', 'Show what would be pruned without removing anything')
  .action((opts) => {
    const excludeNames = opts.exclude
      ? opts.exclude
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
    const dryRun = !!opts.dryRun;
    const pruned = pruneRegistry(undefined, parseInt(opts.ttl, 10), excludeNames, dryRun);
    if (pruned.length === 0) {
      console.log('No stale entries found.');
    } else {
      const prefix = dryRun ? 'Would prune' : 'Pruned';
      for (const entry of pruned) {
        const tag = entry.reason === 'expired' ? 'expired' : 'missing';
        console.log(`${prefix} "${entry.name}" (${entry.path}) [${tag}]`);
      }
      if (dryRun) {
        console.log(
          `\nDry run: ${pruned.length} ${pruned.length === 1 ? 'entry' : 'entries'} would be removed.`,
        );
      } else {
        console.log(
          `\nRemoved ${pruned.length} stale ${pruned.length === 1 ? 'entry' : 'entries'}.`,
        );
      }
    }
  });

// ─── Snapshot commands ──────────────────────────────────────────────────

const snapshot = program
  .command('snapshot')
  .description('Save and restore graph database snapshots');

snapshot
  .command('save <name>')
  .description('Save a snapshot of the current graph database')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--force', 'Overwrite existing snapshot')
  .action((name, opts) => {
    try {
      const result = snapshotSave(name, { dbPath: opts.db, force: opts.force });
      console.log(`Snapshot saved: ${result.name} (${formatSize(result.size)})`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

snapshot
  .command('restore <name>')
  .description('Restore a snapshot over the current graph database')
  .option('-d, --db <path>', 'Path to graph.db')
  .action((name, opts) => {
    try {
      snapshotRestore(name, { dbPath: opts.db });
      console.log(`Snapshot "${name}" restored.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

snapshot
  .command('list')
  .description('List all saved snapshots')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-j, --json', 'Output as JSON')
  .action((opts) => {
    try {
      const snapshots = snapshotList({ dbPath: opts.db });
      if (opts.json) {
        console.log(JSON.stringify(snapshots, null, 2));
      } else if (snapshots.length === 0) {
        console.log('No snapshots found.');
      } else {
        console.log(`Snapshots (${snapshots.length}):\n`);
        for (const s of snapshots) {
          console.log(
            `  ${s.name.padEnd(30)} ${formatSize(s.size).padStart(10)}  ${s.createdAt.toISOString()}`,
          );
        }
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

snapshot
  .command('delete <name>')
  .description('Delete a saved snapshot')
  .option('-d, --db <path>', 'Path to graph.db')
  .action((name, opts) => {
    try {
      snapshotDelete(name, { dbPath: opts.db });
      console.log(`Snapshot "${name}" deleted.`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

// ─── Embedding commands ─────────────────────────────────────────────────

program
  .command('models')
  .description('List available embedding models')
  .action(() => {
    const defaultModel = config.embeddings?.model || DEFAULT_MODEL;
    console.log('\nAvailable embedding models:\n');
    for (const [key, cfg] of Object.entries(MODELS)) {
      const def = key === defaultModel ? ' (default)' : '';
      const ctx = cfg.contextWindow ? `${cfg.contextWindow} ctx` : '';
      console.log(
        `  ${key.padEnd(12)} ${String(cfg.dim).padStart(4)}d  ${ctx.padEnd(9)} ${cfg.desc}${def}`,
      );
    }
    console.log('\nUsage: codegraph embed --model <name> --strategy <structured|source>');
    console.log('       codegraph search "query" --model <name>\n');
  });

program
  .command('embed [dir]')
  .description(
    'Build semantic embeddings for all functions/methods/classes (requires prior `build`)',
  )
  .option(
    '-m, --model <name>',
    'Embedding model (default from config or minilm). Run `codegraph models` for details',
  )
  .option(
    '-s, --strategy <name>',
    `Embedding strategy: ${EMBEDDING_STRATEGIES.join(', ')}. "structured" uses graph context (callers/callees), "source" embeds raw code`,
    'structured',
  )
  .option('-d, --db <path>', 'Path to graph.db')
  .action(async (dir, opts) => {
    if (!EMBEDDING_STRATEGIES.includes(opts.strategy)) {
      console.error(
        `Unknown strategy: ${opts.strategy}. Available: ${EMBEDDING_STRATEGIES.join(', ')}`,
      );
      process.exit(1);
    }
    const root = path.resolve(dir || '.');
    const model = opts.model || config.embeddings?.model || DEFAULT_MODEL;
    await buildEmbeddings(root, model, opts.db, { strategy: opts.strategy });
  });

program
  .command('search <query>')
  .description('Semantic search: find functions by natural language description')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-m, --model <name>', 'Override embedding model (auto-detects from DB)')
  .option('-n, --limit <number>', 'Max results', '15')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('--min-score <score>', 'Minimum similarity threshold', '0.2')
  .option('-k, --kind <kind>', 'Filter by kind: function, method, class')
  .option('--file <pattern>', 'Filter by file path pattern')
  .option('--rrf-k <number>', 'RRF k parameter for multi-query ranking', '60')
  .option('-j, --json', 'Output as JSON')
  .action(async (query, opts) => {
    await search(query, opts.db, {
      limit: parseInt(opts.limit, 10),
      noTests: resolveNoTests(opts),
      minScore: parseFloat(opts.minScore),
      model: opts.model,
      kind: opts.kind,
      filePattern: opts.file,
      rrfK: parseInt(opts.rrfK, 10),
      json: opts.json,
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
  .option('--full', 'Show all files without limit')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (dir, opts) => {
    const { structureData, formatStructure } = await import('./structure.js');
    const data = structureData(opts.db, {
      directory: dir,
      depth: opts.depth ? parseInt(opts.depth, 10) : undefined,
      sort: opts.sort,
      full: opts.full,
      noTests: resolveNoTests(opts),
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
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (opts) => {
    const { hotspotsData, formatHotspots } = await import('./structure.js');
    const data = hotspotsData(opts.db, {
      metric: opts.metric,
      level: opts.level,
      limit: parseInt(opts.limit, 10),
      noTests: resolveNoTests(opts),
    });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatHotspots(data));
    }
  });

program
  .command('roles')
  .description('Show node role classification: entry, core, utility, adapter, dead, leaf')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--role <role>', `Filter by role (${VALID_ROLES.join(', ')})`)
  .option('-f, --file <path>', 'Scope to a specific file (partial match)')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .option('--limit <number>', 'Max results to return')
  .option('--offset <number>', 'Skip N results (default: 0)')
  .option('--ndjson', 'Newline-delimited JSON output')
  .action((opts) => {
    if (opts.role && !VALID_ROLES.includes(opts.role)) {
      console.error(`Invalid role "${opts.role}". Valid roles: ${VALID_ROLES.join(', ')}`);
      process.exit(1);
    }
    roles(opts.db, {
      role: opts.role,
      file: opts.file,
      noTests: resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  });

program
  .command('co-change [file]')
  .description(
    'Analyze git history for files that change together. Use --analyze to scan, or query existing data.',
  )
  .option('--analyze', 'Scan git history and populate co-change data')
  .option('--since <date>', 'Git date for history window (default: "1 year ago")')
  .option('--min-support <n>', 'Minimum co-occurrence count (default: 3)')
  .option('--min-jaccard <n>', 'Minimum Jaccard similarity 0-1 (default: 0.3)')
  .option('--full', 'Force full re-scan (ignore incremental state)')
  .option('-n, --limit <n>', 'Max results', '20')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (file, opts) => {
    const { analyzeCoChanges, coChangeData, coChangeTopData, formatCoChange, formatCoChangeTop } =
      await import('./cochange.js');

    if (opts.analyze) {
      const result = analyzeCoChanges(opts.db, {
        since: opts.since || config.coChange?.since,
        minSupport: opts.minSupport ? parseInt(opts.minSupport, 10) : config.coChange?.minSupport,
        maxFilesPerCommit: config.coChange?.maxFilesPerCommit,
        full: opts.full,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.error) {
        console.error(result.error);
        process.exit(1);
      } else {
        console.log(
          `\nCo-change analysis complete: ${result.pairsFound} pairs from ${result.commitsScanned} commits (since: ${result.since})\n`,
        );
      }
      return;
    }

    const queryOpts = {
      limit: parseInt(opts.limit, 10),
      minJaccard: opts.minJaccard ? parseFloat(opts.minJaccard) : config.coChange?.minJaccard,
      noTests: resolveNoTests(opts),
    };

    if (file) {
      const data = coChangeData(file, opts.db, queryOpts);
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatCoChange(data));
      }
    } else {
      const data = coChangeTopData(opts.db, queryOpts);
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatCoChangeTop(data));
      }
    }
  });

program
  .command('flow [name]')
  .description(
    'Trace execution flow forward from an entry point (route, command, event) through callees to leaves',
  )
  .option('--list', 'List all entry points grouped by type')
  .option('--depth <n>', 'Max forward traversal depth', '10')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-f, --file <path>', 'Scope to a specific file (partial match)')
  .option('-k, --kind <kind>', 'Filter by symbol kind')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .option('--limit <number>', 'Max results to return')
  .option('--offset <number>', 'Skip N results (default: 0)')
  .option('--ndjson', 'Newline-delimited JSON output')
  .action(async (name, opts) => {
    if (!name && !opts.list) {
      console.error('Provide a function/entry point name or use --list to see all entry points.');
      process.exit(1);
    }
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    const { flow } = await import('./flow.js');
    flow(name, opts.db, {
      list: opts.list,
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noTests: resolveNoTests(opts),
      json: opts.json,
      limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      ndjson: opts.ndjson,
    });
  });

program
  .command('complexity [target]')
  .description('Show per-function complexity metrics (cognitive, cyclomatic, nesting depth, MI)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-n, --limit <number>', 'Max results', '20')
  .option(
    '--sort <metric>',
    'Sort by: cognitive | cyclomatic | nesting | mi | volume | effort | bugs | loc',
    'cognitive',
  )
  .option('--above-threshold', 'Only functions exceeding warn thresholds')
  .option('--health', 'Show health metrics (Halstead, MI) columns')
  .option('-f, --file <path>', 'Scope to file (partial match)')
  .option('-k, --kind <kind>', 'Filter by symbol kind')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (target, opts) => {
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    const { complexity } = await import('./complexity.js');
    complexity(opts.db, {
      target,
      limit: parseInt(opts.limit, 10),
      sort: opts.sort,
      aboveThreshold: opts.aboveThreshold,
      health: opts.health,
      file: opts.file,
      kind: opts.kind,
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('manifesto')
  .description('Evaluate manifesto rules (pass/fail verdicts for code health)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-f, --file <path>', 'Scope to file (partial match)')
  .option('-k, --kind <kind>', 'Filter by symbol kind')
  .option('-j, --json', 'Output as JSON')
  .action(async (opts) => {
    if (opts.kind && !ALL_SYMBOL_KINDS.includes(opts.kind)) {
      console.error(`Invalid kind "${opts.kind}". Valid: ${ALL_SYMBOL_KINDS.join(', ')}`);
      process.exit(1);
    }
    const { manifesto } = await import('./manifesto.js');
    manifesto(opts.db, {
      file: opts.file,
      kind: opts.kind,
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('communities')
  .description('Detect natural module boundaries using Louvain community detection')
  .option('--functions', 'Function-level instead of file-level')
  .option('--resolution <n>', 'Louvain resolution parameter (default 1.0)', '1.0')
  .option('--drift', 'Show only drift analysis')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (opts) => {
    const { communities } = await import('./communities.js');
    communities(opts.db, {
      functions: opts.functions,
      resolution: parseFloat(opts.resolution),
      drift: opts.drift,
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('owners [target]')
  .description('Show CODEOWNERS mapping for files and functions')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--owner <owner>', 'Filter to a specific owner')
  .option('--boundary', 'Show cross-owner boundary edges')
  .option('-f, --file <path>', 'Scope to a specific file')
  .option('-k, --kind <kind>', 'Filter by symbol kind')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .action(async (target, opts) => {
    const { owners } = await import('./owners.js');
    owners(opts.db, {
      owner: opts.owner,
      boundary: opts.boundary,
      file: opts.file || target,
      kind: opts.kind,
      noTests: resolveNoTests(opts),
      json: opts.json,
    });
  });

program
  .command('branch-compare <base> <target>')
  .description('Compare code structure between two branches/refs')
  .option('--depth <n>', 'Max transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files')
  .option('--include-tests', 'Include test/spec files (overrides excludeTests config)')
  .option('-j, --json', 'Output as JSON')
  .option('-f, --format <format>', 'Output format: text, mermaid, json', 'text')
  .action(async (base, target, opts) => {
    const { branchCompare } = await import('./branch-compare.js');
    await branchCompare(base, target, {
      engine: program.opts().engine,
      depth: parseInt(opts.depth, 10),
      noTests: resolveNoTests(opts),
      json: opts.json,
      format: opts.format,
    });
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

    // Build metadata from DB
    try {
      const { findDbPath, getBuildMeta } = await import('./db.js');
      const Database = (await import('better-sqlite3')).default;
      const dbPath = findDbPath();
      const fs = await import('node:fs');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const buildEngine = getBuildMeta(db, 'engine');
        const buildVersion = getBuildMeta(db, 'codegraph_version');
        const builtAt = getBuildMeta(db, 'built_at');
        db.close();

        if (buildEngine || buildVersion || builtAt) {
          console.log('Build metadata');
          console.log('──────────────');
          if (buildEngine) console.log(`  Engine        : ${buildEngine}`);
          if (buildVersion) console.log(`  Version       : ${buildVersion}`);
          if (builtAt) console.log(`  Built at      : ${builtAt}`);

          if (buildVersion && buildVersion !== program.version()) {
            console.log(
              `  ⚠ DB was built with v${buildVersion}, current is v${program.version()}. Consider: codegraph build --no-incremental`,
            );
          }
          if (buildEngine && buildEngine !== activeName) {
            console.log(
              `  ⚠ DB was built with ${buildEngine} engine, active is ${activeName}. Consider: codegraph build --no-incremental`,
            );
          }
          console.log();
        }
      }
    } catch {
      /* diagnostics must never crash */
    }
  });

program.parse();
