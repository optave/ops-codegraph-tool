# Codegraph Performance Benchmarks

Self-measured on every release by running codegraph on its own codebase.
Metrics are normalized per file for cross-version comparability.

| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |
|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|
| 3.9.3 | native | 2026-04-13 | 727 | 3.3 ↓79% | 29.5 ↑11% | 25.4 ~ | 51.6 ~ | 43981 ↑7% |
| 3.9.3 | wasm | 2026-04-13 | 727 | 15.9 ↑6% | 41.6 ↑4% | 24.1 ~ | 49.3 ~ | 38380 ~ |
| 3.9.2 | native | 2026-04-09 | 727 | 15.7 ↑54% | 26.6 ↑14% | 25.3 ↓10% | 51.4 ↓10% | 41028 ↓15% |
| 3.9.2 | wasm | 2026-04-09 | 727 | 15 ↑9% | 40.1 ↑13% | 24 ↓15% | 49.2 ↓14% | 38256 ↓16% |
| 3.9.1 | native | 2026-04-06 | 570 | 10.2 ↓20% | 23.4 ↓23% | 28.1 ↑3% | 56.9 ↑5% | 48433 ↑8% |
| 3.9.1 | wasm | 2026-04-06 | 570 | 13.7 ↑5% | 35.6 ↑16% | 28.1 ↑3% | 56.9 ↑5% | 45717 ↑2% |
| 3.9.0 | native | 2026-04-04 | 567 | 12.8 ↓4% | 30.4 ↑5% | 27.3 ~ | 54 ↑14% | 44666 ↑2% |
| 3.9.0 | wasm | 2026-04-04 | 567 | 13.1 ↓4% | 30.6 ↓4% | 27.3 ~ | 54 ~ | 44623 ↑5% |
| 3.8.1 | native | 2026-04-03 | 565 | 13.3 ↑533% | 28.9 ↑113% | 27 ↑4% | 47.5 ↑5% | 43693 ↑42% |
| 3.8.1 | wasm | 2026-04-03 | 565 | 13.6 ↑518% | 31.8 ↑108% | 27.2 ↑5% | 53.8 ↑19% | 42417 ↑39% |
| 3.8.0 | native | 2026-04-02 | 564 | 2.1 | 13.6 | 26 | 45.3 | 30851 |
| 3.8.0 | wasm | 2026-04-02 | 564 | 2.2 ↓85% | 15.3 ↑22% | 26 ~ | 45.3 ↓10% | 30524 ↓43% |
| 3.7.0 | wasm | 2026-04-01 | 532 | 14.2 ↑7% | 12.5 ~ | 25.8 ~ | 50.3 ~ | 53795 ~ |
| 3.6.0 | wasm | 2026-03-30 | 514 | 13.3 ↑12% | 12.3 ~ | 25.6 ↑10% | 49.5 ↑12% | 54013 ↑28% |
| 3.4.1 | native | 2026-03-27 | 473 | 5.7 ↑8% | 11.7 ~ | 23.2 ~ | 44.1 ~ | 57725 ↑5% |
| 3.4.1 | wasm | 2026-03-27 | 473 | 11.9 ↓2% | 12.2 ↑4% | 23.2 ~ | 44.1 ~ | 42276 ↑5% |
| 3.4.0 | native | 2026-03-26 | 473 | 5.3 ↓13% | 11.6 ↑63% | 23.2 ↑32% | 44.2 ↑21% | 55041 ↑13% |
| 3.4.0 | wasm | 2026-03-26 | 473 | 12.2 ↑9% | 11.7 ↑62% | 23.1 ↑32% | 44.4 ↑22% | 40198 ↓15% |
| 3.3.1 | native | 2026-03-20 | 442 | 6.1 ↑74% | 7.1 ↑122% | 17.6 ↑31% | 36.5 ↑27% | 48707 ↑10% |
| 3.3.1 | wasm | 2026-03-20 | 442 | 11.2 ↑17% | 7.2 ↑57% | 17.5 ↑31% | 36.4 ↑26% | 47317 ↑10% |
| 3.1.4 | native | 2026-03-16 | 398 | 3.5 ↓31% | 3.2 ↓18% | 13.4 ↓26% | 28.8 ↓27% | 44469 ↓32% |
| 3.1.4 | wasm | 2026-03-16 | 398 | 9.6 ↓34% | 4.6 ↓16% | 13.4 ↓26% | 28.9 ↓27% | 42823 ↓32% |
| 3.1.3 | native | 2026-03-12 | 236 | 5.1 ~ | 3.9 ↓7% | 18 ~ | 39.4 ↑2% | 65553 ~ |
| 3.1.3 | wasm | 2026-03-12 | 236 | 14.6 ↓3% | 5.5 ↓5% | 18 ~ | 39.6 ~ | 63037 ~ |
| 3.1.2 | native | 2026-03-11 | 235 | 5.2 ↓15% | 4.2 ↑24% | 17.9 ↓14% | 38.6 ↓14% | 65275 ↓19% |
| 3.1.2 | wasm | 2026-03-11 | 235 | 15 ↓9% | 5.8 ↑26% | 17.9 ↓14% | 39.3 ↓13% | 62207 ↓20% |
| 3.1.0 | native | 2026-03-08 | 180 | 6.1 ~ | 3.4 ↑3% | 20.8 ~ | 44.7 ~ | 80919 ↑14% |
| 3.1.0 | wasm | 2026-03-08 | 180 | 16.5 ↓13% | 4.6 ↓4% | 20.9 ~ | 45 ~ | 77665 ~ |
| 3.0.4 | native | 2026-03-06 | 177 | 6.2 ↓50% | 3.3 ↓3% | 20.6 ↑10% | 44.5 ↑7% | 70951 ↓4% |
| 3.0.4 | wasm | 2026-03-06 | 177 | 19 ↑17% | 4.8 ↑4% | 20.6 ↑10% | 44.7 ↑7% | 77245 ↑4% |
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
| Build time | 2.2s |
| Query time | 30ms |
| Nodes | 16,938 |
| Edges | 34,396 |
| DB size | 28.0 MB |
| Files | 727 |

#### WASM

| Metric | Value |
|--------|-------|
| Build time | 11.6s |
| Query time | 42ms |
| Nodes | 17,497 |
| Edges | 35,859 |
| DB size | 26.6 MB |
| Files | 727 |

### Build Phase Breakdown (latest)

| Phase | Native (build) | WASM (build) | Native (1-file) | WASM (1-file) |
|-------|---------------:|-------------:|----------------:|--------------:|
| Parse | 601.2 ms | 5094.5 ms | 51.8 ms | 265.7 ms |
| Insert nodes | 374.9 ms | 919.7 ms | 30.6 ms | 21.1 ms |
| Resolve imports | 4.1 ms | 26.8 ms | 1 ms | 2.1 ms |
| Build edges | 208.6 ms | 327.7 ms | 31.2 ms | 33.1 ms |
| Structure | 122.4 ms | 998.9 ms | 124.6 ms | 38.8 ms |
| Roles | 95.5 ms | 99.1 ms | 105 ms | 84.9 ms |
| AST nodes | 244 ms | 804.2 ms | 0.6 ms | 0.6 ms |
| Complexity | 20.3 ms | 1026.3 ms | 0.8 ms | 0.6 ms |
| CFG | 186.3 ms | 1109 ms | 1.6 ms | 0.3 ms |
| Dataflow | 165.6 ms | 885.1 ms | 0.1 ms | 0.6 ms |

### Estimated performance at 50,000 files

Extrapolated linearly from per-file metrics above.

| Metric | Native (Rust) | WASM |
|--------|---:|---:|
| Build time | 165.0s | 795.0s |
| DB size | 2097.2 MB | 1830.1 MB |
| Nodes | 1,270,000 | 1,205,000 |
| Edges | 2,580,000 | 2,465,000 |

### Incremental Rebuilds

