---
name: architect
description: Run a comprehensive architectural audit of codegraph against state-of-the-art tools and produce a structured report
allowed-tools: Bash, Read, Write, Glob, Grep
---

# /architect — Full Architectural Audit

Run a cold, harsh architectural audit of codegraph. Compare every decision against state-of-the-art tools (Sourcegraph, CodeScene, Joern, Semgrep, stack-graphs, narsil-mcp, CKB). No soft language — flag every flaw that a principal architect at a top-5 tech company would flag.

## Output

**Filename:** `ARCHITECTURE_AUDIT_v{VERSION}_{DATE}.md`
- `{VERSION}` = current `package.json` version (e.g., `3.1.4`)
- `{DATE}` = today's date in `YYYY-MM-DD` format (e.g., `2026-03-16`)

**Saved to two locations:**
1. `docs/architecture/ARCHITECTURE_AUDIT_v{VERSION}_{DATE}.md` — canonical, committed to git
2. `generated/architecture/ARCHITECTURE_AUDIT_v{VERSION}_{DATE}.md` — working copy

**Header format:**
```markdown
# Codegraph Architectural Audit

**Date:** {DATE}
**Version audited:** v{VERSION} (`@optave/codegraph@{VERSION}`)
**Commit:** {SHORT_SHA} ({branch name})
**Auditor perspective:** Principal architect, cold evaluation
**Methodology:** Codegraph self-analysis + manual source review + verified competitor research
**Previous audit:** {link to previous audit if exists, or "First audit"}
```

Before writing, check `docs/architecture/` for previous audits. Reference changes since the last audit where relevant.

## Steps

### Phase 0 — Worktree Isolation
Run `/worktree` to get an isolated copy of the repo. `CLAUDE.md` mandates this for every session that modifies files. This skill writes audit reports and rebuilds the graph — both mutations require isolation.

### Phase 1 — Setup
1. Read `package.json` to get the current version
2. Get the current date, commit SHA, and branch name
3. Check `docs/architecture/` for previous audit files
4. **Read all ADRs in `docs/architecture/decisions/`.** These are the project's settled architectural decisions. Read every file — they document rationale, trade-offs, alternatives considered, and trajectory. The audit must evaluate the codebase *against* these decisions: are they being followed? Are the stated trade-offs still accurate? Has anything changed that invalidates the rationale?
5. Run `codegraph build --no-incremental` to ensure fresh metrics

### Phase 2 — Structural Census
1. Run `codegraph stats` to get graph health baseline
2. Run `codegraph structure --depth 3` to get directory cohesion
3. Run `codegraph triage -T` to get the risk priority queue
4. Run `codegraph roles --role dead -T` to find dead code — **then break down by kind** (function/method vs parameter/property/constant) to avoid inflating the dead count with leaf nodes
5. Run `codegraph cycles` to check for circular dependencies
6. Run `codegraph map` to see the module overview
7. Run `codegraph complexity -T --limit 25` to find the most complex functions
8. Count files, LOC, and test-to-source ratio

### Phase 3 — Layer-by-Layer Critique
For each architectural layer, evaluate against these dimensions:

**A. Abstraction Quality**
- Is the abstraction boundary clean or leaky?
- Are there god objects / god files (>500 LOC)?
- Is there needless indirection (wrappers that add no value)?

**B. Coupling & Cohesion**
- Fan-in / fan-out analysis per module
- Are features truly independent or secretly coupled?
- Is shared state minimized?

**C. State-of-the-Art Comparison**
- How does this layer compare to the equivalent in Sourcegraph, CodeScene, Joern, Semgrep, narsil-mcp, CKB?
- What would a $500M code intelligence company do differently?
- What academic research (ICSE, FSE, ASE) contradicts the design choices?

**D. Scalability & Performance**
- Will this hold up at 1M LOC? 10M LOC? Monorepo scale?
- What are the algorithmic bottlenecks?
- Is the database schema suitable for scale?

**E. Correctness & Soundness**
- Is the analysis sound or best-effort? (Be explicit)
- What false positives / negatives does the approach inherently produce?
- Where does the tool present incomplete data as complete?

**F. ADR Compliance**
- Does the implementation match the decisions documented in `docs/architecture/decisions/`?
- Are the trade-offs described in ADRs still accurate given the current code?
- Has the codebase drifted from any stated trajectory? If so, is that drift justified or accidental?
- Are there architectural decisions that *should* have an ADR but don't?

### Phase 4 — Cross-Cutting Concerns

Evaluate these across the entire codebase:

