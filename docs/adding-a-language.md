# Adding a New Language to Codegraph

This guide walks through every file you need to touch when adding support for a
new programming language. It covers both the **WASM engine** (main branch) and
the **native Rust engine** (`feat/rust-core` branch).

---

## Architecture at a Glance

Codegraph uses a **dual-engine** design:

| Engine | Technology | Availability |
|--------|-----------|--------------|
| **WASM** | `web-tree-sitter` + pre-built `.wasm` grammars | Always available (baseline) |
| **Native** | `napi-rs` + Rust tree-sitter crates | Optional; 5-10x faster; auto-fallback to WASM |

Both engines produce the same `FileSymbols` structure, so graph building and
queries are engine-agnostic. When adding a new language you implement the
extraction logic **twice** — once in JavaScript (WASM) and once in Rust
(native) — and a parity test guarantees they agree.

---

## Symbol Model

Every language extractor must return this shape:

```
FileSymbols {
  definitions[]   – functions, methods, classes, interfaces, types
  calls[]         – function / method invocations
  imports[]       – module / file imports
  classes[]       – extends / implements relationships
  exports[]       – named exports (mainly JS/TS)
}
```

### Field Reference

| Structure | Fields | Notes |
|-----------|--------|-------|
| `Definition` | `name`, `kind`, `line`, `endLine`, `decorators?` | `kind` ∈ `function`, `method`, `class`, `interface`, `type` |
| `Call` | `name`, `line`, `dynamic?` | |
| `Import` | `source`, `names[]`, `line`, `<lang>Import?` | Set a language flag like `cInclude: true` |
| `ClassRelation` | `name`, `extends?`, `implements?`, `line` | |
| `ExportInfo` | `name`, `kind`, `line` | |

Methods inside a class use the `ClassName.methodName` naming convention.

---

## Step-by-step Checklist

Use the placeholder **`<lang>`** for your language name (e.g. `c`, `swift`,
`kotlin`) and **`<ext>`** for its file extensions.

### 1. `package.json` — add the tree-sitter grammar

```jsonc
// devDependencies (alphabetical order)
"tree-sitter-<lang>": "^0.x.y"
```

Then install:

```bash
npm install --legacy-peer-deps
```

### 2. `scripts/build-wasm.js` — register the grammar

Add an entry to the `grammars` array:

```js
{ name: 'tree-sitter-<lang>', pkg: 'tree-sitter-<lang>', sub: null },
```

> If the grammar ships sub-grammars (like `tree-sitter-typescript` ships
> `typescript` and `tsx`), set `sub` to the subdirectory name.

Build the WASM binary:

```bash
npm run build:wasm
```

This generates `grammars/tree-sitter-<lang>.wasm`. Commit this file.

### 3. `src/constants.js` — register file extensions

```js
export const EXTENSIONS = new Set([
  // ... existing ...
  '.<ext>',          // e.g. '.c', '.h'
]);
```

### 4. `src/parser.js` — WASM extraction (3 changes)

#### 4a. Load the grammar in `createParsers()`

Follow the graceful-fallback pattern used by every optional language:

```js
let <lang>Parser = null;
try {
  const <Lang> = await Language.load(grammarPath('tree-sitter-<lang>.wasm'));
  <lang>Parser = new Parser();
  <lang>Parser.setLanguage(<Lang>);
} catch (e) {
  warn(`<Lang> parser failed to initialize: ${e.message}. <Lang> files will be skipped.`);
}
```

Return it from the object: `return { ..., <lang>Parser };`

#### 4b. Route extensions in `getParser()`

```js
if ((filePath.endsWith('.<ext>')) && parsers.<lang>Parser)
  return parsers.<lang>Parser;
```

> Place this *before* the `return null;` at the end of `getParser()`.

#### 4c. Create `extract<Lang>Symbols(tree, filePath)`

This is where the real work happens. Write a recursive AST walker that matches
tree-sitter node types for your language. Copy the pattern from an existing
extractor like `extractGoSymbols` or `extractRustSymbols`:

