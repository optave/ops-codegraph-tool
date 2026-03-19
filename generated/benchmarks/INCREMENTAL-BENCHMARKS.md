# Codegraph Incremental Build Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).
Import resolution: native batch vs JS fallback throughput.

| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |
|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|
| 3.3.0 | native | 429 | 3.0s ↑141% | 10ms ↑67% | 417ms ↑74% | 10ms ↑700% | 26ms ↑888% |
| 3.3.0 | wasm | 429 | 4.3s ↑29% | 11ms ~ | 479ms ↑41% | 10ms ↑700% | 26ms ↑888% |
| 3.1.4 | native | 398 | 1.3s ↑9% | 6ms ~ | 240ms ↓11% | 1ms ↓37% | 3ms ↓45% |
| 3.1.4 | wasm | 398 | 3.3s ↑10% | 11ms ↑83% | 340ms ↓28% | 1ms ↓37% | 3ms ↓45% |
| 3.1.3 | native | 236 | 1.2s ~ | 6ms ↑20% | 271ms ↑3% | 2ms ↓5% | 5ms ~ |
| 3.1.3 | wasm | 236 | 3.0s ↑3% | 6ms ~ | 473ms ↓3% | 2ms ↓5% | 5ms ~ |
| 3.1.2 | native | 235 | 1.2s ↑6% | 5ms ~ | 264ms ↓20% | 2ms ↓9% | 5ms ↑12% |
| 3.1.2 | wasm | 235 | 2.9s ~ | 6ms ~ | 488ms ↓9% | 2ms ↓9% | 5ms ↑12% |
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

**Version:** 3.3.0 | **Files:** 429 | **Date:** 2026-03-19

#### Native (Rust)

| Metric | Value |
|--------|------:|
| Full build | 3.0s |
| No-op rebuild | 10ms |
| 1-file rebuild | 417ms |

#### WASM

| Metric | Value |
|--------|------:|
| Full build | 4.3s |
| No-op rebuild | 11ms |
| 1-file rebuild | 479ms |

#### Import Resolution

| Metric | Value |
|--------|------:|
| Import pairs | 664 |
| Native batch | 10ms |
| JS fallback | 26ms |
| Per-import (native) | 0ms |
| Per-import (JS) | 0ms |
| Speedup ratio | 2.7x |

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "3.3.0",
    "date": "2026-03-19",
    "files": 429,
    "wasm": {
      "fullBuildMs": 4265,
      "noopRebuildMs": 11,
      "oneFileRebuildMs": 479,
      "oneFilePhases": {
        "setupMs": 1.7,
        "parseMs": 193.6,
        "insertMs": 8.3,
        "resolveMs": 1.7,
        "edgesMs": 14.7,
        "structureMs": 16.5,
        "rolesMs": 50.4,
        "astMs": 0.2,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.2,
        "finalizeMs": 13.3
      }
    },
    "native": {
      "fullBuildMs": 3048,
      "noopRebuildMs": 10,
      "oneFileRebuildMs": 417,
      "oneFilePhases": {
        "setupMs": 1.2,
        "parseMs": 134,
        "insertMs": 7.9,
        "resolveMs": 1.6,
        "edgesMs": 25.1,
        "structureMs": 19.6,
        "rolesMs": 45.9,
        "astMs": 0.3,
        "complexityMs": 0.1,
        "cfgMs": 0.2,
        "dataflowMs": 0.2,
        "finalizeMs": 12
      }
    },
    "resolve": {
      "imports": 664,
      "nativeBatchMs": 9.6,
      "jsFallbackMs": 25.7,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.1.4",
    "date": "2026-03-16",
    "files": 398,
    "wasm": {
      "fullBuildMs": 3295,
      "noopRebuildMs": 11,
      "oneFileRebuildMs": 340,
      "oneFilePhases": {
        "setupMs": 1.1,
        "parseMs": 135.9,
        "insertMs": 6.3,
        "resolveMs": 1.5,
        "edgesMs": 14.1,
        "structureMs": 14.6,
        "rolesMs": 26.7,
        "astMs": 0.3,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.2,
        "finalizeMs": 13.9
      }
    },
    "native": {
      "fullBuildMs": 1267,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 240,
      "oneFilePhases": {
        "setupMs": 0.8,
        "parseMs": 51,
        "insertMs": 6.5,
        "resolveMs": 1.5,
        "edgesMs": 14.5,
        "structureMs": 12.1,
        "rolesMs": 32.7,
        "astMs": 0.3,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.2,
        "finalizeMs": 7
      }
    },
    "resolve": {
      "imports": 175,
      "nativeBatchMs": 1.2,
      "jsFallbackMs": 2.6,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.1.3",
    "date": "2026-03-12",
    "files": 236,
    "wasm": {
      "fullBuildMs": 2988,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 473,
      "oneFilePhases": {
        "setupMs": 31.7,
        "parseMs": 225.7,
        "insertMs": 12.9,
        "resolveMs": 1.5,
        "edgesMs": 19.6,
        "structureMs": 7.9,
        "rolesMs": 29.3,
        "astMs": 14.3,
        "complexityMs": 2.8,
        "cfgMs": 5.3,
        "dataflowMs": 4.2,
        "finalizeMs": 9.9
      }
    },
    "native": {
      "fullBuildMs": 1164,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 271,
      "oneFilePhases": {
        "setupMs": 33.8,
        "parseMs": 88.8,
        "insertMs": 9.9,
        "resolveMs": 1.6,
        "edgesMs": 16.8,
        "structureMs": 8.4,
        "rolesMs": 20.3,
        "astMs": 14.1,
        "complexityMs": 1,
        "cfgMs": 5.2,
        "dataflowMs": 6.5,
        "finalizeMs": 4.7
      }
    },
    "resolve": {
      "imports": 218,
      "nativeBatchMs": 1.9,
      "jsFallbackMs": 4.7,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
  {
    "version": "3.1.2",
    "date": "2026-03-11",
    "files": 235,
    "wasm": {
      "fullBuildMs": 2906,
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 488,
      "oneFilePhases": {
        "parseMs": 223.6,
        "insertMs": 13.4,
        "resolveMs": 1.5,
        "edgesMs": 35.6,
        "structureMs": 11.6,
        "rolesMs": 25.6,
        "astMs": 14.9,
        "complexityMs": 0.4,
        "cfgMs": 5.7,
        "dataflowMs": 5
      }
    },
    "native": {
      "fullBuildMs": 1168,
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 264,
      "oneFilePhases": {
        "parseMs": 85,
        "insertMs": 10,
        "resolveMs": 1.2,
        "edgesMs": 15.9,
        "structureMs": 7.7,
        "rolesMs": 29.2,
        "astMs": 14.6,
        "complexityMs": 1,
        "cfgMs": 5.5,
        "dataflowMs": 4.2
      }
    },
    "resolve": {
      "imports": 218,
      "nativeBatchMs": 2,
      "jsFallbackMs": 4.7,
      "perImportNativeMs": 0,
      "perImportJsMs": 0
    }
  },
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
