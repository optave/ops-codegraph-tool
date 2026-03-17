---
name: titan-reset
description: Clean up all Titan Paradigm artifacts and snapshots, restoring the codebase to pre-Titan state
argument-hint: <--keep-graph to preserve the codegraph database>
allowed-tools: Bash, Read, Write, Grep
---

# Titan RESET — Pipeline Cleanup

You are resetting the Titan Paradigm pipeline, removing all artifacts and restoring the codebase to its pre-Titan state.

---

## Step 1 — Restore baseline snapshot (if available)

```bash
codegraph snapshot restore titan-baseline 2>/dev/null && echo "Baseline restored" || echo "No baseline snapshot found"
```

This restores the graph database to its pre-GAUNTLET state.

---

## Step 2 — Delete all Titan snapshots

```bash
codegraph snapshot delete titan-baseline 2>/dev/null
```

Also delete any batch snapshots:

```bash
codegraph snapshot delete titan-batch-1 2>/dev/null
codegraph snapshot delete titan-batch-2 2>/dev/null
codegraph snapshot delete titan-batch-3 2>/dev/null
codegraph snapshot delete titan-batch-4 2>/dev/null
codegraph snapshot delete titan-batch-5 2>/dev/null
codegraph snapshot delete titan-batch-6 2>/dev/null
codegraph snapshot delete titan-batch-7 2>/dev/null
codegraph snapshot delete titan-batch-8 2>/dev/null
codegraph snapshot delete titan-batch-9 2>/dev/null
codegraph snapshot delete titan-batch-10 2>/dev/null
```

(Errors are expected for snapshots that don't exist — ignore them.)

---

## Step 3 — Remove all Titan artifacts

```bash
rm -rf .codegraph/titan/
```

This removes:
- `titan-state.json` — session state
- `GLOBAL_ARCH.md` — architecture document
- `gauntlet.ndjson` — audit results
- `gauntlet-summary.json` — aggregated results
- `sync.json` — execution plan
- `gate-log.ndjson` — gate audit trail

---

## Step 4 — Rebuild graph (unless --keep-graph)

If `$ARGUMENTS` does NOT contain `--keep-graph`:

```bash
codegraph build
```

This ensures the graph reflects the current state of the codebase without any Titan-era corruption.

If `$ARGUMENTS` contains `--keep-graph`, skip this step.

---

## Step 5 — Report

```
Titan pipeline reset complete.
  - Baseline snapshot: restored and deleted
  - Batch snapshots: deleted
  - Artifacts: removed (.codegraph/titan/)
  - Graph: rebuilt (clean state)

To start a fresh Titan pipeline, run /titan-recon
```
