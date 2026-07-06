#!/usr/bin/env node
/**
 * Generates dist/hook-extensions.txt: a plain-text, one-extension-per-line
 * snapshot of EXTENSIONS (src/shared/constants.ts), which is itself derived
 * from LANGUAGE_REGISTRY (src/domain/parser.ts) — the single source of
 * truth for every language codegraph parses.
 *
 * Consumed by .claude/hooks/update-graph.sh, a PostToolUse hook that fires
 * on every Edit/Write in this repo. Reading this pre-generated list with a
 * native `grep -qxF` lets the hook decide in ~1ms whether an edited file's
 * extension is one codegraph tracks, without spawning a second Node process
 * (tens of ms of startup cost) just to check a file extension, and without
 * hand-copying the extension list a second time where it can silently drift
 * out of sync (see issue #1736 — `.mjs`/`.cjs` were missing from the old
 * hardcoded copy).
 *
 * Runs as part of `npm run build`, right after `tsc`, so the snapshot is
 * regenerated automatically whenever LANGUAGE_REGISTRY changes.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSIONS } from '../dist/shared/constants.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outFile = join(root, 'dist', 'hook-extensions.txt');
const sorted = [...EXTENSIONS].sort();

writeFileSync(outFile, `${sorted.join('\n')}\n`);
console.log(`[gen-hook-extensions] wrote ${outFile} (${sorted.length} extensions)`);