```js
/**
 * Extract symbols from <Lang> files.
 */
export function extract<Lang>Symbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walk(node) {
    switch (node.type) {
      // ── Definitions ──
      case '<function_node_type>': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
        }
        break;
      }

      // ── Classes / Structs ──
      case '<class_node_type>': {
        // ...
        break;
      }

      // ── Imports ──
      case '<import_node_type>': {
        // ...
        imports.push({
          source: '...',
          names: [...],
          line: node.startPosition.row + 1,
          <lang>Import: true,        // language flag
        });
        break;
      }

      // ── Calls ──
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn && fn.type === 'identifier') {
          calls.push({ name: fn.text, line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}
```

**Tip:** Use the [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground)
to explore AST node types for your language. Paste sample code and inspect the
tree to find the right `node.type` strings.

#### 4d. Add WASM dispatch in `wasmExtractSymbols()` (feat/rust-core only)

On the `feat/rust-core` branch, `parser.js` has a unified `wasmExtractSymbols`
helper. Add your language before the final `return extractSymbols(...)`:

```js
if (filePath.endsWith('.<ext>')) return extract<Lang>Symbols(tree, filePath);
```

### 5. `src/builder.js` — route parsing (main branch only)

On `main`, the builder dispatches manually. On `feat/rust-core` this is
replaced by `parseFilesAuto`, so **skip this step on the rust branch**.

**main branch** — add your language to the import and ternary chain:

```js
// Import
import { ..., extract<Lang>Symbols } from './parser.js';

// In the parsing loop, add before `extractSymbols(tree, filePath)`
const is<Lang> = filePath.endsWith('.<ext>');
// ... add to the ternary chain:
: is<Lang> ? extract<Lang>Symbols(tree, filePath)
```

### 6. `src/parser.js` — update `normalizeNativeSymbols` (feat/rust-core only)

If your language's imports use a language-specific flag (e.g. `c_include`), add
the camelCase mapping:

```js
<lang>Import: i.<lang>Import ?? i.<lang>_import,
```

---

## Native Engine (feat/rust-core branch)

### 7. `crates/codegraph-core/Cargo.toml` — add the Rust tree-sitter crate

```toml
[dependencies]
tree-sitter-<lang> = "0.x"
```

### 8. `crates/codegraph-core/src/parser_registry.rs` — register the language

Three changes in this file:

```rust
// 1. Add enum variant
pub enum LanguageKind {
    // ... existing ...
    <Lang>,
}

// 2. Map extensions in from_extension()
impl LanguageKind {
    pub fn from_extension(file_path: &str) -> Option<Self> {
        match ext {
            // ... existing ...
            "<ext>" => Some(Self::<Lang>),
            _ => None,
        }
    }

    // 3. Return the tree-sitter Language
    pub fn tree_sitter_language(&self) -> Language {
        match self {
            // ... existing ...
            Self::<Lang> => tree_sitter_<lang>::LANGUAGE.into(),
        }
    }
}
```

### 9. `crates/codegraph-core/src/extractors/<lang>.rs` — implement the Rust extractor

Create a new file following the pattern in `go.rs` or `rust_lang.rs`:

```rust
use tree_sitter::{Node, Tree};
use crate::types::*;
use super::helpers::*;
use super::SymbolExtractor;

pub struct <Lang>Extractor;

impl SymbolExtractor for <Lang>Extractor {
    fn extract(&self, tree: &Tree, source: &[u8], file_path: &str) -> FileSymbols {
        let mut symbols = FileSymbols::new(file_path.to_string());
        walk_node(&tree.root_node(), source, &mut symbols);
        symbols
    }
}

fn walk_node(node: &Node, source: &[u8], symbols: &mut FileSymbols) {
    match node.kind() {
        "<function_node_type>" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                symbols.definitions.push(Definition {
                    name: node_text(&name_node, source).to_string(),
                    kind: "function".to_string(),
                    line: start_line(node),
                    end_line: Some(end_line(node)),
                    decorators: None,
                });
            }
        }

        // ... match other AST node types ...

        _ => {}
    }

    for i in 0..node.child_count() {
        if let Some(child) = node.child(i) {
            walk_node(&child, source, symbols);
        }
    }
}
```

