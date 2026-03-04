# Codegraph Performance Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Metrics are normalized per file for cross-version comparability.

| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |
|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|
| 3.0.3 | native | 2026-03-04 | 172 | 12.3 ↑7% | 3.4 ↑3% | 18.8 ~ | 41.6 ~ | 74133 ~ |
| 3.0.3 | wasm | 2026-03-04 | 172 | 16.3 ↓8% | 4.6 ↑5% | 18.7 ~ | 41.6 ~ | 74300 ~ |
| 3.0.2 | native | 2026-03-04 | 172 | 11.5 ↓18% | 3.3 ↓3% | 18.8 ↓29% | 41.6 ↓17% | 74109 ↓5% |
| 3.0.2 | wasm | 2026-03-04 | 172 | 17.8 ↓27% | 4.4 ↓2% | 18.7 ↓2% | 41.6 ~ | 74252 ~ |
| 3.0.1 | native | 2026-03-04 | 165 | 14.1 ↑220% | 3.4 ↑6% | 26.6 ↑43% | 50 ↑20% | 78246 ↑91% |
| 3.0.1 | wasm | 2026-03-04 | 165 | 24.4 ↑78% | 4.5 ↓10% | 19.1 ↑6% | 42.4 ↑3% | 74870 ↑19% |
| 3.0.0 | native | 2026-03-03 | 164 | 4.4 ↑132% | 3.2 ↑19% | 18.6 ↑195% | 41.6 ↑262% | 41010 ↑682% |
| 3.0.0 | wasm | 2026-03-03 | 164 | 13.7 ↑65% | 5 ↑11% | 18.1 ↑187% | 41.1 ↑257% | 63063 ↑1102% |
| 2.6.0 | native | 2026-03-02 | 146 | 1.9 ~ | 2.7 ↑29% | 6.3 ↓3% | 11.5 ↑4% | 5246 ↓5% |
| 2.6.0 | wasm | 2026-03-02 | 146 | 8.3 ↑6% | 4.5 ↑50% | 6.3 ↓3% | 11.5 ↑4% | 5246 ↓5% |
| 2.5.1 | native | 2026-03-01 | 126 | 1.9 ↓5% | 2.1 ↓12% | 6.5 ~ | 11.1 ~ | 5526 ~ |
| 2.5.1 | wasm | 2026-03-01 | 126 | 7.8 ↓7% | 3 ↓14% | 6.5 ~ | 11.1 ~ | 5526 ~ |
| 2.5.0 | native | 2026-02-28 | 123 | 2 | 2.4 | 6.5 | 11.1 | 5595 |
| 2.5.0 | wasm | 2026-02-28 | 123 | 8.4 ↑65% | 3.5 ↑59% | 6.5 ~ | 11.1 ↑4% | 5595 ↑19% |
| 2.4.0 | wasm | 2026-02-28 | 123 | 5.1 ↓23% | 2.2 ↑5% | 6.5 ↑12% | 10.7 ↑18% | 4695 ↑22% |
| 2.3.0 | native | 2026-02-24 | 99 | 1.9 ~ | 1.5 ↑7% | 5.8 ↑7% | 9.1 ~ | 3848 ~ |
| 2.3.0 | wasm | 2026-02-24 | 99 | 6.6 ~ | 2.1 ↑11% | 5.8 ~ | 9.1 ↑3% | 3848 ~ |
| 2.1.0 | native | 2026-02-23 | 92 | 1.9 ↓24% | 1.4 ↑17% | 5.4 ↑6% | 9.1 ↓47% | 3829 ↓14% |
| 2.1.0 | wasm | 2026-02-23 | 92 | 6.6 ↑32% | 1.9 ↑19% | 5.7 ↑12% | 8.8 ↓46% | 3829 ↓12% |
| 2.0.0 | native | 2026-02-23 | 89 | 2.5 | 1.2 | 5.1 | 17.2 | 4464 |
| 2.0.0 | wasm | 2026-02-23 | 89 | 5 | 1.6 | 5.1 | 16.2 | 4372 |

