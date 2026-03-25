---
name: create-skill
description: Scaffold, write, and validate a new Claude Code skill — enforces quality standards derived from 200+ review comments
argument-hint: "<skill-name>  (kebab-case, e.g. deploy-check)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# /create-skill — Skill Factory

Create a new Claude Code skill with correct structure, robust bash, and built-in quality gates. This skill encodes lessons from 200+ Greptile review comments to prevent the most common skill authoring mistakes.

## Arguments

- `$ARGUMENTS` must contain the skill name in kebab-case (e.g. `deploy-check`)
- If `$ARGUMENTS` is empty, ask the user for a skill name before proceeding

Set `SKILL_NAME` to the provided name. Validate it is kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`). Reject otherwise.

---

## Phase 0 — Discovery & Pre-flight

**Pre-flight:** Verify required tools and environment:

```bash
for tool in git mktemp; do
  command -v "$tool" > /dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found"; exit 1; }
  # > /dev/null 2>&1: suppress command path on success and shell's "not found" on failure — the || clause provides the error message
done
git rev-parse --show-toplevel > /dev/null 2>&1 || { echo "ERROR: not in a git repository — run /create-skill from the repo root"; exit 1; }
# > /dev/null 2>&1: suppress git's own "fatal: not a git repository" — our || message is more actionable
```

Parse `$ARGUMENTS` per the Arguments section above. If validation fails, abort with a clear error.

**Discovery:** Before writing anything, gather requirements interactively. Ask the user these questions (all at once, not one-by-one):

1. **Purpose** — What does this skill do? (one paragraph)
2. **Arguments** — What CLI arguments should it accept? (e.g. `--fix`, `--dry-run`, `<path>`)
3. **Phases** — What are the major steps? (bullet list of 3-8 phases)
4. **Tools needed** — Which tools does it need? (Bash, Read, Write, Edit, Glob, Grep, Agent)
5. **Artifacts** — Does it produce output files? If so, where and what format?
6. **Dangerous operations** — Does it modify code, push to git, call external APIs, or delete files?
7. **Resume/skip support** — Should it support `--start-from` or `--skip-*` flags for long-running pipelines?

**Wait for the user's answers before proceeding.** Do not guess or assume.

**Exit condition:** Pre-flight passed (git repo confirmed, skill name validated). All 7 questions have answers. Purpose, arguments, phases, tools, artifacts, dangerous ops, and resume support are defined.

---

## Phase 1 — Scaffold

**Idempotency guard:** Before writing, check for an existing skill:

```bash
if [ -f ".claude/skills/$SKILL_NAME/SKILL.md" ]; then
  echo "WARN: .claude/skills/$SKILL_NAME/SKILL.md already exists."
  echo "Proceeding will overwrite it. Confirm (y) or abort (n)."
  # STOP — ask the user whether to overwrite before continuing. Exit 1 if they decline.
fi
```

Create the skill directory and SKILL.md with frontmatter:

```bash
mkdir -p .claude/skills/$SKILL_NAME
```

Write the SKILL.md file starting with this structure:

```markdown
---
name: $SKILL_NAME
description: <one-line from user's purpose>
argument-hint: "<from user's argument design>"
allowed-tools: <from user's tool list>
---

# /$SKILL_NAME — <Title>

<Purpose paragraph from Phase 0>

## Arguments

- `$ARGUMENTS` parsing rules here
- Set state variables: `DRY_RUN`, `AUTO_FIX`, etc.

## Phase 0 — Pre-flight

1. Confirm environment (repo root, required runtime/toolchain version, required tools)
2. Parse `$ARGUMENTS` into state variables
3. Validate preconditions

**Exit condition:** <What must be true before Phase 1 starts, e.g. "git repo confirmed, arguments validated, all required tools present">

## Phase N — <Name>

<Steps>

**Exit condition:** <What must be true before the next phase starts>

## Rules

