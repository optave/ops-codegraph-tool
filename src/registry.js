import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { debug, warn } from './logger.js';

export const REGISTRY_PATH = path.join(os.homedir(), '.codegraph', 'registry.json');

/**
 * Load the registry from disk.
 * Returns `{ repos: {} }` on missing or corrupt file.
 */
export function loadRegistry(registryPath = REGISTRY_PATH) {
  try {
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data.repos !== 'object') return { repos: {} };
    return data;
  } catch {
    return { repos: {} };
  }
}

/**
 * Persist the registry to disk (atomic write via temp + rename).
 * Creates the parent directory if needed.
 */
export function saveRegistry(registry, registryPath = REGISTRY_PATH) {
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${registryPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf-8');
  fs.renameSync(tmp, registryPath);
}

/**
 * Register a project directory. Idempotent.
 * Name defaults to `path.basename(rootDir)`.
 */
export function registerRepo(rootDir, name, registryPath = REGISTRY_PATH) {
  const absRoot = path.resolve(rootDir);
  const repoName = name || path.basename(absRoot);
  const registry = loadRegistry(registryPath);

  registry.repos[repoName] = {
    path: absRoot,
    dbPath: path.join(absRoot, '.codegraph', 'graph.db'),
    addedAt: new Date().toISOString(),
  };

  saveRegistry(registry, registryPath);
  debug(`Registered repo "${repoName}" at ${absRoot}`);
  return { name: repoName, entry: registry.repos[repoName] };
}

/**
 * Remove a repo from the registry. Returns false if not found.
 */
export function unregisterRepo(name, registryPath = REGISTRY_PATH) {
  const registry = loadRegistry(registryPath);
  if (!registry.repos[name]) return false;
  delete registry.repos[name];
  saveRegistry(registry, registryPath);
  return true;
}

/**
 * List all registered repos, sorted by name.
 */
export function listRepos(registryPath = REGISTRY_PATH) {
  const registry = loadRegistry(registryPath);
  return Object.entries(registry.repos)
    .map(([name, entry]) => ({
      name,
      path: entry.path,
      dbPath: entry.dbPath,
      addedAt: entry.addedAt,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a repo name to its database path.
 * Returns undefined if the repo is not found or its DB file is missing.
 */
export function resolveRepoDbPath(name, registryPath = REGISTRY_PATH) {
  const registry = loadRegistry(registryPath);
  const entry = registry.repos[name];
  if (!entry) return undefined;
  if (!fs.existsSync(entry.dbPath)) {
    warn(`Registry: database missing for "${name}" at ${entry.dbPath}`);
    return undefined;
  }
  return entry.dbPath;
}
