# Codegraph Embedding Benchmarks

Self-measured on every release using auto-generated queries from symbol names.
Each symbol's name is split into words (e.g. `buildGraph` → `"build graph"`) and used as the search query.
Hit@N = expected symbol found in top N results.

| Version | Model | Symbols | Hit@1 | Hit@3 | Hit@5 | Misses | Embed Time |
|---------|-------|--------:|------:|------:|------:|-------:|-----------:|
| 3.9.6 | minilm | 1500 | 67.4% | 87.2% | 92.4% | 49 | 125.9s |
| 3.9.6 | jina-small | 1500 | 75.8% | 93.6% | 96.5% | 23 | 253.8s |
| 3.9.6 | jina-base | 1500 | 72.1% | 90.3% | 94.9% | 30 | 1327.4s |
| 3.9.6 | nomic | 1500 | 80.1% | 95.5% | 97.9% | 15 | 1331.2s |
| 3.9.6 | nomic-v1.5 | 1500 | 78.4% | 94.9% | 97.1% | 18 | 1325.3s |

### Latest results

**Version:** 3.9.6 | **Strategy:** structured | **Symbols:** 1500 | **Date:** 2026-04-30

| Model | Dim | Context | Hit@1 | Hit@3 | Hit@5 | Hit@10 | Misses | Embed | Search |
|-------|----:|--------:|------:|------:|------:|-------:|-------:|------:|-------:|
| minilm | 384 | 256 | 67.4% | 87.2% | 92.4% | 96.7% | 49 | 125.9s | 130.5s |
| jina-small | 512 | 8192 | 75.8% | 93.6% | 96.5% | 98.5% | 23 | 253.8s | 159.2s |
| jina-base | 768 | 8192 | 72.1% | 90.3% | 94.9% | 98.0% | 30 | 1327.4s | 206.2s |
| nomic | 768 | 8192 | 80.1% | 95.5% | 97.9% | 99.0% | 15 | 1331.2s | 206.0s |
| nomic-v1.5 | 768 | 8192 | 78.4% | 94.9% | 97.1% | 98.8% | 18 | 1325.3s | 207.0s |

<!-- EMBEDDING_BENCHMARK_DATA
[
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
