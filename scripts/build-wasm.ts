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
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const grammarsDir = resolve(root, 'grammars');

if (!existsSync(grammarsDir)) mkdirSync(grammarsDir);

// Allowed WASM imports — pure C runtime / memory primitives only (no I/O, no syscalls)
const ALLOWED_WASM_IMPORTS = new Set([
  'env.memory',
  'env.__indirect_function_table',
  'env.__memory_base',
  'env.__stack_pointer',
  'env.__table_base',
  'env.abort',
  'env.__assert_fail',
  'env.calloc',
  'env.malloc',
  'env.realloc',
  'env.free',
  'env.memchr',
  'env.memcmp',
  'env.strcmp',
  'env.strlen',
  'env.iswalnum',
  'env.iswalpha',
  'env.iswlower',
  'env.iswspace',
  'env.iswupper',
  'env.iswxdigit',
  'env.towupper',
]);

const WASM_MAGIC = '0061736d';

async function validateGrammar(wasmPath: string, expectedName: string): Promise<string[]> {
  const errors: string[] = [];
  const buf = readFileSync(wasmPath);

  if (buf.slice(0, 4).toString('hex') !== WASM_MAGIC) {
    errors.push('not a valid WASM binary (bad magic bytes)');
    return errors;
  }

  const mod = await WebAssembly.compile(buf);
  const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
  const imports = WebAssembly.Module.imports(mod).map((e) => `${e.module}.${e.name}`);

  const tsExports = exports.filter((e) => e.startsWith('tree_sitter_'));
  if (tsExports.length !== 1) {
    errors.push(`expected 1 tree_sitter_ export, found ${tsExports.length}: [${tsExports.join(', ')}]`);
  }

  // Verify the export name matches the expected grammar (prevents substitution attacks)
  const expectedExport = expectedName.replace(/-/g, '_');
  if (tsExports.length === 1 && tsExports[0] !== expectedExport) {
    errors.push(`expected export '${expectedExport}', found '${tsExports[0]}'`);
  }

  if (exports.length < 2) {
    errors.push(`expected at least 2 exports, found ${exports.length}: [${exports.join(', ')}]`);
  }

  const disallowed = imports.filter((i) => !ALLOWED_WASM_IMPORTS.has(i));
  if (disallowed.length > 0) {
    errors.push(`disallowed WASM imports: [${disallowed.join(', ')}]`);
  }

  return errors;
}

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
  { name: 'tree-sitter-elixir', pkg: 'tree-sitter-elixir', sub: null },
  { name: 'tree-sitter-lua', pkg: '@tree-sitter-grammars/tree-sitter-lua', sub: null },
  { name: 'tree-sitter-dart', pkg: 'tree-sitter-dart', sub: null },
  { name: 'tree-sitter-zig', pkg: '@tree-sitter-grammars/tree-sitter-zig', sub: null },
  { name: 'tree-sitter-haskell', pkg: 'tree-sitter-haskell', sub: null },
  { name: 'tree-sitter-ocaml', pkg: 'tree-sitter-ocaml', sub: 'grammars/ocaml' },
  { name: 'tree-sitter-ocaml_interface', pkg: 'tree-sitter-ocaml', sub: 'grammars/interface' },
  { name: 'tree-sitter-fsharp', pkg: 'tree-sitter-fsharp', sub: 'fsharp' },
  { name: 'tree-sitter-gleam', pkg: 'tree-sitter-gleam', sub: null },
  { name: 'tree-sitter-clojure', pkg: 'tree-sitter-clojure', sub: null },
  { name: 'tree-sitter-julia', pkg: 'tree-sitter-julia', sub: null },
  { name: 'tree-sitter-r', pkg: '@eagleoutice/tree-sitter-r', sub: null },
  { name: 'tree-sitter-erlang', pkg: 'tree-sitter-erlang', sub: null },
  { name: 'tree-sitter-solidity', pkg: 'tree-sitter-solidity', sub: null },
  { name: 'tree-sitter-objc', pkg: 'tree-sitter-objc', sub: null },
  { name: 'tree-sitter-cuda', pkg: 'tree-sitter-cuda', sub: null },
  { name: 'tree-sitter-groovy', pkg: 'tree-sitter-groovy', sub: null },
  { name: 'tree-sitter-verilog', pkg: 'tree-sitter-verilog', sub: null },
];

let failed = 0;
let rejected = 0;

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
  } catch (err: any) {
    failed++;
    console.warn(`  WARN: Failed to build ${g.name}.wasm — ${err.message ?? 'unknown error'}`);
    continue;
  }

  // Validate the built grammar is a legitimate tree-sitter WASM module
  const wasmFile = resolve(grammarsDir, `${g.name}.wasm`);
  if (!existsSync(wasmFile)) {
    failed++;
    console.warn(`  WARN: ${g.name}.wasm not found after build`);
    continue;
  }

  const errors = await validateGrammar(wasmFile, g.name);
  if (errors.length > 0) {
    rejected++;
    unlinkSync(wasmFile);
    console.error(`  REJECTED: ${g.name}.wasm failed validation and was deleted:`);
    for (const e of errors) console.error(`    - ${e}`);
  } else {
    console.log(`  OK: ${g.name}.wasm (validated)`);
  }
}

const total = failed + rejected;
if (total > 0) {
  console.warn(`\n${failed} build failures, ${rejected} validation rejections out of ${grammars.length} grammars (non-fatal — native engine available)`);
  if (rejected > 0) {
    console.error('SECURITY: Some grammars were rejected — inspect the source packages before retrying.');
  }
} else {
  console.log('\nAll grammars built and validated successfully into grammars/');
}
