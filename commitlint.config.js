export default {
  extends: ["@commitlint/config-conventional"],
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
        "merge",
      ],
    ],
    "header-max-length": [2, "always", 100],
  },
};
