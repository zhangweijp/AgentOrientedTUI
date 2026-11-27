import { describe, expect, it } from 'vitest';
import { createSnapshotCore } from './store.js';
import { compileToolParameters } from '../tool/tool-parameters.js';
import { refKey } from './snapshot-support.js';
import { SNAPSHOT_SCHEMA_VERSION } from './types.js';
const c = compileToolParameters({ type: 'object', properties: { file: { 'x-aotui-ref-kind': 'File', 'x-aotui-ref-value': { type: 'object' } } }, required: ['file'], additionalProperties: true });if (!c.ok) throw Error('fixture');
describe('R01 qualified Ref Snapshot admission', () => {
    it.each(['valid', 'unknown-marker', 'malformed-profile', 'mutating'])('checks %s before publication', kind => {
        const core = createSnapshotCore({ appId: 'app', instanceId: 'run' });const id = JSON.stringify(['app', 'File', 'read']);
        const schema: any = JSON.parse(JSON.stringify(c.contract.schema));if (kind === 'unknown-marker') schema['x-aotui-parameter-contract'] = 'UNKNOWN';if (kind === 'malformed-profile') delete schema.additionalProperties;
        const result = core.committer.accept({ healthySince: 1,  schemaVersion: 9, appId: 'app', instanceId: 'run', producerSeq: 1, sourceEpoch: 1, capturedAt: 1,
            views: [{ toolBindings: [{ toolId: id, activationId: 'a:1' }], id: 'aa', viewInstanceId: 'm:1', type: 'File', name: 'File', region: 'dynamic', content: { format: 'markdown-v1', value: 'File' } }], refs: {},
            tools: { [id]: { multiplicity: 'multiple', id, name: 'read', viewType: 'File',  description: 'Read', inputSchema: schema } } });
        expect(result.status).toBe(kind === 'valid' || kind === 'mutating' ? 'published' : 'rejected');
    });

    it.each(['2fa', 'items[0]', 'items.value', '姓名', '$note'])('rejects a non-identifier Ref ID %s at the snapshot boundary', id => {
        const core = createSnapshotCore({ appId: 'app', instanceId: 'run' });
        try {
            const key = refKey('aa', 'm:1', id);
            const result = core.committer.accept({ healthySince: 1,  schemaVersion: SNAPSHOT_SCHEMA_VERSION, appId: 'app', instanceId: 'run',
                producerSeq: 1, sourceEpoch: 1, capturedAt: 1, tools: {},
                views: [{ toolBindings: [], id: 'aa', viewInstanceId: 'm:1', type: 'File', name: 'File',
                    region: 'dynamic', content: { format: 'markdown-v1', value: 'File' } }],
                refs: { [key]: { continuity: [1,1,1] as const,  id, ownerViewId: 'aa', ownerViewInstanceId: 'm:1', refType: 'string', scope: 'public',
                    target: { kind: 'snapshot-value', payload: 'value' }, valueSchema: { type: 'string' } } },
            });
            expect(result).toMatchObject({ status: 'rejected',
                issue: { code: 'SNAPSHOT_INVALID', path: '$.refs[' + JSON.stringify(key) + '].id' } });
        } finally { core.lifecycle.dispose(); }
    });
});
