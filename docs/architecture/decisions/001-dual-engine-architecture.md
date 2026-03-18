# ADR-001: Dual-Engine Architecture (JS/WASM + Rust Native)

**Date:** 2026-03-18
**Status:** Accepted
**Context:** Architectural audit v3.1.4 (2026-03-16) raised the dual-engine maintenance cost as a concern. This ADR documents the rationale, trade-offs, and long-term trajectory.

---

## Decision

Codegraph maintains two parsing and analysis engines:

1. **Rust native engine** — compiled to platform-specific `.node` addons via napi-rs, distributed as optional npm packages (`@optave/codegraph-{platform}-{arch}`)
2. **JS/WASM engine** — tree-sitter WASM grammars running in `web-tree-sitter`, built from devDependencies on `npm install`

The `--engine auto` default (and recommended mode) uses native when available, WASM as fallback. Both engines feed the same SQLite graph — downstream queries and analysis are engine-agnostic.

This is a settled architectural decision.

---

## Context

### The problem codegraph solves

AI coding assistants waste tokens re-orienting themselves in large codebases, hallucinate dependencies, and miss blast radius. Codegraph exists to fix this for **large codebases** — the ones where AI agents actually struggle. Small codebases don't have this problem: an agent can read most of the code in a single context window. The tool's value scales with codebase size, which means performance at scale is not optional — it's the core requirement.

### Why two engines exist

The two engines serve fundamentally different deployment constraints:

| Constraint | Rust native | JS/WASM |
|-----------|------------|---------|
| **Performance on large codebases** | 3-10x faster parsing, parallel via rayon | Single-threaded, slower |
| **CI/CD pipelines** | Requires prebuilt binary for the CI runner's platform | Runs anywhere Node.js runs — no binary needed |
| **VS Code extensions** | Cannot load native addons in VS Code web or restricted extension hosts | WASM runs in any V8 environment including VS Code webviews |
| **Browser environments** | Not possible | WASM runs natively |
| **Platform coverage** | Limited to platforms with prebuilt binaries (currently: linux-x64, darwin-arm64, darwin-x64, win32-x64) | Universal — any platform with Node.js ≥20 |
| **Install simplicity** | `npm install` pulls prebuilt binary via optionalDependencies (no Rust toolchain) | `npm install` builds WASM grammars from devDeps (no native compilation) |

A single-engine architecture would force a choice:

- **Rust-only** eliminates the WASM maintenance cost but locks out VS Code plugin development, browser-based visualization, and any CI runner without a prebuilt binary. This is the approach taken by `esbuild` — viable for a build tool, not for a tool that needs to run inside editor extensions and web contexts.
- **WASM-only** eliminates the native maintenance cost but sacrifices the 3-10x performance advantage that makes the tool viable on large codebases. A 15-second initial build on WASM becomes a 3-second build on native — the difference between "fast enough for interactive use" and "waiting for the tool."

Neither trade-off is acceptable for codegraph's target use case.

---

## Trade-offs

### Costs of dual-engine

1. **Maintenance multiplier.** Bug fixes and new features in parsing, extraction, import resolution, and analysis may need to be applied in both JS and Rust. This is real ongoing cost.

2. **Parity verification.** The two engines must produce identical graphs for the same input. Parity tests exist but test specific inputs, not full behavioral equivalence. Divergence between engines is a class of bug that single-engine tools don't have.

3. **New language cost.** Adding a language requires an extractor in both engines (Rust + JS/WASM). This doubles the per-language implementation effort.

4. **Cognitive overhead.** Contributors must understand two codebases (32K LOC JS + 10K LOC Rust) with different idioms, toolchains, and debugging workflows.

### Benefits of dual-engine

1. **Performance where it matters.** Native Rust parsing at 3-10x WASM speed is the difference between codegraph being viable or not on 100K+ LOC codebases. With multi-repo integration on the roadmap, graphs will span multiple repositories — making parse performance even more critical.

2. **Universal portability.** WASM fallback guarantees the tool works everywhere Node.js runs, regardless of platform, environment restrictions, or binary availability. This is essential for VS Code extensions, browser-based visualization, and CI runners on uncommon architectures.

3. **Graceful degradation.** Users on unsupported platforms or restricted environments get full functionality at reduced speed, rather than no functionality. The `--engine auto` strategy handles this transparently.

4. **Future optionality.** The WASM engine enables deployment targets that don't exist yet — browser-based code review tools, WebContainer environments (StackBlitz), cloud IDEs with restricted filesystem access.

### Current parity state

Today, some analysis phases (AST node extraction, CFG, dataflow, complexity) fall back to WASM even when the native engine is selected for parsing. This is a temporary state — Phase 6 (Native Analysis Acceleration) will port these remaining phases to Rust, eliminating the fallback and making the native path fully self-contained. Once complete, the WASM engine will be a true fallback for environments that can't run native code, not a required component of the native pipeline.

---

## Trajectory

The dual-engine architecture is not static. The expected evolution:

1. **Phase 6 (Native Analysis Acceleration):** Port remaining JS-only build phases to Rust. After this, `--engine native` runs the entire pipeline in Rust with zero WASM dependency. The WASM engine becomes a standalone fallback path, not a supplement to native.

2. **Multi-repo integration:** As codegraph supports cross-repository graphs, the data volume grows multiplicatively. A 5-repo monorepo with 50K LOC each means 250K LOC of parsing — native performance becomes non-negotiable.

3. **VS Code extension:** The WASM engine enables in-editor graph queries without requiring users to install platform-specific binaries. The extension can run entirely in WASM for portability, with an option to delegate to a native CLI process for heavy operations (initial build, full rebuild).

4. **Parity convergence.** As the Rust engine reaches full feature parity, the WASM engine's role narrows to "portable fallback." Maintenance cost decreases proportionally — the WASM engine receives bug fixes but not new features, since new analysis capabilities are implemented in Rust first and the WASM path is exercised only for compatibility.

---

## Alternatives considered

| Alternative | Why rejected |
|------------|-------------|
| **Rust-only (like esbuild)** | Locks out VS Code extensions, browser visualization, and CI runners without prebuilt binaries. Acceptable for a build tool, not for an analysis tool that must integrate into diverse environments |
| **WASM-only** | 3-10x slower on large codebases. Unacceptable for the target use case (100K+ LOC where AI agents struggle). Single-threaded WASM can't leverage multi-core parsing |
| **Native tree-sitter Node.js bindings** (not web-tree-sitter) | Would give native speed without Rust custom code, but only for parsing. Import resolution, edge building, and analysis would still be JS. Doesn't solve the full pipeline performance problem. Also adds `node-gyp` compilation step for all users, not just platform-specific prebuilt binaries |
| **Single Rust binary with WASM compilation target** (like oxc, biome, swc) | Would unify the codebase into one language. But codegraph's CLI orchestration, MCP server, and embeddings layer rely heavily on the Node.js ecosystem (`commander`, `@modelcontextprotocol/sdk`, `@huggingface/transformers`, `better-sqlite3`). Rewriting these in Rust is a multi-year effort with no user-facing benefit. The current split — Rust for hot-path parsing/analysis, JS for orchestration/MCP/CLI — puts each language where it's strongest |

---

## Decision outcome

The dual-engine architecture stays. The maintenance cost is real but bounded — it applies to parsing, extraction, and resolution (the hot path), not to the CLI, MCP, queries, or presentation layers which remain JS-only. The performance and portability benefits are load-bearing for the tool's target use case. As the native engine reaches full parity (Phase 6), the WASM engine's maintenance surface shrinks to "portable fallback" rather than "parallel implementation."
