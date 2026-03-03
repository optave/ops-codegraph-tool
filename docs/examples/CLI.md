# CLI Examples

Real output from running codegraph on its own codebase — what you'll see after `npm install -g @optave/codegraph && codegraph build .`

---

## build — Parse and index your project

```bash
codegraph build .
```

```
Using wasm engine
Loaded path aliases: baseUrl=none, 2 path mappings
Found 65 files to parse
Parsed 65 files (42 changed, 0 removed)
Resolved 696 edges
Graph built in 1.2s → .codegraph/graph.db
```

Incremental rebuilds only re-parse changed files:

```
No changes detected. Graph is up to date.
```

---

## stats — Graph health at a glance

```bash
codegraph stats -T
```

```
# Codegraph Stats

Nodes:     479 total
  function 349      file 65           struct 23
  method 21         directory 18      trait 1
  enum 1            class 1

Edges:     696 total
  calls 526         contains 77       imports 68
  reexports 25

Files:     65 (2 languages)
  javascript 46     rust 19

Cycles:    1 file-level, 2 function-level

Top 5 coupling hotspots:
   1. src/parser.js                       fan-in:  16  fan-out:  13
   2. src/db.js                           fan-in:  20  fan-out:   1
   3. src/builder.js                      fan-in:   8  fan-out:   8
   4. src/index.js                        fan-in:   1  fan-out:  14
   5. src/queries.js                      fan-in:  11  fan-out:   4

Embeddings: not built

Graph Quality: 84/100
  Caller coverage:  63.2% (234/370 functions have >=1 caller)
  Call confidence:  97.8% (660/675 call edges are high-confidence)
```

---

## where — Quick symbol lookup

Find where a symbol is defined and who uses it:

```bash
codegraph where buildGraph -T
```

```
f buildGraph  src/builder.js:335  (exported)
  Used in: src/cli.js:77
```

File overview mode — list all symbols, imports, and exports in a file:

```bash
codegraph where -f src/db.js -T
```

```
# src/db.js
  Symbols: openDb:76, initSchema:84, findDbPath:120, openReadonlyOrFail:136
  Imports: src/logger.js
  Imported by: src/builder.js, src/cli.js, src/embedder.js, src/mcp.js, src/queries.js, src/structure.js
  Exported: openDb, initSchema, findDbPath, openReadonlyOrFail
```

---

## audit --quick — Structural summary (file or function)

### On a file

```bash
codegraph audit src/builder.js --quick -T
```

```
# src/builder.js
  949 lines, 10 symbols (4 exported, 6 internal)
  Imports: src/config.js, src/constants.js, src/db.js, src/journal.js, src/logger.js, src/parser.js, src/resolve.js
  Imported by: src/cli.js, src/watcher.js

## Exported
  f collectFiles :45
  f loadPathAliases(rootDir) :101
  f readFileSafe(filePath, retries = 2) :154
  f buildGraph(rootDir, opts = {}) :335

## Internal
  f fileHash(content) :131  -- Compute MD5 hash of file contents for incremental builds.
  f fileStat(filePath) :138  -- Stat a file, returning { mtimeMs, size } or null on error.
  f getChangedFiles(db, allFiles, rootDir) :176  -- Determine which files have changed since last build.
  f getResolved(absFile, importSource) :570
  f isBarrelFile(relPath) :595
  f resolveBarrelExport(barrelPath, symbolName, visited = new Set()) :604

## Data Flow
  getChangedFiles -> fileStat, readFileSafe, fileHash
  buildGraph -> loadPathAliases, collectFiles, getChangedFiles, fileStat, readFileSafe, fileHash
  resolveBarrelExport -> getResolved, isBarrelFile
```

### On a function

```bash
codegraph audit buildGraph --quick -T
```

