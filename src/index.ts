import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { GrafanaClient } from './grafana/client.js';
import { registerAllTools } from './tools/registerAll.js';

async function main() {
  const config = loadConfig();
  const client = new GrafanaClient(config);

  const server = new McpServer({
    name: 'timebuddy-incident-investigator',
    version: '0.1.0',
  });

  registerAllTools(server, { client, config });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('timebuddy-incident-investigator MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
