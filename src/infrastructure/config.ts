import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, toErrorMessage } from '../shared/errors.js';
import { compileGlobs, matchesAny } from '../shared/globs.js';
import type { CodegraphConfig, ConfigSource, ConsentDecision } from '../types.js';
import { debug, warn } from './logger.js';
import { getUserConfigConsent, REGISTRY_PATH, setUserConfigConsent } from './registry.js';

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
    smallFilesThreshold: 5,
    typescriptResolver: true,
    engine: 'auto' as 'auto' | 'native' | 'wasm',
    fastSkipDiag: false,
  },
  query: {
    defaultDepth: 3,
    defaultLimit: 20,
    excludeTests: false,
  },
  embeddings: { model: null as string | null, llmProvider: null as string | null },
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
    // TODO(Phase 8.3): wire these into the points-to solver and type-propagation path
    // once config is threaded through to extractSymbols / buildPointsToMap. Currently
    // controlled by hardcoded constants in src/extractors/javascript.ts
    // (MAX_PROPAGATION_DEPTH, PROPAGATION_HOP_PENALTY, INFERRED_RETURN_TYPE_CONFIDENCE) and in
    // src/domain/graph/resolver/points-to.ts (MAX_SOLVER_ITERATIONS).
    typePropagationDepth: 3,
    /**
     * Confidence score assigned to a return type inferred from `return new Constructor()`
     * when no explicit TypeScript annotation is present.
     * Mirrors `INFERRED_RETURN_TYPE_CONFIDENCE` in `src/extractors/javascript.ts`.
     * @reserved — not yet wired; see TODO above.
     */
    typeInferenceConfidence: 0.85,
    /**
     * Maximum fixed-point iterations for the Phase 8.3 points-to solver.
     * @reserved — currently not wired to either the WASM solver
     * (`MAX_SOLVER_ITERATIONS` in `points-to.ts`) or the native Rust solver
     * (`MAX_SOLVER_ITERATIONS` in `stages/build_edges.rs`), both of which use the
     * same hardcoded value of 50.  See the TODO comment above.
     */
    pointsToMaxIterations: 50,
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
    disabledTools: [] as string[],
  },
} satisfies CodegraphConfig;

// ── Per-process user-config override (set by CLI flags) ────────────────
// Set once by the preAction hook before any command runs; cleared when changed.
let _userConfigOverride: string | boolean | undefined;

/**
 * Set the per-run user-config override from CLI flags.
 * Called by the CLI preAction hook before any command executes.
 * - false  → --no-user-config
 * - string → --user-config <path>
 * - true   → --user-config (bare, use default global file)
 * - undefined → clear override, revert to consent-based resolution
 */
export function setUserConfigOverride(v: string | boolean | undefined): void {
  _userConfigOverride = v;
  _configCache.clear();
  _globalConfigCache.clear();
}

// Per-cwd config cache — avoids re-reading the config file on every query call.
// Key includes the applied global path so toggled flags/consent are reflected.
const _configCache = new Map<string, CodegraphConfig>();
// Parallel cache for the sanitized global layer — needed so loadConfigWithProvenance
// can correctly attribute global-layer keys even on a _configCache hit.
const _globalConfigCache = new Map<string, Record<string, unknown> | null>();

// ── Global config file location ─────────────────────────────────────────

/**
 * Return the canonical path where a new global config file should be written.
 *
 * Uses the same priority logic as resolveUserConfigPath() but always returns a
 * path — it does not check whether the file exists. Used by `--init` to know
 * where to scaffold the file.
 *
 * Priority:
 * 1. CODEGRAPH_USER_CONFIG env var (used as-is)
 * 2. $XDG_CONFIG_HOME/codegraph/config.json
 *    %APPDATA%\codegraph\config.json  (Windows)
 *    fallback: ~/.config/codegraph/config.json
 */
export function getDefaultUserConfigPath(): string {
  const envPath = process.env.CODEGRAPH_USER_CONFIG;
  if (envPath) return envPath;

  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return path.join(xdgConfig, 'codegraph', 'config.json');
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    return appdata
      ? path.join(appdata, 'codegraph', 'config.json')
      : path.join(home, '.config', 'codegraph', 'config.json');
  }
  return path.join(home, '.config', 'codegraph', 'config.json');
}

