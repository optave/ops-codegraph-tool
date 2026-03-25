/**
 * Tests for AST node extraction across all languages.
 *
 * 1. Verifies buildAstNodes accepts native astNodes for non-JS languages
 *    (tests the JS-side ungate from WALK_EXTENSIONS).
 * 2. When native engine is available, verifies each language extractor
 *    produces astNodes for its supported AST node kinds.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { parseFilesAuto } from '../../src/domain/parser.js';
import { buildAstNodes } from '../../src/features/ast.js';
import { loadNative } from '../../src/infrastructure/native.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-lang-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return { tmpDir, db };
}

function queryByKind(db, kind) {
  return db.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
}

function queryAll(db) {
  return db.prepare('SELECT * FROM ast_nodes ORDER BY line').all();
}

// ─── JS-side: buildAstNodes accepts astNodes for non-JS files ────────

describe('buildAstNodes — non-JS language astNodes', () => {
  let tmpDir: string, db: any;

  beforeAll(() => {
    ({ tmpDir, db } = createTempDb());
  });

  afterAll(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('inserts native astNodes for a .py file', async () => {
    // Simulate native engine output with pre-extracted astNodes
    const fileSymbols = new Map();
    fileSymbols.set('src/example.py', {
      definitions: [{ name: 'process', kind: 'function', line: 1, endLine: 10 }],
      calls: [],
      astNodes: [
        {
          kind: 'throw',
          name: 'ValueError',
          line: 3,
          text: 'ValueError("bad input")',
          receiver: null,
        },
        { kind: 'string', name: 'bad input', line: 3, text: '"bad input"', receiver: null },
        { kind: 'await', name: 'fetch_data', line: 5, text: 'fetch_data(url)', receiver: null },
        {
          kind: 'string',
          name: 'https://api.example.com',
          line: 6,
          text: '"https://api.example.com"',
          receiver: null,
        },
      ],
    });

    // Insert a node so parent resolution has something to find
    db.prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)').run(
      'process',
      'function',
      'src/example.py',
      1,
      10,
    );

    await buildAstNodes(db, fileSymbols, tmpDir);

    const all = queryAll(db);
    expect(all.length).toBeGreaterThanOrEqual(4);

    const throws = queryByKind(db, 'throw');
    expect(throws.some((n) => n.name === 'ValueError')).toBe(true);

    const strings = queryByKind(db, 'string');
    expect(strings.some((n) => n.name.includes('api.example.com'))).toBe(true);

    const awaits = queryByKind(db, 'await');
    expect(awaits.some((n) => n.name === 'fetch_data')).toBe(true);
  });

  test('inserts native astNodes for a .java file', async () => {
    const db2Setup = createTempDb();
    const db2 = db2Setup.db;
    const tmpDir2 = db2Setup.tmpDir;

    const fileSymbols = new Map();
    fileSymbols.set('src/Main.java', {
      definitions: [
        { name: 'Main', kind: 'class', line: 1, endLine: 20 },
        { name: 'Main.run', kind: 'method', line: 3, endLine: 15 },
      ],
      calls: [],
      astNodes: [
        { kind: 'new', name: 'ArrayList', line: 4, text: 'new ArrayList<>()', receiver: null },
        {
          kind: 'throw',
          name: 'IllegalArgumentException',
          line: 7,
          text: 'new IllegalArgumentException("invalid")',
          receiver: null,
        },
        { kind: 'string', name: 'invalid', line: 7, text: '"invalid"', receiver: null },
      ],
    });

    db2
      .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
      .run('Main', 'class', 'src/Main.java', 1, 20);
    db2
      .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
      .run('Main.run', 'method', 'src/Main.java', 3, 15);

    await buildAstNodes(db2, fileSymbols, tmpDir2);

    const newNodes = queryByKind(db2, 'new');
    expect(newNodes.some((n) => n.name === 'ArrayList')).toBe(true);

    const throwNodes = queryByKind(db2, 'throw');
    expect(throwNodes.some((n) => n.name === 'IllegalArgumentException')).toBe(true);

    db2.close();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  test('all inserted nodes have valid kinds', async () => {
    const all = queryAll(db);
    const validKinds = new Set(['call', 'new', 'string', 'regex', 'throw', 'await']);
    for (const node of all) {
      expect(validKinds.has(node.kind)).toBe(true);
    }
  });
});

// ─── Native engine: multi-language AST extraction ────────────────────

const LANG_FIXTURES = {
  'fixture.py': `
def process(data):
    raise ValueError("bad input")

async def fetch():
    result = await get_data()
    url = "https://api.example.com/data"
    pattern = r"^[a-z]+\\d{3}$"
    greeting = f"hello {data}"
    raw_bytes = rb"raw bytes value"
    return result
`,
  'fixture.go': `
package main

import "fmt"

func main() {
    msg := "hello world from go"
    raw := \`raw string literal\`
    fmt.Println(msg, raw)
}
`,
  'fixture.java': `
import java.util.ArrayList;

public class Main {
    public void run() {
        ArrayList<String> list = new ArrayList<>();
        String msg = "hello from java";
        if (list.isEmpty()) {
            throw new IllegalArgumentException("empty list");
        }
    }
}
`,
  'fixture.cs': `
using System;
using System.Threading.Tasks;

public class Service {
    public async Task<string> FetchAsync() {
        var result = await GetDataAsync();
        string msg = "hello from csharp";
        var ex = new ArgumentNullException("x");
        if (result == null) {
            throw new ArgumentNullException("result");
        }
        return msg;
    }
}
`,
  'fixture.rb': `
class Greeter
  def greet(name)
    msg = "hello from ruby"
    pattern = /^[A-Z][a-z]+$/
    puts msg
  end
end
`,
  'fixture.rs': `
use std::collections::HashMap;

async fn fetch_data(url: &str) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::get(url).await?;
    let msg = "hello from rust";
    let raw = r#"raw string content"#;
    Ok(msg.to_string())
}
`,
  'fixture.php': `<?php
class UserService {
    public function createUser(string $name): User {
        $user = new User($name);
        $msg = "created user";
        if (!$user->isValid()) {
            throw new \\InvalidArgumentException("invalid user");
        }
        return $user;
    }
}
`,
};

// Check if native addon supports astNodes for non-JS languages
function nativeSupportsMultiLangAst() {
  const native = loadNative();
  if (!native) return false;
  try {
    const tmpCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-ml-check-'));
    const srcCheck = path.join(tmpCheck, 'src');
    fs.mkdirSync(srcCheck, { recursive: true });
    // Test with a Python file that has a string literal
    const checkPath = path.join(srcCheck, 'check.py');
    fs.writeFileSync(checkPath, 'msg = "hello world test"');
    const results = native.parseFiles([checkPath], tmpCheck);
    const r = results?.[0];
    const hasAst = r?.astNodes?.length > 0 || r?.ast_nodes?.length > 0;
    fs.rmSync(tmpCheck, { recursive: true, force: true });
    return hasAst;
  } catch {
    return false;
  }
}

const canTestMultiLang = nativeSupportsMultiLangAst();

describe.skipIf(!canTestMultiLang)('native AST nodes — multi-language', () => {
  let tmpDir: string, db: any;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-multilang-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.codegraph'));

    // Write all fixture files
    const filePaths = [];
    for (const [name, code] of Object.entries(LANG_FIXTURES)) {
      const fp = path.join(srcDir, name);
      fs.writeFileSync(fp, code);
      filePaths.push(fp);
    }

    // Parse all files with native engine
    const allSymbols = await parseFilesAuto(filePaths, tmpDir, { engine: 'native' });

    // Create DB
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // Insert definition nodes for parent resolution
    const insertNode = db.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [relPath, symbols] of allSymbols) {
      for (const def of symbols.definitions || []) {
        insertNode.run(def.name, def.kind, relPath, def.line, def.endLine);
      }
    }

    // Build AST nodes
    await buildAstNodes(db, allSymbols, tmpDir);
  });

  afterAll(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Python ──

  test('Python: extracts raise as throw', () => {
    const throws = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'throw' AND file LIKE '%fixture.py'")
      .all();
    expect(throws.length).toBeGreaterThanOrEqual(1);
    expect(throws.some((n) => n.name === 'ValueError')).toBe(true);
  });

  test('Python: extracts await', () => {
    const awaits = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'await' AND file LIKE '%fixture.py'")
      .all();
    expect(awaits.length).toBeGreaterThanOrEqual(1);
    expect(awaits.some((n) => n.name.includes('get_data'))).toBe(true);
  });

  test('Python: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.py'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(
      strings.some((n) => n.name.includes('bad input') || n.name.includes('api.example.com')),
    ).toBe(true);
  });

  test('Python: strips r/f/rb prefixes from string names', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.py'")
      .all();
    // r"..." prefix should be stripped — name should not start with 'r'
    const rawStr = strings.find((n) => n.name.includes('^[a-z]+'));
    expect(rawStr).toBeDefined();
    expect(rawStr.name.startsWith('r')).toBe(false);
    // f"..." prefix should be stripped
    const fStr = strings.find((n) => n.name.includes('hello'));
    expect(fStr).toBeDefined();
    expect(fStr.name.startsWith('f')).toBe(false);
    // rb"..." prefix should be stripped — check for multi-char prefix remnant,
    // not single 'r' since the content "raw bytes value" starts with 'r' naturally
    const rbStr = strings.find((n) => n.name.includes('raw bytes'));
    expect(rbStr).toBeDefined();
    expect(rbStr.name).not.toMatch(/^rb/);
    expect(rbStr.name.startsWith('b')).toBe(false);
  });

  // ── Go ──

  test('Go: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.go'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(strings.some((n) => n.name.includes('hello world'))).toBe(true);
  });

  // ── Java ──

  test('Java: extracts new as kind:new', () => {
    const news = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'new' AND file LIKE '%fixture.java'")
      .all();
    expect(news.length).toBeGreaterThanOrEqual(1);
    expect(news.some((n) => n.name.includes('ArrayList'))).toBe(true);
  });

  test('Java: extracts throw', () => {
    const throws = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'throw' AND file LIKE '%fixture.java'")
      .all();
    expect(throws.length).toBeGreaterThanOrEqual(1);
    expect(throws.some((n) => n.name.includes('IllegalArgumentException'))).toBe(true);
  });

  test('Java: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.java'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(strings.some((n) => n.name.includes('hello from java'))).toBe(true);
  });

  // ── C# ──

  test('C#: extracts new as kind:new', () => {
    const news = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'new' AND file LIKE '%fixture.cs'")
      .all();
    expect(news.length).toBeGreaterThanOrEqual(1);
    expect(news.some((n) => n.name.includes('ArgumentNullException'))).toBe(true);
  });

  test('C#: extracts throw', () => {
    const throws = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'throw' AND file LIKE '%fixture.cs'")
      .all();
    expect(throws.length).toBeGreaterThanOrEqual(1);
  });

  test('C#: extracts await', () => {
    const awaits = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'await' AND file LIKE '%fixture.cs'")
      .all();
    expect(awaits.length).toBeGreaterThanOrEqual(1);
    expect(awaits.some((n) => n.name.includes('GetDataAsync'))).toBe(true);
  });

  test('C#: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.cs'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(strings.some((n) => n.name.includes('hello from csharp'))).toBe(true);
  });

  // ── Ruby ──

  test('Ruby: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.rb'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(strings.some((n) => n.name.includes('hello from ruby'))).toBe(true);
  });

  test('Ruby: extracts regex literals', () => {
    const regexes = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'regex' AND file LIKE '%fixture.rb'")
      .all();
    expect(regexes.length).toBeGreaterThanOrEqual(1);
    expect(regexes.some((n) => n.name.includes('[A-Z]'))).toBe(true);
  });

  // ── Rust ──

  test('Rust: extracts await', () => {
    const awaits = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'await' AND file LIKE '%fixture.rs'")
      .all();
    expect(awaits.length).toBeGreaterThanOrEqual(1);
  });

  test('Rust: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.rs'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(2);
    expect(strings.some((n) => n.name.includes('hello from rust'))).toBe(true);
  });

  test('Rust: extracts raw string literals with trimmed name', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.rs'")
      .all();
    const rawStr = strings.find((n) => n.name.includes('raw string content'));
    expect(rawStr).toBeDefined();
    // Name should not have r# delimiter prefix or quote chars — but the content
    // "raw string content" naturally starts with 'r', so check for delimiter patterns
    expect(rawStr.name).not.toMatch(/^r#/);
    expect(rawStr.name).not.toMatch(/^[#"]/);
  });

  // ── PHP ──

  test('PHP: extracts new as kind:new', () => {
    const news = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'new' AND file LIKE '%fixture.php'")
      .all();
    expect(news.length).toBeGreaterThanOrEqual(1);
    expect(
      news.some((n) => n.name.includes('User') || n.name.includes('InvalidArgumentException')),
    ).toBe(true);
  });

  test('PHP: extracts throw', () => {
    const throws = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'throw' AND file LIKE '%fixture.php'")
      .all();
    expect(throws.length).toBeGreaterThanOrEqual(1);
  });

  test('PHP: extracts string literals', () => {
    const strings = db
      .prepare("SELECT * FROM ast_nodes WHERE kind = 'string' AND file LIKE '%fixture.php'")
      .all();
    expect(strings.length).toBeGreaterThanOrEqual(1);
    expect(
      strings.some((n) => n.name.includes('created user') || n.name.includes('invalid user')),
    ).toBe(true);
  });

  // ── Cross-language ──

  test('all nodes have valid kinds', () => {
    const all = queryAll(db);
    const validKinds = new Set(['call', 'new', 'string', 'regex', 'throw', 'await']);
    for (const node of all) {
      expect(validKinds.has(node.kind)).toBe(true);
    }
  });
});