```
# buildGraph (function)  src/builder.js:335-882
  548 lines
  Parameters: (rootDir, opts = {})

  Calls (22):
    f openDb  src/db.js:76
    f initSchema  src/db.js:84
    f loadConfig  src/config.js:33
    f getActiveEngine  src/parser.js:316
    f loadPathAliases  src/builder.js:101
    f collectFiles  src/builder.js:45
    f getChangedFiles  src/builder.js:176
    f writeJournalHeader  src/journal.js:88
    f normalizePath  src/constants.js:37
    f parseFilesAuto  src/parser.js:277
    f resolveImportsBatch  src/resolve.js:150
    ...

  Called by (1):
    <- resolveNoTests  src/cli.js:59
```

---

## context — Everything you need to understand a function

```bash
codegraph context buildGraph -T
```

```
# buildGraph (function) — src/builder.js:335-948

## Type/Shape Info
  Parameters: (rootDir, opts = {})

## Source
  export async function buildGraph(rootDir, opts = {}) {
    const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
    const db = openDb(dbPath);
    initSchema(db);

    const config = loadConfig(rootDir);
    const incremental =
      opts.incremental !== false && config.build && config.build.incremental !== false;

    const engineOpts = { engine: opts.engine || 'auto' };
    const { name: engineName, version: engineVersion } = getActiveEngine(engineOpts);
    ...
  }

## Dependencies
  -> openDb (src/db.js:76)
  -> initSchema (src/db.js:84)
  -> loadConfig (src/config.js:33)
  -> collectFiles (src/builder.js:45)
  ...

## Callers
  <- resolveNoTests (src/cli.js:59)
```

---

## fn — Function call chain

```bash
codegraph fn buildGraph -T
```

```
f buildGraph (function) -- src/builder.js:335

  -> Calls (22):
    -> f openDb  src/db.js:76
    -> f initSchema  src/db.js:84
    -> f loadConfig  src/config.js:33
    -> f getActiveEngine  src/parser.js:316
    -> f info  src/logger.js:18
    -> f loadPathAliases  src/builder.js:101
    -> f collectFiles  src/builder.js:45
    -> f getChangedFiles  src/builder.js:176
    -> f writeJournalHeader  src/journal.js:88
    -> f normalizePath  src/constants.js:37
    -> f parseFilesAuto  src/parser.js:277
    -> f fileStat  src/builder.js:138
    -> f readFileSafe  src/builder.js:154
    -> f fileHash  src/builder.js:131
    -> f resolveImportsBatch  src/resolve.js:150
    ...

  <- Called by (1):
    <- f resolveNoTests  src/cli.js:59
```

---

## deps — File-level imports

```bash
codegraph deps src/builder.js -T
```

```
# src/builder.js

  -> Imports (7):
    -> src/config.js
    -> src/constants.js
    -> src/db.js
    -> src/journal.js
    -> src/logger.js
    -> src/parser.js
    -> src/resolve.js

  <- Imported by (1):
    <- src/cli.js

  Definitions (10):
    f collectFiles :45
    f loadPathAliases :101
    f fileHash :131
    f fileStat :138
    f readFileSafe :154
    f getChangedFiles :176
    f buildGraph :335
    f getResolved :570
    f isBarrelFile :595
    f resolveBarrelExport :604
```

---

## fn-impact — Blast radius of a function change

```bash
codegraph fn-impact buildGraph -T
```

```
Function impact: f buildGraph -- src/builder.js:335

  -- Level 1 (1 functions):
      ^ f resolveNoTests  src/cli.js:59

  Total: 1 functions transitively depend on buildGraph
```

---

## path — Shortest path between two symbols

Find how symbol A reaches symbol B through the call graph:

```bash
codegraph path buildGraph openDb -T
```

```
Path from buildGraph to openDb (1 hop):

  f buildGraph (function) -- src/builder.js:335
    --[calls]--> f openDb (function) -- src/db.js:76
```

Multi-hop paths show each intermediate step:

```bash
codegraph path resolveNoTests openDb -T
```

```
Path from resolveNoTests to openDb (2 hops):

  f resolveNoTests (function) -- src/cli.js:59
    --[calls]--> f buildGraph (function) -- src/builder.js:335
      --[calls]--> f openDb (function) -- src/db.js:76
```

