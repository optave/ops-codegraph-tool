# Token Savings Benchmark

Quantifies how much codegraph reduces token usage when AI agents navigate large codebases, compared to raw file exploration (Glob/Grep/Read/Bash).

## Prerequisites

1. **Claude Agent SDK**
   ```bash
   npm install @anthropic-ai/claude-agent-sdk
   ```

2. **API key**
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

3. **Git** (for cloning Next.js)

4. **codegraph** installed in this repo (`npm install`)

## Quick Start

```bash
# Smoke test — 1 issue, 1 run (~$2-4)
node scripts/token-benchmark.js --issues csrf-case-insensitive --runs 1 > result.json

# View the JSON
cat result.json | jq .aggregate

# Generate the markdown report
node scripts/update-token-report.js result.json
cat docs/benchmarks/TOKEN-SAVINGS.md
```

## Full Run

```bash
# All 5 issues × 3 runs (~$10-20)
node scripts/token-benchmark.js > result.json
node scripts/update-token-report.js result.json
```

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--runs <N>` | `3` | Number of runs per issue (medians used) |
| `--model <model>` | `sonnet` | Claude model to use |
| `--issues <id,...>` | all | Comma-separated subset of issue IDs |
| `--nextjs-dir <path>` | `$TMPDIR/...` | Reuse existing Next.js clone |
| `--skip-graph` | `false` | Skip codegraph rebuild (use existing DB) |
| `--max-turns <N>` | `50` | Max agent turns per session |
| `--max-budget <$>` | `2.00` | Max USD per session |
| `--perf` | `false` | Also run build/query perf benchmarks on the Next.js graph |

## Available Issues

| ID | Difficulty | PR | Description |
|----|:----------:|---:|-------------|
| `csrf-case-insensitive` | Easy | #89127 | Case-insensitive CSRF origin matching |
| `ready-in-time` | Medium | #88589 | Incorrect "Ready in" time display |
| `aggregate-error-inspect` | Medium | #88999 | AggregateError.errors missing in output |
| `otel-propagation` | Hard | #90181 | OTEL trace context propagation broken |
| `static-rsc-payloads` | Hard | #89202 | Static RSC payloads not emitted/served |

## Methodology

### Setup
- **Target repo:** [vercel/next.js](https://github.com/vercel/next.js) (~4,000 TypeScript files)
- Each issue is a real closed PR with a known set of affected source files

### Two conditions (identical except codegraph access)

**Baseline:** Agent has `Glob`, `Grep`, `Read`, `Bash` tools. No codegraph.

**Codegraph:** Agent has the same tools **plus** a codegraph MCP server providing structural navigation (symbol search, dependency tracking, impact analysis, call chains).

### Controls
- Same model for both conditions
- Same issue prompt (bug description only — no hints about the solution)
- Checkout pinned to the commit *before* the fix (agent can't see the answer in git history)
- Same `maxTurns` and `maxBudgetUsd` budget caps

### Metrics
- **Input tokens:** Total tokens sent to the model (primary metric)
- **Cost:** USD cost of the session
- **Turns:** Number of agent turns (tool-use round-trips)
- **Hit rate:** Percentage of ground-truth files correctly identified
- **Tool calls:** Breakdown by tool type

### Statistical handling
- N runs per issue (default 3), median used to handle non-determinism
- Error runs are excluded from aggregation

## Cost Estimate

| Scenario | Approximate cost |
|----------|----------------:|
| 1 issue × 1 run | $2-4 |
| 1 issue × 3 runs | $6-12 |
| 5 issues × 3 runs | $30-60 |

Costs depend on model choice and issue difficulty. The `--max-budget` flag caps individual sessions.

## Adding New Issues

Edit `scripts/token-benchmark-issues.js` and add an entry to the `ISSUES` array:

```js
{
  id: 'short-slug',
  difficulty: 'easy|medium|hard',
  pr: 12345,
  title: 'PR title',
  description: 'Bug description for the agent (no solution hints)',
  commitBefore: 'abc123def...',  // SHA before the fix
  expectedFiles: ['packages/next/src/path/to/file.ts'],
}
```

Requirements:
- Use a real closed PR with a clear bug description
- `commitBefore` must be the parent of the merge commit (not the merge itself)
- `expectedFiles` should list only source files, not tests
- Verify the SHA exists: `git log --oneline <sha> -1` in the Next.js repo

## Output Format

The runner outputs JSON to stdout. See [TOKEN-SAVINGS.md](TOKEN-SAVINGS.md) for the generated report.
