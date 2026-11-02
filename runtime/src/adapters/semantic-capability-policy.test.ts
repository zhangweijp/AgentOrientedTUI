import { describe, expect, it, vi } from 'vitest';
import { withExecutableTools } from './semantic-capability-policy.js';
import type { ObservationGrant } from '../core/invocation/observation-types.js';
import type { AppSnapshotV2 } from '../core/snapshot/types.js';
import type { ExecutionBinding, ScopePolicy } from '../core/invocation/scoped-interaction-types.js';

function fixture() {
    const view = { viewId: 'root', viewInstanceId: 'root-instance' };
    const target = { ...view, bindingVersion: 1 };
    const source: AppSnapshotV2 = {
        schemaVersion: 2, id: 'snapshot', appId: 'app', instanceId: 'app-instance', revision: 1, createdAt: 1, contentDigest: 'digest',
        views: [{ id: view.viewId, viewInstanceId: view.viewInstanceId, type: 'Generic', name: 'Root', kind: 'state',
            content: { format: 'markdown-v1', value: 'Current content' } }], refs: {},
        tools: {
            parameterized: { id: 'parameterized', name: 'write', viewType: 'Generic', description: 'Parameterized',
                inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, isMutating: true, targets: [target] },
            empty: { id: 'empty', name: 'diagnostics', viewType: 'Generic', description: 'Read only',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false }, isMutating: false, targets: [target] },
        },
    };
    const grant: ObservationGrant = { views: [view], refs: [], content: [{ view, decision: 'retain' }],
        targets: Object.values(source.tools).map(tool => ({ toolId: tool.id, target })) };
    const policy: ScopePolicy = { project: vi.fn(async () => grant), authorize: vi.fn(() => true), canReadReceipt: vi.fn(() => true) };
    const context = { source, selection: { viewIds: ['root'] }, signal: new AbortController().signal };
    const binding: ExecutionBinding = { identity: {}, mode: 'ordinary', validateInput: () => ({ ok: true, value: {} }),
        isLive: () => ({ ok: true }), execute: () => ({ kind: 'unknown' }) };
    return { policy, grant, context, binding };
}

describe('Host executable Tool projection', () => {
    it('intersects a policy grant with the actual resolver and restores discovery when capability becomes available', async () => {
        const f = fixture();
        let readsNegotiated = false;
        const resolve = vi.fn(source => source.tool.isMutating || readsNegotiated ? f.binding : null);
        const policy = withExecutableTools(f.policy, { resolve });
        const first = await policy.project(f.context);
        expect(first.targets.map(entry => entry.toolId)).toEqual(['parameterized']);
        expect(first.views).toEqual(f.grant.views);
        expect(first.content).toEqual(f.grant.content);
        expect(f.grant.targets).toHaveLength(2);
        expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app', instanceId: 'app-instance', snapshotId: 'snapshot' }));
        readsNegotiated = true;
        expect((await policy.project(f.context)).targets.map(entry => entry.toolId)).toEqual(['parameterized', 'empty']);
    });

    it('preserves execution authorization and receipt authorization', async () => {
        const f = fixture(), policy = withExecutableTools(f.policy, { resolve: () => f.binding });
        expect(policy.authorize).toBe(f.policy.authorize);
        expect(policy.canReadReceipt).toBe(f.policy.canReadReceipt);
    });

    it('does not sanitize invalid or duplicate policy targets by deleting them', async () => {
        const f = fixture(), resolve = vi.fn(() => null);
        const invalid = { ...f.grant, targets: [{ toolId: 'missing', target: f.grant.targets[0].target }] };
        const invalidPolicy: ScopePolicy = { ...f.policy, project: () => invalid };
        expect(await withExecutableTools(invalidPolicy, { resolve }).project(f.context)).toBe(invalid);
        const duplicate = { ...f.grant, targets: [f.grant.targets[0], f.grant.targets[0]] };
        expect(await withExecutableTools({ ...f.policy, project: () => duplicate }, { resolve }).project(f.context)).toBe(duplicate);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('does not normalize malformed policy or projection objects before Core validation', async () => {
        const f = fixture(), resolve = vi.fn(() => null), getter = vi.fn(() => f.policy.project);
        const malformed = { ...f.policy, extra: true };
        expect(withExecutableTools(malformed, { resolve })).toBe(malformed);
        const accessor = { ...f.policy };
        Object.defineProperty(accessor, 'project', { get: getter, enumerable: true });
        expect(withExecutableTools(accessor, { resolve })).toBe(accessor);
        expect(getter).not.toHaveBeenCalled();
        const badGrant = { ...f.grant, extra: 'invalid' };
        expect(await withExecutableTools({ ...f.policy, project: () => badGrant }, { resolve }).project(f.context)).toBe(badGrant);
        expect(resolve).not.toHaveBeenCalled();
    });
});
