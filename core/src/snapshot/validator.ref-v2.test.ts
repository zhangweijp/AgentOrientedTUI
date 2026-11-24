import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { compileToolParameters } from '../tool/tool-parameters.js';
const c = compileToolParameters({ type: 'object', properties: { file: { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true });if (!c.ok) throw Error('fixture');
describe('R01 qualified Ref Snapshot admission', () => {
    it.each(['valid', 'unknown-marker', 'malformed-profile', 'mutating'])('checks %s before publication', kind => {
        const core = createSnapshotCore({ appId: 'app', instanceId: 'run' });const id = JSON.stringify(['app', 'File', 'read']);
        const schema: any = JSON.parse(JSON.stringify(c.contract.schema));if (kind === 'unknown-marker') schema['x-aotui-parameter-contract'] = 'UNKNOWN';if (kind === 'malformed-profile') delete schema.additionalProperties;
        const result = core.committer.accept({ schemaVersion: 8, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{ toolBindings: [{ toolId: id, activationId: 'active-1' }], id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', region: 'dynamic', content: { format: 'markdown-v1', value: 'File' } }], refs: {},
            tools: { [id]: { multiplicity: 'multiple', id, name: 'read', viewType: 'File',  description: 'Read', inputSchema: schema } } });
        expect(result.status).toBe(kind === 'valid' || kind === 'mutating' ? 'published' : 'rejected');
    });
});