1. **Type Safety** — JS without TypeScript in 2026. Cost-benefit.
2. **Error Handling** — Is it consistent? Are errors recoverable? Domain errors vs crashes.
3. **Testing Strategy** — Are the right things tested? Integration-heavy vs unit-heavy tradeoffs.
4. **Dual Engine Maintenance** — JS + Rust doing the same thing. Is this sustainable?
5. **Dependency Hygiene** — Are deps minimal? Are there vendoring risks?
6. **Security Surface** — execFileSync, MCP server exposure, SQLite injection vectors.
7. **API Design** — Is the programmatic API well-designed for embedding?
8. **Documentation** — Is it accurate? Does it lie by omission?

### Phase 5 — Competitive Verification

**Do not trust README claims.** For each top competitor:
1. Fetch the actual GitHub repo README
2. Cross-check feature claims against source code where possible
3. Note: MCP-only vs CLI? Open source vs commercial? External deps required? Deterministic vs LLM-mediated?

Include a verified competitor comparison table with columns: MCP tools, CLI, Open source, Zero-dep, Deterministic, Incremental (all langs).

### Phase 6 — Strategic Verdict

1. **Does codegraph have a reason to exist?** — Answer with verified data, not assumptions
2. **Fundamental Design Flaws** — Decisions that cannot be fixed incrementally
3. **Missed Opportunities** — What the tool should have been but isn't
4. **Competitive Moat Assessment** — What actually differentiates this? Is it defensible?
5. **Kill List** — Features/code that should be deleted, not improved
6. **Build vs Buy** — Components that should use existing libraries instead of custom code
7. **Roadmap Critique** — Is the planned roadmap the right path? What's missing? What's wrong?

### Phase 7 — Write & Save

1. Write the full audit to `docs/architecture/ARCHITECTURE_AUDIT_v{VERSION}_{DATE}.md`
2. Copy to `generated/architecture/ARCHITECTURE_AUDIT_v{VERSION}_{DATE}.md`
3. If a previous audit exists, add a "Changes Since Last Audit" section at the end comparing key metrics (graph quality score, complexity stats, dead code counts, competitive position)

### Phase 8 — Commit & PR
1. Create a new branch: `git checkout -b docs/architect-audit-v{VERSION}-{DATE} main`
2. Stage the audit file: `git add docs/architecture/ARCHITECTURE_AUDIT_v{VERSION}_{DATE}.md`
3. Commit: `git commit -m "docs: add architectural audit v{VERSION} ({DATE})"`
4. Push: `git push -u origin docs/architect-audit-v{VERSION}-{DATE}`
5. Open a PR:
   ```bash
   gh pr create --title "docs: architectural audit v{VERSION} ({DATE})" --body "$(cat <<'EOF'
   ## Summary
   - Full architectural audit of codegraph v{VERSION}
   - Competitive verification against Sourcegraph, CodeScene, Joern, Semgrep, etc.
   - Strategic verdict with prioritized recommendations

   ## Test plan
   - [ ] Verify audit file renders correctly in GitHub markdown
   - [ ] Confirm all codegraph command outputs are current
   - [ ] Cross-check competitor claims against linked sources
   EOF
   )"
   ```

## Audit Structure

The deliverable must contain:
- "Does Codegraph Have a Reason to Exist?" section (verified competitor data)
- Executive summary (1 paragraph, brutally honest)
- Scorecard (each dimension rated 1-10 with justification)
- **ADR compliance review** — for each ADR in `docs/architecture/decisions/`, assess whether the codebase follows the decision, whether the stated trade-offs are still valid, and whether any drift has occurred. Flag missing ADRs for decisions that exist in code but aren't documented
- Detailed findings per layer
- Verified competitor comparison table
- Strategic recommendations (prioritized)
- Comparison matrix vs state-of-the-art
- Final verdict: would you invest in this project? Why or why not?

## Rules
- **No softening.** If something is bad, say it's bad and say why.
- **Cite specifics.** File names, line counts, function names — not vague handwaving.
- **Compare to real tools.** Not hypotheticals — actual production systems.
- **Verify competitor claims.** Fetch READMEs, check source. Do not trust competitive analysis at face value.
- **Quantify everything.** LOC, fan-in, complexity scores, not "high" or "low".
- **Break down "dead" stats.** Separate leaf nodes (parameters, properties, constants) from genuinely unreferenced callables. Further categorize callable dead code by cause (Rust FFI, framework entry, dynamic dispatch, genuine dead).
- **Assume the audience is a principal engineer** who has seen 100+ codebases.
