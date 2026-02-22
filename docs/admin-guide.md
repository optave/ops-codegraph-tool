# Admin Guide — GitHub Repository Settings

This document describes the recommended GitHub settings for the codegraph
repository. These must be configured manually by a repository admin.

---

## Branch Protection on `main`

Go to **Settings > Branches > Add branch protection rule** for `main`:

| Setting | Value |
|---------|-------|
| Require a pull request before merging | Yes |
| Required approvals | 1 |
| Dismiss stale pull request approvals when new commits are pushed | Yes |
| Require status checks to pass before merging | Yes |
| Required status checks | `CI Testing Pipeline` (CI), `Lint` (CI), `Validate commits` (Commitlint), `Validate branch name` (Commitlint), `License Compliance Scan` (SHIELD) |
| Require branches to be up to date before merging | Yes |
| Require conversation resolution before merging | Yes |
| Restrict who can push to matching branches | Optional (recommended for teams) |

## Merge Strategy

Go to **Settings > General > Pull Requests**:

| Setting | Value |
|---------|-------|
| Allow merge commits | Yes |
| Allow squash merging | Yes |
| Allow rebase merging | No |
| Automatically delete head branches | Yes |

Disabling rebase merge ensures conventional commit history is preserved on
`main`. Squash merging is allowed so that messy PR branches can be collapsed
into a single conventional commit.

## Environment Protection

Go to **Settings > Environments** and create an environment called
`npm-publish`:

| Setting | Value |
|---------|-------|
| Required reviewers | At least 1 (e.g. project lead) |
| Deployment branches | `main` only |

This ensures that the publish workflow (`publish.yml`) requires manual
approval before publishing to npm.

## Secrets and Variables

Go to **Settings > Secrets and variables > Actions**:

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Used by the Claude workflow (if enabled) |

**npm publishing** uses OIDC provenance (`--provenance` flag), so no
`NPM_TOKEN` secret is needed — the publish workflow uses the built-in
`id-token: write` permission with `setup-node`'s registry-url.

## Dependabot

Dependabot is already configured via `.github/dependabot.yml`. No additional
admin setup is needed. Dependabot branches (`dependabot/`) are explicitly
allowed by the branch naming convention.
