/**
 * Integration tests for community detection (Louvain).
 *
 * Uses InMemoryRepository via createTestRepo() for fast, SQLite-free testing.
 *
 * Graph topology:
 *   src/auth/login.js  + src/auth/session.js   → tight auth cluster
 *   src/data/db.js     + src/data/cache.js      → tight data cluster
 *   src/api/handler.js → imports from both clusters (bridge)
 *   lib/format.js      → depends on data modules (drift signal)
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { communitiesData, communitySummaryForStats } from '../../src/features/communities.js';
import { createTestRepo } from '../helpers/fixtures.js';

// ─── Fixture ──────────────────────────────────────────────────────────

let repo;

beforeAll(() => {
  ({ repo } = createTestRepo()
    // ── File nodes (multi-directory) ──
    .file('src/auth/login.js')
    .file('src/auth/session.js')
    .file('src/data/db.js')
    .file('src/data/cache.js')
    .file('src/api/handler.js')
    .file('lib/format.js')
    .file('tests/auth.test.js')
    // ── Function nodes ──
    .fn('login', 'src/auth/login.js', 5)
    .fn('createSession', 'src/auth/session.js', 5)
    .fn('validateSession', 'src/auth/session.js', 20)
    .fn('query', 'src/data/db.js', 5)
    .fn('getCache', 'src/data/cache.js', 5)
    .fn('setCache', 'src/data/cache.js', 15)
    .fn('handleRequest', 'src/api/handler.js', 5)
    .fn('formatOutput', 'lib/format.js', 5)
    .fn('testLogin', 'tests/auth.test.js', 5)
    // ── File-level import edges ──
    // Auth cluster: login <-> session
    .imports('src/auth/login.js', 'src/auth/session.js')
    .imports('src/auth/session.js', 'src/auth/login.js')
    // Data cluster: db <-> cache
    .imports('src/data/db.js', 'src/data/cache.js')
    .imports('src/data/cache.js', 'src/data/db.js')
    // Bridge: api/handler imports from both clusters
    .imports('src/api/handler.js', 'src/auth/login.js')
    .imports('src/api/handler.js', 'src/data/db.js')
    // Drift signal: lib/format depends on data modules
    .imports('lib/format.js', 'src/data/db.js')
    .imports('lib/format.js', 'src/data/cache.js')
    // Test file imports
    .imports('tests/auth.test.js', 'src/auth/login.js')
    // ── Function-level call edges ──
    // Auth cluster calls
    .calls('login', 'createSession')
    .calls('login', 'validateSession')
    .calls('createSession', 'validateSession')
    // Data cluster calls
    .calls('query', 'getCache')
    .calls('query', 'setCache')
    .calls('getCache', 'setCache')
    // Bridge: handleRequest calls across clusters
    .calls('handleRequest', 'login')
    .calls('handleRequest', 'query')
    .calls('handleRequest', 'formatOutput')
    // lib/format calls data
    .calls('formatOutput', 'getCache')
    // Test calls
    .calls('testLogin', 'login')
    .build());
});

// ─── File-Level Tests ──────────────────────────────────────────────────

describe('communitiesData (file-level)', () => {
  test('returns valid community structure', () => {
    const data = communitiesData(null, { repo });
    expect(data.communities).toBeInstanceOf(Array);
    expect(data.communities.length).toBeGreaterThan(0);
    for (const c of data.communities) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('size');
      expect(c.size).toBeGreaterThan(0);
      expect(c).toHaveProperty('members');
      expect(c.members.length).toBe(c.size);
      expect(c).toHaveProperty('directories');
    }
  });

  test('detects 2+ communities from distinct clusters', () => {
    const data = communitiesData(null, { repo });
    expect(data.summary.communityCount).toBeGreaterThanOrEqual(2);
  });

  test('modularity is in valid range', () => {
    const data = communitiesData(null, { repo });
    // Leiden starts from singleton partition and only makes improving moves.
    // Quality should always be non-negative on a real graph.
    expect(data.modularity).toBeGreaterThanOrEqual(0);
    expect(data.modularity).toBeLessThanOrEqual(1);
  });

  test('drift analysis finds split candidates', () => {
    const data = communitiesData(null, { repo });
    // At minimum, lib/format.js groups with data but lives in a different dir
    expect(data.drift).toHaveProperty('splitCandidates');
    expect(data.drift.splitCandidates).toBeInstanceOf(Array);
  });

  test('drift analysis finds merge candidates', () => {
    const data = communitiesData(null, { repo });
    expect(data.drift).toHaveProperty('mergeCandidates');
    expect(data.drift.mergeCandidates).toBeInstanceOf(Array);
  });

  test('drift score is 0-100', () => {
    const data = communitiesData(null, { repo });
    expect(data.summary.driftScore).toBeGreaterThanOrEqual(0);
    expect(data.summary.driftScore).toBeLessThanOrEqual(100);
  });

  test('noTests excludes test files', () => {
    const withTests = communitiesData(null, { repo });
    const withoutTests = communitiesData(null, { repo, noTests: true });

    const allMembers = withTests.communities.flatMap((c) => c.members.map((m) => m.file));
    const filteredMembers = withoutTests.communities.flatMap((c) => c.members.map((m) => m.file));

    expect(allMembers.some((f) => f.includes('.test.'))).toBe(true);
    expect(filteredMembers.some((f) => f.includes('.test.'))).toBe(false);
  });

  test('higher resolution produces >= same number of communities', () => {
    const low = communitiesData(null, { repo, resolution: 0.5 });
    const high = communitiesData(null, { repo, resolution: 2.0 });
    expect(high.summary.communityCount).toBeGreaterThanOrEqual(low.summary.communityCount);
  });
});

// ─── Function-Level Tests ──────────────────────────────────────────────

describe('communitiesData (function-level)', () => {
  test('returns function-level results with kind field', () => {
    const data = communitiesData(null, { repo, functions: true });
    expect(data.communities.length).toBeGreaterThan(0);
    for (const c of data.communities) {
      for (const m of c.members) {
        expect(m).toHaveProperty('kind');
        expect(['function', 'method', 'class']).toContain(m.kind);
      }
    }
  });

  test('function-level detects 2+ communities', () => {
    const data = communitiesData(null, { repo, functions: true });
    expect(data.summary.communityCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── Drift-Only Mode ──────────────────────────────────────────────────

describe('drift-only mode', () => {
  test('drift: true returns empty communities array', () => {
    const data = communitiesData(null, { repo, drift: true });
    expect(data.communities).toEqual([]);
    expect(data.drift.splitCandidates).toBeInstanceOf(Array);
    expect(data.drift.mergeCandidates).toBeInstanceOf(Array);
    expect(data.summary.communityCount).toBeGreaterThan(0);
  });
});

// ─── Stats Integration ────────────────────────────────────────────────

describe('communitySummaryForStats', () => {
  test('returns lightweight summary with expected fields', () => {
    const summary = communitySummaryForStats(null, { repo });
    expect(summary).toHaveProperty('communityCount');
    expect(summary).toHaveProperty('modularity');
    expect(summary).toHaveProperty('driftScore');
    expect(summary).toHaveProperty('nodeCount');
    expect(typeof summary.communityCount).toBe('number');
    expect(typeof summary.modularity).toBe('number');
    expect(typeof summary.driftScore).toBe('number');
  });
});

// ─── Empty Graph ──────────────────────────────────────────────────────

describe('empty graph', () => {
  test('empty graph returns zero communities', () => {
    const { repo: emptyRepo } = createTestRepo().build();
    const data = communitiesData(null, { repo: emptyRepo });
    expect(data.communities).toEqual([]);
    expect(data.summary.communityCount).toBe(0);
    expect(data.summary.modularity).toBe(0);
    expect(data.summary.driftScore).toBe(0);
  });
});
