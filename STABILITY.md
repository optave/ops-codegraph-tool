# Stability Policy

> **Status: Anticipated — not yet active.**
> This policy describes the stability guarantees codegraph *will* provide once the public API surface stabilizes after [Phase 3 — Architectural Refactoring](ROADMAP.md). Until then, breaking changes may still land in minor releases as the internal architecture is restructured.

---

## Signal Status

| Signal | Current Status | Planned |
|--------|---------------|---------|
| Stability policy | This document (anticipated) | Active after Phase 3 |
| Deprecation warnings | Not yet | Phase 3+ |
| Migration guides | Partial (v1→v2: "rebuild required") | Every major going forward |
| Semantic versioning policy | SemVer followed, no support window | Phase 3+ |
| LTS / release tracks | No | When adoption warrants |
| API reference docs | CLI `--help` only | Phase 3+ |
| `@deprecated` annotations | No | Phase 3+ |
| MCP tool schema versioning | No | Phase 3+ |

---

## 1. Semantic Versioning

Codegraph follows [SemVer 2.0.0](https://semver.org/). Once this policy is active, version bumps will be governed by these rules:

### What counts as breaking (requires major bump)

- Removing or renaming CLI commands or flags
- Changing MCP tool names, required parameters, or response shapes
- Removing or renaming programmatic exports from `index.js`
- DB schema changes that require a full rebuild (without automatic migration)

### What is NOT breaking

- Internal function signatures (anything not exported from `index.js`)
- Output formatting tweaks (column widths, colors, human-readable text)
- Performance improvements
- New additive features (new commands, new optional flags, new MCP tools)
- Bug fixes that correct previously incorrect behavior

### Support window

**TBD.** The plan is to support at least one previous major version with critical bug and security fixes after a new major is released. The exact window will be defined when this policy activates.

---

## 2. Deprecation Policy

Before removing any public API surface, codegraph will provide advance notice:

1. **`@deprecated` JSDoc annotation** on the function or method, with a message pointing to the replacement.
2. **Runtime `console.warn`** on first use per process, e.g.:
   ```
   [codegraph] DEPRECATED: queryNameData() will be removed in v4.0. Use querySymbol() instead.
   ```
3. **Minimum deprecation window:** one minor release cycle before removal. The deprecation notice ships in version N.x, the removal lands no earlier than version (N+1).0.

### Scope

Deprecation notices apply to:

- Exported functions and classes in `index.js`
- CLI commands and flags
- MCP tool schemas (tool names, parameter names, response properties)

Internal functions not exported from `index.js` may be changed or removed without deprecation notices.

---

## 3. Migration Guides

Starting with the next major version, every major release will ship with a migration guide covering:

- What changed and why
- Step-by-step upgrade instructions
- Before/after code examples for breaking API changes
- DB migration steps (if any)

Migration guides will be published in `docs/` alongside the release.

### Retroactive acknowledgment

**v1 → v2** required a full `codegraph build` to regenerate the graph database. No migration guide was published at the time. Going forward, this gap will not recur.

---

## 4. Release Tracks

### Current (active now)

The **Current** track receives all new features and improvements. Breaking changes land in major versions. This is the only active track today.

### LTS (planned, not yet active)

An **LTS** (Long-Term Support) track is anticipated when adoption warrants it. When activated:

- LTS releases receive security fixes and critical bug fixes only
- LTS support window: N months after the next major version ships (exact duration TBD)
- LTS releases will not receive new features

LTS will be activated based on community adoption and demand — there is no fixed date.

---

## 5. API Reference

| Surface | Current State | Planned |
|---------|--------------|---------|
| CLI commands | Documented via `--help` and [README](README.md#-commands) | No change needed |
| Programmatic API (`index.js`) | Documented in README examples | Auto-generated JSDoc reference (Phase 3+) |
| MCP tools | Documented in [AI Agent Guide](docs/guides/ai-agent-guide.md) | Versioned schema reference (Phase 3+) |

The planned auto-generated reference will cover all public exports from `index.js` with full type signatures, parameter descriptions, and usage examples.

---

## 6. MCP Tool Schema Versioning

MCP tool schemas — tool names, parameter shapes (names, types, required/optional), and response shapes — are part of the public API. Once this policy is active:

- **Breaking schema changes** (renaming a tool, removing a parameter, changing a response shape) require a **major version bump**.
- **Additive changes** (new optional parameters, new tools, new response fields) are **non-breaking** and may land in minor versions.

This ensures that AI agents relying on codegraph's MCP tools will not break silently on upgrade.
