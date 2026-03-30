# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in codegraph, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/optave/ops-codegraph-tool/security/advisories/new).

### What to Include

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (if applicable)

### Response Timeline

- **Acknowledgment:** Within 48 hours of your report
- **Assessment:** Within 1 week, we will assess the severity and determine a fix timeline
- **Fix:** Critical vulnerabilities will be patched as soon as possible; lower-severity issues will be addressed in the next release

### Scope

Codegraph is a local-only CLI tool that makes zero network calls. However, we still take security seriously, particularly regarding:

- Arbitrary code execution through crafted input files
- Path traversal vulnerabilities
- SQL injection in the SQLite layer
- Dependency supply chain risks

## Security Design

Codegraph is designed with security in mind:

- **Zero network calls** — no data ever leaves your machine
- **Zero telemetry** — no usage data is collected
- **Local-only storage** — all data stays in `.codegraph/` within your project
- **No eval** — no dynamic code execution of parsed source files

Thank you for helping keep codegraph and its users safe.
