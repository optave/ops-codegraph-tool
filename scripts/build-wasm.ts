#!/usr/bin/env node

/**
 * Build WASM grammar files from tree-sitter grammar packages.
 *
 * Usage: node scripts/build-wasm.js
 *
 * Requires devDependencies: tree-sitter-cli + grammar packages.
 * Outputs .wasm files into grammars/ (committed to repo).
 */

import { execFileSync } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const grammarsDir = resolve(root, 'grammars');

if (!existsSync(grammarsDir)) mkdirSync(grammarsDir);

const grammars = [
  { name: 'tree-sitter-javascript', pkg: 'tree-sitter-javascript', sub: null },
  { name: 'tree-sitter-typescript', pkg: 'tree-sitter-typescript', sub: 'typescript' },
  { name: 'tree-sitter-tsx', pkg: 'tree-sitter-typescript', sub: 'tsx' },
  { name: 'tree-sitter-python', pkg: 'tree-sitter-python', sub: null },
  { name: 'tree-sitter-hcl', pkg: '@tree-sitter-grammars/tree-sitter-hcl', sub: null },
  { name: 'tree-sitter-go', pkg: 'tree-sitter-go', sub: null },
  { name: 'tree-sitter-rust', pkg: 'tree-sitter-rust', sub: null },
  { name: 'tree-sitter-java', pkg: 'tree-sitter-java', sub: null },
  { name: 'tree-sitter-c-sharp', pkg: 'tree-sitter-c-sharp', sub: null },
  { name: 'tree-sitter-ruby', pkg: 'tree-sitter-ruby', sub: null },
  { name: 'tree-sitter-php', pkg: 'tree-sitter-php', sub: 'php' },
  { name: 'tree-sitter-c', pkg: 'tree-sitter-c', sub: null },
  { name: 'tree-sitter-cpp', pkg: 'tree-sitter-cpp', sub: null },
  { name: 'tree-sitter-kotlin', pkg: 'tree-sitter-kotlin', sub: null },
  { name: 'tree-sitter-swift', pkg: 'tree-sitter-swift', sub: null },
  { name: 'tree-sitter-scala', pkg: 'tree-sitter-scala', sub: null },
  { name: 'tree-sitter-bash', pkg: 'tree-sitter-bash', sub: null },
];

let failed = 0;
for (const g of grammars) {
  const pkgDir = dirname(require.resolve(`${g.pkg}/package.json`));
  const grammarDir = g.sub ? resolve(pkgDir, g.sub) : pkgDir;

  console.log(`Building ${g.name}.wasm from ${grammarDir}...`);
  try {
    execFileSync('npx', ['tree-sitter', 'build', '--wasm', grammarDir], {
      cwd: grammarsDir,
      stdio: 'inherit',
      shell: true,
    });
    console.log(`  Done: ${g.name}.wasm`);
  } catch (err: any) {
    failed++;
    console.warn(`  WARN: Failed to build ${g.name}.wasm — ${err.message ?? 'unknown error'}`);
  }
}

if (failed > 0) {
  console.warn(`\n${failed}/${grammars.length} grammars failed to build (non-fatal — native engine available)`);
} else {
  console.log('\nAll grammars built successfully into grammars/');
}