/**
 * Resolve the absolute path to the user-level global config file.
 *
 * Priority:
 * 1. CODEGRAPH_USER_CONFIG env var (location override only — not forced-on)
 * 2. $XDG_CONFIG_HOME/codegraph/config.json  (Unix/macOS)
 *    %APPDATA%\codegraph\config.json          (Windows)
 *    fallback: ~/.config/codegraph/config.json
 * 3. ~/.codegraph/config.json  (legacy, next to registry.json)
 *
 * Returns the path of the first existing file, or null if none exist.
 */
export function resolveUserConfigPath(): string | null {
  const envPath = process.env.CODEGRAPH_USER_CONFIG;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    debug(`CODEGRAPH_USER_CONFIG points to missing file: ${envPath}`);
    return null;
  }

  const home = os.homedir();

  // XDG_CONFIG_HOME takes priority on all platforms when explicitly set.
  // Falls back to %APPDATA% on Windows, or ~/.config on Unix/macOS.
  let platformDefault: string;
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    platformDefault = path.join(xdgConfig, 'codegraph', 'config.json');
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    platformDefault = appdata
      ? path.join(appdata, 'codegraph', 'config.json')
      : path.join(home, '.config', 'codegraph', 'config.json');
  } else {
    platformDefault = path.join(home, '.config', 'codegraph', 'config.json');
  }

  if (fs.existsSync(platformDefault)) return platformDefault;

  const legacyPath = path.join(home, '.codegraph', 'config.json');
  if (fs.existsSync(legacyPath)) return legacyPath;

  return null;
}

// ── Global config file loading ──────────────────────────────────────────

interface ParsedUserConfig {
  globalConfig: Record<string, unknown>;
  appliesToGlobs: string[];
}

/**
 * Read and parse a user-level global config file.
 * Handles both plain-config and appliesTo-wrapper formats.
 * Returns null on missing or malformed files (never throws).
 */
function loadUserConfigFile(filePath: string): ParsedUserConfig | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Wrapper format: { appliesTo: [...], config: {...} }
    if ('appliesTo' in parsed && typeof parsed.config === 'object' && parsed.config !== null) {
      const globs = Array.isArray(parsed.appliesTo)
        ? (parsed.appliesTo as unknown[]).filter((g): g is string => typeof g === 'string')
        : [];
      return { globalConfig: parsed.config as Record<string, unknown>, appliesToGlobs: globs };
    }
    // Plain config (no appliesTo wrapper)
    return { globalConfig: parsed, appliesToGlobs: [] };
  } catch (err) {
    debug(`Failed to load user config at ${filePath}: ${toErrorMessage(err)}`);
    return null;
  }
}

// ── Safety sanitisation ─────────────────────────────────────────────────

/**
 * Drop any unsafe keys from the global layer before merging.
 * Currently: absolute build.dbPath (would make all repos share one DB).
 * Relative dbPaths resolve per-repo and are allowed through unchanged.
 */
function sanitizeUserLayer(raw: Record<string, unknown>): Record<string, unknown> {
  const build = raw.build as Record<string, unknown> | undefined;
  if (build && typeof build.dbPath === 'string' && path.isAbsolute(build.dbPath)) {
    warn(
      `User config: build.dbPath "${build.dbPath}" is absolute and was ignored ` +
        '(an absolute dbPath would share one database across all repos).',
    );
    const sanitizedBuild = { ...build };
    delete sanitizedBuild.dbPath;
    return { ...raw, build: sanitizedBuild };
  }
  return raw;
}

// ── excludeTests shorthand (per-layer) ─────────────────────────────────

/**
 * Hoist a top-level `excludeTests` key from a raw layer into `query.excludeTests`.
 * If the layer already has `query.excludeTests`, that value wins (no-op).
 * Also removes any stale `excludeTests` key that may have leaked into `merged`.
 */
function applyExcludeTestsShorthand(
  merged: Record<string, unknown>,
  rawLayer: Record<string, unknown>,
): Record<string, unknown> {
  if ('excludeTests' in rawLayer) {
    // Only hoist if this layer doesn't also set query.excludeTests
    if (!(rawLayer.query && 'excludeTests' in (rawLayer.query as object))) {
      (merged.query as Record<string, unknown>).excludeTests = Boolean(rawLayer.excludeTests);
    }
    const result = { ...merged };
    delete result.excludeTests;
    return result;
  }
  if ('excludeTests' in merged) {
    const result = { ...merged };
    delete result.excludeTests;
    return result;
  }
  return merged;
}

