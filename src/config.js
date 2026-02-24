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
  },
  query: {
    defaultDepth: 3,
    defaultLimit: 20,
  },
  embeddings: { model: 'nomic-v1.5', llmProvider: null },
  llm: { provider: null, model: null, baseUrl: null, apiKey: null, apiKeyCommand: null },
  search: { defaultMinScore: 0.2, rrfK: 60, topK: 15 },
  ci: { failOnCycles: false, impactThreshold: null },
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
        return resolveSecrets(applyEnvOverrides(mergeConfig(DEFAULTS, config)));
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

function mergeConfig(defaults, overrides) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      defaults[key] &&
      typeof defaults[key] === 'object'
    ) {
      result[key] = { ...defaults[key], ...value };
    } else {
      result[key] = value;
    }
  }
  return result;
}