Reverse direction — follow edges backward (B is called by... called by A):

```bash
codegraph path openDb buildGraph -T --reverse
```

```
Path from openDb to buildGraph (1 hop) (reverse):

  f openDb (function) -- src/db.js:76
    --[calls]--> f buildGraph (function) -- src/builder.js:335
```

When no path exists:

```bash
codegraph path openDb buildGraph -T
```

```
No path from "openDb" to "buildGraph" within 10 hops.
```

---

## impact — File-level transitive dependents

```bash
codegraph impact src/parser.js -T
```

```
Impact analysis for files matching "src/parser.js":

  # src/parser.js (source)

  -- Level 1 (4 files):
      ^ src/constants.js
      ^ src/watcher.js
      ^ src/builder.js
      ^ src/queries.js

  ---- Level 2 (4 files):
        ^ src/resolve.js
        ^ src/structure.js
        ^ src/cli.js
        ^ src/mcp.js

  Total: 8 files transitively depend on "src/parser.js"
```

---

## diff-impact — Impact of git changes

```bash
codegraph diff-impact main -T
```

```
  Changed files:
    M src/structure.js    (structureCmd, computeStructure)
    M src/queries.js      (findNodeByName)

  Impacted functions:
    -- Level 1:
        ^ resolveNoTests  src/cli.js:59
        ^ structureTool   src/mcp.js:312

  Total: 2 functions affected by this diff
```

Also available as a Mermaid diagram (`-f mermaid`) for visual impact graphs.

---

## map — Module overview

```bash
codegraph map --limit 10 -T
```

```
Module map (top 10 most-connected nodes):

  [src/]
    db.js                               <- 19 ->  1  = 20  ####################
    parser.js                           <- 15 -> 13  = 28  ############################
    logger.js                           <- 13 ->  0  = 13  #############
    native.js                           <- 10 ->  0  = 10  ##########
    queries.js                          <- 10 ->  4  = 14  ##############
    builder.js                          <-  7 ->  8  = 15  ###############
    constants.js                        <-  6 ->  1  =  7  #######
    cycles.js                           <-  5 ->  2  =  7  #######
    resolve.js                          <-  5 ->  2  =  7  #######
  [src/extractors/]
    helpers.js                          <-  9 ->  0  =  9  #########

  Total: 101 files, 591 symbols, 933 edges
```

---

## structure — Project directory tree with metrics

```bash
codegraph structure --depth 2 -T
```

```
Project structure (15 directories):

crates/  (0 files, 0 symbols, <-0 ->0)
  crates/codegraph-core/  (0 files, 0 symbols, <-0 ->0)
scripts/  (2 files, 8 symbols, <-0 ->0)
  embedding-benchmark.js  146L 3sym <-0 ->0
  update-benchmark-report.js  229L 5sym <-0 ->0
src/  (9 files, 92 symbols, <-6 ->20 cohesion=0.32)
  builder.js  883L 10sym <-2 ->7
  cli.js  570L 1sym <-0 ->10
  db.js  147L 4sym <-7 ->1
  embedder.js  714L 16sym <-2 ->2
  mcp.js  585L 2sym <-1 ->3
  queries.js  2318L 44sym <-3 ->4
  registry.js  163L 7sym <-2 ->1
  structure.js  507L 8sym <-1 ->4
  src/extractors/  (0 files, 0 symbols, <-0 ->0)
tests/  (0 files, 32 symbols, <-0 ->6 cohesion=0.00)
  tests/integration/  (0 files, 0 symbols, <-0 ->2)
  tests/search/  (0 files, 4 symbols, <-0 ->2)
  tests/unit/  (0 files, 28 symbols, <-0 ->2)
```

---

## triage --level — Find structural hotspots

```bash
codegraph triage --level file --sort fan-in -T
```

