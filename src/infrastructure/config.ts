import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CodegraphConfig } from '../types.js';
import { debug, warn } from './logger.js';

export type { CodegraphConfig } from '../types.js';

export const CONFIG_FILES: readonly string[] = [
  '.codegraphrc.json',
  '.codegraphrc',
  'codegraph.config.json',
];

export const DEFAULTS = {
  include: [] as string[],
  exclude: [] as string[],
  ignoreDirs: [] as string[],
  extensions: [] as string[],
  aliases: {} as Record<string, string>,
  build: {
    incremental: true,
    dbPath: '.codegraph/graph.db',
    driftThreshold: 0.2,
  },
  query: {
    defaultDepth: 3,
    defaultLimit: 20,
    excludeTests: false,
  },
  embeddings: { model: 'nomic-v1.5', llmProvider: null as string | null },
  llm: {
    provider: null as string | null,
    model: null as string | null,
    baseUrl: null as string | null,
    apiKey: null as string | null,
    apiKeyCommand: null as string | null,
  },
  search: { defaultMinScore: 0.2, rrfK: 60, topK: 15, similarityWarnThreshold: 0.85 },
  ci: { failOnCycles: false, impactThreshold: null as number | null },
  manifesto: {
    rules: {
      cognitive: { warn: 15 },
      cyclomatic: { warn: 10 },
      maxNesting: { warn: 4 },
      maintainabilityIndex: { warn: 20, fail: null as number | null },
      importCount: { warn: null as number | null, fail: null as number | null },
      exportCount: { warn: null as number | null, fail: null as number | null },
      lineCount: { warn: null as number | null, fail: null as number | null },
      fanIn: { warn: null as number | null, fail: null as number | null },
      fanOut: { warn: null as number | null, fail: null as number | null },
      noCycles: { warn: null as number | null, fail: null as number | null },
      boundaries: { warn: null as number | null, fail: null as number | null },
    },
    boundaries: null as unknown,
  },
  check: {
    cycles: true,
    blastRadius: null as number | null,
    signatures: true,
    boundaries: true,
    depth: 3,
  },
  coChange: {
    since: '1 year ago',
    minSupport: 3,
    minJaccard: 0.3,
    maxFilesPerCommit: 50,
  },
  analysis: {
    impactDepth: 3,
    fnImpactDepth: 5,
    auditDepth: 3,
    sequenceDepth: 10,
    falsePositiveCallers: 20,
    briefCallerDepth: 5,
    briefImporterDepth: 5,
    briefHighRiskCallers: 10,
    briefMediumRiskCallers: 3,
  },
  community: {
    resolution: 1.0,
    maxLevels: 50,
    maxLocalPasses: 20,
    refinementTheta: 1.0,
  },
  structure: {
    cohesionThreshold: 0.3,
  },
  risk: {
    weights: {
      fanIn: 0.25,
      complexity: 0.3,
      churn: 0.2,
      role: 0.15,
      mi: 0.1,
    },
    roleWeights: {
      core: 1.0,
      utility: 0.9,
      entry: 0.8,
      adapter: 0.5,
      leaf: 0.2,
      'test-only': 0.1,
      dead: 0.1,
      'dead-leaf': 0.0,
      'dead-entry': 0.3,
      'dead-ffi': 0.05,
      'dead-unresolved': 0.15,
    } as Record<string, number>,
    defaultRoleWeight: 0.5,
  },
  display: {
    maxColWidth: 40,
    excerptLines: 50,
    summaryMaxChars: 100,
    jsdocEndScanLines: 10,
    jsdocOpenScanLines: 20,
    signatureGatherLines: 5,
  },
  mcp: {
    defaults: {
      list_functions: 100,
      query: 10,
      where: 50,
      node_roles: 100,
      export_graph: 500,
      fn_impact: 5,
      context: 5,
      explain: 10,
      file_deps: 20,
      file_exports: 20,
      diff_impact: 30,
      impact_analysis: 20,
      semantic_search: 20,
      execution_flow: 50,
      hotspots: 20,
      co_changes: 20,
      complexity: 30,
      manifesto: 50,
      communities: 20,
      structure: 30,
      triage: 20,
      ast_query: 50,
      implementations: 50,
      interfaces: 50,
    },
  },
} satisfies CodegraphConfig;

