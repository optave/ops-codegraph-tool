#!/usr/bin/env node
// commitlint-check.js — Local commitlint validation
// Mirrors @commitlint/config-conventional + project commitlint.config.ts.
// Called by commitlint-local.sh with the commit message as argv[1].

const MAX = 100;
const TYPES = [
  "feat", "fix", "docs", "refactor", "test", "chore",
  "ci", "perf", "build", "style", "revert", "release", "merge",
];

const msg = process.argv[2];
if (!msg) process.exit(0);

// Skip merge commits (matches commitlint ignores config)
if (/^merge[:\s]/i.test(msg)) process.exit(0);

const lines = msg.split("\n");
const header = lines[0] || "";
const errors = [];

// --- Header checks ---

// type-empty + subject-empty: header must match type(scope)?: subject
const headerMatch = header.match(/^(\w+)(\(.+\))?(!)?:\s*(.*)$/);
if (!headerMatch) {
  errors.push("header must match format: type(scope)?: subject");
} else {
  const [, type, , , subject] = headerMatch;

  // type-case: must be lowercase
  if (type !== type.toLowerCase()) {
    errors.push(`type must be lowercase: "${type}"`);
  }

  // type-enum: must be in allowed list
  if (!TYPES.includes(type.toLowerCase())) {
    errors.push(`type "${type}" not in allowed types: ${TYPES.join(", ")}`);
  }

  // subject-empty
  if (!subject || !subject.trim()) {
    errors.push("subject must not be empty");
  }

  // subject-full-stop
  if (subject && subject.trimEnd().endsWith(".")) {
    errors.push("subject must not end with a period");
  }
}

// header-max-length
if (header.length > MAX) {
  errors.push(
    `header is ${header.length} chars (max ${MAX}): ${header.substring(0, 60)}...`
  );
}

// --- Body/footer line length checks ---
for (let i = 2; i < lines.length; i++) {
  if (lines[i].length > MAX) {
    errors.push(
      `line ${i + 1} is ${lines[i].length} chars (max ${MAX}): ${lines[i].substring(0, 60)}...`
    );
  }
}

if (errors.length > 0) {
  // Output one error per line to stdout
  process.stdout.write(errors.join("\n"));
  process.exit(1);
}