```
Hotspots by fan-in (file-level, top 10):

   1. src/db.js  <-7 ->1  (147L, 4 symbols)
   2. src/queries.js  <-3 ->4  (2318L, 44 symbols)
   3. src/builder.js  <-2 ->7  (883L, 10 symbols)
   4. src/embedder.js  <-2 ->2  (714L, 16 symbols)
   5. src/registry.js  <-2 ->1  (163L, 7 symbols)
   6. src/mcp.js  <-1 ->3  (585L, 2 symbols)
   7. src/structure.js  <-1 ->4  (507L, 8 symbols)
   8. src/cli.js  <-0 ->10  (570L, 1 symbols)
```

Other metrics: `fan-out`, `density`, `coupling`. Use `--level directory` for directory-level hotspots.

---

## cycles — Circular dependency detection

```bash
codegraph cycles
```

```
No circular dependencies detected.
```

When cycles exist:

```
Found 1 file-level cycle:

  Cycle 1 (2 files):
    src/parser.js -> src/constants.js -> src/parser.js
```

---

## export — Graph as DOT, Mermaid, or JSON

### Mermaid (file-level)

```bash
codegraph export -f mermaid -T
```

```mermaid
graph LR
  src_builder_js["src/builder.js"] --> src_config_js["src/config.js"]
  src_builder_js["src/builder.js"] --> src_constants_js["src/constants.js"]
  src_builder_js["src/builder.js"] --> src_db_js["src/db.js"]
  src_builder_js["src/builder.js"] --> src_logger_js["src/logger.js"]
  src_builder_js["src/builder.js"] --> src_parser_js["src/parser.js"]
  src_builder_js["src/builder.js"] --> src_resolve_js["src/resolve.js"]
  src_cli_js["src/cli.js"] --> src_builder_js["src/builder.js"]
  src_cli_js["src/cli.js"] --> src_db_js["src/db.js"]
  src_cli_js["src/cli.js"] --> src_queries_js["src/queries.js"]
  src_watcher_js["src/watcher.js"] --> src_builder_js["src/builder.js"]
  src_watcher_js["src/watcher.js"] --> src_parser_js["src/parser.js"]
```

### Mermaid (function-level)

```bash
codegraph export -f mermaid --functions -T
```

```mermaid
graph LR
  detect_cycles["detect_cycles"] --> strongconnect["strongconnect"]
  GoExtractor_extract["GoExtractor.extract"] --> walk_node["walk_node"]
  walk_node["walk_node"] --> node_text["node_text"]
  walk_node["walk_node"] --> start_line["start_line"]
  walk_node["walk_node"] --> end_line["end_line"]
```

### DOT (Graphviz)

```bash
codegraph export -f dot -T
```

```dot
digraph codegraph {
  rankdir=LR;
  node [shape=box, fontname="monospace", fontsize=10];
  edge [color="#666666"];

  subgraph cluster_0 {
    label="src (cohesion: 0.32)";
    style=dashed;
    "src/builder.js" [label="builder.js"];
    "src/cli.js" [label="cli.js"];
    "src/db.js" [label="db.js"];
    ...
  }

  "src/builder.js" -> "src/db.js";
  "src/builder.js" -> "src/parser.js";
  "src/cli.js" -> "src/builder.js";
  ...
}
```

---

## search — Semantic search (requires `embed` first)

```bash
codegraph embed .
codegraph search "parse source files into AST"
```

```
Results for "parse source files into AST" (top 5):

  1. f parseFilesAuto  src/parser.js:277     score: 0.82
  2. f parseFile       src/parser.js:195     score: 0.76
  3. f buildGraph      src/builder.js:335    score: 0.68
  4. f collectFiles    src/builder.js:45     score: 0.61
  5. f extractSymbols  src/parser.js:142     score: 0.55
```

---

## models — Available embedding models

```bash
codegraph models
```

