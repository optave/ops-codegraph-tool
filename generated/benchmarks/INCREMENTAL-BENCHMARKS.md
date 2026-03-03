# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 3.0.0 | native | 164 | 679ms ↑137% | 4ms ~ | 317ms ↑135% | 4ms ↑31% | 5ms ↑39% |
| 3.0.0 | wasm | 164 | 1.9s ↑116% | 5ms ↑25% | 962ms ↑91% | 4ms ↑31% | 5ms ↑39% |
| 2.6.0 | native | 146 | 286ms ↑3% | 4ms ↓33% | 135ms ↑5% | 3ms ~ | 3ms ↓3% |
| 2.6.0 | wasm | 146 | 899ms ~ | 4ms ↓20% | 503ms ↑37% | 3ms ~ | 3ms ↓3% |
| 2.5.1 | native | 142 | 277ms | 6ms | 129ms | 3ms | 3ms |
| 2.5.1 | wasm | 142 | 888ms | 5ms | 368ms | 3ms | 3ms |

### Latest results

**Version:** 3.0.0 | **Files:** 164 | **Date:** 2026-03-03

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 679ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 317ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 1.9s |
| No-op rebuild | 5ms |
| 1-file rebuild | 962ms |

#### Import Resolution

| Metric | Value |
|--------|------:|
| Import pairs | 201 |
| Native batch | 4ms |
| JS fallback | 5ms |
| Per-import (native) | 0ms |
| Per-import (JS) | 0ms |
| Speedup ratio | 1.2x |

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "3.0.0",
    "date": "2026-03-03",
    "files": 164,
    "wasm": {
      "fullBuildMs": 1942,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 962
    },
    "native": {
      "fullBuildMs": 679,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 317
    },
    "resolve": {
      "imports": 201,
      "nativeBatchMs": 3.8,
      "jsFallbackMs": 4.6,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "2.6.0",
    "date": "2026-03-02",
    "files": 146,
    "wasm": {
      "fullBuildMs": 899,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 503
    },
    "native": {
      "fullBuildMs": 286,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 135
    },
    "resolve": {
      "imports": 171,
      "nativeBatchMs": 2.9,
      "jsFallbackMs": 3.3,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "files": 142,
    "wasm": {
      "fullBuildMs": 888,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 368
    },
    "native": {
      "fullBuildMs": 277,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 129
    },
    "resolve": {
      "imports": 171,
      "nativeBatchMs": 2.9,
      "jsFallbackMs": 3.4,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  }
]
-->
