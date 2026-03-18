import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { debug, warn } from './logger.js';

export const CONFIG_FILES = ['.codegraphrc.json', '.codegraphrc', 'codegraph.config.json'];

export const DEFAULTS = {
  include: [],
  exclude: [],
  ignoreDirs: [],
  extensions: [],
  aliases: {},
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
  embeddings: { model: 'nomic-v1.5', llmProvider: null },
  llm: { provider: null, model: null, baseUrl: null, apiKey: null, apiKeyCommand: null },
  search: { defaultMinScore: 0.2, rrfK: 60, topK: 15, similarityWarnThreshold: 0.85 },
  ci: { failOnCycles: false, impactThreshold: null },
  manifesto: {
    rules: {
      cognitive: { warn: 15 },
      cyclomatic: { warn: 10 },
      maxNesting: { warn: 4 },
      maintainabilityIndex: { warn: 20, fail: null },
      importCount: { warn: null, fail: null },
      exportCount: { warn: null, fail: null },
      lineCount: { warn: null, fail: null },
      fanIn: { warn: null, fail: null },
      fanOut: { warn: null, fail: null },
      noCycles: { warn: null, fail: null },
      boundaries: { warn: null, fail: null },
    },
    boundaries: null,
  },
  check: {
    cycles: true,
    blastRadius: null,
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
    },
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
    },
  },
};

/**
 * Load project configuration from a .codegraphrc.json or similar file.
 * Returns merged config with defaults.
 */
export function loadConfig(cwd) {
  cwd = cwd || process.cwd();
  for (const name of CONFIG_FILES) {
    const filePath = path.join(cwd, name);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const config = JSON.parse(raw);
        debug(`Loaded config from ${filePath}`);
        const merged = mergeConfig(DEFAULTS, config);
        if ('excludeTests' in config && !(config.query && 'excludeTests' in config.query)) {
          merged.query.excludeTests = Boolean(config.excludeTests);
        }
        delete merged.excludeTests;
        return resolveSecrets(applyEnvOverrides(merged));
      } catch (err) {
        debug(`Failed to parse config ${filePath}: ${err.message}`);
      }
    }
  }
  return resolveSecrets(applyEnvOverrides({ ...DEFAULTS }));
}

const ENV_LLM_MAP = {
  CODEGRAPH_LLM_PROVIDER: 'provider',
  CODEGRAPH_LLM_API_KEY: 'apiKey',
  CODEGRAPH_LLM_MODEL: 'model',
};

export function applyEnvOverrides(config) {
  for (const [envKey, field] of Object.entries(ENV_LLM_MAP)) {
    if (process.env[envKey] !== undefined) {
      config.llm[field] = process.env[envKey];
    }
  }
  return config;
}

export function resolveSecrets(config) {
  const cmd = config.llm.apiKeyCommand;
  if (typeof cmd !== 'string' || cmd.trim() === '') return config;

  const parts = cmd.trim().split(/\s+/);
  const [executable, ...args] = parts;
  try {
    const result = execFileSync(executable, args, {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (result) {
      config.llm.apiKey = result;
    }
  } catch (err) {
    warn(`apiKeyCommand failed: ${err.message}`);
  }
  return config;
}

export function mergeConfig(defaults, overrides) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      defaults[key] &&
      typeof defaults[key] === 'object' &&
      !Array.isArray(defaults[key])
    ) {
      result[key] = mergeConfig(defaults[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