```
Available embedding models:

  minilm        384d  256 ctx   Smallest, fastest (~23MB). General text. (default)
  jina-small    512d  8192 ctx  Small, good quality (~33MB). General text.
  jina-base     768d  8192 ctx  Good quality (~137MB). General text, 8192 token context.
  jina-code     768d  8192 ctx  Code-aware (~137MB). Trained on code+text, best for code search.
  nomic         768d  8192 ctx  Good local quality (~137MB). 8192 context.
  nomic-v1.5    768d  8192 ctx  Improved nomic (~137MB). Matryoshka dimensions, 8192 context.
  bge-large    1024d  512 ctx   Best general retrieval (~335MB). Top MTEB scores.
```

---

## info — Engine diagnostics

```bash
codegraph info
```

```
Codegraph Diagnostics
====================
  Version       : 2.3.0
  Node.js       : v22.18.0
  Platform      : win32-x64
  Native engine : unavailable
  Engine flag   : --engine auto
  Active engine : wasm
```

---

## roles — Node role classification

```bash
codegraph roles -T
```

```
Node roles (639 symbols):

  core: 168  utility: 285  entry: 29  dead: 137  leaf: 20

## core (168)
  f safePath           src/queries.js:14
  f isTestFile         src/queries.js:21
  f getClassHierarchy  src/queries.js:76
  f findMatchingNodes  src/queries.js:127
  f kindIcon           src/queries.js:175
  ...
```

Filter by role and file:

```bash
codegraph roles --role dead -T
```

```
Node roles (137 symbols):

  dead: 137

## dead (137)
  f main                 crates/codegraph-core/build.rs:3
  - TarjanState          crates/codegraph-core/src/cycles.rs:38
  - CSharpExtractor      crates/codegraph-core/src/extractors/csharp.rs:6
  o CSharpExtractor.extract  crates/codegraph-core/src/extractors/csharp.rs:9
  ...
```

```bash
codegraph roles --role entry -T
```

```
Node roles (29 symbols):

  entry: 29

## entry (29)
  f command:build        src/cli.js:89
  f command:query        src/cli.js:102
  f command:impact       src/cli.js:113
  f command:map          src/cli.js:125
  f command:stats        src/cli.js:139
  ...
```

```bash
codegraph roles --role core --file src/queries.js
```

```
Node roles (16 symbols):

  core: 16

## core (16)
  f safePath             src/queries.js:14
  f isTestFile           src/queries.js:21
  f getClassHierarchy    src/queries.js:76
  f resolveMethodViaHierarchy  src/queries.js:97
  f findMatchingNodes    src/queries.js:127
  f kindIcon             src/queries.js:175
  f moduleMapData        src/queries.js:310
  f diffImpactMermaid    src/queries.js:766
  ...
```

---

## co-change — Git co-change analysis

First, scan git history:

```bash
codegraph co-change --analyze
```

```
Co-change analysis complete: 173 pairs from 289 commits (since: 1 year ago)
```

Then query globally or per file:

```bash
codegraph co-change
```

```
Top co-change pairs:

  100%     3 commits  src/extractors/csharp.js  <->  src/extractors/go.js
  100%     3 commits  src/extractors/csharp.js  <->  src/extractors/java.js
  100%     3 commits  src/extractors/csharp.js  <->  src/extractors/php.js
  100%     3 commits  src/extractors/csharp.js  <->  src/extractors/ruby.js
  100%     3 commits  src/extractors/go.js      <->  src/extractors/java.js
  ...

  Analyzed: 2026-02-26 | Window: 1 year ago
```

```bash
codegraph co-change src/queries.js
```

```
Co-change partners for src/queries.js:

   43%    12 commits  src/mcp.js

  Analyzed: 2026-02-26 | Window: 1 year ago
```

```bash
codegraph co-change --min-jaccard 0.5 --min-support 5
```

```
Top co-change pairs:

  100%     5 commits  src/parser.js  <->  src/constants.js
   78%     7 commits  src/builder.js  <->  src/resolve.js

  Analyzed: 2026-02-26 | Window: 1 year ago
```

---

## complexity — Per-function complexity metrics

