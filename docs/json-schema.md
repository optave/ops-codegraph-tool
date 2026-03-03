# JSON Schema — Stable Symbol Metadata

Every codegraph command that returns symbol data includes a **stable base shape** of 7 fields. Commands may add extra fields (e.g. `similarity`, `callees`), but these 7 are always present.

## Base Symbol Shape

| Field      | Type              | Description |
|------------|-------------------|-------------|
| `name`     | `string`          | Symbol identifier (e.g. `"buildGraph"`, `"MyClass.method"`) |
| `kind`     | `string`          | Symbol kind — see [Valid Kinds](#valid-kinds) |
| `file`     | `string`          | Repo-relative file path (forward slashes) |
| `line`     | `number`          | 1-based start line |
| `endLine`  | `number \| null`  | 1-based end line, or `null` if unavailable |
| `role`     | `string \| null`  | Architectural role classification, or `null` if unclassified — see [Valid Roles](#valid-roles) |
| `fileHash` | `string \| null`  | SHA-256 hash of the file at build time, or `null` if unavailable |

### Valid Kinds

```
function  method  class  interface  type  struct  enum  trait  record  module
```

Language-specific types use their native kind (e.g. Go structs use `struct`, Rust traits use `trait`, Ruby modules use `module`).

### Valid Roles

```
entry  core  utility  adapter  dead  leaf
```

Roles are assigned during `codegraph build` based on call-graph topology. Symbols without enough signal remain `null`.

## Command Envelopes

### `where` (symbol mode)

```jsonc
{
  "target": "buildGraph",
  "mode": "symbol",
  "results": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123...",
      "exported": true,           // ← command-specific
      "uses": [                   // lightweight refs (4 fields)
        { "name": "parseFile", "file": "src/parser.js", "line": 10 }
      ]
    }
  ]
}
```

### `query`

```jsonc
{
  "query": "buildGraph",
  "results": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123...",
      "callees": [                // lightweight refs
        { "name": "parseFile", "kind": "function", "file": "src/parser.js", "line": 10, "edgeKind": "calls" }
      ],
      "callers": [
        { "name": "main", "kind": "function", "file": "src/cli.js", "line": 5, "edgeKind": "calls" }
      ]
    }
  ]
}
```

### `fn` (fnDeps)

```jsonc
{
  "name": "buildGraph",
  "results": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123...",
      "callees": [/* lightweight */],
      "callers": [/* lightweight */],
      "transitiveCallers": { "2": [/* lightweight */] }
    }
  ]
}
```

### `fn-impact`

```jsonc
{
  "name": "buildGraph",
  "results": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123...",
      "levels": { "1": [/* lightweight */], "2": [/* lightweight */] },
      "totalDependents": 5
    }
  ]
}
```

### `explain` (function mode)

```jsonc
{
  "kind": "function",
  "results": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123...",
      "lineCount": 138,           // ← command-specific
      "summary": "...",
      "signature": "...",
      "complexity": { ... },
      "callees": [/* lightweight */],
      "callers": [/* lightweight */],
      "relatedTests": [/* { file } */]
    }
  ]
}
```

### `search` / `multi-search` / `fts` / `hybrid`

```jsonc
{
  "results": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123...",
      "similarity": 0.85          // ← search-specific (varies by mode)
    }
  ]
}
```

### `list-functions`

```jsonc
{
  "count": 42,
  "functions": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123..."
    }
  ]
}
```

### `roles`

```jsonc
{
  "count": 42,
  "summary": { "core": 10, "utility": 20, "entry": 5, "leaf": 7 },
  "symbols": [
    {
      "name": "buildGraph",       // ← base 7
      "kind": "function",
      "file": "src/builder.js",
      "line": 42,
      "endLine": 180,
      "role": "core",
      "fileHash": "abc123..."
    }
  ]
}
```

## Lightweight Inner References

Nested/secondary references (callees, callers, transitive hops, path nodes) use a lightweight 4-field shape:

| Field  | Type     |
|--------|----------|
| `name` | `string` |
| `kind` | `string` |
| `file` | `string` |
| `line` | `number` |

Some contexts add extra fields like `edgeKind` or `viaHierarchy`.

## Notes

- `variable` is not a tracked kind — codegraph tracks function/type-level symbols only.
- Iterator functions (`iterListFunctions`, `iterRoles`) yield `endLine` and `role` but not `fileHash` (streaming avoids holding DB open for per-row hash lookups).
- The `normalizeSymbol(row, db, hashCache)` utility is exported from both `src/queries.js` and `src/index.js` for programmatic consumers.