// ── Consent resolution ──────────────────────────────────────────────────

interface ConsentResolutionResult {
  applied: boolean;
  globalPath: string | null;
  consentDecision: ConsentDecision | undefined;
}

/**
 * Resolve whether the global user config should be applied for a given repo.
 * Implements the §4.1/§4.2 precedence chain from the spec.
 *
 * @param rootDir  Absolute repo root.
 * @param override Per-run override from CLI flags (_userConfigOverride).
 * @param registryPath  Optional registry path (for tests).
 */
function resolveConsent(
  rootDir: string,
  override: string | boolean | undefined,
  registryPath: string = REGISTRY_PATH,
): ConsentResolutionResult {
  // §4.1 step 1: --no-user-config
  if (override === false) {
    return { applied: false, globalPath: null, consentDecision: undefined };
  }

  // §4.1 steps 2–3: explicit path or bare --user-config
  if (override !== undefined) {
    const explicitPath = typeof override === 'string' ? override : resolveUserConfigPath();
    if (explicitPath && fs.existsSync(explicitPath)) {
      return { applied: true, globalPath: explicitPath, consentDecision: undefined };
    }
    if (typeof override === 'string') {
      warn(`--user-config path "${override}" does not exist; skipping global layer.`);
    }
    return { applied: false, globalPath: null, consentDecision: undefined };
  }

  // §4.1 step 4: resolve global file — if none, NOT applied
  const globalPath = resolveUserConfigPath();
  if (!globalPath) {
    return { applied: false, globalPath: null, consentDecision: undefined };
  }

  // §4.2: check per-repo decision
  const consentDecision = getUserConfigConsent(rootDir, registryPath);

  // §4.2 step 1: recorded disabled
  if (consentDecision === 'disabled') {
    return { applied: false, globalPath, consentDecision };
  }

  // §4.2 step 2: recorded enabled
  if (consentDecision === 'enabled') {
    return { applied: true, globalPath, consentDecision };
  }

  // §4.2 step 3: appliesTo glob match (dynamic, never persisted)
  const parsed = loadUserConfigFile(globalPath);
  if (parsed?.appliesToGlobs.length) {
    const expanded = parsed.appliesToGlobs.map((g) =>
      g.startsWith('~') ? path.join(os.homedir(), g.slice(1)) : g,
    );
    const regexes = compileGlobs(expanded);
    const absRoot = path.resolve(rootDir);
    if (matchesAny(regexes, absRoot)) {
      return { applied: true, globalPath, consentDecision: undefined };
    }
  }

  // §4.2 steps 4–5: undecided — caller decides whether to prompt
  return { applied: false, globalPath, consentDecision: undefined };
}

// Last applied global path and parsed data — exposed so pipeline.ts and
// loadConfigWithProvenance can reuse the already-parsed file contents without a
// second disk read (eliminating the TOCTOU window between loadConfig and callers).
let _lastAppliedGlobalPath: string | null = null;
let _lastAppliedGlobalConfig: Record<string, unknown> | null = null;
export function getLastAppliedGlobalPath(): string | null {
  return _lastAppliedGlobalPath;
}
export function getLastAppliedGlobalConfig(): Record<string, unknown> | null {
  return _lastAppliedGlobalConfig;
}

// ── Build-relevant config hash ──────────────────────────────────────────

const BUILD_HASH_KEYS: ReadonlyArray<keyof CodegraphConfig> = [
  'include',
  'exclude',
  'ignoreDirs',
  'extensions',
  'aliases',
  'build',
];

/**
 * Compute a short stable hash of the build-relevant config subset.
 * Used by the pipeline to detect config changes that require a full rebuild.
 */
export function computeConfigHash(config: CodegraphConfig): string {
  const subset: Partial<CodegraphConfig> = {};
  for (const k of BUILD_HASH_KEYS) {
    (subset as Record<string, unknown>)[k] = config[k];
  }
  return createHash('sha256').update(JSON.stringify(subset)).digest('hex').slice(0, 16);
}

// ── Interactive consent prompt ──────────────────────────────────────────

/**
 * When called from the build command, check whether we should prompt the user
 * for global-config consent and, if so, prompt and persist the answer.
 *
 * Only fires when ALL of:
 *   - A global config file exists
 *   - The repo is undecided (no recorded consent)
 *   - Not matched by appliesTo globs
 *   - process.stdin.isTTY && process.stdout.isTTY
 *   - CI env is not set
 *   - No per-run --user-config / --no-user-config flag is active
 */