| Version | Engine | No-op (ms) | 1-file (ms) |
|---------|--------|----------:|-----------:|
| 3.9.3 | native | 11 ↑22% | 397 ↓29% |
| 3.9.3 | wasm | 22 ↑10% | 638 ↑2% |
| 3.9.2 | native | 9 ↓47% | 558 ↓27% |
| 3.9.2 | wasm | 20 ↑33% | 624 ↓2% |
| 3.9.1 | native | 17 ↑113% | 767 ↑36% |
| 3.9.1 | wasm | 15 ~ | 639 ↑14% |
| 3.9.0 | native | 8 ~ | 562 ↑1238% |
| 3.9.0 | wasm | 15 ↓6% | 559 ↓7% |
| 3.8.1 | native | 8 ~ | 42 ↑27% |
| 3.8.1 | wasm | 16 ↑100% | 600 ↑1718% |
| 3.8.0 | native | 8 | 33 |
| 3.8.0 | wasm | 8 ↓47% | 33 ↓94% |
| 3.7.0 | wasm | 15 ↑7% | 542 ~ |
| 3.6.0 | wasm | 14 ↓12% | 547 ↑12% |
| 3.4.1 | native | 14 ↑17% | 316 ↓27% |
| 3.4.1 | wasm | 16 ↑60% | 487 ↓22% |
| 3.4.0 | native | 12 ~ | 432 ↑22% |
| 3.4.0 | wasm | 10 ↓17% | 621 ↑23% |
| 3.3.1 | native | 12 ↑33% | 353 ↑33% |
| 3.3.1 | wasm | 12 ↑20% | 506 ↑35% |
| 3.1.4 | native | 9 ↑50% | 265 ↓6% |
| 3.1.4 | wasm | 10 ↑67% | 375 ↓24% |
| 3.1.3 | native | 6 ~ | 282 ↓5% |
| 3.1.3 | wasm | 6 ↓14% | 493 ↓12% |
| 3.1.2 | native | 6 ↑20% | 296 ↓11% |
| 3.1.2 | wasm | 7 ↑40% | 563 ~ |
| 3.1.0 | native | 5 ↓98% | 332 ~ |
| 3.1.0 | wasm | 5 ↓29% | 570 ~ |
| 3.0.4 | native | 329 ↑6480% | 335 ↓11% |
| 3.0.4 | wasm | 7 ~ | 559 ~ |
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
| 3.9.3 | native | 2.5 ↑9% | 2.5 ↑4% | 2.5 ~ | 41.3 ↑24% |
| 3.9.3 | wasm | 2.4 ~ | 2.4 ~ | 2.3 ↓4% | 34.5 ↓3% |
| 3.9.2 | native | 2.3 ↑5% | 2.4 ↑4% | 2.5 ↑14% | 33.2 ↑30% |
| 3.9.2 | wasm | 2.4 ↑9% | 2.4 ↑9% | 2.4 ↑9% | 35.4 ↑35% |
| 3.9.1 | native | 2.2 ↑5% | 2.3 ↑5% | 2.2 ~ | 25.5 ~ |
| 3.9.1 | wasm | 2.2 ↑5% | 2.2 ~ | 2.2 ↑5% | 26.3 ~ |
| 3.9.0 | native | 2.1 ↓5% | 2.2 ~ | 2.2 ~ | 25.9 ↓13% |
| 3.9.0 | wasm | 2.1 ↓5% | 2.2 ~ | 2.1 ↓5% | 26.6 ↓6% |
| 3.8.1 | native | 2.2 ↓12% | 2.2 ~ | 2.2 ↑5% | 29.7 ~ |
| 3.8.1 | wasm | 2.2 ~ | 2.2 ~ | 2.2 ↑5% | 28.4 ↓9% |
| 3.8.0 | native | 2.5 | 2.2 | 2.1 | 29.2 |
| 3.8.0 | wasm | 2.2 ↑10% | 2.2 ↑5% | 2.1 ↑5% | 31.3 ↑28% |
| 3.7.0 | wasm | 2 ↓5% | 2.1 ~ | 2 ↑5% | 24.4 ↑2% |
| 3.6.0 | wasm | 2.1 ↑11% | 2.1 ~ | 1.9 ~ | 23.9 ↑15% |
| 3.4.1 | native | 1.9 ↑12% | 2 ↑18% | 1.9 ↑19% | 21.6 ↑9% |
| 3.4.1 | wasm | 1.9 ↑6% | 2.1 ↑24% | 1.9 ↑19% | 20.7 ↓4% |
| 3.4.0 | native | 1.7 ↑21% | 1.7 ↑21% | 1.6 ↑23% | 19.9 ↑32% |
| 3.4.0 | wasm | 1.8 ↑38% | 1.7 ↑21% | 1.6 ↑23% | 21.5 ↑45% |
| 3.3.1 | native | 1.4 ↑56% | 1.4 ↑56% | 1.3 ↑44% | 15.1 ↑50% |
| 3.3.1 | wasm | 1.3 ↑44% | 1.4 ↑40% | 1.3 ↑44% | 14.8 ↑53% |
| 3.1.4 | native | 0.9 ~ | 0.9 ↑12% | 0.9 ↑12% | 10.1 ↑36% |
| 3.1.4 | wasm | 0.9 ↑12% | 1 ↑11% | 0.9 ↑12% | 9.7 ↑26% |
| 3.1.3 | native | 0.9 ↑12% | 0.8 ~ | 0.8 ~ | 7.4 ↓14% |
| 3.1.3 | wasm | 0.8 ↓11% | 0.9 ~ | 0.8 ↓11% | 7.7 ↓7% |
| 3.1.2 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 8.6 ↑34% |
| 3.1.2 | wasm | 0.9 ↑12% | 0.9 ↑12% | 0.9 ↑12% | 8.3 ↑28% |
| 3.1.0 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 6.4 ↑7% |
| 3.1.0 | wasm | 0.8 ↓11% | 0.8 ~ | 0.8 ~ | 6.5 ↓4% |
| 3.0.4 | native | 0.8 ~ | 0.8 ~ | 0.8 ~ | 6 ↑9% |
| 3.0.4 | wasm | 0.9 ↑12% | 0.8 ~ | 0.8 ~ | 6.8 ↑11% |
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

**Native 1-file rebuild regression (v3.8.1 42 ms → v3.9.0 562 ms, ↑1238%):** The native incremental
path is re-running graph-wide work on single-file rebuilds. The phase breakdown shows `structureMs`
at 151.7 ms for a 1-file rebuild vs 54.1 ms for the full 567-file build, and `setupMs` at 38.2 ms
vs 5.5 ms. AST/complexity/CFG/dataflow phases also jump from near-zero to 20-28 ms each,
suggesting these phases are not scoped to only the changed file. WASM 1-file rebuild (559 ms) is
superficially similar in total time but has a different root cause: WASM is parse-dominated
(`parseMs` 258.2 ms accounts for nearly half the total) while `structureMs` (28.3 ms),
`astMs`/`cfgMs`/`dataflowMs` (all under 1 ms) are correctly scoped. The native regression is
specifically in graph-wide phases being re-run during incremental builds. The no-op rebuild
(8 ms native, 15 ms WASM) is unaffected, confirming the regression is triggered by actual
file-change detection.

**Engine edge divergence (v3.9.0, 1 edge):** Native reports 30,609 edges and WASM reports 30,610
for the same 567-file codebase (node counts match at 15,483). This is a parity bug — tracked in
#855.

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

