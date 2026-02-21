# User Actions Required

These actions require manual authorization (npm commands, publishing, etc.) and could not be performed automatically.

---

## 1. Install Dependencies (REQUIRED)

```bash
cd repo
npm install
```

This will install:
- **web-tree-sitter** — WASM-based parser
- **vitest** + **@vitest/coverage-v8** (dev) — test framework
- **@huggingface/transformers** (optional) — semantic embeddings
- **@modelcontextprotocol/sdk** (optional) — MCP server for AI assistants

---

## 2. Run Tests

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage report
```

---

## 3. Link for Global CLI Usage

To use `codegraph` as a global command:

```bash
npm link
```

---

## 4. Publish to npm

The package is published as [`@optave/codegraph`](https://www.npmjs.com/package/@optave/codegraph).

To publish a new version:

1. Bump the version: `npm version patch` (or `minor` / `major`)
2. Dry run: `npm publish --dry-run`
3. Publish: `npm publish --access public`

---

## 5. Rebuild WASM Grammars (Only If Upgrading Grammars)

The `.wasm` grammar files in `grammars/` are pre-built and committed. You only need to rebuild them if you upgrade the grammar devDependencies:

```bash
npm run build:wasm
```

This uses `tree-sitter-cli` to compile each grammar package into a `.wasm` file.

---

## 6. Install MCP SDK (Optional)

If you want the MCP server feature for AI assistant integration:

```bash
npm install @modelcontextprotocol/sdk
```

Then use: `codegraph mcp`

---

## 7. Configuration File (Optional)

Copy the example config to customize codegraph for your projects:

```bash
cp .codegraphrc.example.json your-project/.codegraphrc.json
```

Edit it to set custom ignore patterns, aliases, build options, etc.
