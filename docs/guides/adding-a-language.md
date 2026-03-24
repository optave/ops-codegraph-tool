# Adding a New Language to Codegraph

This guide walks through every file you need to touch when adding support for a
new programming language.

---

## Architecture at a Glance

Codegraph uses a **dual-engine** design:

| Engine | Technology | Availability |
|--------|-----------|--------------|
| **WASM** | `web-tree-sitter` + pre-built `.wasm` grammars | Always available (baseline) |
| **Native** | `napi-rs` + Rust tree-sitter crates | Optional; 5-10x faster; auto-fallback to WASM |

Both engines produce the same `ExtractorOutput` structure, so graph building and
queries are engine-agnostic. When adding a new language you implement the
extraction logic **twice** — once in TypeScript (WASM) and once in Rust
(native) — and a parity test guarantees they agree.

### The LANGUAGE_REGISTRY

`LANGUAGE_REGISTRY` in `src/domain/parser.ts` is the **single source of truth**
for all supported languages. Each entry declares:

```ts
{
  id: '<lang>',                            // LanguageId string
  extensions: ['.<ext>'],                  // File extensions (auto-derives EXTENSIONS)
  grammarFile: 'tree-sitter-<lang>.wasm',  // WASM grammar filename
  extractor: extract<Lang>Symbols,         // Extraction function reference
  required: false,                         // true = crash if missing; false = skip gracefully
}
```

Adding a language to the WASM engine requires **one registry entry** plus an
extractor function. Everything else — extension routing, parser loading, dispatch
— is automatic.

- `SUPPORTED_EXTENSIONS` (re-exported as `EXTENSIONS` in `shared/constants.ts`)
  is **derived** from the registry. You never edit it manually.
- `createParsers()` iterates the registry and builds a `Map<id, Parser>`.
- `getParser()` uses an extension→registry lookup map (`_extToLang`).
- `wasmExtractSymbols()` calls `entry.extractor(tree, filePath)` — no ternary chains.
- `parseFilesAuto()` in `builder.ts` handles all dispatch — no per-language routing needed.

---

## Symbol Model

Every language extractor must return `ExtractorOutput` (defined in `src/types.ts`):

```ts
interface ExtractorOutput {
  definitions: Definition[];      // functions, methods, classes, interfaces, types
  calls: Call[];                  // function / method invocations
  imports: Import[];              // module / file imports
  classes: ClassRelation[];       // extends / implements relationships
  exports: Export[];              // named exports (mainly JS/TS)
  typeMap: Map<string, TypeMapEntry>;  // symbol type annotations
  _tree?: TreeSitterTree;         // retained for CFG / dataflow analysis
  _langId?: LanguageId;           // language identifier
  _lineCount?: number;            // line count for metrics
}
```

### Field Reference

| Structure | Fields | Notes |
|-----------|--------|-------|
| `Definition` | `name`, `kind`, `line`, `endLine?`, `children?`, `visibility?`, `decorators?` | `kind` ∈ symbol kinds (see below). Methods: `ClassName.methodName`. `children` for sub-declarations (params, properties). `visibility`: `'public'` \| `'private'` \| `'protected'` |
| `Call` | `name`, `line`, `receiver?`, `dynamic?` | `receiver` for method calls (e.g. `obj` in `obj.method()`) |
| `Import` | `source`, `names[]`, `line`, `typeOnly?`, `reexport?`, `wildcardReexport?`, `dynamicImport?`, `<lang>Import?` | Set a language flag like `pythonImport: true` |
| `ClassRelation` | `name`, `extends?`, `implements?`, `line` | |
| `Export` | `name`, `kind`, `line` | |
| `TypeMapEntry` | `type`, `confidence` | Confidence 0-1 (typically 0.9 for native) |

**Symbol kinds:** `function`, `method`, `class`, `interface`, `type`, `struct`,
`enum`, `trait`, `record`, `module`, `parameter`, `property`, `constant`
(defined in `src/shared/kinds.ts`). Use the language's native kind (e.g. Go
structs → `struct`, Rust traits → `trait`, Ruby modules → `module`).

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
npm install
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

This generates `grammars/tree-sitter-<lang>.wasm` (gitignored — built from
devDeps on `npm install`).

### 3. Add extractor and registry entry

Two things to do on the TypeScript side:

#### 3a. Create `src/extractors/<lang>.ts`

Every language extractor lives in its own file under `src/extractors/` (e.g.
`go.ts`, `python.ts`, `rust.ts`). Create `src/extractors/<lang>.ts` and
re-export it from `src/extractors/index.ts`. Then import and reference the
extractor function in the `LANGUAGE_REGISTRY` array in `src/domain/parser.ts`
(see Step 3b).

Write a recursive AST walker that matches tree-sitter node types for your
language. Copy the pattern from an existing extractor like `extractGoSymbols` in
`src/extractors/go.ts` or `extractRustSymbols` in `src/extractors/rust.ts`:

```ts
/**
 * Extract symbols from <Lang> files.
 */
export function extract<Lang>Symbols(tree: TreeSitterTree, filePath: string): ExtractorOutput {
  const definitions: Definition[] = [];
  const calls: Call[] = [];
  const imports: Import[] = [];
  const classes: ClassRelation[] = [];
  const exports: Export[] = [];
  const typeMap = new Map<string, TypeMapEntry>();

  function walk(node: TreeSitterNode): void {
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

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports, typeMap };
}
```

**Tip:** Use the [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground)
to explore AST node types for your language. Paste sample code and inspect the
tree to find the right `node.type` strings.