```bash
codegraph complexity -T --limit 5
```

```
# Function Complexity

  Function                                 File                            Cog  Cyc  Nest    MI
  ──────────────────────────────────────── ────────────────────────────── ──── ──── ───── ─────
  buildGraph                               src/builder.js                  495  185     9     - !
  extractJavaSymbols                       src/extractors/java.js          208   64    10  13.9 !
  extractSymbolsWalk                       src/extractors/javascript.js    197   72    11  11.1 !
  walkJavaNode                             src/extractors/java.js          161   59     9    16 !
  walkJavaScriptNode                       src/extractors/javascript.js    160   72    10  11.6 !

  339 functions analyzed | avg cognitive: 18.8 | avg cyclomatic: 10.5 | avg MI: 22 | 106 above threshold
```

Full Halstead health view:

```bash
codegraph complexity --health -T --limit 5
```

```
# Function Complexity

  Function                            File                         MI     Vol   Diff    Effort   Bugs   LOC  SLOC
  ─────────────────────────────────── ───────────────────────── ───── ─────── ────── ───────── ────── ───── ─────
  buildGraph                          src/builder.js                0       0      0         0      0     0     0
  extractJavaSymbols                  src/extractors/java.js     13.9!6673.96  70.52 470637.77 2.2247   225   212
  extractSymbolsWalk                  …tractors/javascript.js    11.1!7911.66  50.02 395780.68 2.6372   251   239
  walkJavaNode                        src/extractors/java.js       16!5939.15  65.25 387509.16 1.9797   198   188
  walkJavaScriptNode                  …tractors/javascript.js    11.6!7624.39  47.67 363429.06 2.5415   240   230

  339 functions analyzed | avg cognitive: 18.8 | avg cyclomatic: 10.5 | avg MI: 22 | 106 above threshold
```

Only functions exceeding warn thresholds:

```bash
codegraph complexity --above-threshold -T --limit 5
```

```
# Functions Above Threshold

  Function                                 File                            Cog  Cyc  Nest    MI
  ──────────────────────────────────────── ────────────────────────────── ──── ──── ───── ─────
  buildGraph                               src/builder.js                  495  185     9     - !
  extractJavaSymbols                       src/extractors/java.js          208   64    10  13.9 !
  extractSymbolsWalk                       src/extractors/javascript.js    197   72    11  11.1 !
  walkJavaNode                             src/extractors/java.js          161   59     9    16 !
  walkJavaScriptNode                       src/extractors/javascript.js    160   72    10  11.6 !

  339 functions analyzed | avg cognitive: 18.8 | avg cyclomatic: 10.5 | avg MI: 22 | 106 above threshold
```

Sort by worst maintainability index:

```bash
codegraph complexity --sort mi -T --limit 5
```

```
# Function Complexity

  Function                                 File                            Cog  Cyc  Nest    MI
  ──────────────────────────────────────── ────────────────────────────── ──── ──── ───── ─────
  median                                   scripts/benchmark.js              1    2     1     -
  round1                                   scripts/benchmark.js              0    1     0     -
  selectTargets                            scripts/benchmark.js              1    2     1     -
  benchmarkEngine                          scripts/benchmark.js              5    5     2     -
  benchQuery                               scripts/benchmark.js              1    2     1     -

  339 functions analyzed | avg cognitive: 18.8 | avg cyclomatic: 10.5 | avg MI: 22 | 106 above threshold
```

---

## communities — Community detection & drift analysis

```bash
codegraph communities -T
```

```
# File-Level Communities

  41 communities | 73 nodes | modularity: 0.4114 | drift: 39%

  Community 34 (16 members): src (16)
    - src/cochange.js
    - src/communities.js
    - src/cycles.js
    - src/embedder.js
    - src/logger.js
    - src/registry.js
    - src/structure.js
    - src/update-check.js
    ... and 8 more
  Community 35 (12 members): src/extractors (11), src (1)
    - src/extractors/csharp.js
    - src/extractors/go.js
    - src/extractors/helpers.js
    - src/extractors/javascript.js
    - src/extractors/php.js
    ... and 7 more
  Community 33 (6 members): src (6)
    - src/builder.js
    - src/constants.js
    - src/journal.js
    - src/native.js
    - src/resolve.js
    - src/watcher.js
```

