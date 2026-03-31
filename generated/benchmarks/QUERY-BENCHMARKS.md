# Codegraph Query Benchmarks

Self-measured on every release by running codegraph queries on its own graph.
Latencies are median over 5 runs. Hub target = most-connected node.

| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |
|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|
| 3.6.0 | native | 9.4 ↑6% | 9.6 ↑8% | 9.4 ↑7% | 3.4 ↑6% | 3.4 ↑10% | 3.3 ↑6% | 8.3ms ~ |
| 3.6.0 | wasm | 9.7 ↑7% | 9.7 ↑7% | 9.6 ↑7% | 3.4 ↑13% | 3.4 ↑10% | 3.4 ↑10% | 9ms ↑41% |
| 3.5.0 | wasm | 9.1 ~ | 9.1 ~ | 9 ~ | 3 ↓9% | 3.1 ↓3% | 3.1 ↓3% | 6.4ms ↓10% |
| 3.4.1 | native | 8.9 ↑5% | 8.9 ↑5% | 8.8 ↑5% | 3.2 ~ | 3.1 ↓3% | 3.1 ↓3% | 8.1ms ↑45% |
| 3.4.1 | wasm | 9.1 ↑7% | 9.2 ↑7% | 9.1 ↑7% | 3.3 ~ | 3.2 ↓3% | 3.2 ↓3% | 7.1ms ↑45% |
| 3.4.0 | native | 8.5 ↑136% | 8.5 ↑136% | 8.4 ↑140% | 3.2 ↑28% | 3.2 ↑23% | 3.2 ↑28% | 5.6ms ↓20% |
| 3.4.0 | wasm | 8.5 ↑143% | 8.6 ↑139% | 8.5 ↑143% | 3.3 ↑38% | 3.3 ↑38% | 3.3 ↑38% | 4.9ms ↑2% |
| 3.3.1 | native | 3.6 ↑157% | 3.6 ↑177% | 3.5 ↑169% | 2.5 ↑92% | 2.6 ↑100% | 2.5 ↑92% | 7ms ↓20% |
| 3.3.1 | wasm | 3.5 ↑169% | 3.6 ↑177% | 3.5 ↑192% | 2.4 ↑85% | 2.4 ↑85% | 2.4 ↑85% | 4.8ms ↓44% |
| 3.3.0 | native | 1.4 ↑56% | 1.3 ↑44% | 1.3 ↑44% | 1.3 ↑44% | 1.3 ↑44% | 1.3 ↑44% | 8.8ms ↑28% |
| 3.3.0 | wasm | 1.3 ↑30% | 1.3 ↑30% | 1.2 ↑33% | 1.3 ↑44% | 1.3 ↑44% | 1.3 ↑44% | 8.5ms ↑39% |
| 3.1.4 | native | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 6.9ms ↓17% |
| 3.1.4 | wasm | 1 ↑11% | 1 ↑25% | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 6.1ms ↓22% |
| 3.1.3 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 8.3ms ↓2% |
| 3.1.3 | wasm | 0.9 ~ | 0.8 ↓11% | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7.8ms ~ |
| 3.1.2 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ↑14% | 0.8 ↑14% | 8.5ms ↑6% |
| 3.1.2 | wasm | 0.9 ↑12% | 0.9 ↑12% | 0.8 ~ | 0.8 ↑14% | 0.8 ↑14% | 0.8 ↑14% | 7.9ms ↑10% |
| 3.1.0 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.7 ↓13% | 0.7 ↓13% | 8ms ~ |
| 3.1.0 | wasm | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.7 ↓13% | 0.7 ↓13% | 0.7 ↓13% | 7.2ms ↑3% |
| 3.0.4 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7.9ms ↑5% |
| 3.0.4 | wasm | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7ms ~ |
| 3.0.3 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7.5ms ↓5% |
| 3.0.3 | wasm | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7ms ↓5% |
| 3.0.2 | native | 0.8 ↓11% | 0.8 ↓11% | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7.9ms ↓13% |
| 3.0.2 | wasm | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 7.4ms ↓13% |
| 3.0.1 | native | 0.9 ↑12% | 0.9 ↑12% | 0.8 ~ | 0.8 ~ | 0.8 ~ | 0.8 ~ | 9.1ms ↑18% |
| 3.0.1 | wasm | 0.8 ↓11% | 0.8 ↓11% | 0.8 ~ | 0.8 ↓11% | 0.8 ~ | 0.8 ~ | 8.5ms ↑20% |
| 3.0.0 | native | 0.8 ↓33% | 0.8 ↓38% | 0.8 ↓38% | 0.8 ↓33% | 0.8 ↓33% | 0.8 ↓33% | 7.7ms ↑24% |
| 3.0.0 | wasm | 0.9 ↓31% | 0.9 ↓36% | 0.8 ↓38% | 0.9 ↓25% | 0.8 ↓33% | 0.8 ↓33% | 7.1ms ↑16% |
| 2.6.0 | native | 1.2 ↑100% | 1.3 ↑117% | 1.3 ↑117% | 1.2 ↑100% | 1.2 ↑100% | 1.2 ↑100% | 6.2ms ↑5% |
| 2.6.0 | wasm | 1.3 ↑86% | 1.4 ↑133% | 1.3 ↑117% | 1.2 ↑100% | 1.2 ↑100% | 1.2 ↑100% | 6.1ms ↑13% |
| 2.5.1 | native | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.9ms |
| 2.5.1 | wasm | 0.7 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.4ms |