**Visibility helpers** are available in `src/extractors/helpers.ts`:
- `goVisibility(name)` — uppercase → public (Go convention)
- `rustVisibility(node)` — extract from `visibility_modifier` child
- `pythonVisibility(name)` — `__name` → private, `_name` → protected
- `extractModifierVisibility(node, modifierTypes)` — general modifier extraction (Java, C#, PHP)

#### 3b. Add an entry to `LANGUAGE_REGISTRY`

Add your language to the `LANGUAGE_REGISTRY` array in `src/domain/parser.ts`:

```ts
{
  id: '<lang>',
  extensions: ['.<ext>'],
  grammarFile: 'tree-sitter-<lang>.wasm',
  extractor: extract<Lang>Symbols,
  required: false,
},
```

Set `required: false` so codegraph still works when the WASM grammar isn't
available (e.g. in CI without `npm install`). Only JS/TS/TSX are `required: true`.

That's it for the WASM engine. The registry automatically:
- Adds `.<ext>` to `SUPPORTED_EXTENSIONS` (and `EXTENSIONS` in `shared/constants.ts`)
- Registers the parser in `createParsers()`
- Routes `getParser()` calls via the extension map
- Dispatches to your extractor in `wasmExtractSymbols()`
- Handles `builder.ts` routing via `parseFilesAuto()`

**You do not need to edit `shared/constants.ts` or `domain/graph/builder.ts`.**

### 4. `src/domain/parser.ts` — update `patchNativeResult` (if needed)

If your language's imports use a language-specific flag (e.g. `pythonImport`),
add the camelCase mapping in `patchNativeResult()`:

```ts
if (i.<lang>Import === undefined) i.<lang>Import = i.<lang>_import;
```

---

## Native Engine (Rust)

### 5. `crates/codegraph-core/Cargo.toml` — add the Rust tree-sitter crate

```toml
[dependencies]
tree-sitter-<lang> = "0.x"
```

### 6. `crates/codegraph-core/src/parser_registry.rs` — register the language

Four changes in this file:

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

    // 4. Return the language ID string (used by dataflow/CFG rules)
    pub fn lang_id_str(&self) -> &'static str {
        match self {
            // ... existing ...
            Self::<Lang> => "<lang>",
        }
    }
}
```

### 7. `crates/codegraph-core/src/extractors/<lang>.rs` — implement the Rust extractor

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

### 8. `crates/codegraph-core/src/extractors/mod.rs` — wire it up

```rust
// 1. Declare module
pub mod <lang>;

// 2. Add dispatch arm in extract_symbols_with_opts()
//    (extract_symbols() simply delegates to this function — do NOT modify it)
pub fn extract_symbols_with_opts(..., include_ast_nodes: bool) -> FileSymbols {
    match lang {
        // ... existing ...
        LanguageKind::<Lang> => <lang>::<Lang>Extractor.extract_with_opts(tree, source, file_path, include_ast_nodes),
    }
}
```

### 9. `crates/codegraph-core/src/types.rs` — add language flag (if needed)

If your imports need a language-specific flag, add it to the `Import` struct:

```rust
pub <lang>_import: Option<bool>,
```

And update `Import::new()` to default it to `None`.

---

## Tests

### 10. `tests/parsers/<lang>.test.js` — WASM parser tests

Follow the pattern from `tests/parsers/go.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { createParsers, extract<Lang>Symbols } from '../../src/domain/parser.js';

describe('<Lang> parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parse<Lang>(code) {
    const parser = parsers.get('<lang>');
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

> **Note:** `parsers` is a `Map` — use `parsers.get('<lang>')`, not
> `parsers.<lang>Parser`. Test imports use `.js` extension for vitest resolution
> of TypeScript sources.

**Recommended test cases:**
- Function definitions (regular, with parameters)
- Class/struct/enum definitions
- Method definitions (associated with a type)
- Import/include directives
- Function calls (direct and method calls)
- Type definitions / aliases
- Visibility extraction (if applicable)
- Forward declarations (if applicable)

### 11. Parity tests — native vs WASM

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

# 4. Build native and test parity
cd crates/codegraph-core && cargo build
npx vitest run tests/engines/parity.test.js

# 5. Test on a real project
codegraph build /path/to/a/<lang>/project
codegraph map
codegraph query someFunction
```

---

## File Checklist Summary

| # | File | Engine | Action |
|---|------|--------|--------|
| 1 | `package.json` | WASM | Add `tree-sitter-<lang>` devDependency |
| 2 | `scripts/build-wasm.js` | WASM | Add grammar entry to array |
| 3 | `src/extractors/<lang>.ts` + `src/domain/parser.ts` | WASM | Create extractor in `src/extractors/`, re-export via `index.ts`, add `LANGUAGE_REGISTRY` entry |
| 4 | `src/domain/parser.ts` | WASM | Update `patchNativeResult` (if language flag needed) |
| 5 | `crates/codegraph-core/Cargo.toml` | Native | Add tree-sitter crate |
| 6 | `crates/.../parser_registry.rs` | Native | Register enum + extension + grammar + `lang_id_str` |
| 7 | `crates/.../extractors/<lang>.rs` | Native | Implement `SymbolExtractor` trait |
| 8 | `crates/.../extractors/mod.rs` | Native | Declare module + dispatch arm in `extract_symbols_with_opts()` |
| 9 | `crates/.../types.rs` | Native | Add language flag to `Import` (if needed) |
| 10 | `tests/parsers/<lang>.test.js` | WASM | Parser extraction tests |
| 11 | `tests/engines/parity.test.js` | Both | Cross-engine validation snippets |

**Files you do NOT need to touch:**
- `src/shared/constants.ts` — `EXTENSIONS` is derived from the registry automatically
- `src/shared/kinds.ts` — symbol kinds are universal across languages
- `src/domain/graph/builder.ts` — `parseFilesAuto()` uses the registry, no manual routing
- `src/types.ts` — core types stay the same; only add import flags if needed