export async function promptForConsentIfNeeded(
  rootDir: string,
  registryPath: string = REGISTRY_PATH,
): Promise<void> {
  // No-op if per-run override is active
  if (_userConfigOverride !== undefined) return;

  const globalPath = resolveUserConfigPath();
  if (!globalPath) return;

  const consentDecision = getUserConfigConsent(rootDir, registryPath);
  if (consentDecision !== undefined) return; // already decided

  // Check appliesTo globs (dynamic consent — no prompt needed)
  const parsed = loadUserConfigFile(globalPath);
  if (parsed?.appliesToGlobs.length) {
    const expanded = parsed.appliesToGlobs.map((g) =>
      g.startsWith('~') ? path.join(os.homedir(), g.slice(1)) : g,
    );
    const regexes = compileGlobs(expanded);
    const absRoot = path.resolve(rootDir);
    if (matchesAny(regexes, absRoot)) return; // covered by appliesTo
  }

  // Only prompt in fully interactive sessions
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (process.env.CI) return;

  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `\nA global codegraph config was found at ${globalPath}.\n` +
        `Apply settings not explicitly configured in this repo to ${path.resolve(rootDir)}? [y/N]\n` +
        `(remembered per-repo; change later with \`codegraph config --enable-global|--disable-global\`)\n` +
        `> `,
      (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      },
    );
  });

  const decided = answer === 'y' || answer === 'yes' ? 'enabled' : 'disabled';
  setUserConfigConsent(rootDir, decided, registryPath);
  process.stderr.write(`Global config consent recorded: ${decided}\n`);
}

// ── Main config loader ──────────────────────────────────────────────────

/** Options for loadConfig. */
export interface LoadConfigOpts {
  /** Per-run user-config override (from CLI flags or programmatic call). */
  userConfig?: string | boolean;
  /** Registry path override (mainly for tests). */
  registryPath?: string;
}

/**
 * Load project configuration from a .codegraphrc.json or similar file.
 * Returns merged config with defaults: defaults → global (if applied) → project → env → secrets.
 * Results are cached per cwd + applied global path.
 */
export function loadConfig(cwd?: string, opts?: LoadConfigOpts): CodegraphConfig {
  cwd = path.resolve(cwd || process.cwd());

  // Determine effective override: explicit opts win over module-level variable
  const override = opts?.userConfig !== undefined ? opts.userConfig : _userConfigOverride;

  // Resolve consent and global path
  const { applied, globalPath } = resolveConsent(cwd, override, opts?.registryPath);

  // Cache key includes applied global path and override flag so toggled consent is reflected
  const cacheKey = `${cwd}::${applied ? (globalPath ?? 'default') : 'none'}`;
  // Always update _lastAppliedGlobalPath/_lastAppliedGlobalConfig before returning —
  // on a cache hit the previous call may have been for a different repo or different
  // opts, so stale values here would misbehave for programmatic callers making
  // multiple buildGraph calls in the same process.
  _lastAppliedGlobalPath = applied ? globalPath : null;
  _lastAppliedGlobalConfig = null; // updated below if a global file is loaded
  const cached = _configCache.get(cacheKey);
  if (cached) {
    // Restore global config so loadConfigWithProvenance gets correct provenance on cache hits.
    _lastAppliedGlobalConfig = _globalConfigCache.get(cacheKey) ?? null;
    return structuredClone(cached);
  }

  // ── Layer 0: DEFAULTS ─────────────────────────────────────────────
  let merged = DEFAULTS as unknown as Record<string, unknown>;

  // ── Layer 1: global (if applied) ──────────────────────────────────
  if (applied && globalPath) {
    const userFileData = loadUserConfigFile(globalPath);
    if (userFileData) {
      debug(`Applying global user config from ${globalPath}`);
      const sanitized = sanitizeUserLayer(userFileData.globalConfig);
      // Cache the sanitized global data so pipeline.ts and loadConfigWithProvenance
      // can use it without a second disk read (eliminates TOCTOU window).
      _lastAppliedGlobalConfig = sanitized;
      merged = mergeConfig(merged, sanitized);
      merged = applyExcludeTestsShorthand(merged, sanitized);
    }
  }

  // ── Layer 2: project ──────────────────────────────────────────────
  for (const name of CONFIG_FILES) {
    const filePath = path.join(cwd, name);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const projectConfig = JSON.parse(raw) as Record<string, unknown>;
        debug(`Loaded project config from ${filePath}`);
        merged = mergeConfig(merged, projectConfig);
        merged = applyExcludeTestsShorthand(merged, projectConfig);
        break;
      } catch (err: unknown) {
        if (err instanceof ConfigError) throw err;
        debug(`Failed to parse config ${filePath}: ${toErrorMessage(err)}`);
      }
    }
  }

  // ── Layers 3–4: env overrides + secret resolution ─────────────────
  const result = resolveSecrets(applyEnvOverrides(merged as unknown as CodegraphConfig));
  _configCache.set(cacheKey, structuredClone(result));
  _globalConfigCache.set(cacheKey, _lastAppliedGlobalConfig);
  return result;
}

