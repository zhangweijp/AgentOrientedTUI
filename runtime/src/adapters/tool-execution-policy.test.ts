import { describe, expect, it, vi } from 'vitest';
import { withToolAuthorization } from './tool-execution-policy.js';
import type { ObservationGrant } from '../core/invocation/observation-types.js';
import type { AppSnapshot } from '../core/snapshot/types.js';
import type { AppInteractionPolicy } from '../core/invocation/app-interaction-types.js';

function fixture() {
    const source: AppSnapshot = {
        schemaVersion: 6, id: 'snapshot', appId: 'app', instanceId: 'run', revision: 1, createdAt: 1, contentDigest: 'digest',
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
        const policy = withToolAuthorization(f.policy, () => enabled);
        expect(await policy.project(f.context)).toEqual({ refs: f.grant.refs, toolIds: [] });
        expect(f.grant.toolIds).toEqual(['read']);
        enabled = true;
        expect(await policy.project(f.context)).toBe(f.grant);
        expect(policy.authorize).toBe(f.policy.authorize);
        expect(policy.canReadReceipt).toBe(f.policy.canReadReceipt);
    });

    it.each([['missing'], ['read', 'read']])('preserves invalid or duplicate tool IDs %j for Core validation', async (...toolIds) => {
        const f = fixture(), bad = { ...f.grant, toolIds };
        expect(await withToolAuthorization({ ...f.policy, project: () => bad }, () => false).project(f.context)).toBe(bad);
    });

    it('preserves malformed policy or grant shapes for Core validation without executing getters', async () => {
        const f = fixture(), getter = vi.fn(() => f.policy.project);
        const malformed = { ...f.policy, extra: true };
        expect(withToolAuthorization(malformed, () => false)).toBe(malformed);
        const accessor = { ...f.policy };
        Object.defineProperty(accessor, 'project', { get: getter, enumerable: true });
        expect(withToolAuthorization(accessor, () => false)).toBe(accessor);
        expect(getter).not.toHaveBeenCalled();
        const badGrant = { ...f.grant, extra: 'invalid' };
        expect(await withToolAuthorization({ ...f.policy, project: () => badGrant }, () => false).project(f.context)).toBe(badGrant);
    });
});
