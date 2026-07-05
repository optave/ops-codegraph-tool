/**
 * Shared source-scanning heuristics for mapping declaration positions to
 * codegraph-style symbol names.
 *
 * Used by codegraph's external call-graph comparison tooling
 * (scripts/import-jelly-micro.mjs, scripts/compare-tools.mjs) to correlate
 * Jelly's line-indexed function specs and ACG's textual function names with
 * codegraph's own naming scheme.
 *
 * This is a line-oriented regex heuristic (not an AST parse) — it walks
 * source text, tracks the enclosing class via a brace-depth counter, and
 * matches an ordered set of declaration patterns. It's good enough for the
 * small hand-authored benchmark fixtures these tools run against; it is not
 * a general-purpose JS parser.
 */

import fs from 'node:fs';
import path from 'node:path';

// Bare words that can be mistaken for a class-body method declaration when
// they're the first word before `(` on a line (e.g. `return (x) => …`).
const METHOD_KEYWORD_EXCLUSIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new']);
const OBJECT_METHOD_KEYWORD_EXCLUSIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function']);

const CLASS_DECL_RE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;

/**
 * Matchers evaluated on every line regardless of class scope, in priority
 * order. Each: { regex, extract(match) => name, guard?(line, match) => boolean }
 */
const TOP_LEVEL_MATCHERS = [
  {
    // function foo() / export default function* foo()
    regex: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+(\w+)\s*[\(<]/,
    extract: (m) => m[1],
  },
  {
    // const/let/var foo = function ... | foo = () => ...
    regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/,
    guard: (line) => line.includes('=>') || line.includes('function'),
    extract: (m) => m[1],
  },
  {
    // Foo.prototype.bar = function() {}
    regex: /^\s*(\w+)\.prototype\.(\w+)\s*=\s*function/,
    extract: (m) => `${m[1]}.${m[2]}`,
  },
  {
    // Foo.bar = function() {}
    regex: /^\s*(\w+)\.(\w+)\s*=\s*function/,
    extract: (m) => `${m[1]}.${m[2]}`,
  },
];

/**
 * Matchers evaluated only while inside a class body. `extract` receives the
 * regex match and the enclosing class name. The constructor matcher is
 * flagged separately (`isConstructor`) since it needs distinct accumulation
 * in name-lookup consumers (ACG labels constructor call targets literally as
 * "constructor", not "<Class>.constructor").
 */
const CLASS_MEMBER_MATCHERS = [
  {
    regex: /^\s+constructor\s*\(/,
    isConstructor: true,
    extract: (_m, cls) => cls,
  },
  {
    // static { ... }
    regex: /^\s+static\s*\{/,
    extract: (_m, cls) => `${cls}.<static>`,
  },
  {
    // static foo = ... (only when it looks like a function/call, not a plain value)
    regex: /^\s+static\s+(\w+)\s*=/,
    guard: (line) => line.includes('=>') || line.includes('function') || line.includes('('),
    extract: (m, cls) => `${cls}.${m[1]}`,
  },
  {
    // named method, incl. async/static/get/set/generator
    regex: /^\s+(?:(?:static|async|get|set)\s+)*(?:\*\s*)?(\w+)\s*\(/,
    guard: (_line, m) => !METHOD_KEYWORD_EXCLUSIONS.has(m[1]),
    extract: (m, cls) => `${cls}.${m[1]}`,
  },
  {
    // class field arrow: foo = () => {}
    regex: /^\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    extract: (m, cls) => `${cls}.${m[1]}`,
  },
];

/**
 * Object-literal matchers, evaluated as the final fallback on any line not
 * already claimed by a top-level or class-member matcher.
 */
const OBJECT_MEMBER_MATCHERS = [
  {
    // { foo() {} } or { async foo() {} }
    regex: /^\s+(?:async\s+)?(\w+)\s*\(.*\)\s*\{/,
    guard: (_line, m) => !OBJECT_METHOD_KEYWORD_EXCLUSIONS.has(m[1]),
    extract: (m) => m[1],
  },
  {
    // foo: function() {} or foo: () => {}
    regex: /^\s+(\w+)\s*:\s*(?:async\s+)?(?:function|\(|[a-zA-Z_$].*=>)/,
    extract: (m) => m[1],
  },
];

/** Run `line` through an ordered matcher list; return the first hit or null. */
function tryMatchers(line, matchers, ctx) {
  for (const matcher of matchers) {
    const m = line.match(matcher.regex);
    if (!m) continue;
    if (matcher.guard && !matcher.guard(line, m)) continue;
    return { name: matcher.extract(m, ctx), isConstructor: !!matcher.isConstructor };
  }
  return null;
}

/**
 * Walk `src` line by line, tracking the enclosing class via a brace-depth
 * counter, and invoke `onDeclaration(entry)` for every recognized
 * class/function/method declaration.
 *
 * `entry` is `{ line, name, className, isConstructor }` (1-based line
 * number). `className` is set only for members matched inside a class body;
 * `isConstructor` distinguishes constructor declarations from other members
 * that resolve to the same "ClassName" value (the class declaration itself).
 *
 * This is the shared scanning core behind both benchmark tools' heuristic
 * name resolution: position→name for Jelly's line-indexed call graph, and
 * name→qualified-name lookups for ACG's textual output.
 */
export function scanDeclarations(src, onDeclaration) {
  const lines = src.split('\n');
  let currentClass = null;
  let classDepth = 0;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    const classMatch = line.match(CLASS_DECL_RE);
    if (classMatch) {
      currentClass = classMatch[1];
      classDepth = braceDepth;
    }

    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (currentClass !== null && braceDepth === classDepth) currentClass = null;
      }
    }

    if (classMatch) {
      onDeclaration({ line: lineNo, name: classMatch[1], className: null, isConstructor: false });
      continue;
    }

    const topLevel = tryMatchers(line, TOP_LEVEL_MATCHERS, null);
    if (topLevel) {
      onDeclaration({ line: lineNo, name: topLevel.name, className: null, isConstructor: false });
      continue;
    }

    if (currentClass !== null) {
      const member = tryMatchers(line, CLASS_MEMBER_MATCHERS, currentClass);
      if (member) {
        onDeclaration({
          line: lineNo,
          name: member.name,
          className: currentClass,
          isConstructor: member.isConstructor,
        });
        continue;
      }
    }

    const obj = tryMatchers(line, OBJECT_MEMBER_MATCHERS, null);
    if (obj) {
      onDeclaration({ line: lineNo, name: obj.name, className: null, isConstructor: false });
    }
  }
}

/**
 * Build a Map<"line:1", name> for all functions/methods/classes in a single
 * JS source string (1-based line, column normalised to 1 on insert).
 *
 * Used by import-jelly-micro.mjs to resolve Jelly's line-indexed function
 * specs within one source file.
 */
export function buildLineNameMap(src) {
  const nameMap = new Map();
  scanDeclarations(src, (d) => nameMap.set(`${d.line}:1`, d.name));
  return nameMap;
}

/**
 * Build a Map<"filename:line", name> across every file in `dir` whose
 * extension is in `exts`.
 *
 * Used by compare-tools.mjs to resolve Jelly's (file, line) function specs
 * against a multi-file fixture directory.
 */
export function buildFileLineNameMap(dir, exts) {
  const nameMap = new Map();
  for (const filename of fs.readdirSync(dir)) {
    if (!exts.some((e) => filename.endsWith(e))) continue;
    const src = fs.readFileSync(path.join(dir, filename), 'utf8');
    scanDeclarations(src, (d) => nameMap.set(`${filename}:${d.line}`, d.name));
  }
  return nameMap;
}

/**
 * Build a Map<"filename:unqualifiedName", Set<qualifiedName>> across every
 * file in `dir` whose extension is in `exts`.
 *
 * Used by compare-tools.mjs to resolve ACG's unqualified function names (no
 * class prefix) back to codegraph-style qualified names. A Set is needed
 * because multiple classes in the same file can share a method name (e.g.
 * Shape.area + Circle.area + Rectangle.area) — callers should try all
 * candidates rather than assume a 1:1 mapping.
 *
 * Constructors are indexed under the literal key "constructor" (ACG labels
 * constructor call targets that way), mapping to the enclosing class name.
 */
export function buildFileNameLookup(dir, exts) {
  const lookup = new Map();
  const add = (key, value) => {
    const existing = lookup.get(key);
    if (existing) existing.add(value);
    else lookup.set(key, new Set([value]));
  };

  for (const filename of fs.readdirSync(dir)) {
    if (!exts.some((e) => filename.endsWith(e))) continue;
    const src = fs.readFileSync(path.join(dir, filename), 'utf8');
    scanDeclarations(src, (d) => {
      if (d.isConstructor) {
        add(`${filename}:constructor`, d.name);
      } else if (d.className) {
        const member = d.name.slice(d.className.length + 1);
        add(`${filename}:${member}`, d.name);
      } else {
        add(`${filename}:${d.name}`, d.name);
      }
    });
  }
  return lookup;
}
