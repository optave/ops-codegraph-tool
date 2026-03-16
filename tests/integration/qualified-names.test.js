import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findNodeByQualifiedName,
  findNodesByScope,
  openReadonlyOrFail,
} from '../../src/db/index.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { childrenData } from '../../src/domain/queries.js';
import { pythonVisibility } from '../../src/extractors/helpers.js';

// Fixture: a small project with classes, methods, and visibility modifiers
const FIXTURE_FILES = {
  'date-helper.js': `
export class DateHelper {
  #locale;

  constructor(locale) {
    this.#locale = locale;
  }

  format(date) {
    return date.toLocaleDateString(this.#locale);
  }

  static now() {
    return new Date();
  }
}

export function freeFunction(x) {
  return x + 1;
}
`,
  'math-utils.js': `
export class MathUtils {
  static PI = 3.14159;

  static add(a, b) {
    return a + b;
  }

  static multiply(a, b) {
    return a * b;
  }
}
`,
};

let tmpDir;
let dbPath;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qualified-'));
  for (const [file, content] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(tmpDir, file), content);
  }
  // package.json so codegraph sees it as a project
  fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
  await buildGraph(tmpDir);
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('qualified_name column', () => {
  it('methods have qualified_name matching their full name', () => {
    const db = openReadonlyOrFail(dbPath);
    try {
      const nodes = findNodeByQualifiedName(db, 'DateHelper.format');
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('DateHelper.format');
      expect(nodes[0].kind).toBe('method');
      expect(nodes[0].qualified_name).toBe('DateHelper.format');
    } finally {
      db.close();
    }
  });

  it('top-level functions have qualified_name equal to name', () => {
    const db = openReadonlyOrFail(dbPath);
    try {
      const nodes = findNodeByQualifiedName(db, 'freeFunction');
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('freeFunction');
      expect(nodes[0].qualified_name).toBe('freeFunction');
    } finally {
      db.close();
    }
  });

  it('child nodes have qualified_name = parent.child', () => {
    const db = openReadonlyOrFail(dbPath);
    try {
      // Parameters of freeFunction should have qualified_name 'freeFunction.x'
      const nodes = findNodeByQualifiedName(db, 'freeFunction.x');
      expect(nodes.length).toBe(1);
      expect(nodes[0].kind).toBe('parameter');
      expect(nodes[0].scope).toBe('freeFunction');
    } finally {
      db.close();
    }
  });
});

describe('scope column', () => {
  it('methods have scope set to their parent class', () => {
    const db = openReadonlyOrFail(dbPath);
    try {
      const nodes = findNodesByScope(db, 'DateHelper');
      expect(nodes.length).toBeGreaterThan(0);
      const names = nodes.map((n) => n.name);
      expect(names).toContain('DateHelper.format');
      expect(names).toContain('DateHelper.constructor');
    } finally {
      db.close();
    }
  });

  it('findNodesByScope with kind filter returns only matching kinds', () => {
    const db = openReadonlyOrFail(dbPath);
    try {
      const methods = findNodesByScope(db, 'MathUtils', { kind: 'method' });
      for (const m of methods) {
        expect(m.kind).toBe('method');
      }
      expect(methods.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('top-level functions have null scope', () => {
    const db = openReadonlyOrFail(dbPath);
    try {
      const nodes = findNodeByQualifiedName(db, 'freeFunction');
      expect(nodes[0].scope).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('visibility column', () => {
  it('python dunder methods are not marked as protected', () => {
    // pythonVisibility('__init__') should return undefined, not 'protected'
    expect(pythonVisibility('__init__')).toBeUndefined();
    expect(pythonVisibility('__str__')).toBeUndefined();
    expect(pythonVisibility('__len__')).toBeUndefined();
    // But true name-mangled privates should still be private
    expect(pythonVisibility('__secret')).toBe('private');
    expect(pythonVisibility('_protected')).toBe('protected');
    expect(pythonVisibility('public_method')).toBeUndefined();
  });

  it('private # fields are marked as private (WASM engine)', async () => {
    // Visibility extraction requires the WASM engine (JS extractor).
    // The native engine doesn't populate visibility yet.
    const wasmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vis-wasm-'));
    try {
      for (const [file, content] of Object.entries(FIXTURE_FILES)) {
        fs.writeFileSync(path.join(wasmDir, file), content);
      }
      fs.writeFileSync(path.join(wasmDir, 'package.json'), '{"name":"test"}');
      await buildGraph(wasmDir, { engine: 'wasm' });
      const wasmDbPath = path.join(wasmDir, '.codegraph', 'graph.db');
      const db = openReadonlyOrFail(wasmDbPath);
      try {
        const nodes = findNodesByScope(db, 'DateHelper', { kind: 'property' });
        const locale = nodes.find((n) => n.name === '#locale');
        expect(locale).toBeDefined();
        expect(locale.visibility).toBe('private');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(wasmDir, { recursive: true, force: true });
    }
  });
});

describe('childrenData exposes new columns', () => {
  it('childrenData returns scope and visibility for children', () => {
    const result = childrenData('DateHelper', dbPath, { kind: 'class' });
    expect(result.results.length).toBeGreaterThan(0);
    const cls = result.results[0];
    expect(cls.qualifiedName).toBe('DateHelper');
    expect(cls.children.length).toBeGreaterThan(0);
    for (const child of cls.children) {
      expect(child).toHaveProperty('scope');
      expect(child).toHaveProperty('visibility');
      expect(child).toHaveProperty('qualifiedName');
      expect(child.scope).toBe('DateHelper');
    }
  });
});