// Per-cwd config cache — avoids re-reading the config file on every query call.
// The config file rarely changes within a single process lifetime.
const _configCache = new Map<string, CodegraphConfig>();

/**
 * Load project configuration from a .codegraphrc.json or similar file.
 * Returns merged config with defaults. Results are cached per cwd.
 */
export function loadConfig(cwd?: string): CodegraphConfig {
  cwd = cwd || process.cwd();
  const cached = _configCache.get(cwd);
  if (cached) return structuredClone(cached);

  for (const name of CONFIG_FILES) {
    const filePath = path.join(cwd, name);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const config = JSON.parse(raw);
        debug(`Loaded config from ${filePath}`);
        const merged = mergeConfig(DEFAULTS as unknown as Record<string, unknown>, config);
        if ('excludeTests' in config && !(config.query && 'excludeTests' in config.query)) {
          (merged.query as Record<string, unknown>).excludeTests = Boolean(config.excludeTests);
        }
        delete merged.excludeTests;
        const result = resolveSecrets(applyEnvOverrides(merged as unknown as CodegraphConfig));
        _configCache.set(cwd, structuredClone(result));
        return result;
      } catch (err: unknown) {
        debug(`Failed to parse config ${filePath}: ${(err as Error).message}`);
      }
    }
  }
  const defaults = resolveSecrets(applyEnvOverrides({ ...DEFAULTS }));
  _configCache.set(cwd, structuredClone(defaults));
  return defaults;
}

/**
 * Clear the config cache. Intended for long-running processes that need to
 * pick up on-disk config changes, and for test isolation when tests share
 * the same cwd.
 */
export function clearConfigCache(): void {
  _configCache.clear();
}

const ENV_LLM_MAP: Record<string, string> = {
  CODEGRAPH_LLM_PROVIDER: 'provider',
  CODEGRAPH_LLM_API_KEY: 'apiKey',
  CODEGRAPH_LLM_MODEL: 'model',
};

export function applyEnvOverrides(config: CodegraphConfig): CodegraphConfig {
  for (const [envKey, field] of Object.entries(ENV_LLM_MAP)) {
    if (process.env[envKey as keyof NodeJS.ProcessEnv] !== undefined) {
      (config.llm as Record<string, unknown>)[field] =
        process.env[envKey as keyof NodeJS.ProcessEnv];
    }
  }
  return config;
}

export function resolveSecrets(config: CodegraphConfig): CodegraphConfig {
  const cmd = config.llm.apiKeyCommand;
  if (typeof cmd !== 'string' || cmd.trim() === '') return config;

  const parts = cmd.trim().split(/\s+/);
  const [executable, ...args] = parts;
  try {
    const result = execFileSync(executable!, args, {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (result) {
      (config.llm as Record<string, unknown>).apiKey = result;
    }
  } catch (err: unknown) {
    warn(`apiKeyCommand failed: ${(err as Error).message}`);
  }
  return config;
}

// ── Monorepo workspace detection ─────────────────────────────────────

/**
 * Expand a workspace glob pattern into matching directories.
 * Supports trailing `/*` or `/**` patterns (e.g. "packages/*").
 * Does not depend on an external glob library — uses fs.readdirSync.
 */
function expandWorkspaceGlob(pattern: string, rootDir: string): string[] {
  // Strip trailing /*, /**, or just *
  const clean = pattern.replace(/\/?\*\*?$/, '');
  const baseDir = path.resolve(rootDir, clean);
  if (!fs.existsSync(baseDir)) return [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(baseDir, e.name))
      .filter((d) => fs.existsSync(path.join(d, 'package.json')));
  } catch {
    return [];
  }
}

/**
 * Read a package.json and return its name field, or null.
 */
function readPackageName(pkgDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    return pkg.name || null;
  } catch {
    return null;
  }
}

interface WorkspaceEntry {
  dir: string;
  entry: string | null;
}

/**
 * Resolve the entry-point source file for a workspace package.
 * Checks exports → main → index file fallback.
 */