### Latest results

**Version:** 3.6.0 | **Date:** 2026-03-30

#### Native (Rust)

**Targets:** hub=`buildGraph`, mid=`node`, leaf=`docs`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 9.4ms |
| fnDeps depth 3 | 9.6ms |
| fnDeps depth 5 | 9.4ms |
| fnImpact depth 1 | 3.4ms |
| fnImpact depth 3 | 3.4ms |
| fnImpact depth 5 | 3.3ms |
| diffImpact latency | 8.3ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

#### WASM

**Targets:** hub=`buildGraph`, mid=`node`, leaf=`docs`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 9.7ms |
| fnDeps depth 3 | 9.7ms |
| fnDeps depth 5 | 9.6ms |
| fnImpact depth 1 | 3.4ms |
| fnImpact depth 3 | 3.4ms |
| fnImpact depth 5 | 3.4ms |
| diffImpact latency | 9ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

<!-- NOTES_START -->
**Note (3.6.0):** Native deltas are relative to 3.4.1 (the last version with native data; 3.5.0 was wasm-only). The mid-query target changed from `db` (3.5.0) to `node`, which affects diffImpact scope and explains the ↑41% WASM diffImpact jump (6.4ms → 9ms). fnDeps/fnImpact growth of 6-10% is consistent with codebase expansion across two releases.

**Note (3.5.0):** This version has WASM-only data (`native: null`) because the native engine crashed during `insertNodes` in the graph build phase. The root cause is a napi-rs serialization bug: parameter and child nodes with undefined `visibility` fields marshal as `null` at the JS-Rust boundary, which fails conversion into the Rust `Option<String>` type in `InsertNodesDefinition.visibility`. The mid-query target also changed from `noTests` to `db`, which may affect diffImpact scope. Query latencies for 3.5.0 are therefore not directly comparable to prior versions that include both engine rows. This will be fixed in the next release.

**Note (3.4.1):** The ↑45% diffImpact delta is inflated by 3.4.0 being an unusually low baseline (5.6ms/4.9ms). The new absolute values (8.1ms native, 7.1ms wasm) fall within the historical range (e.g. 3.1.3: 8.3ms, 3.3.0: 8.8ms). The mid-query target also changed from `rule` to `noTests`, which may affect diffImpact scope. No engine regression — fnDeps grew only 5-7% (consistent with codebase expansion) and fnImpact is flat-to-slightly-down.

**Note (3.4.0):** The ↑136-143% fnDeps deltas for 3.4.0 vs 3.3.1 reflect codebase growth — `buildGraph` has significantly more edges in this release (new extractors, refactored domain/features layers). The mid-query target also changed from `db` to `rule`. There is no engine regression — native `diffImpact` improved 20% in the same release.

