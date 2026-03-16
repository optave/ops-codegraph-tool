export const command = {
  name: 'mcp',
  description: 'Start MCP (Model Context Protocol) server for AI assistant integration',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--multi-repo', 'Enable access to all registered repositories'],
    ['--repos <names>', 'Comma-separated list of allowed repo names (restricts access)'],
  ],
  async execute(_args, opts) {
    const { startMCPServer } = await import('../../mcp.js');
    const mcpOpts = {};
    mcpOpts.multiRepo = opts.multiRepo || !!opts.repos;
    if (opts.repos) {
      mcpOpts.allowedRepos = opts.repos.split(',').map((s) => s.trim());
    }
    await startMCPServer(opts.db, mcpOpts);
  },
};
