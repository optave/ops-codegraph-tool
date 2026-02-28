# Codegraph Performance Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Metrics are normalized per file for cross-version comparability.

| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |
|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|
| 2.5.0 | native | 2026-02-28 | 126 | 2 | 2.7 | 6.5 | 11.1 | 5526 |
| 2.5.0 | wasm | 2026-02-28 | 126 | 8.5 ↑67% | 3.7 ↑68% | 6.5 ~ | 11.1 ↑4% | 5526 ↑18% |
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
| Build time | 257ms |
| Query time | 3ms |
| Nodes | 817 |
| Edges | 1,393 |
| DB size | 680 KB |
| Files | 126 |

#### WASM

| Metric | Value |
|--------|-------|
| Build time | 1.1s |
| Query time | 4ms |
| Nodes | 817 |
| Edges | 1,393 |
| DB size | 680 KB |
| Files | 126 |

### Build Phase Breakdown (latest)

| Phase | Native | WASM |
|-------|-------:|-----:|
| Parse | 138.3 ms | 688.7 ms |
| Insert nodes | 13.6 ms | 19.4 ms |
| Resolve imports | 10.4 ms | 13.7 ms |
| Build edges | 65.1 ms | 61.8 ms |
| Structure | 5.4 ms | 6.9 ms |
| Roles | 4.9 ms | 5.4 ms |
| Complexity | 5.4 ms | 242.2 ms |

### Estimated performance at 50,000 files

Extrapolated linearly from per-file metrics above.

| Metric | Native (Rust) | WASM |
|--------|---:|---:|
| Build time | 100.0s | 425.0s |
| DB size | 263.5 MB | 263.5 MB |
| Nodes | 325,000 | 325,000 |
| Edges | 555,000 | 555,000 |

### Incremental Rebuilds

| Version | Engine | No-op (ms) | 1-file (ms) |
|---------|--------|----------:|-----------:|
| 2.5.0 | native | 4 | 100 |
| 2.5.0 | wasm | 5 ~ | 338 ↑76% |
| 2.4.0 | wasm | 5 | 192 |

### Query Latency

| Version | Engine | fn-deps (ms) | fn-impact (ms) | path (ms) | roles (ms) |
|---------|--------|------------:|--------------:|----------:|----------:|
| 2.5.0 | native | 2.4 | 1.7 | 1.2 | 1.1 |
| 2.5.0 | wasm | 2.4 ↑380% | 1.7 ↑240% | 1.2 | 1.2 ↑33% |
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
    "version": "2.5.0",
    "date": "2026-02-28",
    "files": 126,
    "wasm": {
      "buildTimeMs": 1069,
      "queryTimeMs": 3.7,
      "nodes": 817,
      "edges": 1393,
      "dbSizeBytes": 696320,
      "perFile": {
        "buildTimeMs": 8.5,
        "nodes": 6.5,
        "edges": 11.1,
        "dbSizeBytes": 5526
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 338,
      "queries": {
        "fnDepsMs": 2.4,
        "fnImpactMs": 1.7,
        "pathMs": 1.2,
        "rolesMs": 1.2
      },
      "phases": {
        "parseMs": 688.7,
        "insertMs": 19.4,
        "resolveMs": 13.7,
        "edgesMs": 61.8,
        "structureMs": 6.9,
        "rolesMs": 5.4,
        "complexityMs": 242.2
      }
    },
    "native": {
      "buildTimeMs": 257,
      "queryTimeMs": 2.7,
      "nodes": 817,
      "edges": 1393,
      "dbSizeBytes": 696320,
      "perFile": {
        "buildTimeMs": 2,
        "nodes": 6.5,
        "edges": 11.1,
        "dbSizeBytes": 5526
      },
      "noopRebuildMs": 4,
      "oneFileRebuildMs": 100,
      "queries": {
        "fnDepsMs": 2.4,
        "fnImpactMs": 1.7,
        "pathMs": 1.2,
        "rolesMs": 1.1
      },
      "phases": {
        "parseMs": 138.3,
        "insertMs": 13.6,
        "resolveMs": 10.4,
        "edgesMs": 65.1,
        "structureMs": 5.4,
        "rolesMs": 4.9,
        "complexityMs": 5.4
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
