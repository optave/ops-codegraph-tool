/**
 * Stage: parseFiles
 *
 * Parses source files via parseFilesAuto (native or WASM engine).
 * Populates ctx.allSymbols, ctx.fileSymbols, ctx.filesToParse.
 */
import { performance } from 'node:perf_hooks';
import { info } from '../../../../infrastructure/logger.js';
import { parseFilesAuto } from '../../../parser.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function parseFiles(ctx) {
  const { allFiles, parseChanges, isFullBuild, engineOpts, rootDir } = ctx;

  ctx.filesToParse = isFullBuild ? allFiles.map((f) => ({ file: f })) : parseChanges;
  ctx.fileSymbols = new Map();

  const filePaths = ctx.filesToParse.map((item) => item.file);
  const t0 = performance.now();
  ctx.allSymbols = await parseFilesAuto(filePaths, rootDir, engineOpts);
  ctx.timing.parseMs = performance.now() - t0;

  const parsed = ctx.allSymbols.size;
  const skipped = ctx.filesToParse.length - parsed;
  info(`Parsed ${parsed} files (${skipped} skipped)`);
}
