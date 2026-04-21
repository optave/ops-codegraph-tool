#!/usr/bin/env node
// node-ts.js — TypeScript launcher
// Uses --experimental-strip-types, which is accepted on every supported Node
// version (>=22.6). Node 23 briefly shipped a --strip-types alias that was
// removed in Node 24, so we avoid it.
// Usage: node scripts/node-ts.js <script.ts> [args...]

import { execFileSync } from "node:child_process";

const flag = "--experimental-strip-types";
const [script, ...args] = process.argv.slice(2);

if (!script) {
	console.error("Usage: node scripts/node-ts.js <script.ts> [args...]");
	process.exit(1);
}

try {
	execFileSync(process.execPath, [flag, script, ...args], {
		stdio: "inherit",
		env: process.env,
	});
} catch (err) {
	process.exit(err.status ?? 1);
}
