import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'info',
  description: 'Show codegraph engine info and diagnostics',
  async execute(_args, _opts, ctx) {
    const { getNativePackageVersion, isNativeAvailable, loadNative } = await import(
      '../../infrastructure/native.js'
    );
    const { getActiveEngine } = await import('../../domain/parser.js');

    const engine = ctx.program.opts().engine;
    const { name: activeName, version: activeVersion } = getActiveEngine({ engine });
    const nativeAvailable = isNativeAvailable();

    console.log('\nCodegraph Diagnostics');
    console.log('====================');
    console.log(`  Version       : ${ctx.program.version()}`);
    console.log(`  Node.js       : ${process.version}`);
    console.log(`  Platform      : ${process.platform}-${process.arch}`);
    console.log(`  Native engine : ${nativeAvailable ? 'available' : 'unavailable'}`);
    if (nativeAvailable) {
      const native = loadNative()!;
      const binaryVersion =
        typeof native.engineVersion === 'function' ? native.engineVersion() : 'unknown';
      const pkgVersion = getNativePackageVersion();
      const knownBinaryVersion = binaryVersion !== 'unknown' ? binaryVersion : null;
      if (pkgVersion && knownBinaryVersion && pkgVersion !== knownBinaryVersion) {
        console.log(
          `  Native version: ${pkgVersion} (binary built as ${knownBinaryVersion}, engine loaded OK)`,
        );
      } else {
        console.log(`  Native version: ${pkgVersion ?? binaryVersion}`);
      }
    }
    console.log(`  Engine flag   : --engine ${engine}`);
    console.log(`  Active engine : ${activeName}${activeVersion ? ` (v${activeVersion})` : ''}`);
    console.log();

    try {
      const { findDbPath, getBuildMeta } = await import('../../db/index.js');
      const Database = (await import('better-sqlite3')).default;
      const dbPath = findDbPath();
      const fs = await import('node:fs');
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        const buildEngine = getBuildMeta(db, 'engine');
        const buildVersion = getBuildMeta(db, 'codegraph_version');
        const builtAt = getBuildMeta(db, 'built_at');
        db.close();

        if (buildEngine || buildVersion || builtAt) {
          console.log('Build metadata');
          console.log(
            '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
          );
          if (buildEngine) console.log(`  Engine        : ${buildEngine}`);
          if (buildVersion) console.log(`  Version       : ${buildVersion}`);
          if (builtAt) console.log(`  Built at      : ${builtAt}`);

          if (buildVersion && buildVersion !== ctx.program.version()) {
            console.log(
              `  \u26A0 DB was built with v${buildVersion}, current is v${ctx.program.version()}. Consider: codegraph build --no-incremental`,
            );
          }
          if (buildEngine && buildEngine !== activeName) {
            console.log(
              `  \u26A0 DB was built with ${buildEngine} engine, active is ${activeName}. Consider: codegraph build --no-incremental`,
            );
          }
          console.log();
        }
      }
    } catch {
      /* diagnostics must never crash */
    }
  },
};