- <Hard constraints>
```

### Structural requirements to include in every skill:

1. **Phase 0 always exists** — pre-flight checks, argument parsing, environment validation
2. **Every phase has a clear exit condition** — what must be true before moving to the next phase
3. **Arguments section** — explicit parsing of `$ARGUMENTS` into named state variables
4. **Rules section** — hard constraints at the bottom, kept in sync with the procedure
5. **Artifact definitions** — if the skill produces files, specify path, format, and schema

**Exit condition:** `.claude/skills/$SKILL_NAME/SKILL.md` exists with valid frontmatter, Phase 0, Arguments section, and Rules section.

---

## Phase 2 — Write the Skill Body

Write each phase following these **mandatory patterns** (derived from Greptile review findings across 200+ comments):

### Pattern 1: No shell variables across code fences

Each fenced code block is a **separate shell invocation**. Variables set in one block do not exist in the next.

**Wrong:**
````markdown
```bash
TMPDIR=$(mktemp -d)
```
Later:
```bash
rm -rf $TMPDIR   # BUG: $TMPDIR is empty here
```
````

**Correct:** Persist state to a file (use your actual skill name, not a variable).
First ensure the directory exists:
````markdown
```bash
mkdir -p .codegraph/deploy-check
mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX" > .codegraph/deploy-check/.tmpdir
```
Later:
```bash
rm -rf "$(cat .codegraph/deploy-check/.tmpdir)"
```
````

Or keep everything in a single code block if the operations are sequential.

### Pattern 2: No silent failures

Never use `2>/dev/null` without documenting the skip path. Every command that can fail must either:
- Have explicit error handling (`|| { echo "ERROR: ..."; exit 1; }`)
- Be documented as intentionally tolerant ("this may fail on X, which is acceptable because Y")

**Wrong:**
````markdown
```bash
git show HEAD:$FILE 2>/dev/null | codegraph where --file -
```
````

**Correct:**
````markdown
```bash
PREV_FILE=$(mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX.js")  # adjust extension to match the language of $FILE; template syntax is portable (macOS + Linux)
# $FILE is expected to be set by the surrounding loop, e.g. for FILE in $(git diff --name-only HEAD); do ... done
if git show HEAD:$FILE > "$PREV_FILE" 2>&1; then
  codegraph where --file "$PREV_FILE"
else
  echo "WARN: $FILE is new (not in HEAD) — skipping before/after comparison"
fi
rm -f "$PREV_FILE"
```
````

### Pattern 3: Temp files need extensions

Codegraph's language detection is extension-based. Temp files passed to codegraph must have the correct extension:

```bash
mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX.js"    # NOT just mktemp — template syntax is cross-platform (macOS + Linux)
```

### Pattern 4: No hardcoded temp paths

Use `mktemp` for temp files, never hardcoded paths like `/tmp/skill-output.json`. Concurrent sessions or re-runs will collide.

### Pattern 5: Stable cross-references

When referencing other steps, use **phase names**, not numbers. Numbers break when steps are inserted.

**Wrong:** "Use the results from Step 2"
**Correct:** "Use the diff-impact results from Phase: Impact Analysis"

### Pattern 6: No undefined placeholders

Every variable or placeholder in pseudocode must have a preceding assignment. If a value requires detection, write the explicit detection script — do not use `<detected-value>` placeholders.

**Wrong:** "Run `<detected-test-command>`"
**Correct:**
````markdown
Detect the test runner and run in a single block:
```bash
if [ -f "pnpm-lock.yaml" ]; then TEST_CMD="pnpm test"
elif [ -f "yarn.lock" ]; then TEST_CMD="yarn test"
elif [ -f "package.json" ]; then TEST_CMD="npm test"
else echo "WARN: No recognised test runner found — skipping tests"; TEST_CMD="true"; fi
$TEST_CMD
```
````

### Pattern 7: No internal contradictions

Each decision (pass/fail, rollback/continue, skip/run) must be defined in **exactly one place**. If two sections describe the same decision path, consolidate them and reference the single source.

### Pattern 8: Rules ↔ Procedure sync

Every codegraph command or tool invocation in the procedure must be permitted by the Rules section. Every exception in the Rules must correspond to an actual procedure step. After writing, cross-check both directions.

### Pattern 9: No command redundancy

If a phase runs a codegraph command and stores the result, later phases must reference that result — not re-run the command. Add a note like: "Using `impact_report` from Phase: Impact Analysis".

### Pattern 10: Skip/resume flag validation

If the skill supports `--start-from` or `--skip-*`:
- Skipping a phase must NOT skip its artifact validation
- Add a pre-validation table listing which artifacts are required for each entry point
- Each skip path must be explicitly tested in Phase: Self-Review

### Pattern 11: Progress indicators

For any phase that takes longer than ~10 seconds (file iteration, API calls, batch operations), emit progress:

```bash
# $i, $total, and $FILE are loop variables, e.g. i=0; total=$(wc -l < filelist); while read FILE; do i=$((i+1)); ...
echo "Processing file $i/$total: $FILE"
```

Never leave the user staring at a silent terminal during long operations.

### Pattern 12: Artifact reuse

Before running expensive operations (codegraph build, embedding generation, batch analysis), check if usable output already exists (replace `deploy-check` with your actual skill name):

````markdown
```bash
if [ -f ".codegraph/deploy-check/results.json" ]; then
  echo "Using cached results from previous run"
else
  # run expensive operation
fi
```
````

This supports both idempotent re-runs and resume-after-failure.

### Pattern 13: Platform portability

Avoid shell constructs that behave differently across platforms:
- Use `find ... -name "*.ext"` instead of glob expansion (`ls *.ext`) which differs between bash versions
- Use `mktemp` with template syntax (`mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX.ext"`) — GNU flags like `--suffix` and `-p` are not available on macOS BSD `mktemp`
- Use `sed -i.bak` instead of `sed -i ''` (GNU vs BSD incompatibility)
- Document any platform-specific behavior with a comment: `# NOTE: requires GNU coreutils`

**Exit condition:** Every phase body in the SKILL.md follows all 13 patterns. No wrong/correct examples remain as actual instructions — only the correct versions.

---

## Phase 3 — Dangerous Operation Guards

If the skill performs dangerous operations (from Phase 0 discovery), add explicit guards:

### For git modifications:
- Stage only named files (never `git add .` or `git add -A`)
- Include rollback instructions: "To undo: `git reset HEAD~1`" or similar
- For destructive operations (force-push, reset, clean): require explicit confirmation

### For file deletions:
- List what will be deleted before deleting
- Use `rm -i` or prompt for confirmation in non-`--force` mode

### For external API calls:
- Handle network failures gracefully (don't crash the pipeline)
- Add timeout limits

### For code modifications:
- Run tests after changes: detect test runner per Phase: Write the Skill Body, Pattern 6
- Run lint after changes: detect lint runner:
  ```bash
  if [ -f "biome.json" ]; then LINT_CMD="npx biome check"
  elif find . -maxdepth 1 -name "eslint.config.*" | grep -q .; then LINT_CMD="npx eslint ."
  elif [ -f "package.json" ]; then LINT_CMD="npm run lint"
  else echo "WARN: No recognised lint runner found — skipping lint"; LINT_CMD="true"; fi
  $LINT_CMD
  ```

**Exit condition:** Every dangerous operation identified in Phase: Discovery has a corresponding guard in the SKILL.md.

---

## Phase 4 — Self-Review Checklist

Before finalizing, audit the SKILL.md against every item below. **Do not skip any item.** Fix violations before proceeding.

### Structure checks:
- [ ] Frontmatter has all four fields: `name`, `description`, `argument-hint`, `allowed-tools`
- [ ] `name` matches the directory name
- [ ] Phase 0 exists and validates the environment
- [ ] Arguments section explicitly parses `$ARGUMENTS` into named variables
- [ ] Rules section exists at the bottom
- [ ] Every phase has a clear name (not just a number)

### Anti-pattern checks (all 13 patterns):
- [ ] **Shell variables**: No variable is set in one code fence and used in another. State that must persist is written to a file
- [ ] **Silent failures**: No `2>/dev/null` without a documented skip rationale. No commands that swallow errors
- [ ] **Temp file extensions**: Every temp file passed to codegraph has the correct language extension
- [ ] **Temp file uniqueness**: Every temp path uses `mktemp`, never hardcoded paths
- [ ] **Cross-references**: All step references use phase names, not bare numbers
- [ ] **Placeholders**: Every `<placeholder>` has a preceding detection/assignment script
- [ ] **Contradictions**: No two sections describe contradictory behavior for the same condition
- [ ] **Rules sync**: Every command/tool in the procedure is covered by Rules. Every Rules exception maps to a real step
- [ ] **Redundancy**: No codegraph command is run twice with the same arguments. Later phases reference earlier results
- [ ] **Skip validation**: If `--start-from`/`--skip-*` is supported, every skip path validates required artifacts
- [ ] **Progress indicators**: Phases that iterate over files or run batch operations emit progress (`Processing $i/$total`)
- [ ] **Artifact reuse**: Expensive operations (codegraph build, embedding generation, batch analysis) check for existing output before re-running
- [ ] **Platform portability**: No `sed -i ''`, no unquoted globs, no GNU-only flags without fallback or documentation

### Robustness checks:
- [ ] **Rollback paths**: Every destructive operation has documented undo instructions
- [ ] **Error messages**: Every failure path produces a specific, actionable error message (not just "failed")
- [ ] **Concurrency safety**: No shared global state that would break under parallel invocation
- [ ] **Determinism**: No non-deterministic algorithm output used for before/after comparisons (e.g., Louvain community IDs)

### Completeness checks:
- [ ] **Artifact schema**: If the skill produces files, path/format/schema are documented
- [ ] **Exit conditions**: Each phase states what must be true before the next phase starts
- [ ] **Scope boundary**: The skill's purpose is clear — it does one thing, not five
- [ ] **Examples section**: At least 2-3 realistic usage examples showing common invocations are included

### Safety checks:
- [ ] **Idempotency**: Re-running the skill on the same state is safe. Existing output files are handled (skip, overwrite with warning, or merge)
- [ ] **Dependency validation**: Phase 0 verifies all shell commands used in bash blocks are available before starting work (e.g. `command -v git mktemp jq`). "Command not found" is caught before Phase 2, not during Phase 3
- [ ] **Exit codes**: Every error path uses explicit `exit 1`. No silent early returns that leave the pipeline in an ambiguous state
- [ ] **State cleanup**: If the skill creates `.codegraph/$SKILL_NAME/*` files, the skill documents when they're cleaned up or how users remove them (e.g., `rm -rf .codegraph/$SKILL_NAME` in a cleanup section)

Read through the entire SKILL.md one more time after checking all items. Fix anything found.

---

## Phase 5 — Smoke Test

The self-review is purely theoretical — most real issues (wrong paths, shell syntax, missing tools, argument parsing bugs) only surface when you actually try to run the code. Before finalizing, execute these validation steps:

### Shell syntax validation

Extract every bash code block from the SKILL.md and check for syntax errors:

```bash
# For each ```bash block in the skill:
bash -n <<'BLOCK'
  # paste the block contents here
BLOCK
```

Fix any syntax errors found before proceeding.

### Phase 0 dry-run

Run the skill's Phase 0 (pre-flight) logic in a temporary test directory to verify:
- Argument parsing works for valid inputs and rejects invalid ones
- Tool availability checks actually detect missing tools (temporarily rename one to confirm)
- Environment validation produces clear error messages on failure

```bash
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXXXX")
trap 'cd - > /dev/null 2>&1; rm -rf "$TEST_DIR"' EXIT
cd "$TEST_DIR"
git init --quiet
# Simulate the Phase 0 checks from the skill here
cd - > /dev/null 2>&1
rm -rf "$TEST_DIR"
trap - EXIT
```

### Idempotency check

Mentally trace a second execution of the skill on the same state:
- Does Phase 0 handle pre-existing artifacts (skip, warn, overwrite)?
- Do file-creation steps fail if the file already exists?
- Are `mktemp` paths unique across runs (they should be by default)?

Document any idempotency fix applied.

**Exit condition:** All bash blocks pass `bash -n` syntax check. Phase 0 logic runs without errors in a test directory. Idempotency is confirmed or fixed.

---

## Phase 6 — Finalize

1. Read the final SKILL.md end-to-end and confirm it passes all Phase: Self-Review Checklist checks and Phase: Smoke Test validations
2. Show the user the complete skill for review
3. Ask: "Ready to commit, or want changes?"

If the user approves:
- Stage only `.claude/skills/$SKILL_NAME/SKILL.md`
- Commit: `feat(skill): add /$SKILL_NAME skill`

---

## Examples

- `/create-skill deploy-check` — scaffold a deployment validation skill that runs preflight checks before deploying
- `/create-skill review-pr` — scaffold a PR review skill with API calls and diff analysis
- `/create-skill db-migrate` — scaffold a database migration skill with dangerous-operation guards and rollback paths

---

## Rules

- **Never write the skill without Phase 0 discovery answers.** The user must describe what they want before you write anything.
- **Never skip the self-review checklist or smoke test.** Phase: Self-Review Checklist and Phase: Smoke Test are both mandatory, not optional.
- **Phase names over step numbers.** All cross-references in the generated skill must use phase names.
- **One skill = one concern.** If the user's requirements span multiple unrelated workflows, suggest splitting into separate skills.
- **No co-author lines** in commit messages.
- **No Claude Code references** in commit messages or the skill body.
- **Persist temp state to files, not shell variables** when it must survive across code fences.
- **Test commands must be detected, not assumed.** Never hardcode `npm test` — detect the package manager first.
- **Every `2>/dev/null` needs a justification comment** in the generated skill.
