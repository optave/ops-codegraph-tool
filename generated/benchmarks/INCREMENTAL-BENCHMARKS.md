# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 3.1.0 | native | 180 | 1.1s ↑7% | 5ms ↓98% | 329ms ↓3% | 2ms ↓39% | 4ms ↑5% |
| 3.1.0 | wasm | 180 | 2.9s ↑13% | 6ms ↑20% | 536ms ↓6% | 2ms ↓39% | 4ms ↑5% |
| 3.0.4 | native | 177 | 1.0s ↓41% | 319ms ↑7875% | 338ms ↓2% | 4ms ↑6% | 4ms ~ |
| 3.0.4 | wasm | 177 | 2.5s ↑6% | 5ms ~ | 568ms ↑12% | 4ms ↑6% | 4ms ~ |
| 3.0.3 | native | 172 | 1.8s ↓9% | 4ms ↓20% | 346ms ~ | 3ms ↓3% | 4ms ↓7% |
| 3.0.3 | wasm | 172 | 2.4s ↓6% | 5ms ↓17% | 505ms ~ | 3ms ↓3% | 4ms ↓7% |
| 3.0.2 | native | 172 | 1.9s ↓17% | 5ms ↑25% | 349ms ↓62% | 4ms ↓3% | 4ms ↑7% |
| 3.0.2 | wasm | 172 | 2.5s ↓23% | 6ms ~ | 515ms ↓50% | 4ms ↓3% | 4ms ↑7% |
| 3.0.1 | native | 165 | 2.3s ↑223% | 4ms ↓20% | 928ms ↑186% | 4ms ↑3% | 4ms ↓7% |
| 3.0.1 | wasm | 165 | 3.3s ↑62% | 6ms ↑20% | 1.0s ↓4% | 4ms ↑3% | 4ms ↓7% |
| 3.0.0 | native | 164 | 721ms ↑152% | 5ms ↑25% | 325ms ↑141% | 4ms ↑21% | 4ms ↑30% |
| 3.0.0 | wasm | 164 | 2.0s ↑128% | 5ms ↑25% | 1.1s ↑112% | 4ms ↑21% | 4ms ↑30% |
| 2.6.0 | native | 146 | 286ms ↑3% | 4ms ↓33% | 135ms ↑5% | 3ms ~ | 3ms ↓3% |
| 2.6.0 | wasm | 146 | 899ms ~ | 4ms ↓20% | 503ms ↑37% | 3ms ~ | 3ms ↓3% |
| 2.5.1 | native | 142 | 277ms | 6ms | 129ms | 3ms | 3ms |
| 2.5.1 | wasm | 142 | 888ms | 5ms | 368ms | 3ms | 3ms |

### Latest results

**Version:** 3.1.0 | **Files:** 180 | **Date:** 2026-03-08

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 1.1s |
| No-op rebuild | 5ms |
| 1-file rebuild | 329ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 2.9s |
| No-op rebuild | 6ms |
| 1-file rebuild | 536ms |

#### Import Resolution

| Metric | Value |
|--------|------:|
| Import pairs | 207 |
| Native batch | 2ms |
| JS fallback | 4ms |
| Per-import (native) | 0ms |
| Per-import (JS) | 0ms |
| Speedup ratio | 1.9x |

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "3.1.0",
    "date": "2026-03-08",
    "files": 180,
    "wasm": {
      "fullBuildMs": 2860,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 536
    },
    "native": {
      "fullBuildMs": 1101,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 329
    },
    "resolve": {
      "imports": 207,
      "nativeBatchMs": 2.2,
      "jsFallbackMs": 4.2,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.0.4",
    "date": "2026-03-06",
    "files": 177,
    "wasm": {
      "fullBuildMs": 2539,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 568
    },
    "native": {
      "fullBuildMs": 1030,
      "noopRebuildMs": 319,
      "oneFileRebuildMs": 338
    },
    "resolve": {
      "imports": 202,
      "nativeBatchMs": 3.6,
      "jsFallbackMs": 4,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.0.3",
    "date": "2026-03-04",
    "files": 172,
    "wasm": {
      "fullBuildMs": 2395,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 505
    },
    "native": {
      "fullBuildMs": 1757,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 346
    },
    "resolve": {
      "imports": 202,
      "nativeBatchMs": 3.4,
      "jsFallbackMs": 4,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.0.2",
    "date": "2026-03-04",
    "files": 172,
    "wasm": {
      "fullBuildMs": 2549,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 515
    },
    "native": {
      "fullBuildMs": 1941,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 349
    },
    "resolve": {
      "imports": 202,
      "nativeBatchMs": 3.5,
      "jsFallbackMs": 4.3,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.0.1",
    "date": "2026-03-04",
    "files": 165,
    "wasm": {
      "fullBuildMs": 3313,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 1025
    },
    "native": {
      "fullBuildMs": 2327,
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 928
    },
    "resolve": {
      "imports": 201,
      "nativeBatchMs": 3.6,
      "jsFallbackMs": 4,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.0.0",
    "date": "2026-03-03",
    "files": 164,
    "wasm": {
      "fullBuildMs": 2049,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 1064
    },
    "native": {
      "fullBuildMs": 721,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 325
    },
    "resolve": {
      "imports": 201,
      "nativeBatchMs": 3.5,
      "jsFallbackMs": 4.3,
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
