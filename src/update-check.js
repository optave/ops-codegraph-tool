import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const CACHE_PATH =
  process.env.CODEGRAPH_UPDATE_CACHE_PATH ||
  path.join(os.homedir(), '.codegraph', 'update-check.json');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 3000;
const REGISTRY_URL = 'https://registry.npmjs.org/@optave/codegraph/latest';

/**
 * Minimal semver comparison. Returns -1, 0, or 1.
 * Only handles numeric x.y.z (no pre-release tags).
 */
export function semverCompare(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
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
function loadCache(cachePath = CACHE_PATH) {
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data.lastCheckedAt !== 'number' || typeof data.latestVersion !== 'string') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Persist the cache to disk (atomic write via temp + rename).
 */
function saveCache(cache, cachePath = CACHE_PATH) {
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
function fetchLatestVersion() {
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
        res.on('data', (chunk) => {
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

/**
 * Check whether a newer version of codegraph is available.
 *
 * Returns `{ current, latest }` if an update is available, `null` otherwise.
 * Silently returns null on any error — never affects CLI operation.
 *
 * Options:
 *   cachePath — override cache file location (for testing)
 *   _fetchLatest — override the fetch function (for testing)
 */
export async function checkForUpdates(currentVersion, options = {}) {
  // Suppress in non-interactive / CI contexts
  if (process.env.CI) return null;
  if (process.env.NO_UPDATE_CHECK) return null;
  if (!process.stderr.isTTY) return null;

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
export function printUpdateNotification(current, latest) {
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
