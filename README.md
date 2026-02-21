<p align="center">
  <img src="https://img.shields.io/badge/codegraph-dependency%20intelligence-blue?style=for-the-badge&logo=graphql&logoColor=white" alt="codegraph" />
</p>

<h1 align="center">codegraph</h1>

<p align="center">
  <strong>Local code dependency graph CLI — parse, query, and visualize your codebase at file and function level.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codegraph"><img src="https://img.shields.io/npm/v/codegraph?style=flat-square&logo=npm&logoColor=white&label=npm" alt="npm version" /></a>
  <a href="https://github.com/optave/codegraph/blob/main/LICENSE"><img src="https://img.shields.io/github/license/optave/codegraph?style=flat-square&logo=opensourceinitiative&logoColor=white" alt="MIT License" /></a>
  <a href="https://github.com/optave/codegraph/actions"><img src="https://img.shields.io/github/actions/workflow/status/optave/codegraph/codegraph-impact.yml?style=flat-square&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/platform-local%20only-important?style=flat-square&logo=shield&logoColor=white" alt="Local Only" />
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-features">Features</a> •
  <a href="#-commands">Commands</a> •
  <a href="#-language-support">Languages</a> •
  <a href="#-ai-agent-integration">AI Integration</a> •
  <a href="#-ci--github-actions">CI/CD</a> •
  <a href="#-contributing">Contributing</a>
</p>

---

