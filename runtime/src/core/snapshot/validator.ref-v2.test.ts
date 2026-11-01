import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { compileSnapshotValueParams } from '../tool/snapshot-value-parameter-contract.js';
const c = compileSnapshotValueParams({ file: { type: 'reference', required: true, refSource: 'snapshot-value-v1' } });if (!c.ok) throw Error('fixture');
describe('R01 exact readonly new Ref Snapshot admission', () => {
    it.each(['valid', 'unknown-marker', 'malformed-profile', 'mutating'])('checks %s before publication', kind => {
        const core = createSnapshotCore();core.lifecycle.startApp('app', 'run');const id = JSON.stringify(['app', 'File', 'read']);
        const schema: any = JSON.parse(JSON.stringify(c.contract.schema));if (kind === 'unknown-marker') schema['x-aotui-parameter-contract'] = 'UNKNOWN';if (kind === 'malformed-profile') delete schema.additionalProperties;
        const result = core.committer.accept({ schemaVersion: 2, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{ id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', kind: 'state', content: { format: 'markdown-v1', value: 'File' } }], refs: {},
            tools: { [id]: { id, name: 'read', viewType: 'File', description: 'Read', inputSchema: schema, isMutating: kind === 'mutating', targets: [{ viewId: 'aa', viewInstanceId: 'mount', bindingVersion: 1 }] } } });
        expect(result.status).toBe(kind === 'valid' ? 'published' : 'rejected');
    });
});