Drift analysis only:

```bash
codegraph communities --drift -T
```

```
# File-Level Communities

  41 communities | 73 nodes | modularity: 0.4114 | drift: 39%

# Drift Analysis (score: 39%)

  Split candidates (directories spanning multiple communities):
    - scripts → 13 communities
    - crates/codegraph-core/src/extractors → 11 communities
    - crates/codegraph-core/src → 7 communities
    - src → 4 communities
    - tests/fixtures/sample-project → 3 communities
    - (root) → 2 communities
  Merge candidates (communities spanning multiple directories):
    - Community 35 (12 members) → 2 dirs: src/extractors, src
```

---

## check — Rule engine pass/fail (manifesto mode)

Running `check` with no ref or `--staged` runs manifesto rules on the whole codebase:

```bash
codegraph check -T
```

```
# Manifesto Rules

  Rule                      Status   Threshold         Violations
  ────────────────────────── ──────── ──────────────── ──────────
  cognitive_complexity       FAIL     warn>15 fail>30   84 functions
  cyclomatic_complexity      FAIL     warn>10 fail>20   42 functions
  nesting_depth              FAIL     warn>4 fail>6     28 functions
  maintainability_index      FAIL     warn<40 fail<20   52 functions
  halstead_bugs              WARN     warn>0.5 fail>1   18 functions

  Result: FAIL (exit code 1)
```

---

## audit — Composite risk report

Combines structural summary + fn-impact + complexity metrics into one structured report per function. Use `--quick` for structural summary only (skip impact and health metrics).

```bash
codegraph audit src/builder.js -T
```

```
# Audit: src/builder.js

## buildGraph (function) — src/builder.js:335
  Parameters: (rootDir, opts = {})
  Complexity: cognitive=495 cyclomatic=185 nesting=9 MI=0 ⚠
  Impact: 1 transitive callers
    ^ resolveNoTests  src/cli.js:59
  Calls: openDb, initSchema, loadConfig, collectFiles, getChangedFiles, ...

## collectFiles (function) — src/builder.js:45
  Complexity: cognitive=12 cyclomatic=8 nesting=3 MI=45
  Impact: 1 transitive callers
    ^ buildGraph  src/builder.js:335
  Calls: isTestFile, normalizePath

  ... (8 more functions)
```

Single function:

```bash
codegraph audit buildGraph -T
```

---

## triage — Risk-ranked audit queue

Merges connectivity, hotspots, node roles, and complexity into a prioritized audit queue. Use `--level file` or `--level directory` for file/directory-level hotspot analysis.

```bash
codegraph triage -T --limit 5
```

```
# Triage Queue (top 5)

  Rank  Function                   File                      Role     Cog  Cyc   MI  Fan-in  Fan-out  Score
  ───── ────────────────────────── ───────────────────────── ──────── ──── ──── ──── ─────── ──────── ──────
     1  buildGraph                 src/builder.js            core      495  185    0      1       22   98.5
     2  extractJavaSymbols         src/extractors/java.js    utility   208   64   14      1        3   87.2
     3  extractSymbolsWalk         src/extractors/js.js      utility   197   72   11      1        5   85.1
     4  walkJavaNode               src/extractors/java.js    utility   161   59   16      1        3   79.3
     5  startMCPServer             src/mcp.js                core       45   20   32      1       18   72.8
```

---

## batch — Multi-target batch querying

Accept a list of targets and return all results in one JSON payload — designed for multi-agent dispatch.

```bash
codegraph batch buildGraph openDb parseFile -T --json
```