/**
 * Clear the config cache. Intended for long-running processes that need to
 * pick up on-disk config changes, and for test isolation when tests share
 * the same cwd.
 */
export function clearConfigCache(): void {
  _configCache.clear();
  _globalConfigCache.clear();
}

/**
 * Load config and return it together with per-key provenance information.
 * Used by `codegraph config --explain`.
 *
 * Calls loadConfig first so _lastAppliedGlobalConfig is populated, then uses
 * that cached data for the global-layer provenance — avoiding a second disk
 * read and eliminating the TOCTOU window between the two reads.
 */
export function loadConfigWithProvenance(
  cwd?: string,
  opts?: LoadConfigOpts,
): import('../types.js').ConfigWithProvenance {
  cwd = path.resolve(cwd || process.cwd());
  const override = opts?.userConfig !== undefined ? opts.userConfig : _userConfigOverride;
  const { applied, globalPath, consentDecision } = resolveConsent(
    cwd,
    override,
    opts?.registryPath,
  );

  // Load (or return from cache) the merged config first — this also populates
  // _lastAppliedGlobalConfig with the already-parsed and sanitized global layer.
  const config = loadConfig(cwd, opts);

  // Build provenance by tracking which layer supplies each top-level key
  const provenance: Record<string, ConfigSource> = {};

  // Layer 0: defaults — everything starts as 'default'
  for (const k of Object.keys(DEFAULTS)) provenance[k] = 'default';

  // Layer 1: global — reuse the data loadConfig already parsed (no second disk read)
  const globalRaw = applied && globalPath ? _lastAppliedGlobalConfig : null;
  if (globalRaw) {
    for (const k of Object.keys(globalRaw)) provenance[k] = 'user';
  }

  // Layer 2: project
  for (const name of CONFIG_FILES) {
    const filePath = path.join(cwd, name);
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        for (const k of Object.keys(raw)) provenance[k] = 'project';
        break;
      } catch (err) {
        debug(`loadConfigWithProvenance: failed to parse ${filePath}: ${toErrorMessage(err)}`);
      }
    }
  }

  // Layer 3+: env overrides (LLM keys)
  const ENV_LLM_KEYS = ['CODEGRAPH_LLM_PROVIDER', 'CODEGRAPH_LLM_API_KEY', 'CODEGRAPH_LLM_MODEL'];
  if (ENV_LLM_KEYS.some((k) => process.env[k] !== undefined)) {
    provenance.llm = 'env';
  }

  return { config, provenance, appliedGlobalPath: applied ? globalPath : null, consentDecision };
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
  // Engine selection: CODEGRAPH_ENGINE env always wins over config-file value.
  if (process.env.CODEGRAPH_ENGINE !== undefined) {
    const raw = process.env.CODEGRAPH_ENGINE;
    const valid = ['auto', 'native', 'wasm'] as const;
    if ((valid as readonly string[]).includes(raw)) {
      (config.build as Record<string, unknown>).engine = raw as 'auto' | 'native' | 'wasm';
    } else {
      warn(
        `CODEGRAPH_ENGINE="${raw}" is not a valid engine value (expected auto|native|wasm). Falling back to "auto".`,
      );
      (config.build as Record<string, unknown>).engine = 'auto';
    }
  }
  // Fast-skip diagnostic flag.
  if (process.env.CODEGRAPH_FAST_SKIP_DIAG !== undefined) {
    (config.build as Record<string, unknown>).fastSkipDiag =
      process.env.CODEGRAPH_FAST_SKIP_DIAG === '1';
  }
  return config;
}