### Raw totals (latest)

#### Native (Rust)

| Metric | Value |
|--------|-------|
| Build time | 2.1s |
| Query time | 3ms |
| Nodes | 3,234 |
| Edges | 7,158 |
| DB size | 12.2 MB |
| Files | 172 |

#### WASM

| Metric | Value |
|--------|-------|
| Build time | 2.8s |
| Query time | 5ms |
| Nodes | 3,223 |
| Edges | 7,161 |
| DB size | 12.2 MB |
| Files | 172 |

### Build Phase Breakdown (latest)

| Phase | Native | WASM |
|-------|-------:|-----:|
| Parse | 266.8 ms | 991.6 ms |
| Insert nodes | 68.5 ms | 73 ms |
| Resolve imports | 14.8 ms | 18.8 ms |
| Build edges | 125.5 ms | 138 ms |
| Structure | 6.9 ms | 10.3 ms |
| Roles | 28.8 ms | 29 ms |
| Complexity | 8.9 ms | 342.7 ms |

### Estimated performance at 50,000 files

Extrapolated linearly from per-file metrics above.

| Metric | Native (Rust) | WASM |
|--------|---:|---:|
| Build time | 615.0s | 815.0s |
| DB size | 3534.9 MB | 3542.9 MB |
| Nodes | 940,000 | 935,000 |
| Edges | 2,080,000 | 2,080,000 |

### Incremental Rebuilds

| Version | Engine | No-op (ms) | 1-file (ms) |
|---------|--------|----------:|-----------:|
| 3.0.3 | native | 5 ~ | 375 ↓2% |
| 3.0.3 | wasm | 7 ↑40% | 567 ↓3% |
| 3.0.2 | native | 5 ~ | 384 ↓58% |
| 3.0.2 | wasm | 5 ~ | 584 ↓42% |
| 3.0.1 | native | 5 ↑25% | 915 ↑182% |
| 3.0.1 | wasm | 5 ~ | 1012 ↓5% |
| 3.0.0 | native | 4 ~ | 325 ↑162% |
| 3.0.0 | wasm | 5 ↓29% | 1068 ↑112% |
| 2.6.0 | native | 4 ↑33% | 124 ↑33% |
| 2.6.0 | wasm | 7 ↑75% | 504 ↑56% |
| 2.5.1 | native | 3 ↓25% | 93 ↓4% |
| 2.5.1 | wasm | 4 ~ | 324 ~ |
| 2.5.0 | native | 4 | 97 |
| 2.5.0 | wasm | 4 ↓20% | 324 ↑69% |
| 2.4.0 | wasm | 5 | 192 |

### Query Latency

| Version | Engine | fn-deps (ms) | fn-impact (ms) | path (ms) | roles (ms) |
|---------|--------|------------:|--------------:|----------:|----------:|
| 3.0.3 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 5.5 ↑6% |
| 3.0.3 | wasm | 0.8 ~ | 0.8 ~ | 0.8 ~ | 6.1 ~ |
| 3.0.2 | native | 0.8 ↓11% | 0.8 ~ | 0.8 ~ | 5.2 ↓26% |
| 3.0.2 | wasm | 0.8 ~ | 0.8 ↓11% | 0.8 ~ | 6 ↑15% |
| 3.0.1 | native | 0.9 ↑12% | 0.8 ~ | 0.8 ~ | 7 ↑43% |
| 3.0.1 | wasm | 0.8 ~ | 0.9 ~ | 0.8 ~ | 5.2 ↓5% |
| 3.0.0 | native | 0.8 ↓43% | 0.8 ↓38% | 0.8 ↓43% | 4.9 ↑308% |
| 3.0.0 | wasm | 0.8 ↓43% | 0.9 ↓36% | 0.8 ↓43% | 5.5 ↑323% |
| 2.6.0 | native | 1.4 ↓22% | 1.3 ~ | 1.4 ↑40% | 1.2 ↑20% |
| 2.6.0 | wasm | 1.4 ↓22% | 1.4 ↑8% | 1.4 ↑40% | 1.3 ↑18% |
| 2.5.1 | native | 1.8 ↓14% | 1.3 ↓19% | 1 ↓17% | 1 ↓9% |
| 2.5.1 | wasm | 1.8 ↓18% | 1.3 ↓19% | 1 ↓17% | 1.1 ~ |
| 2.5.0 | native | 2.1 | 1.6 | 1.2 | 1.1 |
| 2.5.0 | wasm | 2.2 ↑340% | 1.6 ↑220% | 1.2 | 1.1 ↑22% |
| 2.4.0 | wasm | 0.5 | 0.5 | null | 0.9 |

