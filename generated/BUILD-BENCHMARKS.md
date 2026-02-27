# Codegraph Performance Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Metrics are normalized per file for cross-version comparability.

| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |
|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|
| 2.4.0 | native | 2026-02-27 | 122 | 6.6 ↑247% | 2.5 ↑67% | 6.4 ↑10% | 10.9 ↑20% | 5506 ↑43% |
| 2.4.0 | wasm | 2026-02-27 | 122 | 9.2 ↑39% | 3.4 ↑62% | 6.4 ↑10% | 10.9 ↑20% | 5506 ↑43% |
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
| Build time | 804ms |
| Query time | 3ms |
| Nodes | 778 |
| Edges | 1,333 |
| DB size | 656 KB |
| Files | 122 |

#### WASM

| Metric | Value |
|--------|-------|
| Build time | 1.1s |
| Query time | 3ms |
| Nodes | 778 |
| Edges | 1,333 |
| DB size | 656 KB |
| Files | 122 |

### Build Phase Breakdown (latest)

| Phase | Native | WASM |
|-------|-------:|-----:|
| Parse | 111.4 ms | 641.9 ms |
| Insert nodes | 12.7 ms | 15.7 ms |
| Resolve imports | 9.7 ms | 12.8 ms |
| Build edges | 56 ms | 60.3 ms |
| Structure | 3.8 ms | 8.8 ms |
| Roles | 4.7 ms | 5 ms |
| Complexity | 585.3 ms | 347.1 ms |

### Estimated performance at 50,000 files

Extrapolated linearly from per-file metrics above.

| Metric | Native (Rust) | WASM |
|--------|---:|---:|
| Build time | 330.0s | 460.0s |
| DB size | 262.5 MB | 262.5 MB |
| Nodes | 320,000 | 320,000 |
| Edges | 545,000 | 545,000 |

### Incremental Rebuilds

| Version | Engine | No-op (ms) | 1-file (ms) |
|---------|--------|----------:|-----------:|
| 2.4.0 | native | 4 | 360 |
| 2.4.0 | wasm | 4 | 351 |

### Query Latency

| Version | Engine | fn-deps (ms) | fn-impact (ms) | path (ms) | roles (ms) |
|---------|--------|------------:|--------------:|----------:|----------:|
| 2.4.0 | native | 2.1 | 1.6 | 1.2 | 1.1 |
| 2.4.0 | wasm | 2.2 | 1.6 | 1.2 | 1.2 |

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
    "version": "2.4.0",
    "date": "2026-02-27",
    "files": 122,
    "wasm": {
      "buildTimeMs": 1123,
      "queryTimeMs": 3.4,
      "nodes": 778,
      "edges": 1333,
      "dbSizeBytes": 671744,
      "perFile": {
        "buildTimeMs": 9.2,
        "nodes": 6.4,
        "edges": 10.9,
        "dbSizeBytes": 5506
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 351,
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.2
      },
      "phases": {
        "parseMs": 641.9,
        "insertMs": 15.7,
        "resolveMs": 12.8,
        "edgesMs": 60.3,
        "structureMs": 8.8,
        "rolesMs": 5,
        "complexityMs": 347.1
      }
    },
    "native": {
      "buildTimeMs": 804,
      "queryTimeMs": 2.5,
      "nodes": 778,
      "edges": 1333,
      "dbSizeBytes": 671744,
      "perFile": {
        "buildTimeMs": 6.6,
        "nodes": 6.4,
        "edges": 10.9,
        "dbSizeBytes": 5506
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 360,
      "queries": {
        "fnDepsMs": 2.1,
        "fnImpactMs": 1.6,
        "pathMs": 1.2,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 111.4,
        "insertMs": 12.7,
        "resolveMs": 9.7,
        "edgesMs": 56,
        "structureMs": 3.8,
        "rolesMs": 4.7,
        "complexityMs": 585.3
      }
    }
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
