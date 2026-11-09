import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';
const c = compileOrdinarySchema({ type: 'object', properties: { file: { type: 'string', minLength: 1, 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true }, 'view-type-parameters-v1');if (!c.ok) throw Error('fixture');
describe('R01 qualified Ref Snapshot admission', () => {
    it.each(['valid', 'unknown-marker', 'malformed-profile', 'mutating'])('checks %s before publication', kind => {
        const core = createSnapshotCore();core.lifecycle.startApp('app', 'run');const id = JSON.stringify(['app', 'File', 'read']);
        const schema: any = JSON.parse(JSON.stringify(ordinaryParameterProfile(c.contract)));if (kind === 'unknown-marker') schema['x-aotui-parameter-contract'] = 'UNKNOWN';if (kind === 'malformed-profile') delete schema.additionalProperties;
        const result = core.committer.accept({ schemaVersion: 3, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{ id: 'aa', viewInstanceId: 'mount', type: 'File', name: 'File', kind: 'state', content: { format: 'markdown-v1', value: 'File' } }], refs: {},
            tools: { [id]: { id, name: 'read', viewType: 'File', description: 'Read', inputSchema: schema, 
                execution: { kind: 'view-type', activationId: 'active-1' } } } });
        expect(result.status).toBe(kind === 'valid' || kind === 'mutating' ? 'published' : 'rejected');
    });
});