function resolveWorkspaceEntry(pkgDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);

    // Try "source" field first (common in monorepos for pre-built packages)
    if (pkg.source) {
      const s = path.resolve(pkgDir, pkg.source);
      if (fs.existsSync(s)) return s;
    }

    // Try "main" field
    if (pkg.main) {
      const m = path.resolve(pkgDir, pkg.main);
      if (fs.existsSync(m)) return m;
    }

    // Index file fallback
    for (const idx of [
      'index.ts',
      'index.tsx',
      'index.js',
      'index.mjs',
      'src/index.ts',
      'src/index.tsx',
      'src/index.js',
    ]) {
      const candidate = path.resolve(pkgDir, idx);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (e) {
    debug(
      `resolveWorkspaceEntry: package.json probe failed for ${pkgDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return null;
}

/**
 * Detect monorepo workspace packages from workspace configuration files.
 *
 * Checks (in order):
 *   1. pnpm-workspace.yaml — `packages:` array
 *   2. package.json — `workspaces` field (npm/yarn)
 *   3. lerna.json — `packages` array
 */
export function detectWorkspaces(rootDir: string): Map<string, WorkspaceEntry> {
  const workspaces = new Map<string, WorkspaceEntry>();
  const patterns: string[] = [];

  // 1. pnpm-workspace.yaml
  const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      const raw = fs.readFileSync(pnpmPath, 'utf-8');
      // Simple YAML parse for `packages:` array — no dependency needed
      const packagesMatch = raw.match(/^packages:\s*\n((?:\s+-\s+.+\n?)*)/m);
      if (packagesMatch) {
        const lines = packagesMatch[1]!.match(/^\s+-\s+['"]?([^'"#\n]+)['"]?\s*$/gm);
        if (lines) {
          for (const line of lines) {
            const m = line.match(/^\s+-\s+['"]?([^'"#\n]+?)['"]?\s*$/);
            if (m) patterns.push(m[1]!.trim());
          }
        }
      }
    } catch (e) {
      debug(
        `detectWorkspaces: failed to parse pnpm-workspace.yaml: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2. package.json workspaces (npm/yarn)
  if (patterns.length === 0) {
    const rootPkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(rootPkgPath)) {
      try {
        const raw = fs.readFileSync(rootPkgPath, 'utf-8');
        const pkg = JSON.parse(raw);
        const ws = pkg.workspaces;
        if (Array.isArray(ws)) {
          patterns.push(...ws);
        } else if (ws && Array.isArray(ws.packages)) {
          // Yarn classic format: { packages: [...], nohoist: [...] }
          patterns.push(...ws.packages);
        }
      } catch (e) {
        debug(
          `detectWorkspaces: failed to parse package.json workspaces: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  // 3. lerna.json
  if (patterns.length === 0) {
    const lernaPath = path.join(rootDir, 'lerna.json');
    if (fs.existsSync(lernaPath)) {
      try {
        const raw = fs.readFileSync(lernaPath, 'utf-8');
        const lerna = JSON.parse(raw);
        if (Array.isArray(lerna.packages)) {
          patterns.push(...lerna.packages);
        }
      } catch (e) {
        debug(
          `detectWorkspaces: failed to parse lerna.json: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  if (patterns.length === 0) return workspaces;

  // Expand glob patterns and collect packages
  for (const pattern of patterns) {
    // Check if pattern is a direct path (no glob) or a glob
    if (pattern.includes('*')) {
      for (const dir of expandWorkspaceGlob(pattern, rootDir)) {
        const name = readPackageName(dir);
        if (name) workspaces.set(name, { dir, entry: resolveWorkspaceEntry(dir) });
      }
    } else {
      // Direct path like "packages/core"
      const dir = path.resolve(rootDir, pattern);
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const name = readPackageName(dir);
        if (name) workspaces.set(name, { dir, entry: resolveWorkspaceEntry(dir) });
      }
    }
  }

  if (workspaces.size > 0) {
    debug(`Detected ${workspaces.size} workspace packages: ${[...workspaces.keys()].join(', ')}`);
  }

  return workspaces;
}

export function mergeConfig(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      defaults[key] &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = mergeConfig(
        defaults[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
