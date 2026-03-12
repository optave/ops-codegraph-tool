import { search } from '../../embedder.js';

export const command = {
  name: 'search <query>',
  description: 'Semantic search: find functions by natural language description',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-m, --model <name>', 'Override embedding model (auto-detects from DB)'],
    ['-n, --limit <number>', 'Max results', '15'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['--min-score <score>', 'Minimum similarity threshold', '0.2'],
    ['-k, --kind <kind>', 'Filter by kind: function, method, class'],
    ['--file <pattern>', 'Filter by file path pattern'],
    ['--rrf-k <number>', 'RRF k parameter for multi-query ranking', '60'],
    ['--mode <mode>', 'Search mode: hybrid, semantic, keyword (default: hybrid)'],
    ['-j, --json', 'Output as JSON'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
  ],
  validate([_query], opts) {
    const validModes = ['hybrid', 'semantic', 'keyword'];
    if (opts.mode && !validModes.includes(opts.mode)) {
      return `Invalid mode "${opts.mode}". Valid: ${validModes.join(', ')}`;
    }
  },
  async execute([query], opts, ctx) {
    await search(query, opts.db, {
      limit: parseInt(opts.limit, 10),
      offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
      noTests: ctx.resolveNoTests(opts),
      minScore: parseFloat(opts.minScore),
      model: opts.model,
      kind: opts.kind,
      filePattern: opts.file,
      rrfK: parseInt(opts.rrfK, 10),
      mode: opts.mode,
      json: opts.json,
      ndjson: opts.ndjson,
    });
  },
};
