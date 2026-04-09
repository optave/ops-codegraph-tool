import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const CACHE_PATH: string =
  process.env.CODEGRAPH_UPDATE_CACHE_PATH ||
  path.join(os.homedir(), '.codegraph', 'update-check.json');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;
const REGISTRY_URL = 'https://registry.npmjs.org/@optave/codegraph/latest';

interface UpdateCache {
  lastCheckedAt: number;
  latestVersion: string;
}

/**
 * Minimal semver comparison. Returns -1, 0, or 1.
 * Strips pre-release suffixes (e.g. "3.9.3-dev.6" → "3.9.3") before comparing.
 */
export function semverCompare(a: string, b: string): -1 | 0 | 1 {
  const pa = a.replace(/-.*$/, '').split('.').map(Number);
  const pb = b.replace(/-.*$/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Load the cached update-check result from disk.
 * Returns null on missing or corrupt file.
 */
function loadCache(cachePath: string = CACHE_PATH): UpdateCache | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data.lastCheckedAt !== 'number' || typeof data.latestVersion !== 'string') {
      return null;
    }
    return data as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Persist the cache to disk (atomic write via temp + rename).
 */
function saveCache(cache: UpdateCache, cachePath: string = CACHE_PATH): void {
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${cachePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache), 'utf-8');
  fs.renameSync(tmp, cachePath);
}

/**
 * Fetch the latest version string from the npm registry.
 * Returns the version string or null on failure.
 */
function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      REGISTRY_URL,
      { timeout: FETCH_TIMEOUT_MS, headers: { Accept: 'application/json' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(typeof data.version === 'string' ? data.version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

interface UpdateResult {
  current: string;
  latest: string;
}

interface CheckForUpdatesOptions {
  cachePath?: string;
  _fetchLatest?: () => Promise<string | null>;
}

/**
 * Check whether a newer version of codegraph is available.
 *
 * Returns `{ current, latest }` if an update is available, `null` otherwise.
 * Silently returns null on any error — never affects CLI operation.
 */
export async function checkForUpdates(
  currentVersion: string,
  options: CheckForUpdatesOptions = {},
): Promise<UpdateResult | null> {
  // Suppress in non-interactive / CI contexts
  if (process.env.CI) return null;
  if (process.env.NO_UPDATE_CHECK) return null;
  if (!process.stderr.isTTY) return null;
  if (currentVersion.includes('-')) return null;

  const cachePath = options.cachePath || CACHE_PATH;
  const fetchFn = options._fetchLatest || fetchLatestVersion;

  try {
    const cache = loadCache(cachePath);

    // Cache is fresh — use it
    if (cache && Date.now() - cache.lastCheckedAt < CACHE_TTL_MS) {
      if (semverCompare(currentVersion, cache.latestVersion) < 0) {
        return { current: currentVersion, latest: cache.latestVersion };
      }
      return null;
    }

    // Cache is stale or missing — fetch
    const latest = await fetchFn();
    if (!latest) return null;

    // Update cache regardless of result
    saveCache({ lastCheckedAt: Date.now(), latestVersion: latest }, cachePath);

    if (semverCompare(currentVersion, latest) < 0) {
      return { current: currentVersion, latest };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Print a visible update notification box to stderr.
 */
export function printUpdateNotification(current: string, latest: string): void {
  const msg1 = `Update available: ${current} → ${latest}`;
  const msg2 = 'Run `npm i -g @optave/codegraph` to update';
  const width = Math.max(msg1.length, msg2.length) + 4;

  const top = `┌${'─'.repeat(width)}┐`;
  const bot = `└${'─'.repeat(width)}┘`;
  const pad1 = ' '.repeat(width - msg1.length - 2);
  const pad2 = ' '.repeat(width - msg2.length - 2);
  const line1 = `│  ${msg1}${pad1}│`;
  const line2 = `│  ${msg2}${pad2}│`;

  process.stderr.write(`\n${top}\n${line1}\n${line2}\n${bot}\n\n`);
}
