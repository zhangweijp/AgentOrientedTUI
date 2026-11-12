import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource } from './semantic-aotui-driven-source.js';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticAOTUIDrivenSourceOptions } from './semantic-aotui-driven-source.js';
import type { IDesktop, IKernel, AppDiscoveryInfo } from '@aotui/runtime/spi';
import type { Observation } from '@aotui/runtime/core';
import type { InvocationOutcome, InvocationReceipt, InvokeResult, AppInvocation, AppInteraction } from '@aotui/runtime/core';

const app = (id: string, status: AppDiscoveryInfo['status'] = 'running', appInstanceId: string | null =
    status === 'pending' || status === 'closed' ? null : `${id}-instance`): AppDiscoveryInfo => ({ appId: id as any, name: id, status,
        ...(appInstanceId === null ? {} : { appInstanceId }) });
function observation(appId: string, revision = 1, name = 'multi_open_file'): Observation {
    const execution = { kind: 'view-type' as const, activationId: `${appId}-type-tool-activation` };
    return {
        observationId: `${appId}-observation-${revision}`, expiresAt: null,
        source: { appId, instanceId: `${appId}-instance`, snapshotId: `${appId}-snapshot-${revision}`, revision },
        views: [{ id: 'workspace', viewInstanceId: `${appId}-view`, type: 'AnyView', name: 'Workspace', kind: 'state',
            content: { format: 'markdown-v1', value: `current ${appId} revision ${revision}` } }],
        refs: [], tools: [{ id: 'tool', name, viewType: 'AnyView', description: 'Current View Tool',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },  execution }],
        bindings: [{ bindingId: `${appId}-binding-${revision}`, toolId: 'tool', execution }],
    };
}
function receipt(request: AppInvocation, outcome: InvocationOutcome = { status: 'succeeded', value: null }): InvocationReceipt {
    return { invocationId: request.invocationId, observationId: request.observationId, bindingId: request.bindingId,
        source: null, completedAt: 1, expiresAt: 60001, executionPhase: 'entered-returned', outcome };
}
function harness(installed = [app('one')], options: SemanticAOTUIDrivenSourceOptions = {}) {
    const observations = new Map(installed.map(item => [String(item.appId), observation(String(item.appId))]));
    const clients: Array<{ appId: string; client: AppInteraction & { adoptObservation: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>; releaseObservation: ReturnType<typeof vi.fn> } }> = [];
    const updates = new Set<() => void>();
    const desktop = {
        id: 'desktop', getInstalledApps: vi.fn(() => installed),
        getSystemLogs: vi.fn((): Array<{timestamp: number; message: string}> => []),
        getSnapshotFragments: vi.fn(() => { throw new Error('legacy fragments forbidden'); }),
        openApp: vi.fn(async (id: string) => { installed.splice(installed.findIndex(item => item.appId === id), 1, app(id)); }),
        closeApp: vi.fn(async () => {}), collapseApp: vi.fn(async () => {}), showApp: vi.fn(async () => {}),
        output: { subscribe: vi.fn((listener: () => void) => updates.add(listener)), unsubscribe: vi.fn((listener: () => void) => updates.delete(listener)) },
    };
    const kernel = {
        acquireSnapshot: vi.fn(() => { throw new Error('legacy snapshot forbidden'); }),
        execute: vi.fn(() => { throw new Error('legacy execute forbidden'); }),
        getAppInteraction: vi.fn((_desktopId: string, appId: string, _instanceId: string) => {
            const existing = clients.find(entry => entry.appId === appId);
            if (existing) return { status: 'ready', interaction: existing.client };
            const results = new Map<string, InvocationReceipt>();
            const client = {
                observe: vi.fn(async () => ({ status: 'observed', observation: observations.get(appId)! })),
                preview: vi.fn(), readReceipt: vi.fn(),
                invoke: vi.fn(async (request: AppInvocation) => {
                    if (results.has(request.invocationId)) return { kind: 'receipt', receipt: results.get(request.invocationId)! };
                    const value = receipt(request); results.set(request.invocationId, value);
                    return { kind: 'receipt', receipt: value };
                }),
                adoptObservation: vi.fn(() => ({ status: 'adopted' })), releaseObservation: vi.fn(),
            } as unknown as (typeof clients)[number]['client'];
            clients.push({ appId, client });
            return { status: 'ready', interaction: client };
        }),
    };
    const source = new SemanticAOTUIDrivenSource(desktop as unknown as IDesktop, kernel as unknown as IKernel, options);
    return { source, desktop, kernel, observations, clients, installed, updates };
}
async function consume(source: SemanticAOTUIDrivenSource) {
    const context = await source.getContext(); await context.adopt!(); return context;
}
const findTool = (context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>, fragment: string) => {
    const name = Object.keys(context.tools).find(name => name.includes(fragment));
    expect(name).toBeDefined(); return name!;
};
async function executeMappedResult(result: InvokeResult) {
    const h = harness(), context = await consume(h.source), name = findTool(context, 'one-');
    h.clients[0]!.client.invoke.mockResolvedValueOnce(result);
    try {
        const mapped = await context.executeTool!(name, {}, 'call');
        expect(mapped).toBeDefined();
        return mapped!;
    } finally {
        await context.release!(); h.source.dispose();
    }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('SemanticAOTUIDrivenSource', () => {
    it('prepares previews without replacing the current context and revokes all old routes only on adoption', async () => {
        const h = harness(), first = await consume(h.source), name = findTool(first, '-multi_open_file');
        h.observations.set('one', observation('one', 2));
        const preview = await h.source.getContext();
        expect((await preview.executeTool!(name, {}, 'preview'))?.error?.code).toBe('SEMANTIC_CONTEXT_NOT_ADOPTED');
        expect((await preview.executeTool!('system-close_app', { app_id: 'one' }, 'preview-close'))?.error?.code).toBe('SEMANTIC_CONTEXT_NOT_ADOPTED');
        expect(h.desktop.closeApp).not.toHaveBeenCalled();
        await first.executeTool!(name, {}, 'before');
        expect(h.clients[0].client.invoke).toHaveBeenCalledTimes(1);
        await preview.adopt!(); await preview.adopt!();
        expect(h.clients[0].client.adoptObservation).toHaveBeenCalledTimes(2);
        expect((await first.executeTool!(name, {}, 'old'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect((await first.executeTool!('system-close_app', { app_id: 'one' }, 'old-close'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        await preview.executeTool!(name, {}, 'after');
        expect(h.clients[0].client.invoke.mock.calls.map(args => args[0].observationId)).toEqual(['one-observation-1', 'one-observation-2']);
        await preview.release!(); h.source.dispose();
    });

    it('failed adoption preserves a still-valid previous context and releases the failed preparation', async () => {
        const h = harness(), first = await consume(h.source), name = findTool(first, '-multi_open_file');
        h.observations.set('one', observation('one', 2));
        const next = await h.source.getContext();
        h.clients[0].client.adoptObservation.mockReturnValueOnce({ status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' } });
        expect(() => next.adopt!()).toThrow(expect.objectContaining({ code: 'SEMANTIC_ADOPTION_FAILED' }));

        expect((await first.executeTool!(name, {}, 'still-current'))?.outcomeStatus).toBe('succeeded');
        expect((await next.executeTool!(name, {}, 'failed'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        await first.release!(); h.source.dispose();
    });

    it('reports partial App adoption without rollback claims and closes the unusable aggregate', async () => {
        const h = harness([app('one'), app('two')]), first = await consume(h.source);
        const next = await h.source.getContext();
        h.clients[1].client.adoptObservation.mockReturnValueOnce({ status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' } });
        expect(() => next.adopt!()).toThrow(expect.objectContaining({ code: 'SEMANTIC_ADOPTION_PARTIAL', results: [
            { appId: 'one', status: 'adopted' },
            { appId: 'two', status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' } },
        ] }));
        expect((await first.executeTool!('system-close_app', { app_id: 'one' }, 'old'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        for (const item of h.clients) expect(item.client.releaseObservation).toHaveBeenCalled();
        await next.release!(); h.source.dispose();
    });
    it('projects multiple App instances and opens pending apps through the Desktop lifecycle', async () => {
        const h = harness([app('one'), app('two'), app('pending', 'pending')]);
        const context = await consume(h.source);
        const one = findTool(context, 'one-'), two = findTool(context, 'two-');
        expect(one).not.toBe(two);
        expect(context.tools.aotui_read_receipt).toBeUndefined();
        expect(context.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(2);
        expect(context.messages.some(message => String(message.content).includes('App ID: pending'))).toBe(true);
        for (const entry of h.clients) expect(entry.client.observe).toHaveBeenCalledWith({ all: true });
        await context.executeTool!(one, {}, 'one-call');
        await context.executeTool!(two, {}, 'two-call');
        expect(h.clients[0].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'one-observation-1', bindingId: 'one-binding-1' }));
        expect(h.clients[1].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'two-observation-1', bindingId: 'two-binding-1' }));
        expect((await context.executeTool!('system-open_app', { app_id: 'pending' }, 'open'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.openApp).toHaveBeenCalledWith('pending');
        expect(h.kernel.acquireSnapshot).not.toHaveBeenCalled();
        expect(h.kernel.execute).not.toHaveBeenCalled();
        expect(h.desktop.getSnapshotFragments).not.toHaveBeenCalled();
        await context.release!();
        const next = await h.source.getContext();
        expect(Object.keys(next.tools).some(name => name.includes('pending-'))).toBe(true);
        await next.release!(); h.source.dispose();
    });

    it('binds close/collapse/show controls to the observed App instance and hides active controls without its identity', async () => {
        const h = harness(), originalId = h.installed[0].appInstanceId!;
        const running = await consume(h.source);
        h.installed[0] = app('one', 'collapsed', originalId);
        const collapsed = await h.source.getContext();

        h.installed[0] = app('one', 'running', 'successor-instance');
        for (const [name, callId] of [['system-close_app', 'old-close'], ['system-collapse_app', 'old-collapse']] as const) {
            const result = await running.executeTool!(name, { app_id: 'one' }, callId);
            expect(result?.error?.code).toBe('APP_INSTANCE_CHANGED');
        }
        expect(h.desktop.closeApp).not.toHaveBeenCalled();
        expect(h.desktop.collapseApp).not.toHaveBeenCalled();

        await collapsed.adopt!();
        h.installed[0] = app('one', 'collapsed', 'successor-instance');
        const staleShow = await collapsed.executeTool!('system-show_app', { app_id: 'one' }, 'old-show');
        expect(staleShow?.error?.code).toBe('APP_INSTANCE_CHANGED');
        expect(h.desktop.showApp).not.toHaveBeenCalled();

        const latest = await consume(h.source);
        expect((await latest.executeTool!('system-show_app', { app_id: 'one' }, 'fresh-show'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.showApp).toHaveBeenCalledWith('one', 'successor-instance');
        h.installed[0] = app('one', 'running', 'successor-instance');
        const freshRunning = await consume(h.source);
        expect((await freshRunning.executeTool!('system-collapse_app', { app_id: 'one' }, 'fresh-collapse'))?.outcomeStatus).toBe('succeeded');
        expect((await freshRunning.executeTool!('system-close_app', { app_id: 'one' }, 'fresh-close'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.collapseApp).toHaveBeenCalledWith('one', 'successor-instance');
        expect(h.desktop.closeApp).toHaveBeenCalledWith('one', 'successor-instance');

        h.installed[0] = app('one', 'running', null);
        const withoutIdentity = await h.source.getContext();
        expect(withoutIdentity.tools['system-close_app']).toBeUndefined();
        expect(withoutIdentity.tools['system-collapse_app']).toBeUndefined();
        for (const context of [running, collapsed, latest, freshRunning, withoutIdentity]) await context.release!();
        h.source.dispose();
    });

    it('isolates malformed live identity metadata to its App during lifecycle control', async () => {
        const h = harness([app('bad'), app('healthy')]), context = await consume(h.source);
        let badIdentityReads = 0;
        h.installed[0] = new Proxy(h.installed[0] as any, {
            getOwnPropertyDescriptor(target, key) {
                if (key === 'appInstanceId') { badIdentityReads++; throw new Error('bad identity metadata'); }
                return Reflect.getOwnPropertyDescriptor(target, key);
            },
        });
        const healthy = await context.executeTool!('system-close_app', { app_id: 'healthy' }, 'healthy-close');
        expect(healthy?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.closeApp).toHaveBeenCalledOnce();
        expect(h.desktop.closeApp).toHaveBeenCalledWith('healthy', 'healthy-instance');
        expect(badIdentityReads).toBe(0);
        const bad = await context.executeTool!('system-close_app', { app_id: 'bad' }, 'bad-close');
        expect(bad?.error?.code).toBe('APP_STATE_CHANGED');
        expect(h.desktop.closeApp).toHaveBeenCalledOnce();
        expect(badIdentityReads).toBe(1);
        await context.release!(); h.source.dispose();
    });

    it('maps the manager admission mismatch as rejected while real lifecycle failures remain unknown', async () => {
        const h = harness(), context = await consume(h.source);
        h.desktop.closeApp.mockRejectedValueOnce(Object.assign(new Error('stale'), { code: 'APP_INSTANCE_CHANGED' }));
        expect(await context.executeTool!('system-close_app', { app_id: 'one' }, 'admission-race')).toMatchObject({
            outcomeStatus: 'rejected', error: { code: 'APP_INSTANCE_CHANGED' },
        });
        h.desktop.closeApp.mockRejectedValueOnce(new Error('cleanup failed'));
        expect(await context.executeTool!('system-close_app', { app_id: 'one' }, 'cleanup-failed')).toMatchObject({
            outcomeStatus: 'unknown', error: { code: 'APP_LIFECYCLE_UNKNOWN' },
        });
        await context.release!();h.source.dispose();
    });

    it('pins each call to its observed binding and releases only the owning observation', async () => {
        const h = harness();
        const first = await consume(h.source), tool = findTool(first, '-multi_open_file');
        h.observations.set('one', observation('one', 2));
        const second = await h.source.getContext();
        await first.executeTool!(tool, {}, 'old');
        await second.adopt!();
        await second.executeTool!(tool, {}, 'new');
        expect(h.clients[0].client.invoke.mock.calls.map(args => args[0].bindingId)).toEqual(['one-binding-1', 'one-binding-2']);
        await first.release!();

        expect((await first.executeTool!(tool, {}, 'late'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect(h.clients[0].client.invoke).toHaveBeenCalledTimes(2);
        await second.release!();

        h.source.dispose();
    });

    it('supports a ready app with no views or view tools', async () => {
        const h = harness(), empty = observation('one');
        h.observations.set('one', { ...empty, views: [], refs: [], tools: [], bindings: [] });
        const context = await consume(h.source);
        expect(context.messages.some(message => String(message.content).startsWith('<view '))).toBe(false);
        expect(Object.keys(context.tools).some(name => name.includes('-multi_open_file'))).toBe(false);
        expect(context.tools['system-close_app']).toBeDefined();
        await context.release!(); h.source.dispose();
    });

    it('exposes one atomic Context interface only', async () => {
        const h = harness();
        expect('getMessages' in h.source).toBe(false);
        expect('getTools' in h.source).toBe(false);
        expect('executeTool' in h.source).toBe(false);
        const context = await consume(h.source);
        expect(context.messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(Object.keys(context.tools).some(name => name.includes('-multi_open_file'))).toBe(true);
        expect(h.clients).toHaveLength(1);
        expect(h.clients[0].client.observe).toHaveBeenCalledTimes(1);
        await context.release!();
        h.source.dispose();
    });

    it('does not accumulate a session-wide invocation ledger over more than 256 rounds', async () => {
        const h = harness();
        for (let round = 0; round < 300; round++) {
            const context = await consume(h.source);
            const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, `call-${round}`);
            expect(result?.outcomeStatus).toBe('succeeded');
            await context.release!();
        }
        expect(h.clients).toHaveLength(1);
        expect(h.clients[0].client.releaseObservation).toHaveBeenCalledTimes(300);
        h.source.dispose();
    });

    it('isolates a interaction lookup failure to its App and preserves healthy Apps', async () => {
        const h = harness([app('one'), app('two')]);
        const create = h.kernel.getAppInteraction.getMockImplementation()!;
        h.kernel.getAppInteraction.mockImplementation((id, appId, instanceId) => {
            if (appId === 'two') throw new Error('cannot observe');
            return create(id, appId, instanceId);
        });
        const context = await consume(h.source);
        expect(context.tools['one-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['two-AnyView-multi_open_file']).toBeUndefined();
        expect(context.messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(context.messages.some(message => String(message.content).includes('current two revision 1'))).toBe(false);
        expect(context.messages.some(message => String(message.content).includes('AOTUI_APP_PROJECTION_FAILED'))).toBe(true);
        await context.release!();
        expect(h.clients[0].client.releaseObservation).toHaveBeenCalledWith('one-observation-1');

        h.source.dispose();
    });

    it('escapes a rejected observation diagnostic and keeps other Apps visible', async () => {
        const h = harness([app('one'), app('two')]);
        const create = h.kernel.getAppInteraction.getMockImplementation()!;
        h.kernel.getAppInteraction.mockImplementation((id, appId, instanceId) => {
            const scope = create(id, appId, instanceId);
            if (appId === 'two') scope.interaction.observe.mockResolvedValueOnce({
                status: 'rejected',
                issue: { code: 'SNAPSHOT_INVALID', message: 'Unexpected <value>&\nRetry', path: '$.<ref&>' },
            });
            return scope;
        });
        const context = await consume(h.source);
        try {
            expect(context.tools['one-AnyView-multi_open_file']).toBeDefined();
            expect(context.tools['two-AnyView-multi_open_file']).toBeUndefined();
            const messages = context.messages.map(message => String(message.content)).join('\n');
            expect(messages).toContain('current one revision 1');
            expect(messages).not.toContain('current two revision 1');
            expect(messages).toContain('Semantic status: SNAPSHOT_INVALID: Unexpected &lt;value&gt;&amp; Retry (at $.&lt;ref&amp;&gt;)');
        } finally {
            await context.release!();
            h.source.dispose();
        }
    });

    it('does not retarget or retry a call whose result is unknown', async () => {
        const h = harness(), context = await consume(h.source);
        h.clients[0].client.invoke.mockRejectedValueOnce(new Error('reply lost'));
        const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, 'uncertain');
        expect(result?.outcomeStatus).toBe('unknown');
        expect(h.clients[0].client.invoke).toHaveBeenCalledOnce();
        await context.release!(); h.source.dispose();
    });

    it('revokes a disabled app even for a previously captured context', async () => {
        const h = harness(), context = await consume(h.source);
        h.source.setAppEnabled('one', false);
        const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, 'after-disable');
        expect(result?.outcomeStatus).toBe('rejected');
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();

        await context.release!(); h.source.dispose();
    });

    it('bounds active contexts and disposes its subscription and observations', async () => {
        const h = harness();
        const listener = vi.fn(), unsubscribe = h.source.onUpdate(listener);
        for (const update of h.updates) update();
        expect(listener).toHaveBeenCalledOnce();
        const contexts = await Promise.all(Array.from({ length: 2 }, () => h.source.getContext()));
        await expect(h.source.getContext()).rejects.toThrow('SEMANTIC_CONTEXT_CAPACITY');
        h.source.dispose(); unsubscribe();
        expect(h.desktop.output.unsubscribe).toHaveBeenCalledTimes(1);
        expect(h.clients[0].client.releaseObservation).toHaveBeenCalledTimes(2);
        for (const context of contexts) await context.release!();

    });

    it('isolates an oversized Tool alias and restores the App after its declaration is corrected', async () => {
        const h = harness([app('good'), app('bad')]);
        h.observations.set('bad', observation('bad', 1, 'send_command_to_exist_terminal_with_an_extremely_long_suffix'));
        const invalid = await h.source.getContext();
        expect(invalid.tools['good-AnyView-multi_open_file']).toBeDefined();
        expect(invalid.tools['bad-AnyView-send_command_to_exist_terminal_with_an_extremely_long_suffix']).toBeUndefined();
        expect(invalid.messages.some(message => String(message.content).includes('current bad revision 1'))).toBe(false);
        expect(invalid.messages.some(message => String(message.content).includes('AOTUI_TOOL_NAME_INVALID'))).toBe(true);
        expect(h.clients.find(entry => entry.appId === 'bad')!.client.releaseObservation).toHaveBeenCalledOnce();

        h.observations.set('bad', observation('bad', 2, 'read'));
        await invalid.release!();
        const recovered = await consume(h.source);
        expect(recovered.tools['bad-AnyView-read']).toBeDefined();
        await invalid.release!(); await recovered.release!();
        h.source.dispose();
    });
});

describe('semantic receipt mapping', () => {
    it('unwraps ordinary completion and preserves the business error and recovery details through executeTool', async () => {
        const request = { invocationId: 'c', observationId: 'o', bindingId: 'b', input: {} };
        const completed = await executeMappedResult({ kind: 'receipt', receipt: receipt(request,
            { status: 'succeeded', value: { success: true, data: { message: 'Edited.', view_id: 'file' } } }) });
        expect(completed.result).toEqual({ message: 'Edited.', view_id: 'file' });
        const failed = await executeMappedResult({ kind: 'receipt', receipt: receipt(request, {
            status: 'unknown', code: 'TOOL_OUTCOME_UNKNOWN', message: 'uncertain', details: { kind: 'tool-result', phase: 'entered-returned',
                result: { success: false, error: { code: 'EDIT_NOT_MATCHED', message: 'Original text was not found.' }, data: { checked: 1 } } },
        }) });
        expect(failed).toMatchObject({ outcomeStatus: 'unknown', error: { code: 'EDIT_NOT_MATCHED', message: 'Original text was not found.' }, result: { checked: 1 } });
        expect(JSON.stringify([completed, failed])).not.toContain('receipt');
    });
    const outcomes: InvocationOutcome[] = [
        { status: 'succeeded', value: null }, { status: 'rejected', code: 'NO', message: 'rejected' },
        { status: 'failed', code: 'FAILED', message: 'failed', effects: 'partial' },
        { status: 'unknown', code: 'UNKNOWN', message: 'uncertain' },
    ];
    it.each(outcomes)('keeps $status internal without leaking a receipt', async outcome => {
        const value = receipt({ invocationId: 'call', observationId: 'obs', bindingId: 'binding', input: {} }, outcome);
        const result = await executeMappedResult({ kind: 'receipt', receipt: value });
        expect(result.outcomeStatus).toBe(outcome.status);
        expect(JSON.stringify(result)).not.toContain('observationId');
        expect(JSON.stringify(result)).not.toContain('receipt');
        expect(Boolean(result.error)).toBe(['rejected', 'failed', 'unknown'].includes(outcome.status));
        if (outcome.status === 'unknown') expect(result.error?.code).toBe('UNKNOWN');
        if (outcome.status === 'failed') expect(result.error?.message).toContain('Some changes were applied.');
    });
    it('distinguishes a known refusal from an unavailable execution result', async () => {
        expect((await executeMappedResult({ kind: 'refused', code: 'FULL', message: 'full' })).outcomeStatus).toBe('rejected');
        expect((await executeMappedResult({ kind: 'unavailable', code: 'GONE', message: 'gone' })).outcomeStatus).toBe('unknown');
    });
});

describe('model-visible presentation contract', () => {
    it('keeps Tools with the same name distinct across different View types', async () => {
        const h = harness(), source = observation('one', 1, 'inspect');
        h.observations.set('one', { ...source,
            views: [...source.views, { ...source.views[0]!, id: 'other', viewInstanceId: 'other-instance', type: 'OtherType' }],
            tools: [...source.tools, { ...source.tools[0]!, id: 'other-tool', viewType: 'OtherType',
                execution: { kind: 'view-type', activationId: 'other-activation' } }],
            bindings: [...source.bindings, { bindingId: 'other-binding', toolId: 'other-tool',
                execution: { kind: 'view-type', activationId: 'other-activation' } }],
        });
        const context = await consume(h.source);
        expect(Object.keys(context.tools).filter(name => name.endsWith('-inspect'))).toEqual(['one-AnyView-inspect', 'one-OtherType-inspect']);
        await context.release!(); h.source.dispose();
    });

    it('normalizes DOM and plain bodies once, preserves content and keeps instruction Views static', async () => {
        const h = harness(), source = observation('one');
        const body = '# Content\n\n```xml\n<record id="business">keep</record>\n```';
        h.observations.set('one', { ...source, views: [
            { ...source.views[0], kind: 'instruction', content: { format: 'markdown-v1', value: body } },
            { ...source.views[0], id: 'plain', viewInstanceId: 'plain-instance', content: { format: 'markdown-v1', value: body } },
        ], refs: [{ viewId: 'workspace', viewInstanceId: 'one-view', refId: 'items[0]', refType: 'Item', kind: 'snapshot-value' }] });
        const context = await consume(h.source);
        const views = context.messages.filter(message => String(message.content).startsWith('<view '));
        expect(views).toHaveLength(2);
        for (const message of views) {
            expect(String(message.content).match(/<view\b/g)).toHaveLength(1);
            expect(String(message.content).match(/<\/view>/g)).toHaveLength(1);
            expect(message.content).toContain('# Content\n\n```xml\n&lt;record id="business"&gt;keep&lt;/record&gt;\n```');
            expect(message.content).not.toMatch(/ instance=| revision=/);
            expect(message.content).toContain('app_id="one" app_name="one"');
        }
        expect(views.map(view => view.region)).toEqual(['static', 'dynamic']);
        expect(views[0].content).toContain('Available references: items[0] (Item)');
        expect(Object.keys(context.tools)).toContain('one-AnyView-multi_open_file');
        expect((context.tools['one-AnyView-multi_open_file'].inputSchema as any).jsonSchema).toEqual(source.tools[0].inputSchema);
        await context.release!(); h.source.dispose();
    });

    it('preserves literal View-like text and encodes metadata and opaque body once at the XML boundary', async () => {
        const h = harness(), source = observation('one');
        const body = '<view id="literal">body from file</view>';
        h.observations.set('one', { ...source, views: [{ ...source.views[0]!, name: 'foo>bar',
            content: { format: 'markdown-v1', value: body } }] });
        const context = await consume(h.source);
        const message = String(context.messages.find(item => String(item.content).startsWith('<view '))?.content);
        expect(message).toContain('name="foo&gt;bar"');
        expect(message).toContain('\n&lt;view id="literal"&gt;body from file&lt;/view&gt;\n</view>');
        expect(message.match(/<view\b/g)).toHaveLength(1);
        await context.release!(); h.source.dispose();
    });

    it('retains timestamps for unchanged content across unrelated revisions and releases presentation cache on disable', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
        const h = harness(), source = observation('one');
        const first = await h.source.getContext();
        await first.release!();
        clock.mockReturnValue(200);
        h.observations.set('one', { ...source, source: { ...source.source, revision: 2 } });
        const second = await h.source.getContext();
        expect(second.messages).toEqual(first.messages);
        await second.release!();
        h.observations.set('one', observation('one', 3));
        const changed = await h.source.getContext();
        expect(changed.messages.find(message => String(message.content).startsWith('<view '))?.timestamp).toBe(200);
        await changed.release!();
        h.source.setEnabled(false); h.source.setEnabled(true); clock.mockReturnValue(300);
        const resumed = await h.source.getContext();
        expect(resumed.messages.find(message => String(message.content).startsWith('<view '))?.timestamp).toBe(300);
        await resumed.release!(); h.source.dispose();
    });

    it('restores a bounded Desktop activity list without bypassing application visibility', async () => {
        const h = harness();
        h.desktop.getSystemLogs.mockReturnValue(Array.from({length: 8}, (_, i) => ({timestamp: i, message: `activity-${i}`})));
        const first = await h.source.getContext();
        const desktop = String(first.messages.find(message => String(message.content).startsWith('<desktop>'))?.content);
        expect(desktop).toContain('## Installed TUI Applications');
        expect(desktop).toContain('App ID: one');
        expect(desktop).toContain('## System Logs');
        expect(desktop).not.toContain('activity-2');
        expect(desktop).toContain('activity-3'); expect(desktop).toContain('activity-7');
        await first.release!();
        h.source.setAppEnabled('one', false);
        const hidden = await h.source.getContext();
        expect(JSON.stringify(hidden.messages)).not.toContain('activity-');
        expect(JSON.stringify(hidden.messages)).toContain('No applications enabled for this context.');
        expect(JSON.stringify(hidden.messages)).not.toContain('No applications installed.');
        expect(JSON.stringify(hidden.messages)).toContain('logs are hidden');
        expect(hidden.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(0);
        expect(Object.keys(hidden.tools)).toHaveLength(0);
        await hidden.release!(); h.source.dispose();
    });

    it('reports an uninstalled Desktop separately from a filtered Desktop', async () => {
        const h = harness([]), context = await consume(h.source);
        expect(JSON.stringify(context.messages)).toContain('No applications installed.');
        expect(JSON.stringify(context.messages)).not.toContain('No applications enabled');
        await context.release!(); h.source.dispose();
    });

    it('honors instruction text, path, environment, fallback and opt-out', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'aotui-instruction-'));
        try {
            const path = join(directory, 'path.md'), env = join(directory, 'env.md');
            writeFileSync(path, 'path instruction'); writeFileSync(env, 'environment instruction');
            vi.stubEnv('AOTUI_SYSTEM_INSTRUCTION_PATH', env);
            for (const [options, expected] of [
                [{ instruction: ' direct instruction ', instructionPath: path }, 'direct instruction'],
                [{ instruction: ' ', instructionPath: path }, 'path instruction'],
                [{}, 'environment instruction'],
                [{ includeInstruction: false }, undefined],
            ] as const) {
                const h = harness([], options), context = await consume(h.source);
                expect(context.messages.find(message => message.region === 'static')?.content).toBe(expected);
                await context.release!(); h.source.dispose();
            }
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const h = harness([], { instructionPath: join(directory, 'missing') }), context = await consume(h.source);
            expect(context.messages[0].content).toBe(DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
            await context.release!(); h.source.dispose();
        } finally { rmSync(directory, {recursive: true, force: true}); }
    });

    it('exposes one ViewType binding for many Views and passes business IDs to the application unchanged', async () => {
        const h = harness(), source = observation('one');
        const schema = { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'], additionalProperties: false };
        const single = { ...source, tools: [{ ...source.tools[0]!, inputSchema: schema }] };
        h.observations.set('one', single);
        const one = await h.source.getContext(), name = 'one-AnyView-multi_open_file';
        h.observations.set('one', { ...single, observationId: 'two-views',
            views: [...source.views, { ...source.views[0]!, id: 'second', viewInstanceId: 'second-instance' }],
        });
        const two = await consume(h.source);
        expect(Object.keys(two.tools).filter(key => key.endsWith('-multi_open_file'))).toEqual([name]);
        expect((one.tools[name].inputSchema as any).jsonSchema).toEqual(schema);
        expect((two.tools[name].inputSchema as any).jsonSchema).toEqual(schema);
        await two.executeTool!(name, { filePath: '/b.txt' }, 'business-id');
        expect(h.clients[0].client.invoke).toHaveBeenCalledWith(expect.objectContaining({
            observationId: 'two-views', bindingId: 'one-binding-1', input: { filePath: '/b.txt' },
        }));
        await one.release!(); await two.release!(); h.source.dispose();
    });

    it('rejects retired instance-owned Tool bindings before dispatch', async () => {
        const h = harness(), source = observation('one');
        const first = { viewId: 'workspace', viewInstanceId: 'one-view', bindingVersion: 1, selector: { param: 'filePath', value: '/a.txt' } };
        const other = { viewId: 'second', viewInstanceId: 'second-instance', bindingVersion: 2, selector: { param: 'filePath', value: '/b.txt' } };
        const execution = { kind: 'view-instance' as const, targets: [first] };
        const tool = { ...source.tools[0]!, inputSchema: {
            type: 'object', properties: { filePath: { type: 'string' }, item: { type: 'object' } },
            required: ['filePath', 'item'], additionalProperties: false,
        },  execution };
        h.observations.set('one', { ...source,
            tools: [{ ...tool, execution: { kind: 'view-instance', targets: [first, other] } }],
            bindings: [
                { bindingId: 'first-binding', toolId: 'tool', execution: { kind: 'view-instance', target: first } },
                { bindingId: 'second-binding', toolId: 'tool', execution: { kind: 'view-instance', target: other } },
            ],
            views: [...source.views, { ...source.views[0]!, id: 'second', viewInstanceId: 'second-instance' }],
        });
        const context = await consume(h.source), name = 'one-AnyView-multi_open_file';
        expect(context.tools[name]).toBeUndefined();
        expect(JSON.stringify(context.messages)).toContain('TOOL_SOURCE_CONFLICT');
        expect(await context.executeTool!(name, { filePath: '/unseen.txt', item: {} }, 'unseen')).toBeUndefined();
        expect(await context.executeTool!(name, { filePath: '/a.txt', item: {} }, 'first')).toBeUndefined();
        expect(await context.executeTool!(name, { filePath: '/b.txt', item: {} }, 'second')).toBeUndefined();
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        await context.release!(); h.source.dispose();
    });

    it('assigns cross-App alias collisions deterministically and keeps unrelated Apps usable', async () => {
        const h = harness([{ ...app('two'), name: 'same' }, { ...app('one'), name: 'same' }, app('healthy')]);
        const context = await consume(h.source);
        expect(context.tools['same-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(context.messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(context.messages.some(message => String(message.content).includes('current two revision 1'))).toBe(false);
        expect(context.messages.some(message => String(message.content).includes('current healthy revision 1'))).toBe(true);
        expect(context.messages.some(message => String(message.content).includes('AOTUI_TOOL_NAME_COLLISION'))).toBe(true);
        await context.executeTool!('same-AnyView-multi_open_file', {}, 'winner');
        await context.executeTool!('healthy-AnyView-multi_open_file', {}, 'healthy');
        expect(h.clients.find(entry => entry.appId === 'one')!.client.invoke).toHaveBeenCalledOnce();
        expect(h.clients.find(entry => entry.appId === 'healthy')!.client.invoke).toHaveBeenCalledOnce();
        expect(h.clients.find(entry => entry.appId === 'two')!.client.releaseObservation).toHaveBeenCalledOnce();
        await context.release!();

        h.source.dispose();
    });

    it('rejects a hyphen inside ViewType without taking down healthy Apps', async () => {
        const h = harness([app('bad'), app('healthy')]);
        const source = observation('bad');
        h.observations.set('bad', { ...source, tools: [{ ...source.tools[0]!, viewType: 'A-B', name: 'read' }] });
        const context = await consume(h.source);
        expect(context.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['bad-A-B-read']).toBeUndefined();
        const desktop = String(context.messages.find(message => String(message.content).startsWith('<desktop>'))?.content);
        expect(desktop).toContain('AOTUI_TOOL_NAME_INVALID: viewType');
        expect(desktop).toContain('Replace hyphens or other separators with underscores.');
        await context.release!();
        h.source.dispose();
    });

    it('rejects a hyphen inside Tool name with a field-specific repair hint', async () => {
        const h = harness([app('healthy'), app('bad')]);
        const source = observation('bad');
        h.observations.set('bad', { ...source, tools: [{ ...source.tools[0]!, name: 'read-file' }] });
        const context = await consume(h.source);
        expect(context.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['bad-AnyView-read-file']).toBeUndefined();
        const desktop = String(context.messages.find(message => String(message.content).startsWith('<desktop>'))?.content);
        expect(desktop).toContain('AOTUI_TOOL_NAME_INVALID: toolName');
        expect(desktop).toContain('Replace hyphens or other separators with underscores.');
        await context.release!(); h.source.dispose();
    });

    it.each(['has space', 'has-hyphen', '名字', 'has/slash'])('isolates invalid App name %s without sanitizing it', async name => {
        const h = harness([app('healthy'), { ...app('bad'), name }]);
        const context = await consume(h.source);
        expect(context.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(Object.keys(context.tools).some(tool => tool.startsWith('bad-'))).toBe(false);
        const desktop = String(context.messages.find(message => String(message.content).startsWith('<desktop>'))?.content);
        expect(desktop).toContain('AOTUI_TOOL_NAME_INVALID: appName');
        expect(desktop).toContain('Replace hyphens or other separators with underscores.');
        await context.release!();
        h.source.dispose();
    });

    it('isolates an invalid Tool schema and recovers after the declaration is corrected', async () => {
        const h = harness([app('healthy'), app('bad')]);
        const source = observation('bad');
        h.observations.set('bad', { ...source, tools: [{ ...source.tools[0]!, inputSchema: null as never }] });
        const invalid = await h.source.getContext();
        expect(invalid.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(invalid.tools['bad-AnyView-multi_open_file']).toBeUndefined();
        expect(invalid.messages.some(message => String(message.content).includes('current bad revision 1'))).toBe(false);
        expect(invalid.messages.some(message => String(message.content).includes('AOTUI_TOOL_SCHEMA_INVALID'))).toBe(true);
        h.observations.set('bad', observation('bad', 2));
        await invalid.release!();
        const recovered = await consume(h.source);
        expect(recovered.tools['bad-AnyView-multi_open_file']).toBeDefined();
        await invalid.release!(); await recovered.release!();
        h.source.dispose();
    });

    it('preserves the original binding after a candidate projection fails', async () => {
        const h = harness([app('healthy'), app('bad')]);
        const previous = await consume(h.source);
        const badClient = h.clients.find(entry => entry.appId === 'bad')!.client;
        h.observations.set('bad', { ...observation('bad', 2), tools: [
            { ...observation('bad', 2).tools[0]!, name: 'bad-tool' },
        ] });
        const current = await h.source.getContext();
        expect(current.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(current.tools['bad-AnyView-bad-tool']).toBeUndefined();
        expect(badClient.releaseObservation).toHaveBeenCalledWith('bad-observation-2');

        await previous.executeTool!('bad-AnyView-multi_open_file', {}, 'prior-binding');
        expect(badClient.invoke).toHaveBeenCalledOnce();
        await previous.release!();

        await current.release!(); h.source.dispose();
    });

    it.each([63, 64, 65])('validates the full composite length at %i characters', async length => {
        const h = harness(), name = 'x'.repeat(length - 'one-AnyView-'.length);
        h.observations.set('one', observation('one', 1, name));
        if (length > 64) {
            const context = await consume(h.source);
            expect(context.tools[`one-AnyView-${name}`]).toBeUndefined();
            expect(context.messages.some(message => String(message.content).includes('AOTUI_TOOL_NAME_INVALID'))).toBe(true);
            await context.release!();
        }
        else {
            const context = await consume(h.source);
            expect(context.tools[`one-AnyView-${name}`]).toBeDefined();
            await context.release!();
        }
        h.source.dispose();
    });

    it('uses the Legacy Desktop instruction verbatim by default', async () => {
        vi.stubEnv('AOTUI_SYSTEM_INSTRUCTION_PATH', undefined);
        const h = harness(), context = await consume(h.source);
        expect(context.messages[0].content).toBe(DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
        await context.release!(); h.source.dispose();
    });
});