**Build regression (v3.1.4 3.5 ms/file → v3.3.0 8 ms/file, +129% native):** The codebase grew from
398 to 429 files (+8%), but the per-file regression is real and driven by richer extraction. Between
v3.1.4 and v3.3.0, type inference was extended to all typed languages (#501), receiver type tracking
with graded confidence was added (#505), re-exported barrel file symbols are now tracked (#515), and
package.json exports + monorepo workspace resolution was introduced (#509). These produce 33% more
nodes/file (13.4 → 17.8) and 28% more edges/file (28.8 → 36.8). The Parse phase tripled on native
(468 → 1511 ms) because extractors now perform additional AST traversals for type annotations and
receiver resolution. The Complexity phase grew 10× (16 → 179 ms) because 33% more functions each
require full AST analysis. Major refactors also decomposed monolithic extractors into per-category
handlers (#490) and split domain/feature modules (#491, #492), adding 31 new source files — the
benchmark measures codegraph on itself, so more source files amplify per-file overhead.

**Native build regression (v3.0.0 4.4 ms/file → v3.0.3 12.3 ms/file):** The regression is entirely
from new build phases added in v3.0.1 that are now default-on: AST node extraction (651ms),
dataflow analysis (367ms), and CFG construction (169ms) — totalling ~1,187ms of new work. The original
seven phases (parse, insert, resolve, edges, structure, roles, complexity) actually got slightly faster
(728ms → 542ms). As of v3.1.0, CFG and dataflow run natively in Rust, eliminating the redundant WASM
pre-parse that previously added ~388ms on native builds.
<!-- NOTES_END -->

<!-- BENCHMARK_DATA
[
  {
    "version": "3.9.3",
    "date": "2026-04-13",
    "files": 727,
    "wasm": {
      "buildTimeMs": 11590,
      "queryTimeMs": 41.6,
      "nodes": 17497,
      "edges": 35859,
      "dbSizeBytes": 27901952,
      "perFile": {
        "buildTimeMs": 15.9,
        "nodes": 24.1,
        "edges": 49.3,
        "dbSizeBytes": 38380
      },
      "noopRebuildMs": 22,
      "oneFileRebuildMs": 638,
      "oneFilePhases": {
        "setupMs": 2,
        "parseMs": 265.7,
        "insertMs": 21.1,
        "resolveMs": 2.1,
        "edgesMs": 33.1,
        "structureMs": 38.8,
        "rolesMs": 84.9,
        "astMs": 0.6,
        "complexityMs": 0.6,
        "cfgMs": 0.3,
        "dataflowMs": 0.6,
        "finalizeMs": 6.7
      },
      "queries": {
        "fnDepsMs": 2.4,
        "fnImpactMs": 2.4,
        "pathMs": 2.3,
        "rolesMs": 34.5
      },
      "phases": {
        "setupMs": 85.7,
        "parseMs": 5094.5,
        "insertMs": 919.7,
        "resolveMs": 26.8,
        "edgesMs": 327.7,
        "structureMs": 998.9,
        "rolesMs": 99.1,
        "astMs": 804.2,
        "complexityMs": 1026.3,
        "cfgMs": 1109,
        "dataflowMs": 885.1,
        "finalizeMs": 63.3
      }
    },
    "native": {
      "buildTimeMs": 2187,
      "queryTimeMs": 29.5,
      "nodes": 16938,
      "edges": 34396,
      "dbSizeBytes": 29335552,
      "perFile": {
        "buildTimeMs": 3.3,
        "nodes": 25.4,
        "edges": 51.6,
        "dbSizeBytes": 43981
      },
      "noopRebuildMs": 11,
      "oneFileRebuildMs": 397,
      "oneFilePhases": {
        "setupMs": 41.2,
        "parseMs": 51.8,
        "insertMs": 30.6,
        "resolveMs": 1,
        "edgesMs": 31.2,
        "structureMs": 124.6,
        "rolesMs": 105,
        "astMs": 0.6,
        "complexityMs": 0.8,
        "cfgMs": 1.6,
        "dataflowMs": 0.1,
        "finalizeMs": 0.5
      },
      "queries": {
        "fnDepsMs": 2.5,
        "fnImpactMs": 2.5,
        "pathMs": 2.5,
        "rolesMs": 41.3
      },
      "phases": {
        "setupMs": 24.6,
        "parseMs": 601.2,
        "insertMs": 374.9,
        "resolveMs": 4.1,
        "edgesMs": 208.6,
        "structureMs": 122.4,
        "rolesMs": 95.5,
        "astMs": 244,
        "complexityMs": 20.3,
        "cfgMs": 186.3,
        "dataflowMs": 165.6,
        "finalizeMs": 0.5
      }
    },
    "resolution": {
      "bash": {
        "precision": 1,
        "recall": 1,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 12,
        "totalExpected": 12,
        "byMode": {
          "same-file": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          }
        },
        "dynamicEdges": 1,
        "dynamicConfirmed": 0
      },
      "c": {
        "precision": 1,
        "recall": 1,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 9,
        "totalExpected": 9,
        "byMode": {
          "same-file": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "static": {
            "expected": 6,
            "resolved": 6,
            "recall": 1
          }
        }
      },
      "clojure": {
        "precision": 0.8,
        "recall": 0.267,
        "truePositives": 4,
        "falsePositives": 1,
        "falseNegatives": 11,
        "totalResolved": 5,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          }
        }
      },
      "cpp": {
        "precision": 1,
        "recall": 0.571,
        "truePositives": 8,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 8,
        "totalExpected": 14,
        "byMode": {
          "same-file": {
            "expected": 8,
            "resolved": 4,
            "recall": 0.5
          },
          "static": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "csharp": {
        "precision": 1,
        "recall": 0.526,
        "truePositives": 10,
        "falsePositives": 0,
        "falseNegatives": 9,
        "totalResolved": 10,
        "totalExpected": 19,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "interface-dispatched": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "cuda": {
        "precision": 0.5,
        "recall": 0.333,
        "truePositives": 4,
        "falsePositives": 4,
        "falseNegatives": 8,
        "totalResolved": 8,
        "totalExpected": 12,
        "byMode": {
          "receiver-typed": {
            "expected": 6,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 4,
            "resolved": 2,
            "recall": 0.5
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "dart": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 18,
        "totalResolved": 0,
        "totalExpected": 18,
        "byMode": {
          "static": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "elixir": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 15,
        "totalResolved": 0,
        "totalExpected": 15,
        "byMode": {
          "same-file": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          },
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "erlang": {
        "precision": 1,
        "recall": 1,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 12,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 10,
            "resolved": 10,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "fsharp": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 9,
        "falseNegatives": 12,
        "totalResolved": 9,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "gleam": {
        "precision": 1,
        "recall": 0.267,
        "truePositives": 4,
        "falsePositives": 0,
        "falseNegatives": 11,
        "totalResolved": 4,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          }
        }
      },
      "go": {
        "precision": 1,
        "recall": 0.692,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 4,
        "totalResolved": 9,
        "totalExpected": 13,
        "byMode": {
          "receiver-typed": {
            "expected": 8,
            "resolved": 4,
            "recall": 0.5
          },
          "package-function": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        },
        "dynamicEdges": 14,
        "dynamicConfirmed": 13
      },
      "groovy": {
        "precision": 1,
        "recall": 0.077,
        "truePositives": 1,
        "falsePositives": 0,
        "falseNegatives": 12,
        "totalResolved": 1,
        "totalExpected": 13,
        "byMode": {
          "receiver-typed": {
            "expected": 7,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "haskell": {
        "precision": 1,
        "recall": 0.333,
        "truePositives": 4,
        "falsePositives": 0,
        "falseNegatives": 8,
        "totalResolved": 4,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 3,
            "recall": 0.2727272727272727
          },
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          }
        }
      },
      "hcl": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 2,
        "totalResolved": 0,
        "totalExpected": 2,
        "byMode": {
          "static": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "java": {
        "precision": 1,
        "recall": 0.529,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 8,
        "totalResolved": 9,
        "totalExpected": 17,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "class-inheritance": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "interface-dispatched": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 4,
            "resolved": 3,
            "recall": 0.75
          },
          "static": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "javascript": {
        "precision": 1,
        "recall": 0.667,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 12,
        "totalExpected": 18,
        "byMode": {
          "static": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 5,
            "resolved": 2,
            "recall": 0.4
          },
          "same-file": {
            "expected": 5,
            "resolved": 2,
            "recall": 0.4
          }
        },
        "dynamicEdges": 28,
        "dynamicConfirmed": 14
      },
      "julia": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 15,
        "totalResolved": 0,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "kotlin": {
        "precision": 0.923,
        "recall": 0.632,
        "truePositives": 12,
        "falsePositives": 1,
        "falseNegatives": 7,
        "totalResolved": 13,
        "totalExpected": 19,
        "byMode": {
          "same-file": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "static": {
            "expected": 7,
            "resolved": 7,
            "recall": 1
          },
          "class-inheritance": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 6,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "lua": {
        "precision": 1,
        "recall": 0.154,
        "truePositives": 2,
        "falsePositives": 0,
        "falseNegatives": 11,
        "totalResolved": 2,
        "totalExpected": 13,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "objc": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 1,
        "falseNegatives": 12,
        "totalResolved": 1,
        "totalExpected": 12,
        "byMode": {
          "receiver-typed": {
            "expected": 6,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "ocaml": {
        "precision": 1,
        "recall": 0.083,
        "truePositives": 1,
        "falsePositives": 0,
        "falseNegatives": 11,
        "totalResolved": 1,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          }
        }
      },
      "php": {
        "precision": 1,
        "recall": 0.316,
        "truePositives": 6,
        "falsePositives": 0,
        "falseNegatives": 13,
        "totalResolved": 6,
        "totalExpected": 19,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "python": {
        "precision": 1,
        "recall": 0.6,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 9,
        "totalExpected": 15,
        "byMode": {
          "static": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 2,
            "recall": 0.25
          },
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          }
        },
        "dynamicEdges": 15,
        "dynamicConfirmed": 15
      },
      "r": {
        "precision": 1,
        "recall": 1,
        "truePositives": 11,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 11,
        "totalExpected": 11,
        "byMode": {
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "ruby": {
        "precision": 1,
        "recall": 1,
        "truePositives": 11,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 11,
        "totalExpected": 11,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          },
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          }
        },
        "dynamicEdges": 11,
        "dynamicConfirmed": 11
      },
      "rust": {
        "precision": 1,
        "recall": 0.357,
        "truePositives": 5,
        "falsePositives": 0,
        "falseNegatives": 9,
        "totalResolved": 5,
        "totalExpected": 14,
        "byMode": {
          "same-file": {
            "expected": 6,
            "resolved": 2,
            "recall": 0.3333333333333333
          },
          "trait-dispatch": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "module-function": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          }
        }
      },
      "scala": {
        "precision": 1,
        "recall": 0.714,
        "truePositives": 5,
        "falsePositives": 0,
        "falseNegatives": 2,
        "totalResolved": 5,
        "totalExpected": 7,
        "byMode": {
          "same-file": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "solidity": {
        "precision": 0.333,
        "recall": 0.077,
        "truePositives": 1,
        "falsePositives": 2,
        "falseNegatives": 12,
        "totalResolved": 3,
        "totalExpected": 13,
        "byMode": {
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "swift": {
        "precision": 0.75,
        "recall": 0.429,
        "truePositives": 6,
        "falsePositives": 2,
        "falseNegatives": 8,
        "totalResolved": 8,
        "totalExpected": 14,
        "byMode": {
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          },
          "static": {
            "expected": 3,
            "resolved": 2,
            "recall": 0.6666666666666666
          },
          "receiver-typed": {
            "expected": 7,
            "resolved": 0,
            "recall": 0
          }
        },
        "dynamicEdges": 9,
        "dynamicConfirmed": 9
      },
      "tsx": {
        "precision": 1,
        "recall": 1,
        "truePositives": 13,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 13,
        "totalExpected": 13,
        "byMode": {
          "same-file": {
            "expected": 5,
            "resolved": 5,
            "recall": 1
          },
          "static": {
            "expected": 8,
            "resolved": 8,
            "recall": 1
          }
        }
      },
      "typescript": {
        "precision": 1,
        "recall": 0.75,
        "truePositives": 15,
        "falsePositives": 0,
        "falseNegatives": 5,
        "totalResolved": 15,
        "totalExpected": 20,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          },
          "interface-dispatched": {
            "expected": 5,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 6,
            "resolved": 6,
            "recall": 1
          }
        }
      },
      "verilog": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 4,
        "totalResolved": 0,
        "totalExpected": 4,
        "byMode": {
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "zig": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 15,
        "totalResolved": 0,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 5,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      }
    }
  },
  {
    "version": "3.9.2",
    "date": "2026-04-09",
    "files": 727,
    "wasm": {
      "buildTimeMs": 10903,
      "queryTimeMs": 40.1,
      "nodes": 17438,
      "edges": 35744,
      "dbSizeBytes": 27811840,
      "perFile": {
        "buildTimeMs": 15,
        "nodes": 24,
        "edges": 49.2,
        "dbSizeBytes": 38256
      },
      "noopRebuildMs": 20,
      "oneFileRebuildMs": 624,
      "oneFilePhases": {
        "setupMs": 2,
        "parseMs": 263.4,
        "insertMs": 21.6,
        "resolveMs": 2,
        "edgesMs": 32.9,
        "structureMs": 39.4,
        "rolesMs": 81.6,
        "astMs": 0.8,
        "complexityMs": 0.7,
        "cfgMs": 0.4,
        "dataflowMs": 0.7,
        "finalizeMs": 6.4
      },
      "queries": {
        "fnDepsMs": 2.4,
        "fnImpactMs": 2.4,
        "pathMs": 2.4,
        "rolesMs": 35.4
      },
      "phases": {
        "setupMs": 33.8,
        "parseMs": 4898.5,
        "insertMs": 989.5,
        "resolveMs": 18.6,
        "edgesMs": 272.5,
        "structureMs": 754.4,
        "rolesMs": 91.6,
        "astMs": 756.4,
        "complexityMs": 1002.4,
        "cfgMs": 1069.7,
        "dataflowMs": 844.9,
        "finalizeMs": 60.4
      }
    },
    "native": {
      "buildTimeMs": 10451,
      "queryTimeMs": 26.6,
      "nodes": 16879,
      "edges": 34281,
      "dbSizeBytes": 27365376,
      "perFile": {
        "buildTimeMs": 15.7,
        "nodes": 25.3,
        "edges": 51.4,
        "dbSizeBytes": 41028
      },
      "noopRebuildMs": 9,
      "oneFileRebuildMs": 558,
      "oneFilePhases": {
        "setupMs": 39.9,
        "parseMs": 53.4,
        "insertMs": 25.9,
        "resolveMs": 0.7,
        "edgesMs": 30.1,
        "structureMs": 121.4,
        "rolesMs": 76.2,
        "astMs": 26,
        "complexityMs": 3.2,
        "cfgMs": 53.5,
        "dataflowMs": 30.6,
        "finalizeMs": 0.8
      },
      "queries": {
        "fnDepsMs": 2.3,
        "fnImpactMs": 2.4,
        "pathMs": 2.5,
        "rolesMs": 33.2
      },
      "phases": {
        "setupMs": 8.4,
        "parseMs": 600.1,
        "insertMs": 363.1,
        "resolveMs": 3.6,
        "edgesMs": 196.8,
        "structureMs": 111,
        "rolesMs": 76.4,
        "astMs": 1436.3,
        "complexityMs": 596.4,
        "cfgMs": 1464.2,
        "dataflowMs": 932.4,
        "finalizeMs": 0.8
      }
    },
    "resolution": {
      "bash": {
        "precision": 1,
        "recall": 1,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 12,
        "totalExpected": 12,
        "byMode": {
          "same-file": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          }
        },
        "dynamicEdges": 1,
        "dynamicConfirmed": 0
      },
      "c": {
        "precision": 1,
        "recall": 1,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 9,
        "totalExpected": 9,
        "byMode": {
          "same-file": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "static": {
            "expected": 6,
            "resolved": 6,
            "recall": 1
          }
        }
      },
      "clojure": {
        "precision": 0.8,
        "recall": 0.267,
        "truePositives": 4,
        "falsePositives": 1,
        "falseNegatives": 11,
        "totalResolved": 5,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          }
        }
      },
      "cpp": {
        "precision": 1,
        "recall": 0.571,
        "truePositives": 8,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 8,
        "totalExpected": 14,
        "byMode": {
          "same-file": {
            "expected": 8,
            "resolved": 4,
            "recall": 0.5
          },
          "static": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "csharp": {
        "precision": 1,
        "recall": 0.526,
        "truePositives": 10,
        "falsePositives": 0,
        "falseNegatives": 9,
        "totalResolved": 10,
        "totalExpected": 19,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "interface-dispatched": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "cuda": {
        "precision": 0.5,
        "recall": 0.333,
        "truePositives": 4,
        "falsePositives": 4,
        "falseNegatives": 8,
        "totalResolved": 8,
        "totalExpected": 12,
        "byMode": {
          "receiver-typed": {
            "expected": 6,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 4,
            "resolved": 2,
            "recall": 0.5
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "dart": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 18,
        "totalResolved": 0,
        "totalExpected": 18,
        "byMode": {
          "static": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "elixir": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 15,
        "totalResolved": 0,
        "totalExpected": 15,
        "byMode": {
          "same-file": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          },
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "erlang": {
        "precision": 1,
        "recall": 1,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 12,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 10,
            "resolved": 10,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "fsharp": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 9,
        "falseNegatives": 12,
        "totalResolved": 9,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "gleam": {
        "precision": 1,
        "recall": 0.267,
        "truePositives": 4,
        "falsePositives": 0,
        "falseNegatives": 11,
        "totalResolved": 4,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          }
        }
      },
      "go": {
        "precision": 1,
        "recall": 0.692,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 4,
        "totalResolved": 9,
        "totalExpected": 13,
        "byMode": {
          "receiver-typed": {
            "expected": 8,
            "resolved": 4,
            "recall": 0.5
          },
          "package-function": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        },
        "dynamicEdges": 14,
        "dynamicConfirmed": 13
      },
      "groovy": {
        "precision": 1,
        "recall": 0.077,
        "truePositives": 1,
        "falsePositives": 0,
        "falseNegatives": 12,
        "totalResolved": 1,
        "totalExpected": 13,
        "byMode": {
          "receiver-typed": {
            "expected": 7,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "haskell": {
        "precision": 1,
        "recall": 0.333,
        "truePositives": 4,
        "falsePositives": 0,
        "falseNegatives": 8,
        "totalResolved": 4,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 3,
            "recall": 0.2727272727272727
          },
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          }
        }
      },
      "hcl": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 2,
        "totalResolved": 0,
        "totalExpected": 2,
        "byMode": {
          "static": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "java": {
        "precision": 1,
        "recall": 0.529,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 8,
        "totalResolved": 9,
        "totalExpected": 17,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "class-inheritance": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "interface-dispatched": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 4,
            "resolved": 3,
            "recall": 0.75
          },
          "static": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "javascript": {
        "precision": 1,
        "recall": 0.667,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 12,
        "totalExpected": 18,
        "byMode": {
          "static": {
            "expected": 4,
            "resolved": 4,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 5,
            "resolved": 2,
            "recall": 0.4
          },
          "same-file": {
            "expected": 5,
            "resolved": 2,
            "recall": 0.4
          }
        },
        "dynamicEdges": 28,
        "dynamicConfirmed": 14
      },
      "julia": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 15,
        "totalResolved": 0,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 4,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "kotlin": {
        "precision": 0.923,
        "recall": 0.632,
        "truePositives": 12,
        "falsePositives": 1,
        "falseNegatives": 7,
        "totalResolved": 13,
        "totalExpected": 19,
        "byMode": {
          "same-file": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "static": {
            "expected": 7,
            "resolved": 7,
            "recall": 1
          },
          "class-inheritance": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 6,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "lua": {
        "precision": 1,
        "recall": 0.154,
        "truePositives": 2,
        "falsePositives": 0,
        "falseNegatives": 11,
        "totalResolved": 2,
        "totalExpected": 13,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "objc": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 1,
        "falseNegatives": 12,
        "totalResolved": 1,
        "totalExpected": 12,
        "byMode": {
          "receiver-typed": {
            "expected": 6,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "ocaml": {
        "precision": 1,
        "recall": 0.083,
        "truePositives": 1,
        "falsePositives": 0,
        "falseNegatives": 11,
        "totalResolved": 1,
        "totalExpected": 12,
        "byMode": {
          "module-function": {
            "expected": 11,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          }
        }
      },
      "php": {
        "precision": 1,
        "recall": 0.316,
        "truePositives": 6,
        "falsePositives": 0,
        "falseNegatives": 13,
        "totalResolved": 6,
        "totalExpected": 19,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "python": {
        "precision": 1,
        "recall": 0.6,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 9,
        "totalExpected": 15,
        "byMode": {
          "static": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 2,
            "recall": 0.25
          },
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          }
        },
        "dynamicEdges": 15,
        "dynamicConfirmed": 15
      },
      "r": {
        "precision": 1,
        "recall": 1,
        "truePositives": 11,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 11,
        "totalExpected": 11,
        "byMode": {
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          }
        }
      },
      "ruby": {
        "precision": 1,
        "recall": 1,
        "truePositives": 11,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 11,
        "totalExpected": 11,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          },
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          }
        },
        "dynamicEdges": 11,
        "dynamicConfirmed": 11
      },
      "rust": {
        "precision": 1,
        "recall": 0.357,
        "truePositives": 5,
        "falsePositives": 0,
        "falseNegatives": 9,
        "totalResolved": 5,
        "totalExpected": 14,
        "byMode": {
          "same-file": {
            "expected": 6,
            "resolved": 2,
            "recall": 0.3333333333333333
          },
          "trait-dispatch": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "module-function": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          }
        }
      },
      "scala": {
        "precision": 1,
        "recall": 0.714,
        "truePositives": 5,
        "falsePositives": 0,
        "falseNegatives": 2,
        "totalResolved": 5,
        "totalExpected": 7,
        "byMode": {
          "same-file": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "solidity": {
        "precision": 0.333,
        "recall": 0.077,
        "truePositives": 1,
        "falsePositives": 2,
        "falseNegatives": 12,
        "totalResolved": 3,
        "totalExpected": 13,
        "byMode": {
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "swift": {
        "precision": 0.75,
        "recall": 0.429,
        "truePositives": 6,
        "falsePositives": 2,
        "falseNegatives": 8,
        "totalResolved": 8,
        "totalExpected": 14,
        "byMode": {
          "same-file": {
            "expected": 1,
            "resolved": 1,
            "recall": 1
          },
          "static": {
            "expected": 3,
            "resolved": 2,
            "recall": 0.6666666666666666
          },
          "receiver-typed": {
            "expected": 7,
            "resolved": 0,
            "recall": 0
          }
        },
        "dynamicEdges": 9,
        "dynamicConfirmed": 9
      },
      "tsx": {
        "precision": 1,
        "recall": 1,
        "truePositives": 13,
        "falsePositives": 0,
        "falseNegatives": 0,
        "totalResolved": 13,
        "totalExpected": 13,
        "byMode": {
          "same-file": {
            "expected": 5,
            "resolved": 5,
            "recall": 1
          },
          "static": {
            "expected": 8,
            "resolved": 8,
            "recall": 1
          }
        }
      },
      "typescript": {
        "precision": 1,
        "recall": 0.75,
        "truePositives": 15,
        "falsePositives": 0,
        "falseNegatives": 5,
        "totalResolved": 15,
        "totalExpected": 20,
        "byMode": {
          "same-file": {
            "expected": 2,
            "resolved": 2,
            "recall": 1
          },
          "interface-dispatched": {
            "expected": 5,
            "resolved": 0,
            "recall": 0
          },
          "static": {
            "expected": 3,
            "resolved": 3,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 6,
            "resolved": 6,
            "recall": 1
          }
        }
      },
      "verilog": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 4,
        "totalResolved": 0,
        "totalExpected": 4,
        "byMode": {
          "static": {
            "expected": 3,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 1,
            "resolved": 0,
            "recall": 0
          }
        }
      },
      "zig": {
        "precision": 0,
        "recall": 0,
        "truePositives": 0,
        "falsePositives": 0,
        "falseNegatives": 15,
        "totalResolved": 0,
        "totalExpected": 15,
        "byMode": {
          "module-function": {
            "expected": 5,
            "resolved": 0,
            "recall": 0
          },
          "receiver-typed": {
            "expected": 8,
            "resolved": 0,
            "recall": 0
          },
          "same-file": {
            "expected": 2,
            "resolved": 0,
            "recall": 0
          }
        }
      }
    }
  },
  {
    "version": "3.9.1",
    "date": "2026-04-06",
    "files": 570,
    "wasm": {
      "buildTimeMs": 7793,
      "queryTimeMs": 35.6,
      "nodes": 16031,
      "edges": 32445,
      "dbSizeBytes": 26058752,
      "perFile": {
        "buildTimeMs": 13.7,
        "nodes": 28.1,
        "edges": 56.9,
        "dbSizeBytes": 45717
      },
      "noopRebuildMs": 15,
      "oneFileRebuildMs": 639,
      "oneFilePhases": {
        "setupMs": 1.1,
        "parseMs": 272.6,
        "insertMs": 20.8,
        "resolveMs": 1.9,
        "edgesMs": 31.5,
        "structureMs": 31.6,
        "rolesMs": 83.1,
        "astMs": 1.4,
        "complexityMs": 0.7,
        "cfgMs": 0.4,
        "dataflowMs": 0.6,
        "finalizeMs": 5.2
      },
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 2.2,
        "pathMs": 2.2,
        "rolesMs": 26.3
      },
      "phases": {
        "setupMs": 86.6,
        "parseMs": 3103.6,
        "insertMs": 346.4,
        "resolveMs": 15.8,
        "edgesMs": 218.1,
        "structureMs": 62.3,
        "rolesMs": 84.9,
        "astMs": 730.3,
        "complexityMs": 1077.6,
        "cfgMs": 1076.7,
        "dataflowMs": 834.7,
        "finalizeMs": 52.2
      }
    },
    "native": {
      "buildTimeMs": 5819,
      "queryTimeMs": 23.4,
      "nodes": 16031,
      "edges": 32445,
      "dbSizeBytes": 27607040,
      "perFile": {
        "buildTimeMs": 10.2,
        "nodes": 28.1,
        "edges": 56.9,
        "dbSizeBytes": 48433
      },
      "noopRebuildMs": 17,
      "oneFileRebuildMs": 767,
      "oneFilePhases": {
        "setupMs": 3.2,
        "parseMs": 338.9,
        "insertMs": 49,
        "resolveMs": 2.2,
        "edgesMs": 49.8,
        "structureMs": 28.7,
        "rolesMs": 80.7,
        "astMs": 11.9,
        "complexityMs": 0.3,
        "cfgMs": 0.7,
        "dataflowMs": 0.3,
        "finalizeMs": 0.9
      },
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 2.3,
        "pathMs": 2.2,
        "rolesMs": 25.5
      },
      "phases": {
        "setupMs": 25.6,
        "parseMs": 3382.4,
        "insertMs": 406.8,
        "resolveMs": 14.1,
        "edgesMs": 234.5,
        "structureMs": 49.6,
        "rolesMs": 86.8,
        "astMs": 283.3,
        "complexityMs": 61.7,
        "cfgMs": 309.7,
        "dataflowMs": 904,
        "finalizeMs": 5.6
      }
    },
    "resolution": {
      "javascript": {
        "precision": 1,
        "recall": 0.667,
        "truePositives": 12,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 12,
        "totalExpected": 18,
        "byMode": {
          "static": {
            "expected": 12,
            "resolved": 9,
            "recall": 0.75
          },
          "receiver-typed": {
            "expected": 6,
            "resolved": 3,
            "recall": 0.5
          }
        }
      },
      "typescript": {
        "precision": 1,
        "recall": 0.75,
        "truePositives": 15,
        "falsePositives": 0,
        "falseNegatives": 5,
        "totalResolved": 15,
        "totalExpected": 20,
        "byMode": {
          "static": {
            "expected": 9,
            "resolved": 9,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 11,
            "resolved": 6,
            "recall": 0.5454545454545454
          }
        }
      }
    }
  },
  {
    "version": "3.9.0",
    "date": "2026-04-04",
    "files": 567,
    "wasm": {
      "buildTimeMs": 7454,
      "queryTimeMs": 30.6,
      "nodes": 15483,
      "edges": 30610,
      "dbSizeBytes": 25300992,
      "perFile": {
        "buildTimeMs": 13.1,
        "nodes": 27.3,
        "edges": 54,
        "dbSizeBytes": 44623
      },
      "noopRebuildMs": 15,
      "oneFileRebuildMs": 559,
      "oneFilePhases": {
        "setupMs": 1.7,
        "parseMs": 258.2,
        "insertMs": 19.3,
        "resolveMs": 1.8,
        "edgesMs": 26.9,
        "structureMs": 28.3,
        "rolesMs": 53.7,
        "astMs": 0.6,
        "complexityMs": 0.7,
        "cfgMs": 0.4,
        "dataflowMs": 0.5,
        "finalizeMs": 5
      },
      "queries": {
        "fnDepsMs": 2.1,
        "fnImpactMs": 2.2,
        "pathMs": 2.1,
        "rolesMs": 26.6
      },
      "phases": {
        "setupMs": 28.6,
        "parseMs": 3079.6,
        "insertMs": 336.9,
        "resolveMs": 19.6,
        "edgesMs": 211,
        "structureMs": 54.9,
        "rolesMs": 73.2,
        "astMs": 240,
        "complexityMs": 420.1,
        "cfgMs": 496.1,
        "dataflowMs": 195.9,
        "finalizeMs": 51
      }
    },
    "native": {
      "buildTimeMs": 7285,
      "queryTimeMs": 30.4,
      "nodes": 15483,
      "edges": 30609,
      "dbSizeBytes": 25325568,
      "perFile": {
        "buildTimeMs": 12.8,
        "nodes": 27.3,
        "edges": 54,
        "dbSizeBytes": 44666
      },
      "noopRebuildMs": 8,
      "oneFileRebuildMs": 562,
      "oneFilePhases": {
        "setupMs": 38.2,
        "parseMs": 50.2,
        "insertMs": 25.8,
        "resolveMs": 0.9,
        "edgesMs": 26.2,
        "structureMs": 151.7,
        "rolesMs": 65.6,
        "astMs": 20.4,
        "complexityMs": 4.8,
        "cfgMs": 27.7,
        "dataflowMs": 15.3,
        "finalizeMs": 0.4
      },
      "queries": {
        "fnDepsMs": 2.1,
        "fnImpactMs": 2.2,
        "pathMs": 2.2,
        "rolesMs": 25.9
      },
      "phases": {
        "setupMs": 5.5,
        "parseMs": 572.6,
        "insertMs": 327.4,
        "resolveMs": 3.6,
        "edgesMs": 168.6,
        "structureMs": 54.1,
        "rolesMs": 67.2,
        "astMs": 246.1,
        "complexityMs": 399.7,
        "cfgMs": 541.8,
        "dataflowMs": 296,
        "finalizeMs": 0.3
      }
    },
    "resolution": {
      "javascript": {
        "precision": 1,
        "recall": 0.6,
        "truePositives": 9,
        "falsePositives": 0,
        "falseNegatives": 6,
        "totalResolved": 9,
        "totalExpected": 15,
        "byMode": {
          "static": {
            "expected": 9,
            "resolved": 6,
            "recall": 0.6666666666666666
          },
          "receiver-typed": {
            "expected": 6,
            "resolved": 3,
            "recall": 0.5
          }
        }
      },
      "typescript": {
        "precision": 1,
        "recall": 0.688,
        "truePositives": 11,
        "falsePositives": 0,
        "falseNegatives": 5,
        "totalResolved": 11,
        "totalExpected": 16,
        "byMode": {
          "static": {
            "expected": 5,
            "resolved": 5,
            "recall": 1
          },
          "receiver-typed": {
            "expected": 11,
            "resolved": 6,
            "recall": 0.5454545454545454
          }
        }
      }
    }
  },
  {
    "version": "3.8.1",
    "date": "2026-04-03",
    "files": 565,
    "wasm": {
      "buildTimeMs": 7699,
      "queryTimeMs": 31.8,
      "nodes": 15342,
      "edges": 30385,
      "dbSizeBytes": 23965696,
      "perFile": {
        "buildTimeMs": 13.6,
        "nodes": 27.2,
        "edges": 53.8,
        "dbSizeBytes": 42417
      },
      "noopRebuildMs": 16,
      "oneFileRebuildMs": 600,
      "oneFilePhases": {
        "setupMs": 6.1,
        "parseMs": 270.6,
        "insertMs": 20.4,
        "resolveMs": 2.3,
        "edgesMs": 24.1,
        "structureMs": 30,
        "rolesMs": 56,
        "astMs": 7.9,
        "complexityMs": 0.9,
        "cfgMs": 0.4,
        "dataflowMs": 0.4,
        "finalizeMs": 5.8
      },
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 2.2,
        "pathMs": 2.2,
        "rolesMs": 28.4
      },
      "phases": {
        "setupMs": 31.3,
        "parseMs": 3341,
        "insertMs": 338.4,
        "resolveMs": 14,
        "edgesMs": 204.6,
        "structureMs": 57.6,
        "rolesMs": 75.5,
        "astMs": 238.9,
        "complexityMs": 435.6,
        "cfgMs": 487.6,
        "dataflowMs": 278.9,
        "finalizeMs": 52.7
      }
    },
    "native": {
      "buildTimeMs": 7519,
      "queryTimeMs": 28.9,
      "nodes": 15273,
      "edges": 26863,
      "dbSizeBytes": 24686592,
      "perFile": {
        "buildTimeMs": 13.3,
        "nodes": 27,
        "edges": 47.5,
        "dbSizeBytes": 43693
      },
      "noopRebuildMs": 8,
      "oneFileRebuildMs": 42,
      "oneFilePhases": {
        "setupMs": 6.7,
        "parseMs": 0.3,
        "insertMs": 0.2,
        "resolveMs": 0.3,
        "edgesMs": 8.2,
        "structureMs": 0.3,
        "rolesMs": 13.6,
        "astMs": 2.6,
        "complexityMs": 0.8,
        "cfgMs": 0.5,
        "dataflowMs": 0.4,
        "finalizeMs": 0.4
      },
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 2.2,
        "pathMs": 2.2,
        "rolesMs": 29.7
      },
      "phases": {
        "setupMs": 5.9,
        "parseMs": 559.7,
        "insertMs": 332.8,
        "resolveMs": 4.6,
        "edgesMs": 147.8,
        "structureMs": 0.3,
        "rolesMs": 65.5,
        "astMs": 246.1,
        "complexityMs": 401.3,
        "cfgMs": 510.3,
        "dataflowMs": 320.2,
        "finalizeMs": 0.4
      }
    }
  },
  {
    "version": "3.8.0",
    "date": "2026-04-02",
    "files": 564,
    "wasm": {
      "buildTimeMs": 1231,
      "queryTimeMs": 15.3,
      "nodes": 14652,
      "edges": 25554,
      "dbSizeBytes": 17215488,
      "perFile": {
        "buildTimeMs": 2.2,
        "nodes": 26,
        "edges": 45.3,
        "dbSizeBytes": 30524
      },
      "noopRebuildMs": 8,
      "oneFileRebuildMs": 33,
      "oneFilePhases": {
        "setupMs": 5.4,
        "parseMs": 0.3,
        "insertMs": 0.7,
        "resolveMs": 0.4,
        "edgesMs": 8.2,
        "structureMs": 0.2,
        "rolesMs": 14.1,
        "astMs": 0,
        "complexityMs": 0,
        "cfgMs": 0,
        "dataflowMs": 0,
        "finalizeMs": 0.3
      },
      "queries": {
        "fnDepsMs": 2.2,
        "fnImpactMs": 2.2,
        "pathMs": 2.1,
        "rolesMs": 31.3
      },
      "phases": {
        "setupMs": 5.9,
        "parseMs": 554.8,
        "insertMs": 377.9,
        "resolveMs": 4.6,
        "edgesMs": 151.9,
        "structureMs": 0.3,
        "rolesMs": 69.6,
        "astMs": 0,
        "complexityMs": 0,
        "cfgMs": 0,
        "dataflowMs": 0,
        "finalizeMs": 0.3
      }
    },
    "native": {
      "buildTimeMs": 1209,
      "queryTimeMs": 13.6,
      "nodes": 14652,
      "edges": 25554,
      "dbSizeBytes": 17399808,
      "perFile": {
        "buildTimeMs": 2.1,
        "nodes": 26,
        "edges": 45.3,
        "dbSizeBytes": 30851
      },
      "noopRebuildMs": 8,
      "oneFileRebuildMs": 33,
      "oneFilePhases": {
        "setupMs": 5.6,
        "parseMs": 0.3,
        "insertMs": 0.8,
        "resolveMs": 0.3,
        "edgesMs": 8.1,
        "structureMs": 0.2,
        "rolesMs": 13.9,
        "astMs": 0,
        "complexityMs": 0,
        "cfgMs": 0,
        "dataflowMs": 0,
        "finalizeMs": 0.3
      },
      "queries": {
        "fnDepsMs": 2.5,
        "fnImpactMs": 2.2,
        "pathMs": 2.1,
        "rolesMs": 29.2
      },
      "phases": {
        "setupMs": 4.9,
        "parseMs": 549.9,
        "insertMs": 375,
        "resolveMs": 4.4,
        "edgesMs": 146.7,
        "structureMs": 0.3,
        "rolesMs": 68.8,
        "astMs": 0,
        "complexityMs": 0,
        "cfgMs": 0,
        "dataflowMs": 0,
        "finalizeMs": 0.4
      }
    }
  },
  {
    "version": "3.7.0",
    "date": "2026-04-01",
    "files": 532,
    "wasm": {
      "buildTimeMs": 7536,
      "queryTimeMs": 12.5,
      "nodes": 13702,
      "edges": 26786,
      "dbSizeBytes": 28618752,
      "perFile": {
        "buildTimeMs": 14.2,
        "nodes": 25.8,
        "edges": 50.3,
        "dbSizeBytes": 53795
      },
      "noopRebuildMs": 15,
      "oneFileRebuildMs": 542,
      "oneFilePhases": {
        "setupMs": 2.7,
        "parseMs": 252.4,
        "insertMs": 17.7,
        "resolveMs": 1.6,
        "edgesMs": 19,
        "structureMs": 34,
        "rolesMs": 47.4,
        "astMs": 6.6,
        "complexityMs": 0.7,
        "cfgMs": 0.4,
        "dataflowMs": 0.4,
        "finalizeMs": 5.3
      },
      "queries": {
        "fnDepsMs": 2,
        "fnImpactMs": 2.1,
        "pathMs": 2,
        "rolesMs": 24.4
      },
      "phases": {
        "setupMs": 27,
        "parseMs": 2888.3,
        "insertMs": 289.1,
        "resolveMs": 11.5,
        "edgesMs": 173.3,
        "structureMs": 43.1,
        "rolesMs": 75,
        "astMs": 393,
        "complexityMs": 416.7,
        "cfgMs": 445.1,
        "dataflowMs": 285.6,
        "finalizeMs": 252.2
      }
    },
    "native": null
  },
  {
    "version": "3.6.0",
    "date": "2026-03-30",
    "files": 514,
    "wasm": {
      "buildTimeMs": 6841,
      "queryTimeMs": 12.3,
      "nodes": 13184,
      "edges": 25425,
      "dbSizeBytes": 27762688,
      "perFile": {
        "buildTimeMs": 13.3,
        "nodes": 25.6,
        "edges": 49.5,
        "dbSizeBytes": 54013
      },
      "noopRebuildMs": 14,
      "oneFileRebuildMs": 547,
      "oneFilePhases": {
        "setupMs": 2.6,
        "parseMs": 241.7,
        "insertMs": 17.6,
        "resolveMs": 1.5,
        "edgesMs": 33.8,
        "structureMs": 25.4,
        "rolesMs": 45.8,
        "astMs": 9.1,
        "complexityMs": 0.7,
        "cfgMs": 0.4,
        "dataflowMs": 0.4,
        "finalizeMs": 5.4
      },
      "queries": {
        "fnDepsMs": 2.1,
        "fnImpactMs": 2.1,
        "pathMs": 1.9,
        "rolesMs": 23.9
      },
      "phases": {
        "setupMs": 32.1,
        "parseMs": 2731.4,
        "insertMs": 274,
        "resolveMs": 11,
        "edgesMs": 178.5,
        "structureMs": 40.2,
        "rolesMs": 80.3,
        "astMs": 391.3,
        "complexityMs": 402.2,
        "cfgMs": 424.2,
        "dataflowMs": 209.5,
        "finalizeMs": 46
      }
    },
    "native": null
  },
  {
    "version": "3.4.1",
    "date": "2026-03-27",
    "files": 473,
    "wasm": {
      "buildTimeMs": 5627,
      "queryTimeMs": 12.2,
      "nodes": 10956,
      "edges": 20870,
      "dbSizeBytes": 19996672,
      "perFile": {
        "buildTimeMs": 11.9,
        "nodes": 23.2,
        "edges": 44.1,
        "dbSizeBytes": 42276
      },
      "noopRebuildMs": 16,
      "oneFileRebuildMs": 487,
      "oneFilePhases": {
        "setupMs": 2,
        "parseMs": 224.1,
        "insertMs": 19,
        "resolveMs": 1.6,
        "edgesMs": 20.7,
        "structureMs": 33.1,
        "rolesMs": 42.1,
        "astMs": 0.6,
        "complexityMs": 0.7,
        "cfgMs": 0.4,
        "dataflowMs": 0.5,
        "finalizeMs": 4.7
      },
      "queries": {
        "fnDepsMs": 1.9,
        "fnImpactMs": 2.1,
        "pathMs": 1.9,
        "rolesMs": 20.7
      },
      "phases": {
        "setupMs": 23.1,
        "parseMs": 2374.7,
        "insertMs": 242.3,
        "resolveMs": 14.7,
        "edgesMs": 147.6,
        "structureMs": 28.7,
        "rolesMs": 72,
        "astMs": 249.5,
        "complexityMs": 330.8,
        "cfgMs": 368,
        "dataflowMs": 133.6,
        "finalizeMs": 39.1
      }
    },
    "native": {
      "buildTimeMs": 2704,
      "queryTimeMs": 11.7,
      "nodes": 10982,
      "edges": 20869,
      "dbSizeBytes": 27303936,
      "perFile": {
        "buildTimeMs": 5.7,
        "nodes": 23.2,
        "edges": 44.1,
        "dbSizeBytes": 57725
      },
      "noopRebuildMs": 14,
      "oneFileRebuildMs": 316,
      "oneFilePhases": {
        "setupMs": 2.5,
        "parseMs": 80.8,
        "insertMs": 16.7,
        "resolveMs": 1.5,
        "edgesMs": 31.7,
        "structureMs": 33.6,
        "rolesMs": 40.4,
        "astMs": 0.6,
        "complexityMs": 0.6,
        "cfgMs": 0.3,
        "dataflowMs": 0.4,
        "finalizeMs": 0.4
      },
      "queries": {
        "fnDepsMs": 1.9,
        "fnImpactMs": 2,
        "pathMs": 1.9,
        "rolesMs": 21.6
      },
      "phases": {
        "setupMs": 20.9,
        "parseMs": 1391.1,
        "insertMs": 233.2,
        "resolveMs": 12,
        "edgesMs": 151.2,
        "structureMs": 28.3,
        "rolesMs": 64.4,
        "astMs": 401.5,
        "complexityMs": 28,
        "cfgMs": 182.1,
        "dataflowMs": 131.2,
        "finalizeMs": 3.4
      }
    }
  },
  {
    "version": "3.4.0",
    "date": "2026-03-26",
    "files": 473,
    "wasm": {
      "buildTimeMs": 5752,
      "queryTimeMs": 11.7,
      "nodes": 10937,
      "edges": 21022,
      "dbSizeBytes": 19013632,
      "perFile": {
        "buildTimeMs": 12.2,
        "nodes": 23.1,
        "edges": 44.4,
        "dbSizeBytes": 40198
      },
      "noopRebuildMs": 10,
      "oneFileRebuildMs": 621,
      "oneFilePhases": {
        "setupMs": 1.1,
        "parseMs": 239.9,
        "insertMs": 14.1,
        "resolveMs": 1.6,
        "edgesMs": 20.2,
        "structureMs": 30.4,
        "rolesMs": 61,
        "astMs": 2.4,
        "complexityMs": 7.9,
        "cfgMs": 0.3,
        "dataflowMs": 0.5,
        "finalizeMs": 13.8
      },
      "queries": {
        "fnDepsMs": 1.8,
        "fnImpactMs": 1.7,
        "pathMs": 1.6,
        "rolesMs": 21.5
      },
      "phases": {
        "setupMs": 21.1,
        "parseMs": 2438.2,
        "insertMs": 209.8,
        "resolveMs": 15.1,
        "edgesMs": 149.1,
        "structureMs": 26.1,
        "rolesMs": 77.9,
        "astMs": 217.2,
        "complexityMs": 348.1,
        "cfgMs": 370.5,
        "dataflowMs": 119.5,
        "finalizeMs": 63.8
      }
    },
    "native": {
      "buildTimeMs": 2499,
      "queryTimeMs": 11.6,
      "nodes": 10963,
      "edges": 20921,
      "dbSizeBytes": 26034176,
      "perFile": {
        "buildTimeMs": 5.3,
        "nodes": 23.2,
        "edges": 44.2,
        "dbSizeBytes": 55041
      },
      "noopRebuildMs": 12,
      "oneFileRebuildMs": 432,
      "oneFilePhases": {
        "setupMs": 1.7,
        "parseMs": 78.3,
        "insertMs": 15.6,
        "resolveMs": 1.7,
        "edgesMs": 32.3,
        "structureMs": 29.9,
        "rolesMs": 55.9,
        "astMs": 0.7,
        "complexityMs": 0.7,
        "cfgMs": 0.3,
        "dataflowMs": 0.5,
        "finalizeMs": 9.4
      },
      "queries": {
        "fnDepsMs": 1.7,
        "fnImpactMs": 1.7,
        "pathMs": 1.6,
        "rolesMs": 19.9
      },
      "phases": {
        "setupMs": 20.7,
        "parseMs": 1348.3,
        "insertMs": 192,
        "resolveMs": 13.3,
        "edgesMs": 144.8,
        "structureMs": 24.9,
        "rolesMs": 65,
        "astMs": 337.8,
        "complexityMs": 25.8,
        "cfgMs": 160.3,
        "dataflowMs": 117,
        "finalizeMs": 14.4
      }
    }
  },
  {
    "version": "3.3.1",
    "date": "2026-03-20",
    "files": 442,
    "wasm": {
      "buildTimeMs": 4972,
      "queryTimeMs": 7.2,
      "nodes": 7752,
      "edges": 16103,
      "dbSizeBytes": 20914176,
      "perFile": {
        "buildTimeMs": 11.2,
        "nodes": 17.5,
        "edges": 36.4,
        "dbSizeBytes": 47317
      },
      "noopRebuildMs": 12,
      "oneFileRebuildMs": 506,
      "oneFilePhases": {
        "setupMs": 2.1,
        "parseMs": 200.5,
        "insertMs": 8.4,
        "resolveMs": 1.6,
        "edgesMs": 15.4,
        "structureMs": 24.4,
        "rolesMs": 54.5,
        "astMs": 0.2,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.2,
        "finalizeMs": 13.6
      },
      "queries": {
        "fnDepsMs": 1.3,
        "fnImpactMs": 1.4,
        "pathMs": 1.3,
        "rolesMs": 14.8
      },
      "phases": {
        "setupMs": 22.9,
        "parseMs": 2123.4,
        "insertMs": 201.2,
        "resolveMs": 12.8,
        "edgesMs": 167,
        "structureMs": 21.1,
        "rolesMs": 51.8,
        "astMs": 397.2,
        "complexityMs": 215.5,
        "cfgMs": 154.8,
        "dataflowMs": 128.8,
        "finalizeMs": 48.1
      }
    },
    "native": {
      "buildTimeMs": 2716,
      "queryTimeMs": 7.1,
      "nodes": 7777,
      "edges": 16115,
      "dbSizeBytes": 21528576,
      "perFile": {
        "buildTimeMs": 6.1,
        "nodes": 17.6,
        "edges": 36.5,
        "dbSizeBytes": 48707
      },
      "noopRebuildMs": 12,
      "oneFileRebuildMs": 353,
      "oneFilePhases": {
        "setupMs": 1.9,
        "parseMs": 56.6,
        "insertMs": 8.2,
        "resolveMs": 1.6,
        "edgesMs": 20.8,
        "structureMs": 26.1,
        "rolesMs": 54.1,
        "astMs": 0.2,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.1,
        "finalizeMs": 9.2
      },
      "queries": {
        "fnDepsMs": 1.4,
        "fnImpactMs": 1.4,
        "pathMs": 1.3,
        "rolesMs": 15.1
      },
      "phases": {
        "setupMs": 20.7,
        "parseMs": 600.6,
        "insertMs": 205.9,
        "resolveMs": 11.9,
        "edgesMs": 108.1,
        "structureMs": 22,
        "rolesMs": 51.9,
        "astMs": 392.7,
        "complexityMs": 170.6,
        "cfgMs": 161,
        "dataflowMs": 125,
        "finalizeMs": 46.9
      }
    }
  },
  {
    "version": "3.1.4",
    "date": "2026-03-16",
    "files": 398,
    "wasm": {
      "buildTimeMs": 3815,
      "queryTimeMs": 4.6,
      "nodes": 5320,
      "edges": 11496,
      "dbSizeBytes": 17043456,
      "perFile": {
        "buildTimeMs": 9.6,
        "nodes": 13.4,
        "edges": 28.9,
        "dbSizeBytes": 42823
      },
      "noopRebuildMs": 10,
      "oneFileRebuildMs": 375,
      "oneFilePhases": {
        "setupMs": 2.2,
        "parseMs": 146.1,
        "insertMs": 13,
        "resolveMs": 1.2,
        "edgesMs": 17.4,
        "structureMs": 13.2,
        "rolesMs": 35.4,
        "astMs": 0.2,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.2,
        "finalizeMs": 13.3
      },
      "queries": {
        "fnDepsMs": 0.9,
        "fnImpactMs": 1,
        "pathMs": 0.9,
        "rolesMs": 9.7
      },
      "phases": {
        "setupMs": 20.5,
        "parseMs": 1482.5,
        "insertMs": 147.5,
        "resolveMs": 9.2,
        "edgesMs": 151.6,
        "structureMs": 16.6,
        "rolesMs": 32.3,
        "astMs": 347.4,
        "complexityMs": 76.5,
        "cfgMs": 124.5,
        "dataflowMs": 98.4,
        "finalizeMs": 42.6
      }
    },
    "native": {
      "buildTimeMs": 1380,
      "queryTimeMs": 3.2,
      "nodes": 5325,
      "edges": 11466,
      "dbSizeBytes": 17698816,
      "perFile": {
        "buildTimeMs": 3.5,
        "nodes": 13.4,
        "edges": 28.8,
        "dbSizeBytes": 44469
      },
      "noopRebuildMs": 9,
      "oneFileRebuildMs": 265,
      "oneFilePhases": {
        "setupMs": 1,
        "parseMs": 51.2,
        "insertMs": 12,
        "resolveMs": 1.7,
        "edgesMs": 13,
        "structureMs": 13.1,
        "rolesMs": 27.2,
        "astMs": 0.4,
        "complexityMs": 0.1,
        "cfgMs": 0.1,
        "dataflowMs": 0.2,
        "finalizeMs": 11.5
      },
      "queries": {
        "fnDepsMs": 0.9,
        "fnImpactMs": 0.9,
        "pathMs": 0.9,
        "rolesMs": 10.1
      },
      "phases": {
        "setupMs": 9.5,
        "parseMs": 467.8,
        "insertMs": 142.5,
        "resolveMs": 7.8,
        "edgesMs": 88.1,
        "structureMs": 12.5,
        "rolesMs": 29,
        "astMs": 361.3,
        "complexityMs": 15.6,
        "cfgMs": 126.2,
        "dataflowMs": 99.6,
        "finalizeMs": 12.4
      }
    }
  },
  {
    "version": "3.1.3",
    "date": "2026-03-12",
    "files": 236,
    "wasm": {
      "buildTimeMs": 3443,
      "queryTimeMs": 5.5,
      "nodes": 4249,
      "edges": 9349,
      "dbSizeBytes": 14876672,
      "perFile": {
        "buildTimeMs": 14.6,
        "nodes": 18,
        "edges": 39.6,
        "dbSizeBytes": 63037
      },
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 493,
      "oneFilePhases": {
        "setupMs": 36.6,
        "parseMs": 226,
        "insertMs": 10.2,
        "resolveMs": 1.6,
        "edgesMs": 35,
        "structureMs": 9.2,
        "rolesMs": 22.5,
        "astMs": 23.1,
        "complexityMs": 3,
        "cfgMs": 5.3,
        "dataflowMs": 4.1,
        "finalizeMs": 10.9
      },
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.9,
        "pathMs": 0.8,
        "rolesMs": 7.7
      },
      "phases": {
        "setupMs": 23.3,
        "parseMs": 1334.3,
        "insertMs": 97.3,
        "resolveMs": 8.5,
        "edgesMs": 137,
        "structureMs": 21,
        "rolesMs": 24.4,
        "astMs": 327.9,
        "complexityMs": 72.6,
        "cfgMs": 112.8,
        "dataflowMs": 87.1,
        "finalizeMs": 42.5
      }
    },
    "native": {
      "buildTimeMs": 1202,
      "queryTimeMs": 3.9,
      "nodes": 4245,
      "edges": 9305,
      "dbSizeBytes": 15470592,
      "perFile": {
        "buildTimeMs": 5.1,
        "nodes": 18,
        "edges": 39.4,
        "dbSizeBytes": 65553
      },
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 282,
      "oneFilePhases": {
        "setupMs": 35.8,
        "parseMs": 82.1,
        "insertMs": 10.3,
        "resolveMs": 1.7,
        "edgesMs": 17.4,
        "structureMs": 11,
        "rolesMs": 25.1,
        "astMs": 18.7,
        "complexityMs": 1.3,
        "cfgMs": 8.7,
        "dataflowMs": 4,
        "finalizeMs": 5
      },
      "queries": {
        "fnDepsMs": 0.9,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 7.4
      },
      "phases": {
        "setupMs": 11.9,
        "parseMs": 420.1,
        "insertMs": 96.5,
        "resolveMs": 4.7,
        "edgesMs": 70,
        "structureMs": 20.8,
        "rolesMs": 27.1,
        "astMs": 321.5,
        "complexityMs": 12.6,
        "cfgMs": 114.1,
        "dataflowMs": 88.6,
        "finalizeMs": 11.8
      }
    }
  },
  {
    "version": "3.1.2",
    "date": "2026-03-11",
    "files": 235,
    "wasm": {
      "buildTimeMs": 3516,
      "queryTimeMs": 5.8,
      "nodes": 4202,
      "edges": 9240,
      "dbSizeBytes": 14618624,
      "perFile": {
        "buildTimeMs": 15,
        "nodes": 17.9,
        "edges": 39.3,
        "dbSizeBytes": 62207
      },
      "noopRebuildMs": 7,
      "oneFileRebuildMs": 563,
      "oneFilePhases": {
        "parseMs": 239.4,
        "insertMs": 11.1,
        "resolveMs": 1.6,
        "edgesMs": 52,
        "structureMs": 9.6,
        "rolesMs": 26.2,
        "astMs": 21.4,
        "complexityMs": 0.5,
        "cfgMs": 6.4,
        "dataflowMs": 5.1
      },
      "queries": {
        "fnDepsMs": 0.9,
        "fnImpactMs": 0.9,
        "pathMs": 0.9,
        "rolesMs": 8.3
      },
      "phases": {
        "parseMs": 1421.3,
        "insertMs": 103.2,
        "resolveMs": 8.9,
        "edgesMs": 158.5,
        "structureMs": 23.7,
        "rolesMs": 23.8,
        "astMs": 345.1,
        "complexityMs": 5.3,
        "cfgMs": 115.4,
        "dataflowMs": 92.1
      }
    },
    "native": {
      "buildTimeMs": 1223,
      "queryTimeMs": 4.2,
      "nodes": 4198,
      "edges": 9063,
      "dbSizeBytes": 15339520,
      "perFile": {
        "buildTimeMs": 5.2,
        "nodes": 17.9,
        "edges": 38.6,
        "dbSizeBytes": 65275
      },
      "noopRebuildMs": 6,
      "oneFileRebuildMs": 296,
      "oneFilePhases": {
        "parseMs": 86.6,
        "insertMs": 11.7,
        "resolveMs": 1.3,
        "edgesMs": 17.1,
        "structureMs": 9.4,
        "rolesMs": 32.8,
        "astMs": 20.9,
        "complexityMs": 1.2,
        "cfgMs": 5.7,
        "dataflowMs": 4.5
      },
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 8.6
      },
      "phases": {
        "parseMs": 421.6,
        "insertMs": 100.2,
        "resolveMs": 4.5,
        "edgesMs": 70,
        "structureMs": 19.9,
        "rolesMs": 29.6,
        "astMs": 335.7,
        "complexityMs": 13.1,
        "cfgMs": 116.8,
        "dataflowMs": 84.8
      }
    }
  },
  {
    "version": "3.1.0",
    "date": "2026-03-08",
    "files": 180,
    "wasm": {
      "buildTimeMs": 2962,
      "queryTimeMs": 4.6,
      "nodes": 3758,
      "edges": 8093,
      "dbSizeBytes": 13979648,
      "perFile": {
        "buildTimeMs": 16.5,
        "nodes": 20.9,
        "edges": 45,
        "dbSizeBytes": 77665
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 570,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 6.5
      },
      "phases": {
        "parseMs": 1002.3,
        "insertMs": 86.3,
        "resolveMs": 5.9,
        "edgesMs": 133.5,
        "structureMs": 18.8,
        "rolesMs": 20.9,
        "astMs": 616.6,
        "complexityMs": 389.5,
        "wasmPreMs": 0,
        "cfgMs": 198.9,
        "dataflowMs": 445.8
      }
    },
    "native": {
      "buildTimeMs": 1093,
      "queryTimeMs": 3.4,
      "nodes": 3750,
      "edges": 8045,
      "dbSizeBytes": 14565376,
      "perFile": {
        "buildTimeMs": 6.1,
        "nodes": 20.8,
        "edges": 44.7,
        "dbSizeBytes": 80919
      },
      "noopRebuildMs": 5,
      "oneFileRebuildMs": 332,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 6.4
      },
      "phases": {
        "parseMs": 384.4,
        "insertMs": 86.2,
        "resolveMs": 3.3,
        "edgesMs": 61,
        "structureMs": 15.1,
        "rolesMs": 18.6,
        "astMs": 302.1,
        "complexityMs": 9.6,
        "wasmPreMs": 0,
        "cfgMs": 110.5,
        "dataflowMs": 79.2
      }
    }
  },
  {
    "version": "3.0.4",
    "date": "2026-03-06",
    "files": 177,
    "wasm": {
      "buildTimeMs": 3367,
      "queryTimeMs": 4.8,
      "nodes": 3652,
      "edges": 7907,
      "dbSizeBytes": 13672448,
      "perFile": {
        "buildTimeMs": 19,
        "nodes": 20.6,
        "edges": 44.7,
        "dbSizeBytes": 77245
      },
      "noopRebuildMs": 7,
      "oneFileRebuildMs": 559,
      "queries": {
        "fnDepsMs": 0.9,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 6.8
      },
      "phases": {
        "parseMs": 1019.3,
        "insertMs": 86.1,
        "resolveMs": 19.1,
        "edgesMs": 145.4,
        "structureMs": 477.7,
        "rolesMs": 19.8,
        "astMs": 589,
        "complexityMs": 352.7,
        "wasmPreMs": 0,
        "cfgMs": 187.1,
        "dataflowMs": 434.7
      }
    },
    "native": {
      "buildTimeMs": 1092,
      "queryTimeMs": 3.3,
      "nodes": 3645,
      "edges": 7868,
      "dbSizeBytes": 12558336,
      "perFile": {
        "buildTimeMs": 6.2,
        "nodes": 20.6,
        "edges": 44.5,
        "dbSizeBytes": 70951
      },
      "noopRebuildMs": 329,
      "oneFileRebuildMs": 335,
      "queries": {
        "fnDepsMs": 0.8,
        "fnImpactMs": 0.8,
        "pathMs": 0.8,
        "rolesMs": 6
      },
      "phases": {
        "parseMs": 413,
        "insertMs": 80.3,
        "resolveMs": 15.6,
        "edgesMs": 143.2,
        "structureMs": 13.2,
        "rolesMs": 21.9,
        "astMs": 300,
        "complexityMs": 9.7,
        "wasmPreMs": 0,
        "cfgMs": 1.3,
        "dataflowMs": 75.9
      }
    }
  },
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
