# Codegraph Dogfooding Guide

Codegraph analyzing its own codebase. This guide documents findings from self-analysis and lists improvements — both automated fixes already applied and items requiring human judgment.

## Running the Self-Analysis

```bash
# Build the graph (from repo root)
node src/cli.js build .

# Core analysis commands
node src/cli.js cycles                    # Circular dependency check
node src/cli.js cycles --functions        # Function-level cycles
node src/cli.js map --limit 20 --json     # Module coupling overview
node src/cli.js diff-impact main --json   # Impact of current branch
node src/cli.js deps src/<file>.js        # File dependency inspection
node src/cli.js fn <name>                 # Function call chain trace
node src/cli.js fn-impact <name>          # What breaks if function changes
```

## Action Items

These findings require human judgment to address properly:

### HIGH PRIORITY

#### 1. parser.js is a 2200+ line monolith (47 function definitions)
**Found by:** `codegraph deps src/parser.js` and `codegraph map`

`parser.js` has the highest fan-in (14 files import it) and contains extractors for **all 11 languages** in a single file. Each language extractor (Python, Go, Rust, Java, C#, PHP, Ruby, HCL) has its own `walk()` function, creating duplicate names that confuse function-level analysis.

**Recommendation:** Split per-language extractors into separate files under `src/extractors/`:
```
src/extractors/
  javascript.js    # JS/TS/TSX extractor (currently inline)
  python.js        # extractPythonSymbols + findPythonParentClass + walk
  go.js            # extractGoSymbols + walk
  rust.js          # extractRustSymbols + extractRustUsePath + walk
  java.js          # extractJavaSymbols + findJavaParentClass + walk
  csharp.js        # extractCSharpSymbols + extractCSharpBaseTypes + walk
  ruby.js          # extractRubySymbols + findRubyParentClass + walk
  php.js           # extractPHPSymbols + findPHPParentClass + walk
  hcl.js           # extractHCLSymbols + walk
```
**Impact:** Would improve codegraph's own function-level analysis (no more ambiguous `walk` matches), make each extractor independently testable, and reduce the cognitive load of the file.

**Trade-off:** The Rust native engine already has this structure (`crates/codegraph-core/src/extractors/`). Aligning the WASM extractors would create parity.


### MEDIUM PRIORITY

#### 3. builder.js has the highest fan-out (7 dependencies)
**Found by:** `codegraph map`

`builder.js` imports from 7 modules: config, constants, db, logger, parser, resolve, and structure. As the build orchestrator this is somewhat expected, but it also means any change to builder.js has wide blast radius.

**Recommendation:** Consider whether the `structure.js` integration (already lazy-loaded via dynamic import) pattern could apply to other optional post-build steps.

#### 4. watcher.js fan-out vs fan-in imbalance (5 out, 2 in)
**Found by:** `codegraph map`

The watcher depends on 5 modules but only 2 modules reference it. This suggests it might be pulling in more than it needs.

**Recommendation:** Review whether watcher.js can use more targeted imports or lazy-load some dependencies.

#### 5. diff-impact runs git in temp directories (test fragility)
**Found by:** Integration test output showing `git diff --no-index` errors in temp directories

The `diff-impact` command runs `git diff` which fails in non-git temp directories used by tests. The error output is noisy but doesn't fail the test.

**Recommendation:** Guard the git call or skip gracefully when not in a git repo.

### LOW PRIORITY

#### 6. Consider adding a `codegraph stats` command
There's no single command that shows a quick overview of graph health: node/edge counts, cycle count, top coupling hotspots, fan-out outliers. Currently you need to run `map`, `cycles`, and read the build output separately.

#### 7. Embed and search the codebase itself
Running `codegraph embed .` and then `codegraph search "build dependency graph"` on the codegraph repo would exercise the embedding pipeline and could surface naming/discoverability issues in the API.

## Known Environment Issue

On this workstation, changes to files not already tracked as modified on the current git branch (`docs/architecture-audit`) get reverted by an external process (likely a VS Code extension). If you're applying the parser.js cycle fix, do it from a fresh branch or commit immediately.

## Periodic Self-Check Routine

Run this after significant changes:

```bash
# 1. Rebuild the graph
node src/cli.js build .

# 2. Check for regressions
node src/cli.js cycles            # Should be 0 file-level cycles
node src/cli.js map --limit 10    # Verify no new coupling hotspots

# 3. Check impact of your changes
node src/cli.js diff-impact main

# 4. Run tests
npm test
```
