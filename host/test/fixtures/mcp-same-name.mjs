import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const label = process.argv[2];
const server = new Server({ name: label, version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'search', description: `Search ${label}`, inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    if (params.name !== 'search') throw new Error('Unknown fixture tool');
    return { content: [{ type: 'text', text: label }] };
});
await server.connect(new StdioServerTransport());
