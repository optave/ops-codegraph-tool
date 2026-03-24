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

## Phase 0 — Discovery

Before writing anything, gather requirements interactively. Ask the user these questions (all at once, not one-by-one):

1. **Purpose** — What does this skill do? (one paragraph)
2. **Arguments** — What CLI arguments should it accept? (e.g. `--fix`, `--dry-run`, `<path>`)
3. **Phases** — What are the major steps? (bullet list of 3-8 phases)
4. **Tools needed** — Which tools does it need? (Bash, Read, Write, Edit, Glob, Grep, Agent)
5. **Artifacts** — Does it produce output files? If so, where and what format?
6. **Dangerous operations** — Does it modify code, push to git, call external APIs, or delete files?
7. **Resume/skip support** — Should it support `--start-from` or `--skip-*` flags for long-running pipelines?

**Wait for the user's answers before proceeding.** Do not guess or assume.

**Exit condition:** All 7 questions have answers. Purpose, arguments, phases, tools, artifacts, dangerous ops, and resume support are defined.

---

## Phase 1 — Scaffold

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

1. Confirm environment (repo root, node version, required tools)
2. Parse `$ARGUMENTS` into state variables
3. Validate preconditions

## Phase N — <Name>

<Steps>

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

Write each phase following these **mandatory patterns** (derived from the top 10 Greptile review findings):

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

**Correct:** Persist state to a file:
````markdown
```bash
mktemp -d > .codegraph/$SKILL_NAME/.tmpdir
```
Later:
```bash
rm -rf "$(cat .codegraph/$SKILL_NAME/.tmpdir)"
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
PREV_FILE=$(mktemp --suffix=.js)
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
mktemp --suffix=.js    # NOT just mktemp
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
else TEST_CMD="npm test"; fi
$TEST_CMD
```
````

### Pattern 7: No internal contradictions

Each decision (pass/fail, rollback/continue, skip/run) must be defined in **exactly one place**. If two sections describe the same decision path, consolidate them and reference the single source.

### Pattern 8: Rules ↔ Procedure sync

Every codegraph command or tool invocation in the procedure must be permitted by the Rules section. Every exception in the Rules must correspond to an actual procedure step. After writing, cross-check both directions.

### Pattern 9: No command redundancy

If a phase runs a codegraph command and stores the result, later phases must reference that result — not re-run the command. Add a note: "Using <result> from Phase: <Name>".

### Pattern 10: Skip/resume flag validation

If the skill supports `--start-from` or `--skip-*`:
- Skipping a phase must NOT skip its artifact validation
- Add a pre-validation table listing which artifacts are required for each entry point
- Each skip path must be explicitly tested in Phase: Self-Review

**Exit condition:** Every phase body in the SKILL.md follows all 10 patterns. No wrong/correct examples remain as actual instructions — only the correct versions.

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
  elif ls eslint.config.* 2>/dev/null | grep -q .; then LINT_CMD="npx eslint ."
  else LINT_CMD="npm run lint"; fi
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

### Anti-pattern checks (the top 10):
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

### Robustness checks:
- [ ] **Rollback paths**: Every destructive operation has documented undo instructions
- [ ] **Error messages**: Every failure path produces a specific, actionable error message (not just "failed")
- [ ] **Concurrency safety**: No shared global state that would break under parallel invocation
- [ ] **Determinism**: No non-deterministic algorithm output used for before/after comparisons (e.g., Louvain community IDs)

### Completeness checks:
- [ ] **Artifact schema**: If the skill produces files, path/format/schema are documented
- [ ] **Exit conditions**: Each phase states what must be true before the next phase starts
- [ ] **Scope boundary**: The skill's purpose is clear — it does one thing, not five

Read through the entire SKILL.md one more time after checking all items. Fix anything found.

---

## Phase 5 — Finalize

1. Read the final SKILL.md end-to-end and confirm it passes all Phase 4 checks
2. Show the user the complete skill for review
3. Ask: "Ready to commit, or want changes?"

If the user approves:
- Stage only `.claude/skills/$SKILL_NAME/SKILL.md`
- Commit: `feat(skill): add /$SKILL_NAME skill`

---

## Rules

- **Never write the skill without Phase 0 discovery answers.** The user must describe what they want before you write anything.
- **Never skip the self-review checklist.** Phase 4 is mandatory, not optional.
- **Phase names over step numbers.** All cross-references in the generated skill must use phase names.
- **One skill = one concern.** If the user's requirements span multiple unrelated workflows, suggest splitting into separate skills.
- **No co-author lines** in commit messages.
- **No Claude Code references** in commit messages or the skill body.
- **Persist temp state to files, not shell variables** when it must survive across code fences.
- **Test commands must be detected, not assumed.** Never hardcode `npm test` — detect the package manager first.
- **Every `2>/dev/null` needs a justification comment** in the generated skill.
