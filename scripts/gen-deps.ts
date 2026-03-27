#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const outFile = join('generated', 'DEPENDENCIES.md');
mkdirSync(dirname(outFile), { recursive: true });

try {
  const tree = execSync('npm ls --all --omit=dev', { encoding: 'utf8' });
  writeFileSync(outFile, '# Dependencies\n\n```\n' + tree + '```\n');
} catch (err: any) {
  // npm ls exits non-zero on ELSPROBLEMS (version mismatches in optional deps).
  // If stdout still has content, write it; otherwise skip silently.
  if (err.stdout) {
    writeFileSync(
      outFile,
      '# Dependencies\n\n```\n' + err.stdout + '```\n',
    );
  } else {
    console.warn('deps:tree skipped —', err.message);
  }
}
