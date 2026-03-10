import { outputResult } from '../infrastructure/result-formatter.js';
import { ownersData } from '../owners.js';

/**
 * CLI display function for the `owners` command.
 */
export function owners(customDbPath, opts = {}) {
  const data = ownersData(customDbPath, opts);
  if (outputResult(data, null, opts)) return;

  if (!data.codeownersFile) {
    console.log('No CODEOWNERS file found.');
    return;
  }

  console.log(`\nCODEOWNERS: ${data.codeownersFile}\n`);

  const s = data.summary;
  console.log(
    `  Coverage: ${s.coveragePercent}% (${s.ownedFiles}/${s.totalFiles} files owned, ${s.ownerCount} owners)\n`,
  );

  if (s.byOwner.length > 0) {
    console.log('  Owners:\n');
    for (const o of s.byOwner) {
      console.log(`    ${o.owner}  ${o.fileCount} files`);
    }
    console.log();
  }

  if (data.files.length > 0 && opts.owner) {
    console.log(`  Files owned by ${opts.owner}:\n`);
    for (const f of data.files) {
      console.log(`    ${f.file}`);
    }
    console.log();
  }

  if (data.boundaries.length > 0) {
    console.log(`  Cross-owner boundaries: ${data.boundaries.length} edges\n`);
    const shown = data.boundaries.slice(0, 30);
    for (const b of shown) {
      const srcOwner = b.from.owners.join(', ') || '(unowned)';
      const tgtOwner = b.to.owners.join(', ') || '(unowned)';
      console.log(`    ${b.from.name} [${srcOwner}] -> ${b.to.name} [${tgtOwner}]`);
    }
    if (data.boundaries.length > 30) {
      console.log(`    ... and ${data.boundaries.length - 30} more`);
    }
    console.log();
  }
}
