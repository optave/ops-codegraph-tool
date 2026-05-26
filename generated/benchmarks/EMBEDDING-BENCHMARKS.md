# Codegraph Embedding Benchmarks

Self-measured on every release using auto-generated queries from symbol names.
Each symbol's name is split into words (e.g. `buildGraph` → `"build graph"`) and used as the search query.
Hit@N = expected symbol found in top N results.

| Version | Model | Symbols | Hit@1 | Hit@3 | Hit@5 | Misses | Embed Time |
|---------|-------|--------:|------:|------:|------:|-------:|-----------:|
| 3.11.0 | minilm | 1500 | 62.1% ↓3.7pp | 85.5% ↓0.7pp | 91.5% ~ | 72 | 138.8s |
| 3.11.0 | jina-small | 1500 | 76.0% ↓1.1pp | 92.2% ↓0.6pp | 95.3% ~ | 32 | 263.0s |
| 3.11.0 | jina-base | 1500 | 69.9% ↓1.5pp | 89.9% ↓1.4pp | 93.7% ↓1.7pp | 46 | 1346.7s |
| 3.11.0 | nomic | 1500 | 76.7% ↓4.6pp | 93.9% ↓0.8pp | 97.3% ~ | 14 | 1348.3s |
| 3.11.0 | nomic-v1.5 | 1500 | 75.5% ↓3.9pp | 92.6% ↓1.4pp | 95.8% ↓0.9pp | 20 | 1344.7s |
| 3.10.0 | minilm | 1500 | 65.9% ↓1.5pp | 86.3% ↓0.9pp | 91.8% ↓0.6pp | 58 | 128.0s |
| 3.10.0 | jina-small | 1500 | 77.1% ↑1.3pp | 92.8% ↓0.8pp | 95.8% ↓0.7pp | 29 | 262.7s |
| 3.10.0 | jina-base | 1500 | 71.4% ↓0.7pp | 91.3% ↑1.0pp | 95.4% ~ | 35 | 1346.3s |
| 3.10.0 | nomic | 1500 | 81.3% ↑1.2pp | 94.7% ↓0.9pp | 97.5% ~ | 18 | 1340.3s |
| 3.10.0 | nomic-v1.5 | 1500 | 79.3% ↑0.9pp | 94.0% ↓0.9pp | 96.7% ~ | 24 | 1335.2s |
| 3.9.6 | minilm | 1500 | 67.4% | 87.2% | 92.4% | 49 | 125.9s |
| 3.9.6 | jina-small | 1500 | 75.8% | 93.6% | 96.5% | 23 | 253.8s |
| 3.9.6 | jina-base | 1500 | 72.1% | 90.3% | 94.9% | 30 | 1327.4s |
| 3.9.6 | nomic | 1500 | 80.1% | 95.5% | 97.9% | 15 | 1331.2s |
| 3.9.6 | nomic-v1.5 | 1500 | 78.4% | 94.9% | 97.1% | 18 | 1325.3s |

### Latest results

**Version:** 3.11.0 | **Strategy:** structured | **Symbols:** 1500 | **Date:** 2026-05-26

| Model | Dim | Context | Hit@1 | Hit@3 | Hit@5 | Hit@10 | Misses | Embed | Search |
|-------|----:|--------:|------:|------:|------:|-------:|-------:|------:|-------:|
| minilm | 384 | 256 | 62.1% | 85.5% | 91.5% | 95.2% | 72 | 138.8s | 135.5s |
| jina-small | 512 | 8192 | 76.0% | 92.2% | 95.3% | 97.9% | 32 | 263.0s | 159.5s |
| jina-base | 768 | 8192 | 69.9% | 89.9% | 93.7% | 96.9% | 46 | 1346.7s | 206.1s |
| nomic | 768 | 8192 | 76.7% | 93.9% | 97.3% | 99.1% | 14 | 1348.3s | 209.6s |
| nomic-v1.5 | 768 | 8192 | 75.5% | 92.6% | 95.8% | 98.7% | 20 | 1344.7s | 205.4s |

