/**
 * Unit tests for src/infrastructure/doctor.ts (issue #1733).
 *
 * Covers the two failure classes reported against a stale worktree: a
 * better-sqlite3 native binary compiled for an older Node ABI, and a
 * grammars/ directory missing most of its .wasm files. Every check function
 * takes its I/O (require(), directory listing) as an injectable parameter,
 * so these tests simulate both broken states with fakes — no real native
 * binary or grammars/ file is touched or modified.
 *
 * Grammar-completeness tests specifically cover the required-vs-optional
 * split: a missing *required* (JS/TS/TSX) grammar must fail the check and the
 * overall report (blocking `pretest`), but a missing *optional* grammar must
 * only warn — never flip the report unhealthy — per this repo's own
 * CLAUDE.md ("Non-required parsers ... fail gracefully if their WASM grammar
 * is unavailable").
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LANGUAGE_REGISTRY } from '../../src/domain/parser.js';
import {
  checkBetterSqlite3Abi,
  checkWasmGrammars,
  findMissingGrammars,
  parseAbiMismatchError,
  runDoctorChecks,
} from '../../src/infrastructure/doctor.js';

describe('parseAbiMismatchError', () => {
  it('parses the real Node native-addon ABI mismatch message', () => {
    const message = `The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 147. Please try re-compiling or re-installing
the module (for instance, using \`npm rebuild\` or \`npm install\`).`;

    expect(parseAbiMismatchError(message)).toEqual({
      compiledVersion: 137,
      requiredVersion: 147,
    });
  });

  it('returns null for unrelated error text', () => {
    expect(parseAbiMismatchError("Cannot find module 'better-sqlite3'")).toBeNull();
    expect(parseAbiMismatchError('Segmentation fault (core dumped)')).toBeNull();
    expect(parseAbiMismatchError('')).toBeNull();
  });

  it('returns null when only one NODE_MODULE_VERSION mention is present', () => {
    expect(parseAbiMismatchError('NODE_MODULE_VERSION 137 only mentioned once')).toBeNull();
  });
});

describe('checkBetterSqlite3Abi', () => {
  it('reports ok when loadModule succeeds', () => {
    const result = checkBetterSqlite3Abi(() => ({ Database: class {} }));
    expect(result.status).toBe('ok');
    expect(result.id).toBe('better-sqlite3-abi');
    expect(result.fixCommand).toBeUndefined();
    expect(result.detail).toContain(process.version);
  });

  it('reports a parsed ABI mismatch with the rebuild fix command', () => {
    const message = `The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 147. Please try re-compiling or re-installing
the module (for instance, using \`npm rebuild\` or \`npm install\`).`;
    const result = checkBetterSqlite3Abi(() => {
      throw new Error(message);
    });

    expect(result.status).toBe('fail');
    expect(result.fixCommand).toBe('npm rebuild better-sqlite3');
    expect(result.detail).toContain('137');
    expect(result.detail).toContain('147');
  });

  it('reports a missing install with the npm install fix command', () => {
    const result = checkBetterSqlite3Abi(() => {
      const err = Object.assign(new Error("Cannot find module 'better-sqlite3'"), {
        code: 'MODULE_NOT_FOUND',
      });
      throw err;
    });

    expect(result.status).toBe('fail');
    expect(result.fixCommand).toBe('npm install');
    expect(result.detail).toMatch(/not installed/i);
  });

  it('falls back to the raw message and a generic rebuild fix when the error is unrecognized', () => {
    // Simulates a future Node version rewording the ABI-mismatch message —
    // detection must still fail closed rather than silently reporting healthy.
    const result = checkBetterSqlite3Abi(() => {
      throw new Error('Segmentation fault (core dumped)');
    });

    expect(result.status).toBe('fail');
    expect(result.fixCommand).toBe('npm rebuild better-sqlite3');
    expect(result.detail).toContain('Segmentation fault');
  });

  it('handles non-Error throws gracefully', () => {
    const result = checkBetterSqlite3Abi(() => {
      throw 'boom';
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('boom');
  });
});

describe('findMissingGrammars (pure)', () => {
  const registry = [
    { id: 'javascript', grammarFile: 'tree-sitter-javascript.wasm', required: true },
    { id: 'python', grammarFile: 'tree-sitter-python.wasm', required: false },
    { id: 'rust', grammarFile: 'tree-sitter-rust.wasm', required: false },
  ];

  it('returns entries whose grammar file is absent from the existing set', () => {
    const missing = findMissingGrammars(registry, new Set(['tree-sitter-javascript.wasm']));
    expect(missing.map((m) => m.id)).toEqual(['python', 'rust']);
  });

  it('returns an empty array when every grammar file is present', () => {
    const all = new Set(registry.map((r) => r.grammarFile));
    expect(findMissingGrammars(registry, all)).toEqual([]);
  });

  it('returns the full registry when nothing is installed', () => {
    expect(findMissingGrammars(registry, new Set())).toEqual(registry);
  });

  it('does not mutate its inputs', () => {
    const existing = new Set(['tree-sitter-javascript.wasm']);
    const registryCopy = [...registry];
    findMissingGrammars(registry, existing);
    expect(registry).toEqual(registryCopy);
    expect(existing.size).toBe(1);
  });
});

describe('checkWasmGrammars (fake registry + fake listGrammarFiles)', () => {
  // Mirrors the real LANGUAGE_REGISTRY shape: a small required tier (like
  // JS/TS/TSX) plus a larger optional tier (like every other language).
  const registry = [
    { id: 'javascript', grammarFile: 'tree-sitter-javascript.wasm', required: true },
    { id: 'typescript', grammarFile: 'tree-sitter-typescript.wasm', required: true },
    { id: 'python', grammarFile: 'tree-sitter-python.wasm', required: false },
    { id: 'rust', grammarFile: 'tree-sitter-rust.wasm', required: false },
    { id: 'go', grammarFile: 'tree-sitter-go.wasm', required: false },
    { id: 'java', grammarFile: 'tree-sitter-java.wasm', required: false },
    { id: 'ruby', grammarFile: 'tree-sitter-ruby.wasm', required: false },
    { id: 'php', grammarFile: 'tree-sitter-php.wasm', required: false },
  ];
  const requiredFiles = registry.filter((r) => r.required).map((r) => r.grammarFile);

  it('reports ok when every grammar file is present', () => {
    const result = checkWasmGrammars(registry, () => new Set(registry.map((r) => r.grammarFile)));
    expect(result.status).toBe('ok');
    expect(result.id).toBe('wasm-grammars');
    expect(result.detail).toBe(`all ${registry.length} grammar files present in grammars/`);
    expect(result.fixCommand).toBeUndefined();
  });

  it('reports warn — never fail — when only optional grammars are missing and all required are present', () => {
    // All required (javascript, typescript) present; all 6 optional missing.
    const result = checkWasmGrammars(registry, () => new Set(requiredFiles));
    expect(result.status).toBe('warn');
    expect(result.status).not.toBe('fail');
    expect(result.fixCommand).toBe('npm run build:wasm');
    expect(result.detail).toContain('all required grammar files present');
    expect(result.detail).toContain('6 optional');
    expect(result.detail).toContain('non-blocking');
    // 6 missing optional entries, truncated sample: 5 shown + "+1 more".
    expect(result.detail).toContain('+1 more');
  });

  it('reports fail when a required grammar is missing, even if it is the only one missing', () => {
    const present = new Set(registry.map((r) => r.grammarFile));
    present.delete('tree-sitter-javascript.wasm'); // drop one required grammar
    const result = checkWasmGrammars(registry, () => present);

    expect(result.status).toBe('fail');
    expect(result.fixCommand).toBe('npm run build:wasm');
    expect(result.detail).toContain('1 required grammar file(s) missing');
    expect(result.detail).toContain('tree-sitter-javascript.wasm');
    // No optional grammars are missing in this scenario.
    expect(result.detail).not.toContain('optional grammar file(s) also missing');
  });

  it('reports fail and still mentions optional grammars missing alongside a required one', () => {
    // Only typescript present: javascript (required) AND all 6 optional missing.
    const result = checkWasmGrammars(registry, () => new Set(['tree-sitter-typescript.wasm']));

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('1 required grammar file(s) missing');
    expect(result.detail).toContain('tree-sitter-javascript.wasm');
    expect(result.detail).toContain('6 optional grammar file(s) also missing');
  });

  it('reports fail when the grammars directory does not exist (empty set)', () => {
    const result = checkWasmGrammars(registry, () => new Set());
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`${requiredFiles.length} required grammar file(s) missing`);
  });
});

describe('checkWasmGrammars (real fs I/O against a temp directory, real LANGUAGE_REGISTRY)', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects a healthy directory containing every registered grammar file', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cg-doctor-grammars-healthy-'));
    for (const entry of LANGUAGE_REGISTRY) {
      writeFileSync(path.join(tmpDir, entry.grammarFile), '');
    }

    const result = checkWasmGrammars(LANGUAGE_REGISTRY, () => new Set(readdirSync(tmpDir)));
    expect(result.status).toBe('ok');
    expect(result.detail).toBe(
      `all ${LANGUAGE_REGISTRY.length} grammar files present in grammars/`,
    );
  });

  it('detects a near-empty directory (mirrors the reported worktree: 1 of ~40 files) — required grammars missing, so it fails', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cg-doctor-grammars-broken-'));
    // Only the erlang (optional) grammar present, exactly as in the original
    // bug report — JS/TS/TSX (required) are among the 35 missing files, so
    // this must still be a hard failure, not just a warning.
    writeFileSync(path.join(tmpDir, 'tree-sitter-erlang.wasm'), '');

    const result = checkWasmGrammars(LANGUAGE_REGISTRY, () => new Set(readdirSync(tmpDir)));
    expect(result.status).toBe('fail');
    expect(result.fixCommand).toBe('npm run build:wasm');
    expect(result.detail).toContain('required grammar file(s) missing');
    expect(result.detail).toContain('tree-sitter-javascript.wasm');
  });

  it('detects a directory missing exactly one required grammar', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cg-doctor-grammars-partial-'));
    const [, ...rest] = LANGUAGE_REGISTRY; // drop the first entry (javascript, required)
    for (const entry of rest) {
      writeFileSync(path.join(tmpDir, entry.grammarFile), '');
    }

    const result = checkWasmGrammars(LANGUAGE_REGISTRY, () => new Set(readdirSync(tmpDir)));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('tree-sitter-javascript.wasm');
    expect(result.detail).toContain('1 required grammar file(s) missing');
  });

  it('detects a directory missing only an optional grammar (all required present) — warns, does not fail', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cg-doctor-grammars-optional-gap-'));
    // tree-sitter-erlang.wasm is an optional (required: false) grammar.
    for (const entry of LANGUAGE_REGISTRY) {
      if (entry.grammarFile === 'tree-sitter-erlang.wasm') continue;
      writeFileSync(path.join(tmpDir, entry.grammarFile), '');
    }

    const result = checkWasmGrammars(LANGUAGE_REGISTRY, () => new Set(readdirSync(tmpDir)));
    expect(result.status).toBe('warn');
    expect(result.status).not.toBe('fail');
    expect(result.detail).toContain('tree-sitter-erlang.wasm');
    expect(result.detail).toContain('non-blocking');
  });
});

describe('runDoctorChecks', () => {
  it('a non-blocking warn check does not flip the overall report unhealthy', () => {
    const report = runDoctorChecks([
      { id: 'a', label: 'A', status: 'ok', detail: 'fine' },
      { id: 'b', label: 'B', status: 'warn', detail: 'minor issue, non-blocking' },
    ]);
    expect(report.ok).toBe(true);
  });

  it('a fail check flips the overall report unhealthy, even alongside ok/warn checks', () => {
    const report = runDoctorChecks([
      { id: 'a', label: 'A', status: 'ok', detail: 'fine' },
      { id: 'b', label: 'B', status: 'warn', detail: 'minor issue, non-blocking' },
      { id: 'c', label: 'C', status: 'fail', detail: 'broken' },
    ]);
    expect(report.ok).toBe(false);
  });

  it('an all-ok report is healthy', () => {
    const report = runDoctorChecks([{ id: 'a', label: 'A', status: 'ok', detail: 'fine' }]);
    expect(report.ok).toBe(true);
  });

  it('runs both real checks against the real environment and returns a well-formed report', () => {
    // Uses the real defaults (real require('better-sqlite3'), real grammars/
    // directory) — by the time this test runs, `pretest` has already gated
    // `npm test` on a healthy environment, but this asserts shape rather than
    // hard-coding a specific status so a single-file run on a mid-repair
    // machine doesn't fail on an unrelated assertion.
    const report = runDoctorChecks();

    expect(typeof report.ok).toBe('boolean');
    expect(report.checks).toHaveLength(2);
    expect(report.checks.map((c) => c.id)).toEqual(['better-sqlite3-abi', 'wasm-grammars']);
    for (const check of report.checks) {
      expect(['ok', 'warn', 'fail']).toContain(check.status);
      expect(typeof check.label).toBe('string');
      expect(typeof check.detail).toBe('string');
      expect(check.detail.length).toBeGreaterThan(0);
    }
    expect(report.ok).toBe(report.checks.every((c) => c.status !== 'fail'));
  });
});
