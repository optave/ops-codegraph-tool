/**
 * Unit tests for src/change-journal.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendChangeEvents,
  buildChangeEvent,
  CHANGE_EVENTS_FILENAME,
  changeEventsPath,
  DEFAULT_MAX_BYTES,
  diffSymbols,
  rotateIfNeeded,
} from '../../src/change-journal.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-change-journal-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(tmpDir, 'root-'));
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  return root;
}

function eventsPath(root) {
  return path.join(root, '.codegraph', CHANGE_EVENTS_FILENAME);
}

function readLines(filePath) {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0);
}

function parseLines(filePath) {
  return readLines(filePath).map((l) => JSON.parse(l));
}

describe('diffSymbols', () => {
  it('returns empty arrays for empty inputs', () => {
    const result = diffSymbols([], []);
    expect(result).toEqual({ added: [], removed: [], modified: [] });
  });

  it('detects added symbols', () => {
    const result = diffSymbols([], [{ name: 'foo', kind: 'function', line: 1 }]);
    expect(result.added).toEqual([{ name: 'foo', kind: 'function', line: 1 }]);
    expect(result.removed).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('detects removed symbols', () => {
    const result = diffSymbols([{ name: 'foo', kind: 'function', line: 1 }], []);
    expect(result.removed).toEqual([{ name: 'foo', kind: 'function' }]);
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('detects modified symbols (line changed)', () => {
    const result = diffSymbols(
      [{ name: 'foo', kind: 'function', line: 1 }],
      [{ name: 'foo', kind: 'function', line: 10 }],
    );
    expect(result.modified).toEqual([{ name: 'foo', kind: 'function', line: 10 }]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('treats same name with different kind as separate symbols', () => {
    const result = diffSymbols(
      [{ name: 'Foo', kind: 'class', line: 1 }],
      [{ name: 'Foo', kind: 'function', line: 5 }],
    );
    expect(result.added).toEqual([{ name: 'Foo', kind: 'function', line: 5 }]);
    expect(result.removed).toEqual([{ name: 'Foo', kind: 'class' }]);
    expect(result.modified).toEqual([]);
  });

  it('reports no changes when symbols are identical', () => {
    const syms = [
      { name: 'a', kind: 'function', line: 1 },
      { name: 'b', kind: 'method', line: 5 },
    ];
    const result = diffSymbols(syms, syms);
    expect(result).toEqual({ added: [], removed: [], modified: [] });
  });

  it('handles complex mixed changes', () => {
    const old = [
      { name: 'keep', kind: 'function', line: 1 },
      { name: 'move', kind: 'method', line: 10 },
      { name: 'drop', kind: 'class', line: 20 },
    ];
    const now = [
      { name: 'keep', kind: 'function', line: 1 },
      { name: 'move', kind: 'method', line: 15 },
      { name: 'fresh', kind: 'function', line: 25 },
    ];
    const result = diffSymbols(old, now);
    expect(result.added).toEqual([{ name: 'fresh', kind: 'function', line: 25 }]);
    expect(result.removed).toEqual([{ name: 'drop', kind: 'class' }]);
    expect(result.modified).toEqual([{ name: 'move', kind: 'method', line: 15 }]);
  });
});

describe('buildChangeEvent', () => {
  it('returns well-formed event object', () => {
    const diff = { added: [{ name: 'x', kind: 'function', line: 1 }], removed: [], modified: [] };
    const ev = buildChangeEvent('src/foo.js', 'modified', diff, {
      nodesBefore: 5,
      nodesAfter: 6,
      edgesAdded: 3,
    });

    expect(ev.file).toBe('src/foo.js');
    expect(ev.event).toBe('modified');
    expect(ev.symbols).toBe(diff);
    expect(ev.counts).toEqual({ nodes: { before: 5, after: 6 }, edges: { added: 3 } });
  });

  it('has a valid ISO timestamp', () => {
    const ev = buildChangeEvent('a.js', 'added', { added: [], removed: [], modified: [] }, {});
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('defaults missing counts to 0', () => {
    const ev = buildChangeEvent('a.js', 'added', { added: [], removed: [], modified: [] }, {});
    expect(ev.counts).toEqual({ nodes: { before: 0, after: 0 }, edges: { added: 0 } });
  });
});

describe('appendChangeEvents', () => {
  it('creates file and writes NDJSON', () => {
    const root = makeRoot();
    const diff = { added: [{ name: 'x', kind: 'function', line: 1 }], removed: [], modified: [] };
    const ev = buildChangeEvent('src/a.js', 'added', diff, {
      nodesBefore: 0,
      nodesAfter: 1,
      edgesAdded: 0,
    });

    appendChangeEvents(root, [ev]);

    const lines = parseLines(eventsPath(root));
    expect(lines).toHaveLength(1);
    expect(lines[0].file).toBe('src/a.js');
    expect(lines[0].event).toBe('added');
  });

  it('appends to existing file', () => {
    const root = makeRoot();
    const ev1 = buildChangeEvent('a.js', 'added', { added: [], removed: [], modified: [] }, {});
    const ev2 = buildChangeEvent('b.js', 'modified', { added: [], removed: [], modified: [] }, {});

    appendChangeEvents(root, [ev1]);
    appendChangeEvents(root, [ev2]);

    const lines = parseLines(eventsPath(root));
    expect(lines).toHaveLength(2);
    expect(lines[0].file).toBe('a.js');
    expect(lines[1].file).toBe('b.js');
  });

  it('creates .codegraph directory if missing', () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'nodir-'));
    const ev = buildChangeEvent('x.js', 'added', { added: [], removed: [], modified: [] }, {});

    appendChangeEvents(root, [ev]);

    expect(fs.existsSync(eventsPath(root))).toBe(true);
    const lines = parseLines(eventsPath(root));
    expect(lines).toHaveLength(1);
  });

  it('is non-fatal on bad root path', () => {
    // Should not throw
    const ev = buildChangeEvent('x.js', 'added', { added: [], removed: [], modified: [] }, {});
    expect(() => appendChangeEvents('/nonexistent/z/y/x/root', [ev])).not.toThrow();
  });
});

describe('rotateIfNeeded', () => {
  it('is a no-op when file is under threshold', () => {
    const root = makeRoot();
    const fp = eventsPath(root);
    fs.writeFileSync(fp, '{"a":1}\n{"b":2}\n');
    const before = fs.readFileSync(fp, 'utf-8');

    rotateIfNeeded(fp, 1024);

    expect(fs.readFileSync(fp, 'utf-8')).toBe(before);
  });

  it('truncates at line boundary when over threshold', () => {
    const root = makeRoot();
    const fp = eventsPath(root);

    // Write enough lines to exceed a small threshold
    const line = `${JSON.stringify({ data: 'x'.repeat(50) })}\n`;
    const content = line.repeat(20);
    fs.writeFileSync(fp, content);

    rotateIfNeeded(fp, content.length - 10);

    const after = fs.readFileSync(fp, 'utf-8');
    expect(after.length).toBeLessThan(content.length);
    // Every remaining line should be valid JSON
    const lines = after.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  it('is a no-op on missing file', () => {
    expect(() => rotateIfNeeded('/does/not/exist.ndjson', 100)).not.toThrow();
  });
});

describe('changeEventsPath', () => {
  it('returns correct path', () => {
    const p = changeEventsPath('/my/project');
    expect(p).toBe(path.join('/my/project', '.codegraph', 'change-events.ndjson'));
  });
});

describe('constants', () => {
  it('CHANGE_EVENTS_FILENAME is correct', () => {
    expect(CHANGE_EVENTS_FILENAME).toBe('change-events.ndjson');
  });

  it('DEFAULT_MAX_BYTES is 1 MB', () => {
    expect(DEFAULT_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe('full lifecycle', () => {
  it('append past threshold, rotate, append more — all lines valid JSON', () => {
    const root = makeRoot();
    const fp = eventsPath(root);
    const smallMax = 500;

    // Append events until we exceed the threshold
    for (let i = 0; i < 20; i++) {
      const ev = buildChangeEvent(
        `src/f${i}.js`,
        'modified',
        {
          added: [{ name: `fn${i}`, kind: 'function', line: i }],
          removed: [],
          modified: [],
        },
        { nodesBefore: i, nodesAfter: i + 1, edgesAdded: 1 },
      );
      appendChangeEvents(root, [ev]);
    }

    // Force rotation with small threshold
    const sizeBeforeRotation = fs.statSync(fp).size;
    rotateIfNeeded(fp, smallMax);

    const afterRotation = fs.readFileSync(fp, 'utf-8');
    // Rotation keeps roughly the last half — must be smaller than the original
    expect(afterRotation.length).toBeLessThan(sizeBeforeRotation);
    expect(afterRotation.length).toBeGreaterThan(0);

    // Append more after rotation
    const ev = buildChangeEvent(
      'src/extra.js',
      'added',
      {
        added: [{ name: 'extra', kind: 'function', line: 1 }],
        removed: [],
        modified: [],
      },
      { nodesBefore: 0, nodesAfter: 1, edgesAdded: 0 },
    );
    appendChangeEvents(root, [ev]);

    // Verify every line is valid JSON
    const lines = readLines(fp);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const parsed = JSON.parse(l);
      expect(parsed).toHaveProperty('ts');
      expect(parsed).toHaveProperty('file');
      expect(parsed).toHaveProperty('event');
      expect(parsed).toHaveProperty('symbols');
      expect(parsed).toHaveProperty('counts');
    }

    // Last line should be the extra event
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.file).toBe('src/extra.js');
  });
});
