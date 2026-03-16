// Barrel re-export — keeps all existing `import { ... } from './builder.js'` working.
// See src/builder/ for the pipeline implementation (ROADMAP 3.9).

export {
  collectFiles,
  loadPathAliases,
  purgeFilesFromGraph,
  readFileSafe,
} from './builder/helpers.js';
export { buildGraph } from './builder/pipeline.js';
export { resolveImportPath } from './resolve.js';
