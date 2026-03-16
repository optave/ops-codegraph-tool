/**
 * Stage: collectFiles
 *
 * Collects all source files to process. Handles both normal and scoped rebuilds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from '../../constants.js';
import { info } from '../../logger.js';
import { collectFiles as collectFilesUtil } from '../helpers.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function collectFiles(ctx) {
  const { rootDir, config, opts } = ctx;

  if (opts.scope) {
    // Scoped rebuild: rebuild only specified files
    const scopedFiles = opts.scope.map((f) => normalizePath(f));
    const existing = [];
    const missing = [];
    for (const rel of scopedFiles) {
      const abs = path.join(rootDir, rel);
      if (fs.existsSync(abs)) {
        existing.push({ file: abs, relPath: rel });
      } else {
        missing.push(rel);
      }
    }
    ctx.allFiles = existing.map((e) => e.file);
    ctx.discoveredDirs = new Set(existing.map((e) => path.dirname(e.file)));
    ctx.parseChanges = existing;
    ctx.metadataUpdates = [];
    ctx.removed = missing;
    ctx.isFullBuild = false;
    info(`Scoped rebuild: ${existing.length} files to rebuild, ${missing.length} to purge`);
  } else {
    const collected = collectFilesUtil(rootDir, [], config, new Set());
    ctx.allFiles = collected.files;
    ctx.discoveredDirs = collected.directories;
    info(`Found ${ctx.allFiles.length} files to parse`);
  }
}