<!-- NOTES_START -->
### Notes

**WASM regression (v2.0.0 → v2.1.0, ↑32% — persists in v2.3.0):** The
"v2.1.0" entry was measured after the v2.1.0 tag on main, when `package.json`
still read "2.1.0" but the codebase already included post-release features:
receiver field extraction (`b08c2b2`) and Commander/Express callback extraction
(`2ac24ef`). Both added WASM-to-JS boundary crossings on every
`call_expression` AST node. The native engine was unaffected because its Rust
extractors have zero boundary overhead — and it gained a net 24% speedup from
the ~45% edge reduction introduced by scoped call-resolution fallback
(`3a11191`). For WASM the extra crossings outweighed the edge savings. A
targeted fix in `d4ef6da` gated `extractCallbackDefinition` behind a
`member_expression` type check and eliminated redundant `childForFieldName`
calls, but the v2.3.0 CI benchmark confirms this was **insufficient** — WASM
remains at 6.6 ms/file (vs 5.0 in v2.0.0). The WASM/Native ratio widened from
2.0x to 3.5x. Further optimization of WASM boundary crossings in the JS
extractor is needed to recover the regression.
<!-- NOTES_END -->

<!-- BENCHMARK_DATA
[
  {
    "version": "3.0.3",
    "date": "2026-03-04",
    "files": 172,
    "wasm": {
      "buildTimeMs": 2799,
      "queryTimeMs": 4.6,
      "nodes": 3223,
      "edges": 7161,
      "dbSizeBytes": 12779520,
      "perFile": {
        "buildTimeMs": 16.3,
        "nodes": 18.7,
        "edges": 41.6,
        "dbSizeBytes": 74300
      },
      "noopRebuildMs": 7,
      "oneFileRebuildMs": 567,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 6.1
      },
      "phases": {
        "parseMs": 991.6,
        "insertMs": 73,
        "resolveMs": 18.8,
        "edgesMs": 138,
        "structureMs": 10.3,
        "rolesMs": 29,
        "astMs": 577.9,
        "complexityMs": 342.7,
        "wasmPreMs": 0.4,
        "cfgMs": 185.6,
        "dataflowMs": 395.9
      }
    },
    "native": {
      "buildTimeMs": 2117,
      "queryTimeMs": 3.4,
      "nodes": 3234,
      "edges": 7158,
      "dbSizeBytes": 12750848,
      "perFile": {
        "buildTimeMs": 12.3,
        "nodes": 18.8,
        "edges": 41.6,
        "dbSizeBytes": 74133
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 375,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 5.5
      },
      "phases": {
        "parseMs": 266.8,
        "insertMs": 68.5,
        "resolveMs": 14.8,
        "edgesMs": 125.5,
        "structureMs": 6.9,
        "rolesMs": 28.8,
        "astMs": 651.2,
        "complexityMs": 8.9,
        "wasmPreMs": 388.1,
        "cfgMs": 169,
        "dataflowMs": 367.2
      }
    }
  },
  {
    "version": "3.0.2",
    "date": "2026-03-04",
    "files": 172,
    "wasm": {
      "buildTimeMs": 3055,
      "queryTimeMs": 4.4,
      "nodes": 3223,
      "edges": 7161,
      "dbSizeBytes": 12771328,
      "perFile": {
        "buildTimeMs": 17.8,
        "nodes": 18.7,
        "edges": 41.6,
        "dbSizeBytes": 74252
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 584,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 6
      },
      "phases": {
        "parseMs": 975,
        "insertMs": 74,
        "resolveMs": 18.8,
        "edgesMs": 144.2,
        "structureMs": 9,
        "rolesMs": 28.6,
        "astMs": 738.8,
        "complexityMs": 341.3,
        "wasmPreMs": 0.3,
        "cfgMs": 200.5,
        "dataflowMs": 396.3
      }
    },
    "native": {
      "buildTimeMs": 1983,
      "queryTimeMs": 3.3,
      "nodes": 3234,
      "edges": 7158,
      "dbSizeBytes": 12746752,
      "perFile": {
        "buildTimeMs": 11.5,
        "nodes": 18.8,
        "edges": 41.6,
        "dbSizeBytes": 74109
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 384,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 5.2
      },
      "phases": {
        "parseMs": 254.8,
        "insertMs": 69,
        "resolveMs": 14.8,
        "edgesMs": 143.6,
        "structureMs": 6.4,
        "rolesMs": 27.1,
        "astMs": 454.5,
        "complexityMs": 13.7,
        "wasmPreMs": 410,
        "cfgMs": 190.4,
        "dataflowMs": 381.9
      }
    }
  },
  {
    "version": "3.0.1",
    "date": "2026-03-04",
    "files": 165,
    "wasm": {
      "buildTimeMs": 4026,
      "queryTimeMs": 4.5,
      "nodes": 3156,
      "edges": 6993,
      "dbSizeBytes": 12353536,
      "perFile": {
        "buildTimeMs": 24.4,
        "nodes": 19.1,
        "edges": 42.4,
        "dbSizeBytes": 74870
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 1012,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.9,
        "pathMs": 0.8,
        "rolesMs": 5.2
      },
      "phases": {
        "parseMs": 934.4,
        "insertMs": 71.7,
        "resolveMs": 18.1,
        "edgesMs": 127,
        "structureMs": 9.7,
        "rolesMs": 27.6,
        "astMs": 768.6,
        "complexityMs": 358.4,
        "cfgMs": 632.4,
        "dataflowMs": 718
      }
    },
    "native": {
      "buildTimeMs": 2330,
      "queryTimeMs": 3.4,
      "nodes": 4385,
      "edges": 8246,
      "dbSizeBytes": 12910592,
      "perFile": {
        "buildTimeMs": 14.1,
        "nodes": 26.6,
        "edges": 50,
        "dbSizeBytes": 78246
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 915,
      "queries": {
        "fnDepsMs": 0.9,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 7
      },
      "phases": {
        "parseMs": 267.4,
        "insertMs": 85,
        "resolveMs": 14.6,
        "edgesMs": 135.8,
        "structureMs": 16.5,
        "rolesMs": 22.3,
        "astMs": 458.8,
        "complexityMs": 8.5,
        "cfgMs": 605.4,
        "dataflowMs": 691.1
      }
    }
  },
  {
    "version": "3.0.0",
    "date": "2026-03-03",
    "files": 164,
    "wasm": {
      "buildTimeMs": 2249,
      "queryTimeMs": 5,
      "nodes": 2966,
      "edges": 6746,
      "dbSizeBytes": 10342400,
      "perFile": {
        "buildTimeMs": 13.7,
        "nodes": 18.1,
        "edges": 41.1,
        "dbSizeBytes": 63063
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 1068,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.9,
        "pathMs": 0.8,
        "rolesMs": 5.5
      },
      "phases": {
        "parseMs": 850.7,
        "insertMs": 65.1,
        "resolveMs": 18.4,
        "edgesMs": 123.2,
        "structureMs": 9.3,
        "rolesMs": 17.2,
        "complexityMs": 338.1
      }
    },
    "native": {
      "buildTimeMs": 728,
      "queryTimeMs": 3.2,
      "nodes": 3055,
      "edges": 6821,
      "dbSizeBytes": 6725632,
      "perFile": {
        "buildTimeMs": 4.4,
        "nodes": 18.6,
        "edges": 41.6,
        "dbSizeBytes": 41010
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 325,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 4.9
      },
      "phases": {
        "parseMs": 220.6,
        "insertMs": 63.4,
        "resolveMs": 14.2,
        "edgesMs": 116.5,
        "structureMs": 6.1,
        "rolesMs": 21.3,
        "complexityMs": 8.2
      }
    }
  },
  {
    "version": "2.6.0",
    "date": "2026-03-02",
    "files": 146,
    "wasm": {
      "buildTimeMs": 1208,
      "queryTimeMs": 4.5,
      "nodes": 923,
      "edges": 1685,
      "dbSizeBytes": 765952,
      "perFile": {
        "buildTimeMs": 8.3,
        "nodes": 6.3,
        "edges": 11.5,
        "dbSizeBytes": 5246
      },
      "noopRebuildMs": 7,
      "oneFileRebuildMs": 504,
      "queries": {
        "fnDepsMs": 1.4,
        "fnImpactMs": 1.4,
        "pathMs": 1.4,
        "rolesMs": 1.3
      },
      "phases": {
        "parseMs": 750.2,
        "insertMs": 18,
        "resolveMs": 17.2,
        "edgesMs": 81.5,
        "structureMs": 9,
        "rolesMs": 6.6,
        "complexityMs": 292.2
      }
    },
    "native": {
      "buildTimeMs": 271,
      "queryTimeMs": 2.7,
      "nodes": 923,
      "edges": 1685,
      "dbSizeBytes": 765952,
      "perFile": {
        "buildTimeMs": 1.9,
        "nodes": 6.3,
        "edges": 11.5,
        "dbSizeBytes": 5246
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 124,
      "queries": {
        "fnDepsMs": 1.4,
        "fnImpactMs": 1.3,
        "pathMs": 1.4,
        "rolesMs": 1.2
      },
      "phases": {
        "parseMs": 148.6,
        "insertMs": 16,
        "resolveMs": 13.2,
        "edgesMs": 64,
        "structureMs": 4.4,
        "rolesMs": 5.6,
        "complexityMs": 5.6
      }
    }
  },
  {
    "version": "2.5.1",
    "date": "2026-03-01",
    "files": 126,
    "wasm": {
      "buildTimeMs": 979,
      "queryTimeMs": 3,
      "nodes": 817,
      "edges": 1393,
      "dbSizeBytes": 696320,
      "perFile": {
        "buildTimeMs": 7.8,
        "nodes": 6.5,
        "edges": 11.1,
        "dbSizeBytes": 5526
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 324,
      "queries": {
        "fnDepsMs": 1.8,
        "fnImpactMs": 1.3,
        "pathMs": 1,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 621.1,
        "insertMs": 16.7,
        "resolveMs": 10.2,
        "edgesMs": 60.5,
        "structureMs": 7.2,
        "rolesMs": 4.9,
        "complexityMs": 232.5
      }
    },
    "native": {
      "buildTimeMs": 236,
      "queryTimeMs": 2.1,
      "nodes": 817,
      "edges": 1393,
      "dbSizeBytes": 696320,
      "perFile": {
        "buildTimeMs": 1.9,
        "nodes": 6.5,
        "edges": 11.1,
        "dbSizeBytes": 5526
      },
      "noopRebuildMs": 3,
      "oneFileRebuildMs": 93,
      "queries": {
        "fnDepsMs": 1.8,
        "fnImpactMs": 1.3,
        "pathMs": 1,
        "rolesMs": 1
      },
      "phases": {
        "parseMs": 138.2,
        "insertMs": 12.1,
        "resolveMs": 5.5,
        "edgesMs": 56.9,
        "structureMs": 3.6,
        "rolesMs": 4.7,
        "complexityMs": 4.7
      }
    }
  },
  {
    "version": "2.5.0",
    "date": "2026-02-28",
    "files": 123,
    "wasm": {
      "buildTimeMs": 1033,
      "queryTimeMs": 3.5,
      "nodes": 801,
      "edges": 1365,
      "dbSizeBytes": 688128,
      "perFile": {
        "buildTimeMs": 8.4,
        "nodes": 6.5,
        "edges": 11.1,
        "dbSizeBytes": 5595
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 324,
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 655.7,
        "insertMs": 18.8,
        "resolveMs": 13,
        "edgesMs": 62.8,
        "structureMs": 10.2,
        "rolesMs": 8.5,
        "complexityMs": 240.7
      }
    },
    "native": {
      "buildTimeMs": 241,
      "queryTimeMs": 2.4,
      "nodes": 801,
      "edges": 1365,
      "dbSizeBytes": 688128,
      "perFile": {
        "buildTimeMs": 2,
        "nodes": 6.5,
        "edges": 11.1,
        "dbSizeBytes": 5595
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 97,
      "queries": {
        "fnDepsMs": 2.1,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 133,
        "insertMs": 13,
        "resolveMs": 9.7,
        "edgesMs": 57.4,
        "structureMs": 3.8,
        "rolesMs": 5.3,
        "complexityMs": 5.1
      }
    }
  },
  {
    "version": "2.4.0",
    "date": "2026-02-28",
    "files": 123,
    "wasm": {
      "buildTimeMs": 630,
      "queryTimeMs": 2.2,
      "nodes": 801,
      "edges": 1320,
      "dbSizeBytes": 577536,
      "perFile": {
        "buildTimeMs": 5.1,
        "nodes": 6.5,
        "edges": 10.7,
        "dbSizeBytes": 4695
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 192,
      "queries": {
        "fnDepsMs": 0.5,
        "fnImpactMs": 0.5,
        "pathMs": null,
        "rolesMs": 0.9
      },
      "phases": null
    },
    "native": null
  },
  {
    "version": "2.3.0",
    "date": "2026-02-24",
    "files": 99,
    "wasm": {
      "buildTimeMs": 649,
      "queryTimeMs": 2.1,
      "nodes": 575,
      "edges": 897,
      "dbSizeBytes": 380928,
      "perFile": {
        "buildTimeMs": 6.6,
        "nodes": 5.8,
        "edges": 9.1,
        "dbSizeBytes": 3848
      }
    },
    "native": {
      "buildTimeMs": 183,
      "queryTimeMs": 1.5,
      "nodes": 575,
      "edges": 897,
      "dbSizeBytes": 380928,
      "perFile": {
        "buildTimeMs": 1.9,
        "nodes": 5.8,
        "edges": 9.1,
        "dbSizeBytes": 3848
      }
    }
  },
  {
    "version": "2.1.0",
    "date": "2026-02-23",
    "files": 92,
    "wasm": {
      "buildTimeMs": 609,
      "queryTimeMs": 1.9,
      "nodes": 527,
      "edges": 814,
      "dbSizeBytes": 352256,
      "perFile": {
        "buildTimeMs": 6.6,
        "nodes": 5.7,
        "edges": 8.8,
        "dbSizeBytes": 3829
      }
    },
    "native": {
      "buildTimeMs": 172,
      "queryTimeMs": 1.4,
      "nodes": 500,
      "edges": 839,
      "dbSizeBytes": 352256,
      "perFile": {
        "buildTimeMs": 1.9,
        "nodes": 5.4,
        "edges": 9.1,
        "dbSizeBytes": 3829
      }
    }
  },
  {
    "version": "2.0.0",
    "date": "2026-02-23",
    "files": 89,
    "wasm": {
      "buildTimeMs": 444,
      "queryTimeMs": 1.6,
      "nodes": 451,
      "edges": 1442,
      "dbSizeBytes": 389120,
      "perFile": {
        "buildTimeMs": 5,
        "nodes": 5.1,
        "edges": 16.2,
        "dbSizeBytes": 4372
      }
    },
    "native": {
      "buildTimeMs": 226,
      "queryTimeMs": 1.2,
      "nodes": 451,
      "edges": 1534,
      "dbSizeBytes": 397312,
      "perFile": {
        "buildTimeMs": 2.5,
        "nodes": 5.1,
        "edges": 17.2,
        "dbSizeBytes": 4464
      }
    }
  }
]
-->
