# Codegraph Embedding Benchmarks

Self-measured on every release using auto-generated queries from symbol names.
Each symbol's name is split into words (e.g. `buildGraph` → `"build graph"`) and used as the search query.
Hit@N = expected symbol found in top N results.

| Version | Model | Symbols | Hit@1 | Hit@3 | Hit@5 | Misses | Embed Time |
|---------|-------|--------:|------:|------:|------:|-------:|-----------:|
| 3.12.0 | minilm | 1500 | 64.0% ↓2.6pp | 84.7% ↓2.0pp | 90.2% ↓1.3pp | 78 | 158.6s |
| 3.12.0 | jina-small | 1500 | 77.4% ↑2.1pp | 92.1% ↑0.8pp | 95.1% ~ | 42 | 307.6s |
| 3.12.0 | jina-code | 1500 | 68.5% ~ | 84.5% ↓1.3pp | 89.2% ↓1.9pp | 87 | 1342.5s |
| 3.12.0 | mxbai-xsmall | 1500 | 50.2% ~ | 69.7% ↑0.9pp | 76.9% ↑1.7pp | 232 | 233.1s |
| 3.12.0 | modernbert | 1500 | 74.7% ~ | 91.8% ↑0.7pp | 95.1% ↑0.8pp | 31 | 1472.9s |
| 3.11.2 | minilm | 1500 | 66.6% ↑1.2pp | 86.7% ↑1.1pp | 91.5% ~ | 66 | 148.6s |
| 3.11.2 | jina-small | 1500 | 75.3% ↓0.9pp | 91.3% ↓1.0pp | 95.1% ~ | 35 | 297.1s |
| 3.11.2 | jina-base | 1500 | 69.1% ↓1.4pp | 88.6% ↓1.3pp | 92.7% ↓0.5pp | 62 | 1536.6s |
| 3.11.2 | jina-code | 1500 | 68.0% ↑1.4pp | 85.9% ~ | 91.1% ~ | 70 | 1318.3s |
| 3.11.2 | nomic | 1500 | 80.7% ↑1.7pp | 95.2% ~ | 97.4% ~ | 10 | 1535.8s |
| 3.11.2 | nomic-v1.5 | 1500 | 79.3% ↑2.4pp | 94.0% ↑0.9pp | 96.9% ↑0.9pp | 17 | 1534.3s |
| 3.11.2 | mxbai-xsmall | 1500 | 50.0% ~ | 68.8% ↓1.9pp | 75.1% ↓1.8pp | 252 | 213.0s |
| 3.11.2 | modernbert | 1500 | 74.9% ↑0.9pp | 91.1% ↓0.5pp | 94.3% ~ | 43 | 1425.5s |
| 3.11.1 | minilm | 1500 | 65.4% ~ | 85.7% ↓0.6pp | 91.1% ↓0.7pp | 72 | 149.6s |
| 3.11.1 | jina-small | 1500 | 76.2% ↓0.9pp | 92.3% ~ | 94.9% ↓0.9pp | 35 | 296.2s |
| 3.11.1 | jina-base | 1500 | 70.5% ↓0.9pp | 89.9% ↓1.5pp | 93.3% ↓2.1pp | 49 | 1525.9s |
| 3.11.1 | jina-code | 1500 | 66.6% | 85.7% | 90.8% | 68 | 1310.7s |
| 3.11.1 | nomic | 1500 | 79.0% ↓2.3pp | 95.0% ~ | 97.2% ~ | 15 | 1536.3s |
| 3.11.1 | nomic-v1.5 | 1500 | 76.9% ↓2.5pp | 93.1% ↓0.9pp | 95.9% ↓0.8pp | 21 | 1522.4s |
| 3.11.1 | mxbai-xsmall | 1500 | 49.9% | 70.7% | 76.9% | 242 | 213.9s |
| 3.11.1 | modernbert | 1500 | 74.0% | 91.6% | 94.7% | 40 | 1415.6s |
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

**Version:** 3.12.0 | **Strategy:** structured | **Symbols:** 1500 | **Date:** 2026-06-11

| Model | Dim | Context | Hit@1 | Hit@3 | Hit@5 | Hit@10 | Misses | Embed | Search |
|-------|----:|--------:|------:|------:|------:|-------:|-------:|------:|-------:|
| minilm | 384 | 256 | 64.0% | 84.7% | 90.2% | 94.8% | 78 | 158.6s | 143.0s |
| jina-small | 512 | 8192 | 77.4% | 92.1% | 95.1% | 97.2% | 42 | 307.6s | 181.9s |
| jina-code | 768 | 8192 | 68.5% | 84.5% | 89.2% | 94.2% | 87 | 1342.5s | 235.4s |
| mxbai-xsmall | 384 | 4096 | 50.2% | 69.7% | 76.9% | 84.5% | 232 | 233.1s | 164.0s |
| modernbert | 768 | 8192 | 74.7% | 91.8% | 95.1% | 97.9% | 31 | 1472.9s | 231.8s |

