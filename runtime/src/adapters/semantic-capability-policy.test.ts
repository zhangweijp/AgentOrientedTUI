import { describe, expect, it, vi } from 'vitest';
import { withExecutableTools } from './semantic-capability-policy.js';
import type { ObservationGrant } from '../core/invocation/observation-types.js';
import type { AppSnapshotV5 } from '../core/snapshot/types.js';
import type { AppInteractionPolicy } from '../core/invocation/app-interaction-types.js';

function fixture() {
    const source: AppSnapshotV5 = {
        schemaVersion: 5, id: 'snapshot', appId: 'app', instanceId: 'run', revision: 1, createdAt: 1, contentDigest: 'digest',
        views: [], refs: {}, tools: {
            read: { id: 'read', name: 'read', viewType: 'Detail', nameSharedAcrossViewTypes: false, description: 'Read',
                inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
        },
    };
    const grant: ObservationGrant = { refs: [{ viewId: 'v', viewInstanceId: 'mount', refId: 'r' }], toolIds: ['read'] };
    const policy: AppInteractionPolicy = { project: () => grant, authorize: vi.fn(() => true), canReadReceipt: vi.fn(() => true) };
    const context = { source, signal: new AbortController().signal };
    return { policy, grant, context };
}

describe('Host executable Tool projection', () => {
    it('gates the executable inventory and restores it when the Worker capability is available', async () => {
        const f = fixture();
        let enabled = false;
        const policy = withExecutableTools(f.policy, () => enabled);
        expect(await policy.project(f.context)).toEqual({ refs: f.grant.refs, toolIds: [] });
        expect(f.grant.toolIds).toEqual(['read']);
        enabled = true;
        expect(await policy.project(f.context)).toBe(f.grant);
        expect(policy.authorize).toBe(f.policy.authorize);
        expect(policy.canReadReceipt).toBe(f.policy.canReadReceipt);
    });

    it.each([['missing'], ['read', 'read']])('preserves invalid or duplicate tool IDs %j for Core validation', async (...toolIds) => {
        const f = fixture(), bad = { ...f.grant, toolIds };
        expect(await withExecutableTools({ ...f.policy, project: () => bad }, () => false).project(f.context)).toBe(bad);
    });

    it('preserves malformed policy or grant shapes for Core validation without executing getters', async () => {
        const f = fixture(), getter = vi.fn(() => f.policy.project);
        const malformed = { ...f.policy, extra: true };
        expect(withExecutableTools(malformed, () => false)).toBe(malformed);
        const accessor = { ...f.policy };
        Object.defineProperty(accessor, 'project', { get: getter, enumerable: true });
        expect(withExecutableTools(accessor, () => false)).toBe(accessor);
        expect(getter).not.toHaveBeenCalled();
        const badGrant = { ...f.grant, extra: 'invalid' };
        expect(await withExecutableTools({ ...f.policy, project: () => badGrant }, () => false).project(f.context)).toBe(badGrant);
    });
});
