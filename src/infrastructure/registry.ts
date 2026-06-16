import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConsentDecision } from '../types.js';
import { debug, warn } from './logger.js';

export const REGISTRY_PATH: string =
  process.env.CODEGRAPH_REGISTRY_PATH || path.join(os.homedir(), '.codegraph', 'registry.json');

/** Default TTL: entries not accessed within 30 days are pruned. */
export const DEFAULT_TTL_DAYS = 30;

interface RegistryEntry {
  path: string;
  dbPath: string;
  addedAt: string;
  lastAccessedAt?: string;
}

interface UserConfigSection {
  /** Per-repo consent decisions keyed by absolute repo path. */
  consent: Record<string, ConsentDecision>;
}

interface Registry {
  repos: Record<string, RegistryEntry>;
  /** User-level global config consent store — separate from MCP repo listings. */
  userConfig?: UserConfigSection;
}

/**
 * Load the registry from disk.
 * Returns `{ repos: {} }` on missing or corrupt file.
 */
export function loadRegistry(registryPath: string = REGISTRY_PATH): Registry {
  try {
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data.repos !== 'object') return { repos: {} };
    return data as Registry;
  } catch {
    return { repos: {} };
  }
}

/**
 * Persist the registry to disk (atomic write via temp + rename).
 * Creates the parent directory if needed.
 */
export function saveRegistry(registry: Registry, registryPath: string = REGISTRY_PATH): void {
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

/** Find a unique suffixed name when the base name collides with a different path. */
function findAvailableName(
  baseName: string,
  absRoot: string,
  repos: Record<string, RegistryEntry>,
): string {
  let suffix = 2;
  while (repos[`${baseName}-${suffix}`]) {
    const entry = repos[`${baseName}-${suffix}`]!;
    if (path.resolve(entry.path) === absRoot) return `${baseName}-${suffix}`;
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

export function registerRepo(
  rootDir: string,
  name?: string,
  registryPath: string = REGISTRY_PATH,
): { name: string; entry: RegistryEntry } {
  const absRoot = path.resolve(rootDir);
  const baseName = name || path.basename(absRoot);
  const registry = loadRegistry(registryPath);

  let repoName = baseName;

  // Auto-suffix only when no explicit name was provided
  if (!name) {
    const existing = registry.repos[baseName];
    if (existing && path.resolve(existing.path) !== absRoot) {
      repoName = findAvailableName(baseName, absRoot, registry.repos);
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
  return { name: repoName, entry: registry.repos[repoName]! };
}

/**
 * Remove a repo from the registry. Returns false if not found.
 */
export function unregisterRepo(name: string, registryPath: string = REGISTRY_PATH): boolean {
  const registry = loadRegistry(registryPath);
  if (!registry.repos[name]) return false;
  delete registry.repos[name];
  saveRegistry(registry, registryPath);
  return true;
}

export interface RepoListEntry {
  name: string;
  path: string;
  dbPath: string;
  addedAt: string;
  lastAccessedAt: string;
}

/**
 * List all registered repos, sorted by name.
 */
export function listRepos(registryPath: string = REGISTRY_PATH): RepoListEntry[] {
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
export function resolveRepoDbPath(
  name: string,
  registryPath: string = REGISTRY_PATH,
): string | undefined {
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

// ── User-config consent ────────────────────────────────────────────────

/**
 * Read the per-repo consent decision for the global user config.
 * Returns `undefined` when the repo is undecided (no recorded decision).
 */
export function getUserConfigConsent(
  rootDir: string,
  registryPath: string = REGISTRY_PATH,
): ConsentDecision | undefined {
  const registry = loadRegistry(registryPath);
  const absRoot = path.resolve(rootDir);
  return registry.userConfig?.consent?.[absRoot];
}

/**
 * Persist a per-repo consent decision. Atomic write via temp+rename.
 */
export function setUserConfigConsent(
  rootDir: string,
  decision: ConsentDecision,
  registryPath: string = REGISTRY_PATH,
): void {
  const registry = loadRegistry(registryPath);
  const absRoot = path.resolve(rootDir);
  if (!registry.userConfig) registry.userConfig = { consent: {} };
  if (!registry.userConfig.consent) registry.userConfig.consent = {};
  registry.userConfig.consent[absRoot] = decision;
  saveRegistry(registry, registryPath);
  debug(`User-config consent for "${absRoot}" set to "${decision}"`);
}

/**
 * List every repo with a recorded consent decision, sorted by path.
 */
export function listUserConfigConsent(
  registryPath: string = REGISTRY_PATH,
): Array<{ path: string; decision: ConsentDecision }> {
  const registry = loadRegistry(registryPath);
  const consent = registry.userConfig?.consent ?? {};
  return Object.entries(consent)
    .map(([p, decision]) => ({ path: p, decision }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Revert a repo to undecided state. Returns true if a decision was removed.
 */
export function clearUserConfigConsent(
  rootDir: string,
  registryPath: string = REGISTRY_PATH,
): boolean {
  const registry = loadRegistry(registryPath);
  const absRoot = path.resolve(rootDir);
  const consent = registry.userConfig?.consent;
  if (!consent || !(absRoot in consent)) return false;
  delete consent[absRoot];
  saveRegistry(registry, registryPath);
  return true;
}

interface PrunedEntry {
  name: string;
  path: string;
  reason: 'missing' | 'expired';
}

/**
 * Remove registry entries whose repo directory no longer exists on disk,
 * or that haven't been accessed within `ttlDays` days.
 * Returns an array of `{ name, path, reason }` for each pruned entry.
 *
 * When `dryRun` is true, entries are identified but not removed from disk.
 */
export function pruneRegistry(
  registryPath: string = REGISTRY_PATH,
  ttlDays: number = DEFAULT_TTL_DAYS,
  excludeNames: string[] = [],
  dryRun = false,
): PrunedEntry[] {
  const registry = loadRegistry(registryPath);
  const pruned: PrunedEntry[] = [];
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

  // Prune consent entries whose repo paths no longer exist on disk.
  // Consent entries are TTL-exempt — only the missing-path rule applies.
  let consentChanged = false;
  if (!dryRun && registry.userConfig?.consent) {
    for (const p of Object.keys(registry.userConfig.consent)) {
      if (!fs.existsSync(p)) {
        delete registry.userConfig.consent[p];
        consentChanged = true;
      }
    }
  }

  if (!dryRun && (pruned.length > 0 || consentChanged)) {
    saveRegistry(registry, registryPath);
  }

  return pruned;
}
