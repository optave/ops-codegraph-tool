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

Delete the grind baseline snapshot (if it exists):

```bash
codegraph snapshot delete titan-grind-baseline 2>/dev/null
```

Also delete any batch snapshots dynamically:

```bash
for name in $(codegraph snapshot list --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{JSON.parse(d).filter(s=>s.name.startsWith('titan-batch-')).forEach(s=>console.log(s.name))}catch(e){}})"); do
  codegraph snapshot delete "$name" 2>/dev/null
done
```

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
- `issues.ndjson` — cross-phase issue tracker
- `close-summary.json` — close phase summary
- `drift-report.json` — staleness detection across phases
- `grind-targets.ndjson` — grind phase adoption targets and outcomes
- `arch-snapshot.json` — pre-forge architectural snapshot

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
  - Grind snapshot: deleted
  - Batch snapshots: deleted
  - Artifacts: removed (.codegraph/titan/)
  - Graph: rebuilt (clean state)

To start a fresh Titan pipeline, run /titan-recon
```
