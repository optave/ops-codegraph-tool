/**
 * Integration tests for sequence diagram generation.
 *
 * Main tests use InMemoryRepository via createTestRepo() for fast, SQLite-free testing.
 * Dataflow annotation tests still use SQLite (InMemoryRepository has no dataflow table).
 *
 * Graph topology:
 *   buildGraph() → parseFiles()       [src/builder.js → src/parser.js]
 *                → resolveImports()   [src/builder.js → src/resolve.js]
 *   parseFiles() → extractSymbols()   [src/parser.js  → src/parser.js, same-file]
 *   extractSymbols()                  [leaf]
 *   resolveImports()                  [leaf]
 *
 * For alias collision test:
 *   helperA()  in  src/utils/helper.js
 *   helperB()  in  lib/utils/helper.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { sequenceData, sequenceToMermaid } from '../../src/features/sequence.js';
import { createTestRepo } from '../helpers/fixtures.js';

// ─── Helpers (for dataflow SQLite tests only) ─────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

// ─── InMemory Fixture ─────────────────────────────────────────────────

let repo: any;

beforeAll(() => {
  ({ repo } = createTestRepo()
    // Core nodes
    .fn('buildGraph', 'src/builder.js', 10)
    .fn('parseFiles', 'src/parser.js', 5)
    .fn('extractSymbols', 'src/parser.js', 20)
    .fn('resolveImports', 'src/resolve.js', 1)
    // Alias collision nodes (two different helper.js files)
    .fn('helperA', 'src/utils/helper.js', 1)
    .fn('helperB', 'lib/utils/helper.js', 1)
    // Test file node (for noTests filtering)
    .fn('testBuild', 'tests/builder.test.js', 1)
    // Call edges
    .calls('buildGraph', 'parseFiles')
    .calls('buildGraph', 'resolveImports')
    .calls('parseFiles', 'extractSymbols')
    .calls('buildGraph', 'helperA')
    .calls('helperA', 'helperB')
    .calls('buildGraph', 'testBuild')
    .build());
});

// ─── sequenceData ──────────────────────────────────────────────────────

describe('sequenceData', () => {
  test('basic sequence — correct participants and messages in BFS order', () => {
    const data = sequenceData('buildGraph', null, { repo, noTests: true });
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('buildGraph');

    // Should have 5 files as participants (builder, parser, resolve, src/utils/helper, lib/utils/helper)
    // (test file excluded by noTests)
    expect(data.participants.length).toBe(5);

    // Messages should be in BFS depth order
    expect(data.messages.length).toBeGreaterThanOrEqual(4);
    const depths = data.messages.map((m) => m.depth);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeGreaterThanOrEqual(depths[i - 1]);
    }
  });

  test('self-call — same-file call appears as self-message', () => {
    const data = sequenceData('parseFiles', null, { repo, noTests: true });
    expect(data.entry).not.toBeNull();

    // parseFiles → extractSymbols are both in src/parser.js
    const selfMessages = data.messages.filter((m) => m.from === m.to);
    expect(selfMessages.length).toBe(1);
    expect(selfMessages[0].label).toBe('extractSymbols');
  });

  test('depth limiting — depth:1 truncates', () => {
    const data = sequenceData('buildGraph', null, { repo, depth: 1, noTests: true });
    expect(data.truncated).toBe(true);
    expect(data.depth).toBe(1);

    // At depth 1, only direct callees of buildGraph
    const msgDepths = data.messages.map((m) => m.depth);
    expect(Math.max(...msgDepths)).toBe(1);
  });

  test('unknown name — entry is null', () => {
    const data = sequenceData('nonExistentFunction', null, { repo });
    expect(data.entry).toBeNull();
    expect(data.participants).toHaveLength(0);
    expect(data.messages).toHaveLength(0);
  });

  test('leaf entry — entry exists, zero messages', () => {
    const data = sequenceData('extractSymbols', null, { repo });
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('extractSymbols');
    expect(data.messages).toHaveLength(0);
    // Only the entry file as participant
    expect(data.participants).toHaveLength(1);
  });

  test('participant alias collision — two helper.js files get distinct IDs', () => {
    const data = sequenceData('buildGraph', null, { repo, noTests: true });
    const helperParticipants = data.participants.filter((p) => p.label === 'helper.js');
    expect(helperParticipants.length).toBe(2);

    // IDs should be distinct
    const ids = helperParticipants.map((p) => p.id);
    expect(ids[0]).not.toBe(ids[1]);

    // IDs must be valid Mermaid participant identifiers (no slashes, etc.)
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  test('noTests filtering — test file nodes excluded', () => {
    const withTests = sequenceData('buildGraph', null, { repo, noTests: false });
    const withoutTests = sequenceData('buildGraph', null, { repo, noTests: true });

    // With tests should have more messages (includes testBuild)
    expect(withTests.totalMessages).toBeGreaterThan(withoutTests.totalMessages);

    // testBuild should not appear when filtering
    const testMsgs = withoutTests.messages.filter((m) => m.label === 'testBuild');
    expect(testMsgs).toHaveLength(0);
  });
});

// ─── sequenceToMermaid ──────────────────────────────────────────────────

describe('sequenceToMermaid', () => {
  test('starts with sequenceDiagram and has participant lines', () => {
    const data = sequenceData('buildGraph', null, { repo, noTests: true });
    const mermaid = sequenceToMermaid(data);

    expect(mermaid).toMatch(/^sequenceDiagram/);
    expect(mermaid).toContain('participant');
  });

  test('has ->> arrows for calls', () => {
    const data = sequenceData('buildGraph', null, { repo, noTests: true });
    const mermaid = sequenceToMermaid(data);
    expect(mermaid).toContain('->>');
  });

  test('truncation note when truncated', () => {
    const data = sequenceData('buildGraph', null, { repo, depth: 1, noTests: true });
    const mermaid = sequenceToMermaid(data);
    expect(mermaid).toContain('Truncated at depth');
  });

  test('no truncation note when participants empty (offset past all messages)', () => {
    const mockData = {
      participants: [],
      messages: [],
      truncated: true,
      depth: 5,
    };
    const mermaid = sequenceToMermaid(mockData);
    expect(mermaid).not.toContain('note right of');
    expect(mermaid).not.toContain('undefined');
  });

  test('escapes colons in labels', () => {
    const mockData = {
      participants: [{ id: 'a', label: 'a.js' }],
      messages: [{ from: 'a', to: 'a', label: 'route:GET /users', type: 'call' }],
      truncated: false,
    };
    const mermaid = sequenceToMermaid(mockData);
    expect(mermaid).toContain('#colon;');
    expect(mermaid).not.toContain('route:');
  });
});

// ─── Dataflow annotations (SQLite — requires dataflow table) ──────────

describe('dataflow annotations', () => {
  let dfTmpDir: string, dfDbPath: string;

  beforeAll(() => {
    dfTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-seq-df-'));
    fs.mkdirSync(path.join(dfTmpDir, '.codegraph'));
    dfDbPath = path.join(dfTmpDir, '.codegraph', 'graph.db');

    const db = new Database(dfDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // caller → callee (cross-file)
    const caller = insertNode(db, 'handleRequest', 'function', 'src/handler.js', 1);
    const callee = insertNode(db, 'fetchData', 'function', 'src/service.js', 10);
    insertEdge(db, caller, callee, 'calls');

    // dataflow: fetchData returns 'Promise<User[]>' and receives param 'userId'
    db.prepare(
      'INSERT INTO dataflow (source_id, target_id, kind, param_index, expression) VALUES (?, ?, ?, ?, ?)',
    ).run(callee, caller, 'returns', null, 'Promise<User[]>');
    db.prepare(
      'INSERT INTO dataflow (source_id, target_id, kind, param_index, expression) VALUES (?, ?, ?, ?, ?)',
    ).run(caller, callee, 'flows_to', 0, 'userId');

    db.close();
  });

  afterAll(() => {
    if (dfTmpDir) fs.rmSync(dfTmpDir, { recursive: true, force: true });
  });

  test('return arrows appear with dataflow enabled', () => {
    const data = sequenceData('handleRequest', dfDbPath, { noTests: true, dataflow: true });
    expect(data.entry).not.toBeNull();

    const returnMsgs = data.messages.filter((m) => m.type === 'return');
    expect(returnMsgs.length).toBe(1);
    expect(returnMsgs[0].label).toBe('Promise<User[]>');
    // Return goes from callee file back to caller file
    expect(returnMsgs[0].from).not.toBe(returnMsgs[0].to);
  });

  test('call labels annotated with parameter names', () => {
    const data = sequenceData('handleRequest', dfDbPath, { noTests: true, dataflow: true });

    const callMsgs = data.messages.filter((m) => m.type === 'call');
    expect(callMsgs.length).toBe(1);
    expect(callMsgs[0].label).toBe('fetchData(userId)');
  });

  test('without dataflow flag, no return arrows or param annotations', () => {
    const data = sequenceData('handleRequest', dfDbPath, { noTests: true, dataflow: false });

    const returnMsgs = data.messages.filter((m) => m.type === 'return');
    expect(returnMsgs).toHaveLength(0);

    const callMsgs = data.messages.filter((m) => m.type === 'call');
    expect(callMsgs[0].label).toBe('fetchData');
  });

  test('mermaid output has dashed return arrow', () => {
    const data = sequenceData('handleRequest', dfDbPath, { noTests: true, dataflow: true });
    const mermaid = sequenceToMermaid(data);
    expect(mermaid).toContain('-->>');
  });
});
