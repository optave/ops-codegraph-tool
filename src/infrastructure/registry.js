import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { debug, warn } from './logger.js';

export const REGISTRY_PATH =
  process.env.CODEGRAPH_REGISTRY_PATH || path.join(os.homedir(), '.codegraph', 'registry.json');

/** Default TTL: entries not accessed within 30 days are pruned. */
export const DEFAULT_TTL_DAYS = 30;

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
 *
 * When no explicit name is provided and the basename already exists
 * pointing to a different path, auto-suffixes (`api` → `api-2`, `api-3`, …).
 * Re-registering the same path updates in place. Explicit names always overwrite.
 */
export function registerRepo(rootDir, name, registryPath = REGISTRY_PATH) {
  const absRoot = path.resolve(rootDir);
  const baseName = name || path.basename(absRoot);
  const registry = loadRegistry(registryPath);

  let repoName = baseName;

  // Auto-suffix only when no explicit name was provided
  if (!name) {
    const existing = registry.repos[baseName];
    if (existing && path.resolve(existing.path) !== absRoot) {
      // Basename collision with a different path — find next available suffix
      let suffix = 2;
      while (registry.repos[`${baseName}-${suffix}`]) {
        const entry = registry.repos[`${baseName}-${suffix}`];
        if (path.resolve(entry.path) === absRoot) {
          // Already registered under this suffixed name — update in place
          repoName = `${baseName}-${suffix}`;
          break;
        }
        suffix++;
      }
      if (repoName === baseName) {
        repoName = `${baseName}-${suffix}`;
      }
    }
  }

  const now = new Date().toISOString();
  registry.repos[repoName] = {
    path: absRoot,
    dbPath: path.join(absRoot, '.codegraph', 'graph.db'),
    addedAt: registry.repos[repoName]?.addedAt || now,
    lastAccessedAt: now,
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
      lastAccessedAt: entry.lastAccessedAt || entry.addedAt,
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
  // Touch lastAccessedAt on successful resolution
  entry.lastAccessedAt = new Date().toISOString();
  saveRegistry(registry, registryPath);
  return entry.dbPath;
}

/**
 * Remove registry entries whose repo directory no longer exists on disk,
 * or that haven't been accessed within `ttlDays` days.
 * Returns an array of `{ name, path, reason }` for each pruned entry.
 *
 * When `dryRun` is true, entries are identified but not removed from disk.
 */
export function pruneRegistry(
  registryPath = REGISTRY_PATH,
  ttlDays = DEFAULT_TTL_DAYS,
  excludeNames = [],
  dryRun = false,
) {
  const registry = loadRegistry(registryPath);
  const pruned = [];
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const excludeSet = new Set(
    excludeNames.filter((n) => typeof n === 'string' && n.trim().length > 0),
  );

  for (const [name, entry] of Object.entries(registry.repos)) {
    if (excludeSet.has(name)) continue;
    if (!fs.existsSync(entry.path)) {
      pruned.push({ name, path: entry.path, reason: 'missing' });
      if (!dryRun) delete registry.repos[name];
      continue;
    }
    const lastAccess = Date.parse(entry.lastAccessedAt || entry.addedAt);
    if (lastAccess < cutoff) {
      pruned.push({ name, path: entry.path, reason: 'expired' });
      if (!dryRun) delete registry.repos[name];
    }
  }

  if (!dryRun && pruned.length > 0) {
    saveRegistry(registry, registryPath);
  }

  return pruned;
}