<!-- EMBEDDING_BENCHMARK_DATA
[
  {
    "version": "3.12.0",
    "date": "2026-06-11",
    "strategy": "structured",
    "symbols": 1500,
    "models": {
      "minilm": {
        "dim": 384,
        "contextWindow": 256,
        "hits1": 960,
        "hits3": 1271,
        "hits5": 1353,
        "hits10": 1422,
        "misses": 78,
        "total": 1500,
        "embedTimeMs": 158640,
        "searchTimeMs": 142958
      },
      "jina-small": {
        "dim": 512,
        "contextWindow": 8192,
        "hits1": 1161,
        "hits3": 1382,
        "hits5": 1427,
        "hits10": 1458,
        "misses": 42,
        "total": 1500,
        "embedTimeMs": 307560,
        "searchTimeMs": 181906
      },
      "jina-code": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1027,
        "hits3": 1268,
        "hits5": 1338,
        "hits10": 1413,
        "misses": 87,
        "total": 1500,
        "embedTimeMs": 1342512,
        "searchTimeMs": 235431
      },
      "mxbai-xsmall": {
        "dim": 384,
        "contextWindow": 4096,
        "hits1": 753,
        "hits3": 1046,
        "hits5": 1153,
        "hits10": 1268,
        "misses": 232,
        "total": 1500,
        "embedTimeMs": 233137,
        "searchTimeMs": 163956
      },
      "modernbert": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1120,
        "hits3": 1377,
        "hits5": 1426,
        "hits10": 1469,
        "misses": 31,
        "total": 1500,
        "embedTimeMs": 1472876,
        "searchTimeMs": 231831
      }
    }
  },
  {
    "version": "3.11.2",
    "date": "2026-06-02",
    "strategy": "structured",
    "symbols": 1500,
    "models": {
      "minilm": {
        "dim": 384,
        "contextWindow": 256,
        "hits1": 999,
        "hits3": 1301,
        "hits5": 1373,
        "hits10": 1434,
        "misses": 66,
        "total": 1500,
        "embedTimeMs": 148614,
        "searchTimeMs": 147007
      },
      "jina-small": {
        "dim": 512,
        "contextWindow": 8192,
        "hits1": 1130,
        "hits3": 1370,
        "hits5": 1426,
        "hits10": 1465,
        "misses": 35,
        "total": 1500,
        "embedTimeMs": 297143,
        "searchTimeMs": 181596
      },
      "jina-base": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1036,
        "hits3": 1329,
        "hits5": 1391,
        "hits10": 1438,
        "misses": 62,
        "total": 1500,
        "embedTimeMs": 1536553,
        "searchTimeMs": 228959
      },
      "jina-code": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1020,
        "hits3": 1288,
        "hits5": 1366,
        "hits10": 1430,
        "misses": 70,
        "total": 1500,
        "embedTimeMs": 1318324,
        "searchTimeMs": 231657
      },
      "nomic": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1211,
        "hits3": 1428,
        "hits5": 1461,
        "hits10": 1490,
        "misses": 10,
        "total": 1500,
        "embedTimeMs": 1535841,
        "searchTimeMs": 230421
      },
      "nomic-v1.5": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1189,
        "hits3": 1410,
        "hits5": 1453,
        "hits10": 1483,
        "misses": 17,
        "total": 1500,
        "embedTimeMs": 1534325,
        "searchTimeMs": 227132
      },
      "mxbai-xsmall": {
        "dim": 384,
        "contextWindow": 4096,
        "hits1": 750,
        "hits3": 1032,
        "hits5": 1127,
        "hits10": 1248,
        "misses": 252,
        "total": 1500,
        "embedTimeMs": 213025,
        "searchTimeMs": 162908
      },
      "modernbert": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1124,
        "hits3": 1366,
        "hits5": 1414,
        "hits10": 1457,
        "misses": 43,
        "total": 1500,
        "embedTimeMs": 1425497,
        "searchTimeMs": 232502
      }
    }
  },
  {
    "version": "3.11.1",
    "date": "2026-05-31",
    "strategy": "structured",
    "symbols": 1500,
    "models": {
      "minilm": {
        "dim": 384,
        "contextWindow": 256,
        "hits1": 981,
        "hits3": 1285,
        "hits5": 1367,
        "hits10": 1428,
        "misses": 72,
        "total": 1500,
        "embedTimeMs": 149582,
        "searchTimeMs": 153149
      },
      "jina-small": {
        "dim": 512,
        "contextWindow": 8192,
        "hits1": 1143,
        "hits3": 1385,
        "hits5": 1424,
        "hits10": 1465,
        "misses": 35,
        "total": 1500,
        "embedTimeMs": 296235,
        "searchTimeMs": 180693
      },
      "jina-base": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1057,
        "hits3": 1348,
        "hits5": 1399,
        "hits10": 1451,
        "misses": 49,
        "total": 1500,
        "embedTimeMs": 1525891,
        "searchTimeMs": 232757
      },
      "jina-code": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 999,
        "hits3": 1285,
        "hits5": 1362,
        "hits10": 1432,
        "misses": 68,
        "total": 1500,
        "embedTimeMs": 1310746,
        "searchTimeMs": 231202
      },
      "nomic": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1185,
        "hits3": 1425,
        "hits5": 1458,
        "hits10": 1485,
        "misses": 15,
        "total": 1500,
        "embedTimeMs": 1536284,
        "searchTimeMs": 231696
      },
      "nomic-v1.5": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1153,
        "hits3": 1397,
        "hits5": 1439,
        "hits10": 1479,
        "misses": 21,
        "total": 1500,
        "embedTimeMs": 1522404,
        "searchTimeMs": 229968
      },
      "mxbai-xsmall": {
        "dim": 384,
        "contextWindow": 4096,
        "hits1": 748,
        "hits3": 1061,
        "hits5": 1154,
        "hits10": 1258,
        "misses": 242,
        "total": 1500,
        "embedTimeMs": 213870,
        "searchTimeMs": 153090
      },
      "modernbert": {
        "dim": 768,
        "contextWindow": 8192,
        "hits1": 1110,
        "hits3": 1374,
        "hits5": 1421,
        "hits10": 1460,
        "misses": 40,
        "total": 1500,
        "embedTimeMs": 1415646,
        "searchTimeMs": 231199
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