```json
{
  "results": [
    { "target": "buildGraph", "context": { ... }, "impact": { ... } },
    { "target": "openDb", "context": { ... }, "impact": { ... } },
    { "target": "parseFile", "context": { ... }, "impact": { ... } }
  ],
  "total": 3,
  "errors": []
}
```

---

## check — CI validation predicates

Configurable pass/fail gates. Exit code 0 = pass, 1 = fail.

- `check` (no args) — runs manifesto rules on whole codebase (see above)
- `check --staged` / `check <ref>` — runs diff predicates against changes
- `check --staged --rules` — runs both diff predicates AND manifesto rules

```bash
codegraph check --staged --no-new-cycles --max-complexity 30
```

```
# Check Results

  ✓ no-new-cycles         — no new cycles introduced
  ✗ max-complexity (30)   — 3 functions exceed threshold:
      buildGraph (cognitive=495)  src/builder.js:335
      extractJavaSymbols (cognitive=208)  src/extractors/java.js
      extractSymbolsWalk (cognitive=197)  src/extractors/javascript.js

  Result: FAIL (exit code 1)
```

```bash
codegraph check --staged --max-blast-radius 50
```

```
# Check Results

  ✓ max-blast-radius (50) — max blast radius is 1

  Result: PASS (exit code 0)
```

```bash
codegraph check --no-boundary-violations -T
```

```
# Check Results

  ✓ no-boundary-violations — no architecture boundary violations

  Result: PASS (exit code 0)
```

---

## owners — CODEOWNERS integration

```bash
codegraph owners src/queries.js -T
```

```
# Ownership: src/queries.js

  Owner: @backend-team
  Functions: 44

  f safePath           src/queries.js:14     @backend-team
  f isTestFile         src/queries.js:21     @backend-team
  f findMatchingNodes  src/queries.js:127    @backend-team
  ...
```

Ownership boundaries:

```bash
codegraph owners --boundary -T
```

```
# Ownership Boundaries

  @backend-team → @frontend-team: 3 cross-boundary edges
    src/queries.js:findMatchingNodes → src/cli.js:resolveNoTests
    ...

  @backend-team → @infra-team: 1 cross-boundary edges
    src/db.js:openDb → src/builder.js:buildGraph
```

---

## snapshot — Graph DB backup and restore

```bash
codegraph snapshot save before-refactor
```

```
Snapshot saved: before-refactor (2.1 MB)
  Path: .codegraph/snapshots/before-refactor.db
```

```bash
codegraph snapshot list
```

```
Snapshots:
  before-refactor  2.1 MB  2026-03-02 10:30:00
  baseline         2.0 MB  2026-03-01 14:15:00
```

```bash
codegraph snapshot restore before-refactor
```

```
Snapshot restored: before-refactor → .codegraph/graph.db
```

---

## branch-compare — Structural diff between refs

```bash
codegraph branch-compare main HEAD -T
```

```
# Branch Comparison: main → HEAD

  Added (3 symbols):
    + f checkBoundaries     src/boundaries.js:45
    + f validateBoundaryConfig  src/boundaries.js:120
    + f onionPreset         src/boundaries.js:180

  Changed (2 symbols):
    ~ f manifestoData       src/manifesto.js:88  (signature changed)
    ~ f startMCPServer      src/mcp.js:650       (body changed)

  Removed (0 symbols)

  Impact: 4 transitive callers affected
    ^ resolveNoTests  src/cli.js:59
    ^ manifestoTool   src/mcp.js:472
    ...
```

```bash
codegraph branch-compare main HEAD --format mermaid -T
```

---

## registry — Multi-repo management

```bash
codegraph registry list
```

```
Registered repositories:

  my-app
    Path: /home/user/projects/my-app
    DB:   /home/user/projects/my-app/.codegraph/graph.db

  shared-lib
    Path: /home/user/projects/shared-lib
    DB:   /home/user/projects/shared-lib/.codegraph/graph.db
```

```bash
codegraph registry add ~/projects/another-repo
codegraph registry remove old-repo
codegraph registry prune --ttl 30
```
