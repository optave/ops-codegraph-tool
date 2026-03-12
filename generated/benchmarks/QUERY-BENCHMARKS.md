# Codegraph Query Benchmarks

Self-measured on every release by running codegraph queries on its own graph.
Latencies are median over 5 runs. Hub target = most-connected node.

| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |
|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|
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

**Version:** 3.1.3 | **Date:** 2026-03-12

#### Native (Rust)

**Targets:** hub=`src/queries.js`, mid=`modelKey`, leaf=`docs`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 0.8ms |
| fnDeps depth 3 | 0.8ms |
| fnDeps depth 5 | 0.8ms |
| fnImpact depth 1 | 0.8ms |
| fnImpact depth 3 | 0.8ms |
| fnImpact depth 5 | 0.8ms |
| diffImpact latency | 8.3ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

#### WASM

**Targets:** hub=`src/queries.js`, mid=`modelKey`, leaf=`docs`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 0.9ms |
| fnDeps depth 3 | 0.8ms |
| fnDeps depth 5 | 0.8ms |
| fnImpact depth 1 | 0.8ms |
| fnImpact depth 3 | 0.8ms |
| fnImpact depth 5 | 0.8ms |
| diffImpact latency | 7.8ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

<!-- QUERY_BENCHMARK_DATA
[
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
