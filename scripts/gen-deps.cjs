const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outFile = path.join('generated', 'DEPENDENCIES.md');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

try {
  const tree = execSync('npm ls --all --omit=dev', { encoding: 'utf8' });
  fs.writeFileSync(outFile, '# Dependencies\n\n```\n' + tree + '```\n');
} catch (err) {
  // npm ls exits non-zero on ELSPROBLEMS (version mismatches in optional deps).
  // If stdout still has content, write it; otherwise skip silently.
  if (err.stdout) {
    fs.writeFileSync(
      outFile,
      '# Dependencies\n\n```\n' + err.stdout + '```\n',
    );
  } else {
    console.warn('deps:tree skipped —', err.message);
  }
}