**Available helpers** (from `helpers.rs`):

| Function | Purpose |
|----------|---------|
| `node_text(&node, source)` | Get node text as `&str` |
| `find_child(&node, "kind")` | First child of a given type |
| `find_parent_of_type(&node, "kind")` | Walk up to find parent |
| `find_parent_of_types(&node, &["a","b"])` | Walk up, match any type |
| `named_child_text(&node, "field", source)` | Shorthand for field text |
| `start_line(&node)` / `end_line(&node)` | 1-based line numbers |

### 10. `crates/codegraph-core/src/extractors/mod.rs` — wire it up

```rust
// 1. Declare module
pub mod <lang>;

// 2. Add dispatch arm in extract_symbols()
pub fn extract_symbols(...) -> FileSymbols {
    match lang {
        // ... existing ...
        LanguageKind::<Lang> => <lang>::<Lang>Extractor.extract(tree, source, file_path),
    }
}
```

### 11. `crates/codegraph-core/src/types.rs` — add language flag (if needed)

If your imports need a language-specific flag, add it to the `Import` struct:

```rust
pub <lang>_import: Option<bool>,
```

And update `Import::new()` to default it to `None`.

---

## Tests

### 12. `tests/parsers/<lang>.test.js` — WASM parser tests

Follow the pattern from `tests/parsers/go.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { createParsers, extract<Lang>Symbols } from '../../src/parser.js';

describe('<Lang> parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parse<Lang>(code) {
    const parser = parsers.<lang>Parser;
    if (!parser) throw new Error('<Lang> parser not available');
    const tree = parser.parse(code);
    return extract<Lang>Symbols(tree, 'test.<ext>');
  }

  it('extracts function definitions', () => {
    const symbols = parse<Lang>(`<sample code>`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'myFunc', kind: 'function' })
    );
  });

  // Test: classes/structs, methods, imports, calls, type definitions, etc.
});
```

**Recommended test cases:**
- Function definitions (regular, with parameters)
- Class/struct/enum definitions
- Method definitions (associated with a type)
- Import/include directives
- Function calls (direct and method calls)
- Type definitions / aliases
- Forward declarations (if applicable)

### 13. Parity tests (feat/rust-core only)

Add test snippets to `tests/engines/parity.test.js` to verify the native and
WASM extractors produce identical output for your language.

---

## Verification

```bash
# 1. Build WASM grammar
npm run build:wasm

# 2. Run your parser tests
npx vitest run tests/parsers/<lang>.test.js

# 3. Run the full test suite
npm test

# 4. (feat/rust-core) Build native and test parity
cd crates/codegraph-core && cargo build
npx vitest run tests/engines/parity.test.js
```

---

## File Checklist Summary

| # | File | Branch | Action |
|---|------|--------|--------|
| 1 | `package.json` | both | Add `tree-sitter-<lang>` devDependency |
| 2 | `scripts/build-wasm.js` | both | Add grammar entry |
| 3 | `grammars/tree-sitter-<lang>.wasm` | both | Generated by `npm run build:wasm` |
| 4 | `src/constants.js` | both | Add file extensions |
| 5 | `src/parser.js` | both | Load grammar, route parser, add `extract<Lang>Symbols()`, add WASM dispatch |
| 6 | `src/builder.js` | main only | Import + ternary routing (not needed on rust branch) |
| 7 | `tests/parsers/<lang>.test.js` | both | WASM parser tests |
| 8 | `crates/codegraph-core/Cargo.toml` | rust | Add tree-sitter crate |
| 9 | `crates/.../parser_registry.rs` | rust | Register enum + extension + grammar |
| 10 | `crates/.../extractors/<lang>.rs` | rust | Implement `SymbolExtractor` trait |
| 11 | `crates/.../extractors/mod.rs` | rust | Declare module + dispatch arm |
| 12 | `crates/.../types.rs` | rust | Add language flag to `Import` (if needed) |
| 13 | `tests/engines/parity.test.js` | rust | Cross-engine validation snippets |