**Note (3.3.1):** The ↑157-192% fnDeps/fnImpact deltas for 3.3.1 vs 3.3.0 are not comparable. PR #528 changed the hub target from auto-selected `src/types.ts` (shallow type-barrel) to pinned `buildGraph` (deep orchestration function with 2-3x more edges). There is no engine regression — `diffImpact` improved 20-44% in the same release. Future version comparisons (3.3.1+) are stable and meaningful.
<!-- NOTES_END -->

<!-- QUERY_BENCHMARK_DATA
[
  {
    "version": "3.6.0",
    "date": "2026-03-30",
    "wasm": {
      "targets": {
        "hub": "buildGraph",
        "mid": "node",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 9.7,
        "depth3Ms": 9.7,
        "depth5Ms": 9.6
      },
      "fnImpact": {
        "depth1Ms": 3.4,
        "depth3Ms": 3.4,
        "depth5Ms": 3.4
      },
      "diffImpact": {
        "latencyMs": 9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "buildGraph",
        "mid": "node",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 9.4,
        "depth3Ms": 9.6,
        "depth5Ms": 9.4
      },
      "fnImpact": {
        "depth1Ms": 3.4,
        "depth3Ms": 3.4,
        "depth5Ms": 3.3
      },
      "diffImpact": {
        "latencyMs": 8.3,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.5.0",
    "date": "2026-03-30",
    "wasm": {
      "targets": {
        "hub": "buildGraph",
        "mid": "db",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 9.1,
        "depth3Ms": 9.1,
        "depth5Ms": 9
      },
      "fnImpact": {
        "depth1Ms": 3,
        "depth3Ms": 3.1,
        "depth5Ms": 3.1
      },
      "diffImpact": {
        "latencyMs": 6.4,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": null
  },
  {
    "version": "3.4.1",
    "date": "2026-03-27",
    "wasm": {
      "targets": {
        "hub": "buildGraph",
        "mid": "noTests",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 9.1,
        "depth3Ms": 9.2,
        "depth5Ms": 9.1
      },
      "fnImpact": {
        "depth1Ms": 3.3,
        "depth3Ms": 3.2,
        "depth5Ms": 3.2
      },
      "diffImpact": {
        "latencyMs": 7.1,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "buildGraph",
        "mid": "noTests",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 8.9,
        "depth3Ms": 8.9,
        "depth5Ms": 8.8
      },
      "fnImpact": {
        "depth1Ms": 3.2,
        "depth3Ms": 3.1,
        "depth5Ms": 3.1
      },
      "diffImpact": {
        "latencyMs": 8.1,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.4.0",
    "date": "2026-03-26",
    "wasm": {
      "targets": {
        "hub": "buildGraph",
        "mid": "rule",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 8.5,
        "depth3Ms": 8.6,
        "depth5Ms": 8.5
      },
      "fnImpact": {
        "depth1Ms": 3.3,
        "depth3Ms": 3.3,
        "depth5Ms": 3.3
      },
      "diffImpact": {
        "latencyMs": 4.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "buildGraph",
        "mid": "rule",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 8.5,
        "depth3Ms": 8.5,
        "depth5Ms": 8.4
      },
      "fnImpact": {
        "depth1Ms": 3.2,
        "depth3Ms": 3.2,
        "depth5Ms": 3.2
      },
      "diffImpact": {
        "latencyMs": 5.6,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.3.1",
    "date": "2026-03-20",
    "wasm": {
      "targets": {
        "hub": "buildGraph",
        "mid": "db",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 3.5,
        "depth3Ms": 3.6,
        "depth5Ms": 3.5
      },
      "fnImpact": {
        "depth1Ms": 2.4,
        "depth3Ms": 2.4,
        "depth5Ms": 2.4
      },
      "diffImpact": {
        "latencyMs": 4.8,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "buildGraph",
        "mid": "db",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 3.6,
        "depth3Ms": 3.6,
        "depth5Ms": 3.5
      },
      "fnImpact": {
        "depth1Ms": 2.5,
        "depth3Ms": 2.6,
        "depth5Ms": 2.5
      },
      "diffImpact": {
        "latencyMs": 7,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.3.0",
    "date": "2026-03-19",
    "wasm": {
      "targets": {
        "hub": "src/types.ts",
        "mid": "functionNodeId",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 1.3,
        "depth3Ms": 1.3,
        "depth5Ms": 1.2
      },
      "fnImpact": {
        "depth1Ms": 1.3,
        "depth3Ms": 1.3,
        "depth5Ms": 1.3
      },
      "diffImpact": {
        "latencyMs": 8.5,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/types.ts",
        "mid": "db",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 1.4,
        "depth3Ms": 1.3,
        "depth5Ms": 1.3
      },
      "fnImpact": {
        "depth1Ms": 1.3,
        "depth3Ms": 1.3,
        "depth5Ms": 1.3
      },
      "diffImpact": {
        "latencyMs": 8.8,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.1.4",
    "date": "2026-03-16",
    "wasm": {
      "targets": {
        "hub": "src/db.js",
        "mid": "previous",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 1,
        "depth3Ms": 1,
        "depth5Ms": 0.9
      },
      "fnImpact": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.9,
        "depth5Ms": 0.9
      },
      "diffImpact": {
        "latencyMs": 6.1,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/db.js",
        "mid": "previous",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.9,
        "depth5Ms": 0.9
      },
      "fnImpact": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.9,
        "depth5Ms": 0.9
      },
      "diffImpact": {
        "latencyMs": 6.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.1.3",
    "date": "2026-03-12",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "modelKey",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.8,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "modelKey",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 8.3,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.1.2",
    "date": "2026-03-11",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "cyclomatic",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.9,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "cyclomatic",
        "leaf": "docs"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 8.5,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.1.0",
    "date": "2026-03-08",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "include_ast_nodes",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.7,
        "depth3Ms": 0.7,
        "depth5Ms": 0.7
      },
      "diffImpact": {
        "latencyMs": 7.2,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "include_ast_nodes",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.7,
        "depth5Ms": 0.7
      },
      "diffImpact": {
        "latencyMs": 8,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.0.4",
    "date": "2026-03-06",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "self",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "self",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.0.3",
    "date": "2026-03-04",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "targets",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "targets",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.5,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.0.2",
    "date": "2026-03-04",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "targets",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.4,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "targets",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.0.1",
    "date": "2026-03-04",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "n",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 8.5,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "n",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.9,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 9.1,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "3.0.0",
    "date": "2026-03-03",
    "wasm": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "source",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.9,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.9,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.1,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/queries.js",
        "mid": "source",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "fnImpact": {
        "depth1Ms": 0.8,
        "depth3Ms": 0.8,
        "depth5Ms": 0.8
      },
      "diffImpact": {
        "latencyMs": 7.7,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "2.6.0",
    "date": "2026-03-02",
    "wasm": {
      "targets": {
        "hub": "startMCPServer",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 1.3,
        "depth3Ms": 1.4,
        "depth5Ms": 1.3
      },
      "fnImpact": {
        "depth1Ms": 1.2,
        "depth3Ms": 1.2,
        "depth5Ms": 1.2
      },
      "diffImpact": {
        "latencyMs": 6.1,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "startMCPServer",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 1.2,
        "depth3Ms": 1.3,
        "depth5Ms": 1.3
      },
      "fnImpact": {
        "depth1Ms": 1.2,
        "depth3Ms": 1.2,
        "depth5Ms": 1.2
      },
      "diffImpact": {
        "latencyMs": 6.2,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  },
  {
    "version": "2.5.1",
    "date": "2026-03-02",
    "wasm": {
      "targets": {
        "hub": "src/db.js",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.7,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "fnImpact": {
        "depth1Ms": 0.6,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "diffImpact": {
        "latencyMs": 5.4,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    },
    "native": {
      "targets": {
        "hub": "src/db.js",
        "mid": "extract_implements_from_node",
        "leaf": "crates"
      },
      "fnDeps": {
        "depth1Ms": 0.6,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "fnImpact": {
        "depth1Ms": 0.6,
        "depth3Ms": 0.6,
        "depth5Ms": 0.6
      },
      "diffImpact": {
        "latencyMs": 5.9,
        "affectedFunctions": 0,
        "affectedFiles": 0
      }
    }
  }
]
-->
