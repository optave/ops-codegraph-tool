#!/usr/bin/env node
// node-ts.js — Version-aware TypeScript launcher
// Uses --strip-types on Node 23+ and --experimental-strip-types on Node 22.x.
// Usage: node scripts/node-ts.js <script.ts> [args...]

import { execFileSync } from "node:child_process";

const [major] = process.versions.node.split(".").map(Number);
const flag = major >= 23 ? "--strip-types" : "--experimental-strip-types";
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
