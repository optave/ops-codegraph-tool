# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 2.5.1 | native | 132 | 238ms | 4ms | 111ms | 1ms | 1ms |
| 2.5.1 | wasm | 132 | 806ms | 4ms | 328ms | 1ms | 1ms |

### Latest results

**Version:** 2.5.1 | **Files:** 132 | **Date:** 2026-03-02

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 238ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 111ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 806ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 328ms |

#### Import Resolution

| Metric | Value |
|--------|------:|
| Import pairs | 139 |
| Native batch | 1ms |
| JS fallback | 1ms |
| Per-import (native) | 0ms |
| Per-import (JS) | 0ms |
| Speedup ratio | 1.1x |

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "files": 132,
    "wasm": {
      "fullBuildMs": 806,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 328
    },
    "native": {
      "fullBuildMs": 238,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 111
    },
    "resolve": {
      "imports": 139,
      "nativeBatchMs": 1.2,
      "jsFallbackMs": 1.3,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  }
]
-->
