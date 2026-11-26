import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import Type from 'typebox';
import { createApp, createView, defineViewType } from '@aotui/sdk';
import { DIAGRAM, PLAIN_APP, RAW_VIEWS } from './batch-five-content.js';

const Raw = defineViewType({ name: 'raw_markdown', multiplicity: 'multiple' });
const Healthy = defineViewType<{ ping(): void }>()({ name: 'healthy', multiplicity: 'single', region: 'dynamic', tools: {
    ping: { description: 'Record an independent health check.', inputSchema: Type.Object({}), execute: ({ context }) => {
        context.ping();
        return { success: true, data: { peer: 'healthy' } };
    } },
} });

export default createApp({ app_name: PLAIN_APP, viewTypes: [Raw, Healthy], initialize({ launchConfig, prepareProjection }) {
    const folder = launchConfig?.folder;
    if (typeof folder !== 'string') throw new Error('Missing test directory');
    const entries = Object.entries({ ...RAW_VIEWS, diagram: '```mermaid\n' + DIAGRAM + '\n```\n' });
    prepareProjection({ views: [
        ...entries.map(([idPrefix, body]) => createView(Raw, {
            idPrefix, region: idPrefix === 'split_raw' ? 'static' : 'dynamic', render: () => ({ body }),
        })),
        createView(Healthy, { render: () => ({ body: 'Independent healthy workspace',
            context: { ping: () => appendFileSync(join(folder, 'pings.jsonl'), '{"peer":"healthy"}\n') } }) }),
    ] });
} });
