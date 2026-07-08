/**
 * Regression tests for issue #1881: several read-only query functions
 * resolved `loadConfig()` from `process.cwd()` (or bare, which also defaults
 * to `process.cwd()`) instead of the rootDir derived from the resolved
 * `--db` path. This meant `--db /other/repo/.codegraph/graph.db` invoked
 * from a different directory read the *invoking* directory's
 * `.codegraphrc.json` instead of the target repo's.
 *
 * Covers the shared `resolveConfigForDbPath()` helper directly, plus every
 * call site named in the issue:
 *   - manifestoData (src/features/manifesto.ts)
 *   - hybridSearchData (src/domain/search/search/hybrid.ts)
 *   - moduleBoundariesData (src/features/structure-query.ts)
 *   - diffImpactData (src/domain/analysis/diff-impact.ts)
 *   - complexityData / resolveComplexityQueryOptions (src/features/complexity-query.ts)
 *   - auditData / resolveThresholds (src/features/audit.ts)
 *
 * Each call site test sets `process.cwd()` to an unrelated directory with no
 * (or a differently-configured) `.codegraphrc.json` and asserts the
 * configured `db.busyTimeoutMs` still reaches `PRAGMA busy_timeout`,
 * proving resolution came from the `--db` path, not cwd.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, initSchema, openDb, resolveConfigForDbPath } from '../../src/db/index.js';
import { diffImpactData } from '../../src/domain/analysis/diff-impact.js';
import { hybridSearchData } from '../../src/domain/search/search/hybrid.js';
import { auditData } from '../../src/features/audit.js';
import { complexityData } from '../../src/features/complexity-query.js';
import { manifestoData } from '../../src/features/manifesto.js';
import { moduleBoundariesData } from '../../src/features/structure-query.js';
import { DEFAULTS } from '../../src/infrastructure/config.js';

const REPO_BUSY_TIMEOUT_MS = 55555;

let repoDir: string;
let dbPath: string;
let unrelatedCwd: string;

/** Capture every `busy_timeout = N` pragma issued against a real Database instance. */
function captureBusyTimeoutPragmas(): { calls: string[]; restore: () => void } {
  const original = Database.prototype.pragma;
  const calls: string[] = [];
  const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: unknown,
    sql: string,
    ...rest: unknown[]
  ) {
    if (typeof sql === 'string' && sql.startsWith('busy_timeout')) calls.push(sql);
    return original.apply(this, [sql, ...rest] as Parameters<typeof original>);
  });
  return { calls, restore: () => spy.mockRestore() };
}

function insertNode(
  db: Database.Database,
  name: string,
  kind: string,
  file: string,
  line: number,
  endLine: number | null = null,
) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dbpath-repo-'));
  dbPath = path.join(repoDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);
  insertNode(db, 'myFunction', 'function', 'src/a.js', 1, 10);
  closeDb(db);
  fs.writeFileSync(
    path.join(repoDir, '.codegraphrc.json'),
    JSON.stringify({ db: { busyTimeoutMs: REPO_BUSY_TIMEOUT_MS } }),
  );

  // A separate directory with no .codegraphrc.json, used as process.cwd()
  // to prove config resolution ignores it in favor of the --db path.
  unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dbpath-unrelated-'));
});

afterAll(() => {
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  if (unrelatedCwd) fs.rmSync(unrelatedCwd, { recursive: true, force: true });
});

describe('resolveConfigForDbPath', () => {
  it('derives rootDir from a file-style --db path, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      const config = resolveConfigForDbPath(dbPath);
      expect(config.db?.busyTimeoutMs).toBe(REPO_BUSY_TIMEOUT_MS);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('derives rootDir from a directory-style --db path (normalises via findDbPath)', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    try {
      const config = resolveConfigForDbPath(repoDir);
      expect(config.db?.busyTimeoutMs).toBe(REPO_BUSY_TIMEOUT_MS);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('falls back to process.cwd() when no --db path is given', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repoDir);
    try {
      const config = resolveConfigForDbPath(undefined);
      expect(config.db?.busyTimeoutMs).toBe(REPO_BUSY_TIMEOUT_MS);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('falls back to DEFAULTS.db.busyTimeoutMs when no project config sets it', () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dbpath-bare-'));
    try {
      const bareDbPath = path.join(bareDir, '.codegraph', 'graph.db');
      const db = openDb(bareDbPath);
      initSchema(db);
      closeDb(db);
      expect(resolveConfigForDbPath(bareDbPath).db?.busyTimeoutMs).toBe(DEFAULTS.db.busyTimeoutMs);
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });
});

describe('configured project settings reach ad-hoc read-only query call sites via --db, not cwd', () => {
  it('manifestoData resolves config from the --db path', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    const capture = captureBusyTimeoutPragmas();
    try {
      manifestoData(dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${REPO_BUSY_TIMEOUT_MS}`);
  });

  it('hybridSearchData resolves config from the --db path', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    const capture = captureBusyTimeoutPragmas();
    try {
      await hybridSearchData('nonexistent-query', dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${REPO_BUSY_TIMEOUT_MS}`);
  });

  it('moduleBoundariesData resolves config from the --db path', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    const capture = captureBusyTimeoutPragmas();
    try {
      moduleBoundariesData(dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${REPO_BUSY_TIMEOUT_MS}`);
  });

  it('diffImpactData resolves config from the --db path (before the git-root check)', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    const capture = captureBusyTimeoutPragmas();
    try {
      diffImpactData(dbPath, {});
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${REPO_BUSY_TIMEOUT_MS}`);
  });

  it('complexityData resolves config from the --db path', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    const capture = captureBusyTimeoutPragmas();
    try {
      complexityData(dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${REPO_BUSY_TIMEOUT_MS}`);
  });

  it('auditData resolves config from the --db path', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(unrelatedCwd);
    const capture = captureBusyTimeoutPragmas();
    try {
      auditData('myFunction', dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${REPO_BUSY_TIMEOUT_MS}`);
  });
});
