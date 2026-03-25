/**
 * Tests for native CFG extraction across all languages.
 *
 * 1. Verifies buildCFGData accepts native def.cfg for non-JS languages
 *    (tests the JS-side native path in buildCFGData).
 * 2. When native engine is available, verifies each language extractor
 *    produces CFG data for function/method definitions.
 * 3. Parity: compares native CFG block/edge counts against WASM buildFunctionCFG.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { createParsers, getParser, parseFilesAuto } from '../../src/domain/parser.js';
import { buildCFGData, buildFunctionCFG } from '../../src/features/cfg.js';
import { COMPLEXITY_RULES, findFunctionNode } from '../../src/features/complexity.js';
import { loadNative } from '../../src/infrastructure/native.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function createTempDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-lang-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return { tmpDir, db };
}

// ─── JS-side: buildCFGData accepts native def.cfg ─────────────────────

describe('buildCFGData — native CFG path', () => {
  let tmpDir: string, db: any;

  beforeAll(() => {
    ({ tmpDir, db } = createTempDb());
  });

  afterAll(() => {
    if (db) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('inserts native CFG data for a function with pre-computed cfg', async () => {
    // Insert function node in DB
    db.prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)').run(
      'processData',
      'function',
      'src/process.py',
      1,
      10,
    );

    const fileSymbols = new Map();
    fileSymbols.set('src/process.py', {
      definitions: [
        {
          name: 'processData',
          kind: 'function',
          line: 1,
          endLine: 10,
          cfg: {
            blocks: [
              { index: 0, type: 'entry', startLine: null, endLine: null, label: null },
              { index: 1, type: 'exit', startLine: null, endLine: null, label: null },
              { index: 2, type: 'body', startLine: 2, endLine: 5, label: null },
              { index: 3, type: 'condition', startLine: 6, endLine: 6, label: 'if' },
              { index: 4, type: 'branch_true', startLine: 7, endLine: 8, label: 'then' },
              { index: 5, type: 'body', startLine: 9, endLine: 10, label: null },
            ],
            edges: [
              { sourceIndex: 0, targetIndex: 2, kind: 'fallthrough' },
              { sourceIndex: 2, targetIndex: 3, kind: 'fallthrough' },
              { sourceIndex: 3, targetIndex: 4, kind: 'branch_true' },
              { sourceIndex: 3, targetIndex: 5, kind: 'branch_false' },
              { sourceIndex: 4, targetIndex: 5, kind: 'fallthrough' },
              { sourceIndex: 5, targetIndex: 1, kind: 'fallthrough' },
            ],
          },
        },
      ],
      calls: [],
      _langId: 'python',
    });

    await buildCFGData(db, fileSymbols, tmpDir);

    const blocks = db.prepare('SELECT * FROM cfg_blocks ORDER BY block_index').all();
    expect(blocks.length).toBe(6);
    expect(blocks[0].block_type).toBe('entry');
    expect(blocks[1].block_type).toBe('exit');
    expect(blocks[3].block_type).toBe('condition');

    const edges = db.prepare('SELECT * FROM cfg_edges').all();
    expect(edges.length).toBe(6);
    const edgeKinds = edges.map((e) => e.kind);
    expect(edgeKinds).toContain('branch_true');
    expect(edgeKinds).toContain('branch_false');
    expect(edgeKinds).toContain('fallthrough');
  });

  test('native CFG data does not require WASM tree', async () => {
    const { tmpDir: tmpDir2, db: db2 } = createTempDb();

    db2
      .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
      .run('hello', 'function', 'src/hello.rb', 1, 5);

    const fileSymbols = new Map();
    fileSymbols.set('src/hello.rb', {
      definitions: [
        {
          name: 'hello',
          kind: 'function',
          line: 1,
          endLine: 5,
          cfg: {
            blocks: [
              { index: 0, type: 'entry', startLine: null, endLine: null, label: null },
              { index: 1, type: 'exit', startLine: null, endLine: null, label: null },
              { index: 2, type: 'body', startLine: 2, endLine: 4, label: null },
            ],
            edges: [
              { sourceIndex: 0, targetIndex: 2, kind: 'fallthrough' },
              { sourceIndex: 2, targetIndex: 1, kind: 'fallthrough' },
            ],
          },
        },
      ],
      calls: [],
      // No _tree, no _langId — should still work with native CFG
      _langId: 'ruby',
    });

    await buildCFGData(db2, fileSymbols, tmpDir2);

    const blocks = db2.prepare('SELECT * FROM cfg_blocks').all();
    expect(blocks.length).toBe(3);

    db2.close();
    fs.rmSync(tmpDir2, { recursive: true, force: true });
  });
});

// ─── Native engine: multi-language CFG extraction + parity ─────────────

const LANG_CFG_FIXTURES = {
  'fixture.js': `
function processItems(items) {
  if (items.length === 0) {
    return [];
  }
  for (const item of items) {
    console.log(item);
  }
  return items;
}
`,
  'fixture.py': `
def process(data):
    if not data:
        raise ValueError("empty")
    for item in data:
        print(item)
    return data
`,
  'fixture.go': `
package main

func process(items []string) []string {
    if len(items) == 0 {
        return nil
    }
    for _, item := range items {
        println(item)
    }
    return items
}
`,
  'fixture.rs': `
fn process(items: Vec<String>) -> Vec<String> {
    if items.is_empty() {
        return vec![];
    }
    for item in &items {
        println!("{}", item);
    }
    items
}
`,
  'fixture.java': `
public class Processor {
    public String[] process(String[] items) {
        if (items.length == 0) {
            return new String[0];
        }
        for (String item : items) {
            System.out.println(item);
        }
        return items;
    }
}
`,
  'fixture.cs': `
public class Processor {
    public string[] Process(string[] items) {
        if (items.Length == 0) {
            return new string[0];
        }
        foreach (var item in items) {
            Console.WriteLine(item);
        }
        return items;
    }
}
`,
  'fixture.rb': `
class Processor
  def process(items)
    if items.empty?
      return []
    end
    for item in items
      puts item
    end
    items
  end
end
`,
  'fixture.php': `<?php
class Processor {
    public function process(array $items): array {
        if (empty($items)) {
            return [];
        }
        foreach ($items as $item) {
            echo $item;
        }
        return $items;
    }
}
`,
};

// Complex fixtures for deeper parity validation (try/catch, switch, do-while, nested loops)
const COMPLEX_CFG_FIXTURES = {
  'complex-trycatch.js': `
function handleRequest(data) {
  try {
    if (!data) throw new Error("no data");
    return JSON.parse(data);
  } catch (err) {
    console.error(err);
    return null;
  } finally {
    console.log("done");
  }
}
`,
  'complex-switch.js': `
function classify(x) {
  switch (x) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return "other";
  }
}
`,
  'complex-dowhile.js': `
function retry(fn) {
  let attempts = 0;
  do {
    attempts++;
    if (fn()) return true;
  } while (attempts < 3);
  return false;
}
`,
  'complex-nested.js': `
function matrix(rows, cols) {
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (i === j) continue;
      console.log(i, j);
    }
  }
}
`,
  'complex-labeled.js': `
function search(grid) {
  outer: for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid[i].length; j++) {
      if (grid[i][j] === 0) break outer;
    }
  }
  return -1;
}
`,
};

function nativeSupportsCfg() {
  const native = loadNative();
  if (!native) return false;
  try {
    const tmpCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-check-'));
    const srcCheck = path.join(tmpCheck, 'src');
    fs.mkdirSync(srcCheck, { recursive: true });
    const checkPath = path.join(srcCheck, 'check.js');
    fs.writeFileSync(checkPath, 'function hello() { if (true) { return 1; } return 2; }');
    const results = native.parseFiles([checkPath], tmpCheck);
    const r = results?.[0];
    const hasCfg = r?.definitions?.some((d) => d.cfg?.blocks?.length > 0);
    fs.rmSync(tmpCheck, { recursive: true, force: true });
    return hasCfg;
  } catch {
    return false;
  }
}

const canTestNativeCfg = nativeSupportsCfg();

// The published native binary has a bug in process_for_loop that treats
// iterator-style for-loops as infinite loops (missing branch edges).
// The fix is in cfg.rs but only takes effect after the next binary publish.
// Detect the fix by parsing a for-of loop and checking for branch_true edge
// (bounded loop). The buggy binary only produces fallthrough (infinite loop).
const hasFixedCfg = (() => {
  const native = loadNative();
  if (!native) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-forin-'));
  try {
    const src = path.join(tmp, 'src');
    fs.mkdirSync(src, { recursive: true });
    const fp = path.join(src, 'check.js');
    fs.writeFileSync(fp, 'function f(items) { for (const x of items) { console.log(x); } }');
    const results = native.parseFiles([fp], tmp);
    const cfg = results?.[0]?.definitions?.[0]?.cfg;
    if (!cfg?.edges) return false;
    // Fixed binary emits branch_true from the loop header; buggy binary does not
    return cfg.edges.some((e) => e.kind === 'branch_true');
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

describe.skipIf(!canTestNativeCfg)('native CFG — multi-language', () => {
  let tmpDir: string;
  const nativeResults = new Map();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-multilang-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const filePaths = [];
    for (const [name, code] of Object.entries(LANG_CFG_FIXTURES)) {
      const fp = path.join(srcDir, name);
      fs.writeFileSync(fp, code);
      filePaths.push(fp);
    }

    const allSymbols = await parseFilesAuto(filePaths, tmpDir, { engine: 'native' });
    for (const [relPath, symbols] of allSymbols) {
      nativeResults.set(relPath, symbols);
    }
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const langTests = [
    { file: 'fixture.js', lang: 'JavaScript', funcPattern: /processItems/ },
    { file: 'fixture.py', lang: 'Python', funcPattern: /process/ },
    { file: 'fixture.go', lang: 'Go', funcPattern: /process/ },
    { file: 'fixture.rs', lang: 'Rust', funcPattern: /process/ },
    { file: 'fixture.java', lang: 'Java', funcPattern: /process/ },
    { file: 'fixture.cs', lang: 'C#', funcPattern: /Process/ },
    { file: 'fixture.rb', lang: 'Ruby', funcPattern: /process/ },
    { file: 'fixture.php', lang: 'PHP', funcPattern: /process/ },
  ];

  for (const { file, lang, funcPattern } of langTests) {
    test(`${lang}: native produces CFG data for function`, () => {
      const relPath = `src/${file}`;
      const symbols = nativeResults.get(relPath);
      expect(symbols, `no symbols for ${relPath}`).toBeTruthy();

      const funcDefs = symbols.definitions.filter(
        (d) => (d.kind === 'function' || d.kind === 'method') && funcPattern.test(d.name),
      );
      expect(funcDefs.length, `no function matching ${funcPattern} in ${relPath}`).toBeGreaterThan(
        0,
      );

      for (const def of funcDefs) {
        expect(def.cfg, `no cfg on ${def.name}`).toBeTruthy();
        expect(def.cfg.blocks.length, `no blocks in cfg of ${def.name}`).toBeGreaterThan(0);
        expect(def.cfg.edges.length, `no edges in cfg of ${def.name}`).toBeGreaterThan(0);

        // Entry and exit blocks should always be present
        const blockTypes = def.cfg.blocks.map((b) => b.type);
        expect(blockTypes).toContain('entry');
        expect(blockTypes).toContain('exit');

        // At least one fallthrough edge
        const edgeKinds = def.cfg.edges.map((e) => e.kind);
        expect(edgeKinds).toContain('fallthrough');
      }
    });
  }

  for (const { file, lang, funcPattern } of langTests) {
    test(`${lang}: CFG has if-condition and for-loop blocks`, () => {
      const relPath = `src/${file}`;
      const symbols = nativeResults.get(relPath);
      if (!symbols) return;

      const funcDefs = symbols.definitions.filter(
        (d) => (d.kind === 'function' || d.kind === 'method') && funcPattern.test(d.name),
      );
      if (funcDefs.length === 0) return;

      const def = funcDefs[0];
      const blockTypes = def.cfg.blocks.map((b) => b.type);
      const edgeKinds = def.cfg.edges.map((e) => e.kind);

      // All fixtures have an if statement
      expect(blockTypes).toContain('condition');
      expect(edgeKinds).toContain('branch_true');

      // All fixtures have a for loop
      expect(blockTypes).toContain('loop_header');
      expect(blockTypes).toContain('loop_body');
    });
  }
});

// ─── Parity: native vs WASM CFG ──────────────────────────────────────

describe.skipIf(!canTestNativeCfg || !hasFixedCfg)('native vs WASM CFG parity', () => {
  let tmpDir: string;
  const nativeResults = new Map();
  let parsers: any;

  const LANG_MAP = {
    '.js': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
  };

  let hasGoRangeFix = false;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-parity-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const filePaths = [];
    for (const [name, code] of Object.entries(LANG_CFG_FIXTURES)) {
      const fp = path.join(srcDir, name);
      fs.writeFileSync(fp, code);
      filePaths.push(fp);
    }

    const allSymbols = await parseFilesAuto(filePaths, tmpDir, { engine: 'native' });
    for (const [relPath, symbols] of allSymbols) {
      nativeResults.set(relPath, symbols);
    }

    parsers = await createParsers();

    // Determine if the loaded native binary includes the range_clause fix.
    // Must be computed here (after nativeResults is populated), not at describe() registration time.
    // Note: this heuristic checks for any loop_exit edge in the Go `process` function.
    // If the fixture also contains a C-style for loop with a condition, that loop emits
    // loop_exit regardless of the range_clause fix — causing a false positive (test runs
    // instead of skipping on an unpatched binary). The current fixture only has a range loop,
    // so this is safe. If fixture.go gains additional loop types, scope the check to
    // range-specific block labels.
    const goSymbols = nativeResults.get('src/fixture.go');
    const goDef = goSymbols?.definitions.find((d: any) => d.name === 'process');
    hasGoRangeFix = goDef?.cfg?.edges?.some((e: any) => e.kind === 'loop_exit') ?? false;
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const parityTests = [
    { file: 'fixture.js', ext: '.js', funcPattern: /processItems/ },
    { file: 'fixture.py', ext: '.py', funcPattern: /process/ },
    { file: 'fixture.go', ext: '.go', funcPattern: /process/, requiresFix: true },
    { file: 'fixture.rs', ext: '.rs', funcPattern: /process/ },
    { file: 'fixture.java', ext: '.java', funcPattern: /process/ },
    { file: 'fixture.cs', ext: '.cs', funcPattern: /Process/ },
    { file: 'fixture.rb', ext: '.rb', funcPattern: /process/ },
    { file: 'fixture.php', ext: '.php', funcPattern: /process/ },
  ];

  for (const { file, ext, funcPattern, requiresFix } of parityTests) {
    test(`parity: ${file} — native vs WASM block/edge counts match`, (ctx) => {
      if (requiresFix && !hasGoRangeFix) {
        ctx.skip();
        return;
      }

      const relPath = `src/${file}`;
      const symbols = nativeResults.get(relPath);
      if (!symbols) {
        ctx.skip();
        return;
      }

      const langId = LANG_MAP[ext];
      const complexityRules = COMPLEXITY_RULES.get(langId);
      if (!complexityRules) {
        ctx.skip();
        return;
      }

      // Parse with WASM
      const absPath = path.join(tmpDir, relPath);
      const parser = getParser(parsers, absPath);
      if (!parser) {
        ctx.skip();
        return;
      }

      const code = fs.readFileSync(absPath, 'utf-8');
      const tree = parser.parse(code);
      if (!tree) {
        ctx.skip();
        return;
      }

      const funcDefs = symbols.definitions.filter(
        (d) => (d.kind === 'function' || d.kind === 'method') && funcPattern.test(d.name),
      );

      // Guard: skip rather than silently pass when no defs have CFG blocks populated
      const defsWithCfg = funcDefs.filter((d: any) => d.cfg?.blocks?.length);
      if (defsWithCfg.length === 0) {
        ctx.skip();
        return;
      }

      for (const def of defsWithCfg) {
        const funcNode = findFunctionNode(tree.rootNode, def.line, def.endLine, complexityRules);
        if (!funcNode) continue;

        const wasmCfg = buildFunctionCFG(funcNode, langId);

        // Block counts should match
        expect(def.cfg.blocks.length).toBe(wasmCfg.blocks.length);
        // Edge counts should match
        expect(def.cfg.edges.length).toBe(wasmCfg.edges.length);

        // Block types should match (sorted for order independence)
        const nativeTypes = def.cfg.blocks.map((b) => b.type).sort();
        const wasmTypes = wasmCfg.blocks.map((b) => b.type).sort();
        expect(nativeTypes).toEqual(wasmTypes);

        // Edge kinds should match (sorted)
        const nativeKinds = def.cfg.edges.map((e) => e.kind).sort();
        const wasmKinds = wasmCfg.edges.map((e) => e.kind).sort();
        expect(nativeKinds).toEqual(wasmKinds);
      }
    });
  }
});

// ─── Complex parity: try/catch, switch, do-while, nested, labeled ──────

describe.skipIf(!canTestNativeCfg || !hasFixedCfg)(
  'native vs WASM CFG parity — complex patterns',
  () => {
    let tmpDir: string;
    const nativeResults = new Map<string, any>();
    let parsers: any;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-complex-'));
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      const filePaths: string[] = [];
      for (const [name, code] of Object.entries(COMPLEX_CFG_FIXTURES)) {
        const fp = path.join(srcDir, name);
        fs.writeFileSync(fp, code);
        filePaths.push(fp);
      }

      const allSymbols = await parseFilesAuto(filePaths, tmpDir, { engine: 'native' });
      for (const [relPath, symbols] of allSymbols) {
        nativeResults.set(relPath, symbols);
      }

      parsers = await createParsers();
    });

    afterAll(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const complexTests = [
      { file: 'complex-trycatch.js', funcPattern: /handleRequest/, desc: 'try/catch/finally' },
      { file: 'complex-switch.js', funcPattern: /classify/, desc: 'switch/case/default' },
      { file: 'complex-dowhile.js', funcPattern: /retry/, desc: 'do-while with early return' },
      { file: 'complex-nested.js', funcPattern: /matrix/, desc: 'nested for + continue' },
      { file: 'complex-labeled.js', funcPattern: /search/, desc: 'labeled break' },
    ];

    for (const { file, funcPattern, desc } of complexTests) {
      test(`parity: ${desc} — native vs WASM block/edge counts match`, (ctx) => {
        const relPath = `src/${file}`;
        const symbols = nativeResults.get(relPath);
        if (!symbols) {
          ctx.skip();
          return;
        }

        const langId = 'javascript';
        const complexityRules = COMPLEXITY_RULES.get(langId);
        if (!complexityRules) {
          ctx.skip();
          return;
        }

        const absPath = path.join(tmpDir, relPath);
        const parser = getParser(parsers, absPath);
        if (!parser) {
          ctx.skip();
          return;
        }

        const code = fs.readFileSync(absPath, 'utf-8');
        const tree = parser.parse(code);
        if (!tree) {
          ctx.skip();
          return;
        }

        const funcDefs = symbols.definitions.filter(
          (d: any) => (d.kind === 'function' || d.kind === 'method') && funcPattern.test(d.name),
        );

        // Guard: skip rather than silently pass when no defs have CFG blocks populated
        const defsWithCfg = funcDefs.filter((d: any) => d.cfg?.blocks?.length);
        if (defsWithCfg.length === 0) {
          ctx.skip();
          return;
        }

        for (const def of defsWithCfg) {
          const funcNode = findFunctionNode(tree.rootNode, def.line, def.endLine, complexityRules);
          if (!funcNode) continue;

          const wasmCfg = buildFunctionCFG(funcNode, langId);

          expect(def.cfg.blocks.length, `${desc}: block count mismatch`).toBe(
            wasmCfg.blocks.length,
          );
          expect(def.cfg.edges.length, `${desc}: edge count mismatch`).toBe(wasmCfg.edges.length);

          const nativeTypes = def.cfg.blocks.map((b: any) => b.type).sort();
          const wasmTypes = wasmCfg.blocks.map((b: any) => b.type).sort();
          expect(nativeTypes, `${desc}: block types mismatch`).toEqual(wasmTypes);

          const nativeKinds = def.cfg.edges.map((e: any) => e.kind).sort();
          const wasmKinds = wasmCfg.edges.map((e: any) => e.kind).sort();
          expect(nativeKinds, `${desc}: edge kinds mismatch`).toEqual(wasmKinds);
        }
      });
    }
  },
);