export function resolveSecrets(config: CodegraphConfig): CodegraphConfig {
  const cmd = config.llm.apiKeyCommand;
  if (cmd == null) return config;
  if (typeof cmd !== 'string') {
    const actual = Array.isArray(cmd) ? 'array' : typeof cmd;
    throw new ConfigError(
      `llm.apiKeyCommand must be a string (received ${actual}). ` +
        'The command is split on whitespace and executed without a shell. ' +
        'Example: "apiKeyCommand": "op read op://vault/openai/api-key"',
    );
  }
  if (cmd.trim() === '') return config;

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
    warn(`apiKeyCommand failed: ${toErrorMessage(err)}`);
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
  } catch (e) {
    debug(`expandGlobDirs: failed to read ${baseDir}: ${toErrorMessage(e)}`);
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
  } catch (e) {
    debug(`readPackageName: failed for ${pkgDir}: ${toErrorMessage(e)}`);
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
    debug(`resolveWorkspaceEntry: package.json probe failed for ${pkgDir}: ${toErrorMessage(e)}`);
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
/** Read pnpm-workspace.yaml and return workspace glob patterns. */
function readPnpmWorkspacePatterns(rootDir: string): string[] {
  const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (!fs.existsSync(pnpmPath)) return [];
  try {
    const raw = fs.readFileSync(pnpmPath, 'utf-8');
    const packagesMatch = raw.match(/^packages:\s*\n((?:\s+-\s+.+\n?)*)/m);
    if (!packagesMatch) return [];
    const lines = packagesMatch[1]!.match(/^\s+-\s+['"]?([^'"#\n]+)['"]?\s*$/gm);
    if (!lines) return [];
    const patterns: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s+-\s+['"]?([^'"#\n]+?)['"]?\s*$/);
      if (m) patterns.push(m[1]!.trim());
    }
    return patterns;
  } catch (e) {
    debug(`detectWorkspaces: failed to parse pnpm-workspace.yaml: ${toErrorMessage(e)}`);
    return [];
  }
}

/** Read package.json workspaces field (npm/yarn) and return glob patterns. */
function readNpmWorkspacePatterns(rootDir: string): string[] {
  const rootPkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(rootPkgPath)) return [];
  try {
    const raw = fs.readFileSync(rootPkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws;
    if (ws && Array.isArray(ws.packages)) return ws.packages;
    return [];
  } catch (e) {
    debug(`detectWorkspaces: failed to parse package.json workspaces: ${toErrorMessage(e)}`);
    return [];
  }
}

/** Read lerna.json packages field and return glob patterns. */
function readLernaPatterns(rootDir: string): string[] {
  const lernaPath = path.join(rootDir, 'lerna.json');
  if (!fs.existsSync(lernaPath)) return [];
  try {
    const raw = fs.readFileSync(lernaPath, 'utf-8');
    const lerna = JSON.parse(raw);
    if (Array.isArray(lerna.packages)) return lerna.packages;
    return [];
  } catch (e) {
    debug(`detectWorkspaces: failed to parse lerna.json: ${toErrorMessage(e)}`);
    return [];
  }
}

/** Expand workspace patterns into concrete package entries. */
function expandWorkspacePatterns(patterns: string[], rootDir: string): Map<string, WorkspaceEntry> {
  const workspaces = new Map<string, WorkspaceEntry>();
  for (const pattern of patterns) {
    if (pattern.includes('*')) {
      for (const dir of expandWorkspaceGlob(pattern, rootDir)) {
        const name = readPackageName(dir);
        if (name) workspaces.set(name, { dir, entry: resolveWorkspaceEntry(dir) });
      }
    } else {
      const dir = path.resolve(rootDir, pattern);
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        const name = readPackageName(dir);
        if (name) workspaces.set(name, { dir, entry: resolveWorkspaceEntry(dir) });
      }
    }
  }
  return workspaces;
}

export function detectWorkspaces(rootDir: string): Map<string, WorkspaceEntry> {
  // Try each package manager in priority order — first match wins
  let patterns = readPnpmWorkspacePatterns(rootDir);
  if (patterns.length === 0) patterns = readNpmWorkspacePatterns(rootDir);
  if (patterns.length === 0) patterns = readLernaPatterns(rootDir);
  if (patterns.length === 0) return new Map();

  const workspaces = expandWorkspacePatterns(patterns, rootDir);

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
