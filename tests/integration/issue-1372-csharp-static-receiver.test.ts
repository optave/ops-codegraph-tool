/**
 * Regression test for #1372 — WASM engine missing C# static receiver call edges.
 *
 * The gap: the WASM resolver had no fallback for calls where the receiver is a
 * class name used directly (e.g. `Validators.IsValidEmail(...)`).  The class name
 * is never assigned to a local variable, so it has no typeMap entry, and the old
 * code returned empty.  The fix adds a fallback that treats the receiver as a
 * potential class name and looks up `Receiver.Method` directly in the symbol DB.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

// ── Fixture ──────────────────────────────────────────────────────────────────

const FILES: Record<string, string> = {
  // Static class with two public methods.
  'Validators.cs': `
namespace Demo;
public static class Validators {
  public static bool IsValidEmail(string email) {
    return email.Contains("@");
  }
  public static bool IsValidName(string name) {
    return name.Length >= 2;
  }
}
`,
  // Caller class that references Validators via explicit static receiver.
  'Program.cs': `
namespace Demo;
public class Program {
  public static void Main() {
    bool ok = Validators.IsValidEmail("a@b.com");
  }
  public static void Run() {
    bool ok2 = Validators.IsValidName("Alice");
  }
}
`,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(dir, rel), content.trimStart());
  }
}

function readEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; kind: string }>;
  } finally {
    db.close();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('C# static receiver call resolution (#1372)', () => {
  let tmpDir: string;
  let edges: Array<{ src: string; tgt: string; kind: string }> = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1372-'));
    writeFixture(tmpDir);
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
    edges = readEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves static receiver call: Program.Main → Validators.IsValidEmail', () => {
    expect(edges).toContainEqual(
      expect.objectContaining({
        src: 'Program.Main',
        tgt: 'Validators.IsValidEmail',
        kind: 'calls',
      }),
    );
  });

  it('resolves static receiver call: Program.Run → Validators.IsValidName', () => {
    expect(edges).toContainEqual(
      expect.objectContaining({ src: 'Program.Run', tgt: 'Validators.IsValidName', kind: 'calls' }),
    );
  });
});