<!-- EMBEDDING_BENCHMARK_DATA
[
  {
    "version": "3.11.0",
    "date": "2026-05-26",
    "strategy": "structured",
    "symbols": 1500,
    "models": {
      "minilm": {
        "dim": 384,
        "contextWindow": 256,
        "hits1": 932,
        "hits3": 1283,
        "hits5": 1373,
        "hits10": 1428,
        "misses": 72,
        "total": 1500,
        "embedTimeMs": 138822,
        "searchTimeMs": 135495
      },
      "jina-small": {
        "dim": 512,
        "contextWindow": 8192,
        "hits1": 1140,
        "hits3": 1383,
        "hits5": 1430,
        "hits10": 1468,
        "misses": 32,
        "total": 1500,
        "embedTimeMs": 263027,
        "searchTimeMs": 159491
      },
      "jina-base": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1049,
        "hits3": 1349,
        "hits5": 1405,
        "hits10": 1454,
        "misses": 46,
        "total": 1500,
        "embedTimeMs": 1346661,
        "searchTimeMs": 206052
      },
      "nomic": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1151,
        "hits3": 1408,
        "hits5": 1459,
        "hits10": 1486,
        "misses": 14,
        "total": 1500,
        "embedTimeMs": 1348319,
        "searchTimeMs": 209584
      },
      "nomic-v1.5": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1132,
        "hits3": 1389,
        "hits5": 1437,
        "hits10": 1480,
        "misses": 20,
        "total": 1500,
        "embedTimeMs": 1344731,
        "searchTimeMs": 205412
      }
    }
  },
  {
    "version": "3.10.0",
    "date": "2026-05-11",
    "strategy": "structured",
    "symbols": 1500,
    "models": {
      "minilm": {
        "dim": 384,
        "contextWindow": 256,
        "hits1": 988,
        "hits3": 1294,
        "hits5": 1377,
        "hits10": 1442,
        "misses": 58,
        "total": 1500,
        "embedTimeMs": 127967,
        "searchTimeMs": 133929
      },
      "jina-small": {
        "dim": 512,
        "contextWindow": 8192,
        "hits1": 1157,
        "hits3": 1392,
        "hits5": 1437,
        "hits10": 1471,
        "misses": 29,
        "total": 1500,
        "embedTimeMs": 262748,
        "searchTimeMs": 161910
      },
      "jina-base": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1071,
        "hits3": 1370,
        "hits5": 1431,
        "hits10": 1465,
        "misses": 35,
        "total": 1500,
        "embedTimeMs": 1346347,
        "searchTimeMs": 209513
      },
      "nomic": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1220,
        "hits3": 1420,
        "hits5": 1463,
        "hits10": 1482,
        "misses": 18,
        "total": 1500,
        "embedTimeMs": 1340310,
        "searchTimeMs": 210505
      },
      "nomic-v1.5": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1190,
        "hits3": 1410,
        "hits5": 1451,
        "hits10": 1476,
        "misses": 24,
        "total": 1500,
        "embedTimeMs": 1335152,
        "searchTimeMs": 208134
      }
    }
  },
  {
    "version": "3.9.6",
    "date": "2026-04-30",
    "strategy": "structured",
    "symbols": 1500,
    "models": {
      "minilm": {
        "dim": 384,
        "contextWindow": 256,
        "hits1": 1011,
        "hits3": 1308,
        "hits5": 1386,
        "hits10": 1451,
        "misses": 49,
        "total": 1500,
        "embedTimeMs": 125867,
        "searchTimeMs": 130509
      },
      "jina-small": {
        "dim": 512,
        "contextWindow": 8192,
        "hits1": 1137,
        "hits3": 1404,
        "hits5": 1447,
        "hits10": 1477,
        "misses": 23,
        "total": 1500,
        "embedTimeMs": 253823,
        "searchTimeMs": 159156
      },
      "jina-base": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1082,
        "hits3": 1355,
        "hits5": 1424,
        "hits10": 1470,
        "misses": 30,
        "total": 1500,
        "embedTimeMs": 1327410,
        "searchTimeMs": 206246
      },
      "nomic": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1202,
        "hits3": 1433,
        "hits5": 1469,
        "hits10": 1485,
        "misses": 15,
        "total": 1500,
        "embedTimeMs": 1331223,
        "searchTimeMs": 206002
      },
      "nomic-v1.5": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1176,
        "hits3": 1423,
        "hits5": 1457,
        "hits10": 1482,
        "misses": 18,
        "total": 1500,
        "embedTimeMs": 1325336,
        "searchTimeMs": 206972
      }
    }
  },
  {
    "version": "3.1.4",
    "date": "2026-03-16",
    "strategy": "structured",
    "symbols": 1095,
    "models": {}
  }
]
-->
