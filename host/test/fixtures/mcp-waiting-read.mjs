import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const directory = process.argv[2];
const server = new Server({ name: 'closing fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'read', description: 'Read the local fixture status.', inputSchema: { type: 'object', properties: {} } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
    await writeFile(join(directory, 'entered'), '');
    const until = Date.now() + 12_000;
    while (!await access(join(directory, 'release')).then(() => true, () => false)) {
        if (Date.now() >= until) throw new Error('The test did not release the read');
        await delay(10);
    }
    await writeFile(join(directory, 'returned'), '');
    return { content: [{ type: 'text', text: 'local status' }] };
});
await server.connect(new StdioServerTransport());
