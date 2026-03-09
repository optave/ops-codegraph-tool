export default {
  extends: ["@commitlint/config-conventional"],
  ignores: [(msg) => /^merge[:\s]/i.test(msg)],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "refactor",
        "test",
        "chore",
        "ci",
        "perf",
        "build",
        "style",
        "revert",
        "release",
      ],
    ],
    "header-max-length": [2, "always", 100],
  },
};
