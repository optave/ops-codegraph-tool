#!/usr/bin/env node

/**
 * Verify that all dynamic import() paths in src/ resolve to existing files.
 *
 * Catches stale paths left behind after moves/renames — the class of bug
 * that caused the ast-command crash (see roadmap 10.3).
 *
 * Exit codes:
 *   0 — all imports resolve
 *   1 — one or more broken imports found
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcDir = resolve(__dirname, '..', 'src');

// ── collect source files ────────────────────────────────────────────────
function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      results.push(...walk(full));
    } else if (/\.[jt]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── extract dynamic import specifiers ───────────────────────────────────
// Matches:  import('...')  and  import("...") — with or without await
const DYNAMIC_IMPORT_RE = /(?:await\s+)?import\(\s*(['"])(.+?)\1\s*\)/g;

/**
 * Check whether the text contains a `//` line-comment marker that is NOT
 * inside a string literal. Walks character-by-character tracking quote state.
 */
function isInsideLineComment(text) {
  let inStr = null; // null | "'" | '"' | '`'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inStr) { i++; continue; } // skip escaped char
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    if (ch === '/' && text[i + 1] === '/') return true;
  }
  return false;
}

function extractDynamicImports(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const imports = [];
  const lines = src.split('\n');

  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track block comments (/** ... */ and /* ... */)
    let scanLine = line;
    if (inBlockComment) {
      const closeIdx = scanLine.indexOf('*/');
      if (closeIdx === -1) continue; // still fully inside a block comment
      inBlockComment = false;
      scanLine = scanLine.slice(closeIdx + 2); // scan content after */
    }
    // Skip single-line comments
    if (/^\s*\/\//.test(scanLine)) continue;
    if (scanLine.includes('/*')) {
      // Remove fully closed inline block comments: code /* ... */ more code
      scanLine = scanLine.replace(/\/\*.*?\*\//g, '');
      // If an unclosed /* remains, keep only the part before it and enter block mode
      const openIdx = scanLine.indexOf('/*');
      if (openIdx !== -1) {
        scanLine = scanLine.slice(0, openIdx);
        inBlockComment = true;
      }
    }

    let match;
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    while ((match = DYNAMIC_IMPORT_RE.exec(scanLine)) !== null) {
      // Skip if the match is inside a trailing line comment (// outside quotes)
      const before = scanLine.slice(0, match.index);
      if (isInsideLineComment(before)) continue;

      imports.push({ specifier: match[2], line: i + 1 });
    }
  }
  return imports;
}

// ── resolve a specifier to a file on disk ───────────────────────────────
function resolveSpecifier(specifier, fromFile) {
  // Skip bare specifiers (packages): 'node:*', '@scope/pkg', 'pkg'
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  const base = dirname(fromFile);
  const target = resolve(base, specifier);

  // Exact file exists
  if (existsSync(target) && statSync(target).isFile()) return null;

  // .js → .ts fallback (mirrors the ESM resolver hook for incremental TS migration)
  if (specifier.endsWith('.js')) {
    const tsTarget = target.replace(/\.js$/, '.ts');
    if (existsSync(tsTarget) && statSync(tsTarget).isFile()) return null;
  }

  // Try implicit extensions (.js, .ts, .mjs, .cjs)
  for (const ext of ['.js', '.ts', '.mjs', '.cjs']) {
    if (!extname(target) && existsSync(target + ext)) return null;
  }

  // Try index files (directory import)
  if (existsSync(target) && statSync(target).isDirectory()) {
    for (const idx of ['index.js', 'index.ts', 'index.mjs']) {
      if (existsSync(join(target, idx))) return null;
    }
  }

  // Not resolved — broken
  return specifier;
}

// ── main ────────────────────────────────────────────────────────────────
const files = walk(srcDir);
const broken = [];

for (const file of files) {
  const imports = extractDynamicImports(file);
  for (const { specifier, line } of imports) {
    const bad = resolveSpecifier(specifier, file);
    if (bad !== null) {
      const rel = file.replace(resolve(srcDir, '..') + '/', '').replace(/\\/g, '/');
      broken.push({ file: rel, line, specifier: bad });
    }
  }
}

if (broken.length === 0) {
  console.log(`✓ All dynamic imports in src/ resolve (${files.length} files scanned)`);
  process.exit(0);
} else {
  console.error(`✗ ${broken.length} broken dynamic import(s) found:\n`);
  for (const { file, line, specifier } of broken) {
    console.error(`  ${file}:${line}  →  ${specifier}`);
  }
  console.error('\nFix the import paths and re-run.');
  process.exit(1);
}