> **Zero network calls. Zero telemetry. Your code never leaves your machine.**
>
> Codegraph uses [tree-sitter](https://tree-sitter.github.io/) (via WASM — no native compilation required) to parse your codebase into an AST, extracts functions, classes, imports, and call sites, resolves dependencies, and stores everything in a local SQLite database. Query it instantly from the command line.

---

## 🚀 Quick Start

```bash
# Install
git clone https://github.com/optave/codegraph.git
cd codegraph
npm install
npm link

# Build a graph for any project
cd your-project
codegraph build        # → .codegraph/graph.db created

# Start exploring
codegraph map          # see most-connected files
codegraph query myFunc # find any function, see callers & callees
codegraph deps src/index.ts  # file-level import/export map
```

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔍 | **Symbol search** | Find any function, class, or method by name with callers/callees |
| 📁 | **File dependencies** | See what a file imports and what imports it |
| 💥 | **Impact analysis** | Trace every file affected by a change (transitive) |
| 🧬 | **Function-level tracing** | Call chains, caller trees, and function-level impact |
| 📊 | **Diff impact** | Parse `git diff`, find overlapping functions, trace their callers |
| 🗺️ | **Module map** | Bird's-eye view of your most-connected files |
| 🔄 | **Cycle detection** | Find circular dependencies at file or function level |
| 📤 | **Export** | DOT (Graphviz), Mermaid, and JSON graph export |
| 🧠 | **Semantic search** | Embeddings-powered natural language code search |
| 👀 | **Watch mode** | Incrementally update the graph as files change |
| 🤖 | **MCP server** | Model Context Protocol integration for AI assistants |
| 🔒 | **Fully local** | No network calls, no data exfiltration, SQLite-backed |

## 📦 Commands

### Build & Watch

```bash
codegraph build [dir]          # Parse and build the dependency graph
codegraph build --no-incremental  # Force full rebuild
codegraph watch [dir]          # Watch for changes, update graph incrementally
```

### Query & Explore

```bash
codegraph query <name>         # Find a symbol — shows callers and callees
codegraph deps <file>          # File imports/exports
codegraph map                  # Top 20 most-connected files
codegraph map -n 50            # Top 50
```

### Impact Analysis

```bash
codegraph impact <file>        # Transitive reverse dependency trace
codegraph fn <name>            # Function-level: callers, callees, call chain
codegraph fn <name> --no-tests --depth 5
codegraph fn-impact <name>     # What functions break if this one changes
codegraph diff-impact          # Impact of unstaged git changes
codegraph diff-impact --staged # Impact of staged changes
codegraph diff-impact HEAD~3   # Impact vs a specific ref
```

### Export & Visualization

```bash
codegraph export -f dot        # Graphviz DOT format
codegraph export -f mermaid    # Mermaid diagram
codegraph export -f json       # JSON graph
codegraph export --functions -o graph.dot  # Function-level, write to file
codegraph cycles               # Detect circular dependencies
codegraph cycles --functions   # Function-level cycles
```

### Semantic Search

```bash
codegraph embed                # Build embeddings (requires prior build)
codegraph search "handle authentication"  # Natural language search
codegraph search "parse config" --min-score 0.4 -n 10
codegraph models               # List available embedding models
```

### AI Integration

```bash
codegraph mcp                  # Start MCP server for AI assistants
```

### Common Flags

| Flag | Description |
|---|---|
| `-d, --db <path>` | Custom path to `graph.db` |
| `-T, --no-tests` | Exclude `.test.`, `.spec.`, `__test__` files |
| `--depth <n>` | Transitive trace depth (default varies by command) |
| `-j, --json` | Output as JSON |
| `-v, --verbose` | Enable debug output |

## 🌐 Language Support

| Language | Extensions | Coverage |
|---|---|---|
| ![JavaScript](https://img.shields.io/badge/-JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) | `.js`, `.jsx`, `.mjs`, `.cjs` | Full — functions, classes, imports, call sites |
| ![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) | `.ts`, `.tsx` | Full — interfaces, type aliases, `.d.ts` |
| ![Python](https://img.shields.io/badge/-Python-3776AB?style=flat-square&logo=python&logoColor=white) | `.py` | Functions, classes, methods, imports, decorators |
| ![Terraform](https://img.shields.io/badge/-Terraform-844FBA?style=flat-square&logo=terraform&logoColor=white) | `.tf`, `.hcl` | Resource, data, variable, module, output blocks |

## ⚙️ How It Works

```
┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────┐    ┌─────────┐
│  Source   │───▶│ tree-sitter│───▶│  Extract  │───▶│  Resolve │───▶│ SQLite  │
│  Files   │    │   Parse   │    │  Symbols  │    │  Imports │    │   DB    │
└──────────┘    └───────────┘    └───────────┘    └──────────┘    └─────────┘
                                                                       │
                                                                       ▼
                                                                 ┌─────────┐
                                                                 │  Query  │
                                                                 └─────────┘
```

1. **Parse** — tree-sitter (WASM) parses every source file into an AST
2. **Extract** — Functions, classes, methods, interfaces, imports, exports, and call sites are extracted
3. **Resolve** — Imports are resolved to actual files (handles ESM conventions, `tsconfig.json` path aliases, `baseUrl`)
4. **Store** — Everything goes into SQLite as nodes + edges with tree-sitter node boundaries
5. **Query** — All queries run locally against the SQLite DB — typically under 100ms

### Call Resolution

Calls are resolved with priority and confidence scoring:

| Priority | Source | Confidence |
|---|---|---|
| 1 | **Import-aware** — `import { foo } from './bar'` → link to `bar` | `1.0` |
| 2 | **Same-file** — definitions in the current file | `1.0` |
| 3 | **Same directory** — definitions in sibling files | `0.7` |
| 4 | **Same parent directory** — definitions in sibling dirs | `0.5` |
| 5 | **Global fallback** — match by name across codebase | `0.3` |
| 6 | **Method hierarchy** — resolved through `extends`/`implements` | — |

Dynamic patterns like `fn.call()`, `fn.apply()`, `fn.bind()`, and `obj["method"]()` are also detected on a best-effort basis.

## 📊 Performance

Benchmarked on a ~3,200-file TypeScript project:

| Metric | Value |
|---|---|
| Build time | ~30s |
| Nodes | 19,000+ |
| Edges | 120,000+ |
| Query time | <100ms |
| DB size | ~5 MB |

## 🤖 AI Agent Integration

### MCP Server

Codegraph includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server, so AI assistants can query your dependency graph directly:

```bash
codegraph mcp
```

### CLAUDE.md / Agent Instructions

Add this to your project's `CLAUDE.md` to help AI agents use codegraph:

```markdown
## Code Navigation

This project has a codegraph database at `.codegraph/graph.db`.

- **Before modifying a function**: `codegraph fn <name> --no-tests`
- **Before modifying a file**: `codegraph deps <file>`
- **To assess PR impact**: `codegraph diff-impact --no-tests`
- **To find entry points**: `codegraph map`
- **To trace breakage**: `codegraph fn-impact <name> --no-tests`

Rebuild after major structural changes: `codegraph build`
```

## 🔁 CI / GitHub Actions

Codegraph ships with a ready-to-use GitHub Actions workflow that comments impact analysis on every pull request.

Copy `.github/workflows/codegraph-impact.yml` to your repo, and every PR will get a comment like:

> **3 functions changed** → **12 callers affected** across **7 files**

## 🛠️ Configuration

Create a `.codegraphrc.json` in your project root to customize behavior:

```json
{
  "include": ["src/**", "lib/**"],
  "exclude": ["**/*.test.js", "**/__mocks__/**"],
  "ignoreDirs": ["node_modules", ".git", "dist"],
  "extensions": [".js", ".ts", ".tsx", ".py"],
  "aliases": {
    "@/": "./src/",
    "@utils/": "./src/utils/"
  },
  "build": {
    "incremental": true
  }
}
```

## 📖 Programmatic API

Codegraph also exports a full API for use in your own tools:

```js
import { buildGraph, queryNameData, findCycles, exportDOT } from 'codegraph';

// Build the graph
buildGraph('/path/to/project');

// Query programmatically
const results = queryNameData('myFunction', '/path/to/.codegraph/graph.db');
```

## ⚠️ Limitations

- **No full type inference** — parses `.d.ts` interfaces but doesn't use TypeScript's type checker for overload resolution
- **Dynamic calls are best-effort** — complex computed property access and `eval` patterns are not resolved
- **Python imports** — resolves relative imports but doesn't follow `sys.path` or virtual environment packages

## 🤝 Contributing

Contributions are welcome! Here's how to get started:

```bash
git clone https://github.com/optave/codegraph.git
cd codegraph
npm install --legacy-peer-deps
npm test                # run tests with vitest
```

1. Fork the repo
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## 📄 License

[MIT](LICENSE) — use it however you want.

---

<p align="center">
  <sub>Built with <a href="https://tree-sitter.github.io/">tree-sitter</a> and <a href="https://github.com/WiseLibs/better-sqlite3">better-sqlite3</a>. No data leaves your machine. Ever.</sub>
</p>
