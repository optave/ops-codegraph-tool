# Codegraph Query Benchmarks

Self-measured on every release by running codegraph queries on its own graph.
Latencies are median over 5 runs. Hub target = most-connected node.

| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |
|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|
| 2.6.0 | native | 1.2 ↑100% | 1.3 ↑117% | 1.3 ↑117% | 1.2 ↑100% | 1.2 ↑100% | 1.2 ↑100% | 6.2ms ↑5% |
| 2.6.0 | wasm | 1.3 ↑86% | 1.4 ↑133% | 1.3 ↑117% | 1.2 ↑100% | 1.2 ↑100% | 1.2 ↑100% | 6.1ms ↑13% |
| 2.5.1 | native | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.9ms |
| 2.5.1 | wasm | 0.7 | 0.6 | 0.6 | 0.6 | 0.6 | 0.6 | 5.4ms |

### Latest results

**Version:** 2.6.0 | **Date:** 2026-03-02

#### Native (Rust)

**Targets:** hub=`startMCPServer`, mid=`extract_implements_from_node`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 1.2ms |
| fnDeps depth 3 | 1.3ms |
| fnDeps depth 5 | 1.3ms |
| fnImpact depth 1 | 1.2ms |
| fnImpact depth 3 | 1.2ms |
| fnImpact depth 5 | 1.2ms |
| diffImpact latency | 6.2ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

#### WASM

**Targets:** hub=`startMCPServer`, mid=`extract_implements_from_node`, leaf=`crates`

| Metric | Value |
|--------|------:|
| fnDeps depth 1 | 1.3ms |
| fnDeps depth 3 | 1.4ms |
| fnDeps depth 5 | 1.3ms |
| fnImpact depth 1 | 1.2ms |
| fnImpact depth 3 | 1.2ms |
| fnImpact depth 5 | 1.2ms |
| diffImpact latency | 6.1ms |
| diffImpact affected functions | 0 |
| diffImpact affected files | 0 |

<!-- QUERY_BENCHMARK_DATA
[
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
