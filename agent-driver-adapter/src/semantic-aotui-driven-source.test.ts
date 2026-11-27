import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource } from './semantic-aotui-driven-source.js';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from '@aotui/runtime/adapters';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticAOTUIDrivenSourceOptions } from './semantic-aotui-driven-source.js';
import type { ActiveTurn, IDesktop, AppDiscoveryInfo, ObservationCandidate, TurnSelection, UpdateSignal } from '@aotui/runtime';
import type { AppWindows } from '@aotui/runtime';
import { createCandidateScope } from '../../runtime/src/engine/core/candidate-scope.js';
import { createProviderToolSchemaPolicy, type MeasureModelRequest } from '@aotui/agent-driver-v2';
import type { Observation, ObservationOptions } from '@aotui/core';
import type { InvocationOutcome, InvocationReceipt, InvokeResult, AppInvocation } from '@aotui/core';

const app = (id: string, status: AppDiscoveryInfo['status'] = 'running', appInstanceId: string | null =
    status === 'pending' || status === 'closed' ? null : `${id}-instance`): AppDiscoveryInfo => ({ installationId: id, name: id, status,
        ...(appInstanceId === null ? {} : { appId: id as any, appInstanceId }) });
function observation(appId: string, revision = 1, name = 'multi_open_file'): Observation {
    return {
        observationId: `${appId}-observation-${revision}`,
        source: { appId, instanceId: `${appId}-instance`, snapshotId: `${appId}-snapshot-${revision}`, revision },
        views: [{ id: 'workspace', viewInstanceId: `${appId}-view`, type: 'AnyView', name: 'Workspace', region: 'dynamic',
            content: { format: 'markdown-v1', value: `current ${appId} revision ${revision}` } }],
        refs: [], tools: [{ multiplicity: 'single', id: 'tool', name, viewType: 'AnyView', description: 'Current View Tool',
            inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
    };
}
function receipt(request: AppInvocation, outcome: InvocationOutcome = { status: 'succeeded', value: null }): InvocationReceipt {
    return { invocationId: request.invocationId, observationId: request.observationId, operation: {kind:"tool", toolId:request.toolId},
        source: null, completedAt: 1, expiresAt: 60001, executionPhase: 'entered-returned', outcome };
}
function harness(installed = [app('one')], options: SemanticAOTUIDrivenSourceOptions = {}) {
    const observations = new Map(installed.map(item => [String(item.appId ?? item.installationId), observation(String(item.appId ?? item.installationId))]));
    const updates = new Set<(signal: UpdateSignal) => void>();
    type Probe = { appId: string; client: ReturnType<typeof clientFor> };
    const clients: Probe[] = [];
    const owners = new WeakMap<ObservationCandidate, { appId: string; cleanup(): void }>();
    let current: ActiveTurn | undefined;
    const adoptedCandidates = new WeakSet<ObservationCandidate>();
    function clientFor(appId: string) {
        const results = new Map<string, InvocationReceipt>();
        const release = vi.fn();
        return {
            observe: vi.fn(async (options?: ObservationOptions) => {
                const captured = observations.get(appId)!;
                const observation = options?.excludeToolIds?.length
                    ? { ...captured, observationId: captured.observationId + '-narrow',
                        tools: captured.tools.filter(tool => !options.excludeToolIds!.includes(tool.id)) } : captured;
                let removed = false;
                const discard = () => { if (!removed) { removed = true; release(observation.observationId); } return []; };
                const candidate: ObservationCandidate = { observation, discard: () => adoptedCandidates.has(candidate) ? [] : discard() };
                owners.set(candidate, { appId, cleanup: discard });
                return { status: 'prepared', candidate };
            }),
            preview: vi.fn(), readReceipt: vi.fn(), release,
            invoke: vi.fn(async (request: AppInvocation, _timeout?: number, _signal?: AbortSignal) => {
                if (results.has(request.invocationId)) return { kind: 'receipt', receipt: results.get(request.invocationId)! };
                const value = receipt(request); results.set(request.invocationId, value);
                return { kind: 'receipt', receipt: value };
            }),
        };
    }
    const desktop = {
        createCandidateScope: vi.fn(createCandidateScope),
        id: 'desktop', listApps: vi.fn(() => installed), getAppWindows: vi.fn((): AppWindows | undefined => undefined),
        adoptTurn: vi.fn((selection: TurnSelection) => {
            const previous = current;
            previous?.release();
            const byApp = new Map(selection.apps.map(({ candidate }) => [owners.get(candidate)!.appId, candidate]));
            for (const candidate of byApp.values()) adoptedCandidates.add(candidate);
            const turn = {
                get isCurrent() { return current === turn; },
                invoke: (appId: string, request: AppInvocation, timeout?: number, signal?: AbortSignal) =>
                    clients.find(client => client.appId === appId)!.client.invoke(request, timeout, signal),
                readPublicRefs: async () => ({ status: 'ready', refs: [] }),
                release() {
                    if (current === turn) {
                        current = undefined;
                        for (const candidate of byApp.values()) owners.get(candidate)!.cleanup();
                    }
                    return [];
                },
            } as unknown as ActiveTurn;
            current = turn;
            return { status: 'adopted', turn, cleanupIssues: [] };
        }),
        getSystemLogs: vi.fn((): Array<{timestamp: number; message: string}> => []),
        openApp: vi.fn(async (id: string) => { installed.splice(installed.findIndex(item => item.installationId === id), 1, app(id)); return { appId: id }; }),
        beginAppClose: vi.fn(async (_appId: string, _instance: string) => ({ ok: true, resourcesReleased: true })),
        beginCloseApp: (appId: string, instanceId: string) => ({ completion: desktop.beginAppClose(appId, instanceId) }),
        revokeWindowAccess: vi.fn((_turn: ActiveTurn, _target: { appId: string; instanceId: string }) => {}),
        output: { subscribe: vi.fn((listener: (signal: UpdateSignal) => void) => updates.add(listener)),
            unsubscribe: vi.fn((listener: (signal: UpdateSignal) => void) => updates.delete(listener)) },
        getRunningApp: vi.fn((appId: string, instanceId: string) => {
            let probe = clients.find(entry => entry.appId === appId);
            if (!probe) { probe = { appId, client: clientFor(appId) }; clients.push(probe); }
            return { status: 'ready', app: { ...probe.client, appId, instanceId, beginClose: () => ({ completion: desktop.beginAppClose(appId, instanceId) }) } };
        }),
    };
    const source = new SemanticAOTUIDrivenSource(desktop as unknown as IDesktop, options);
    return { source, desktop, observations, clients, installed, updates };
}
async function consume(source: SemanticAOTUIDrivenSource) {
    const context = await source.getContext(); await context.adopt!(); return context;
}
const findTool = (context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>, fragment: string) => {
    const name = Object.keys(context.tools).find(name => name.includes(fragment));
    expect(name).toBeDefined(); return name!;
};
const openApp = 'system-open_app', closeApp = 'system-close_app';
function baseControls(context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>) {
    return [openApp, closeApp].map(name => {
        const tool = context.tools[name];
        const field = name === openApp ? 'installation_id' : 'app_id';
        expect(tool?.description).toContain(field);
        const { jsonSchema } = tool!.inputSchema as { jsonSchema: unknown };
        expect(jsonSchema).toEqual({ type: 'object', properties: { [field]: { type: 'string' } },
            required: [field], additionalProperties: false });
        return { name, description: tool!.description, jsonSchema };
    });
}
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
        expect(h.desktop.beginAppClose).not.toHaveBeenCalled();
        await first.executeTool!(name, {}, 'before');
        expect(h.clients[0].client.invoke).toHaveBeenCalledTimes(1);
        await preview.adopt!(); await preview.adopt!();
        expect(h.desktop.adoptTurn).toHaveBeenCalledTimes(2);
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
        h.desktop.adoptTurn.mockReturnValueOnce({ status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' } } as never);
        expect(() => next.adopt!()).toThrow(expect.objectContaining({ code: 'SEMANTIC_ADOPTION_FAILED' }));

        expect((await first.executeTool!(name, {}, 'still-current'))?.outcomeStatus).toBe('succeeded');
        expect((await next.executeTool!(name, {}, 'failed'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        await first.release!(); h.source.dispose();
    });

    it('reports an adoption cleanup issue and keeps the new turn usable', async () => {
        const cleanup = { code: 'OBSERVATION_INTERNAL_ERROR', message: 'retirement failed' };
        const onCleanupIssues = vi.fn();
        const h = harness([app('one')], { onCleanupIssues });
        const adopt = h.desktop.adoptTurn.getMockImplementation()!;
        h.desktop.adoptTurn.mockImplementationOnce(selection => ({ ...adopt(selection), cleanupIssues: [cleanup] }));
        const context = await consume(h.source);
        expect(onCleanupIssues).toHaveBeenCalledExactlyOnceWith([cleanup]);
        expect(await context.executeTool!('one-AnyView-multi_open_file', {}, 'after-cleanup')).toMatchObject({ outcomeStatus: 'succeeded' });
        await context.release!();
        await h.source.dispose();
    });

    it('retains the original adoption rejection when candidate cleanup also reports failure', async () => {
        const h = harness();
        const cleanup = { code: 'OBSERVATION_INTERNAL_ERROR', message: 'release failed' };
        const scope = createCandidateScope();
        h.desktop.createCandidateScope.mockReturnValueOnce({
            ...scope, discard: () => { scope.discard(); return [cleanup]; },
        });
        const context = await h.source.getContext();
        const rejected = { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' };
        h.desktop.adoptTurn.mockReturnValueOnce({ status: 'rejected', issue: rejected } as never);
        expect(() => context.adopt!()).toThrow(expect.objectContaining({
            code: cleanup.code, issues: [cleanup],
            cause: expect.objectContaining({ code: 'SEMANTIC_ADOPTION_FAILED', cause: rejected }),
        }));
        expect(h.clients[0]?.client.release).toHaveBeenCalledOnce();
        await h.source.dispose();
    });

    it('submits the complete list and keeps the old turn on an invalid App candidate', async () => {
        const h = harness([app('one'), app('two')]), first = await consume(h.source);
        const next = await h.source.getContext();
        h.desktop.adoptTurn.mockReturnValueOnce({ status: 'rejected', issue: { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' } } as never);
        expect(() => next.adopt!()).toThrow(expect.objectContaining({ code: 'SEMANTIC_ADOPTION_FAILED',
            cause: { code: 'OBSERVATION_UNAVAILABLE', message: 'gone' } }));
        expect(h.desktop.adoptTurn.mock.calls[1]?.[0].apps).toHaveLength(2);
        expect((await first.executeTool!('one-AnyView-multi_open_file', {}, 'old'))?.outcomeStatus).toBe('succeeded');
        for (const item of h.clients) expect(item.client.release).toHaveBeenCalled();
        await next.release!(); await h.source.dispose();
    });
    it('projects multiple App instances and opens pending apps through the Desktop lifecycle', async () => {
        const h = harness([app('one'), app('two'), app('pending', 'pending')]);
        const context = await consume(h.source);
        const one = findTool(context, 'one-'), two = findTool(context, 'two-');
        expect(one).not.toBe(two);
        expect(context.tools.aotui_read_receipt).toBeUndefined();
        expect(context.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(2);
        expect(context.messages.some(message => String(message.content).includes('installation_id: pending'))).toBe(true);
        for (const entry of h.clients) expect(entry.client.observe).toHaveBeenCalledWith(undefined);
        await context.executeTool!(one, {}, 'one-call');
        await context.executeTool!(two, {}, 'two-call');
        expect(h.clients[0].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'one-observation-1', toolId: 'tool' }), undefined, undefined);
        expect(h.clients[1].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'two-observation-1', toolId: 'tool' }), undefined, undefined);
        expect((await context.executeTool!('system-open_app', { installation_id: 'pending' }, 'open'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.openApp).toHaveBeenCalledWith('pending');
        await context.release!();
        const next = await h.source.getContext();
        expect(Object.keys(next.tools).some(name => name.includes('pending-'))).toBe(true);
        await next.release!(); h.source.dispose();
    });

    it('keeps open and close definitions stable while checking captured targets and current state', async () => {
        const h = harness([app('one'), app('two', 'pending')]);
        const first = await consume(h.source);
        const definitions = baseControls(first);
        const getter = vi.fn(() => 'one');
        for (const args of [{}, { app_id: 1 }, { app_id: 'one', extra: true }, Object.assign(Object.create({ app_id: 'one' }), { extra: true }),
            Object.defineProperty({}, 'app_id', { enumerable: true, get: getter })]) {
            expect(await first.executeTool!(closeApp, args, 'malformed')).toMatchObject({
                outcomeStatus: 'rejected', error: { code: 'INVALID_APP_TARGET' },
            });
        }
        expect(getter).not.toHaveBeenCalled();
        h.installed[1] = app('two', 'running');
        expect((await first.executeTool!(openApp, { installation_id: 'two' }, 'changed'))?.error?.code).toBe('APP_STATE_CHANGED');
        await first.release!();

        for (const [apps, rejected] of [
            [[], [openApp, closeApp]],
            [[app('one')], [openApp]],
            [[app('one', 'pending')], [closeApp]],
            [[app('one', 'closed')], [closeApp]],
            [[app('one', 'running', null)], [openApp, closeApp]],
        ] as const) {
            h.installed.splice(0, h.installed.length, ...apps);
            const current = await consume(h.source);
            expect(baseControls(current)).toEqual(definitions);
            for (const name of rejected) {
                expect(await current.executeTool!(name, { [name === openApp ? 'installation_id' : 'app_id']: 'one' }, 'ineligible')).toMatchObject({
                    outcomeStatus: 'rejected', error: { code: 'INVALID_APP_TARGET',
                        message: expect.stringContaining(name === openApp ? 'installation_id' : 'app_id') },
                });
            }
            await current.release!();
        }
        expect(h.desktop.openApp).not.toHaveBeenCalled();
        expect(h.desktop.beginAppClose).not.toHaveBeenCalled();
        h.source.dispose();
    });

    it.each(['retitle', 'remount', 'close'] as const)('checks real mount eligibility during request adoption (%s)', async change => {
        const h = harness();
        let views: AppWindows['views'] = [{ viewId: 'workspace', viewInstanceId: 'one-view',
            type: 'AnyView', name: 'Workspace', region: 'dynamic', canClose: true }];
        h.desktop.getAppWindows.mockImplementation(() => ({ appId: 'one', instanceId: 'one-instance', views }));
        const prepared = await h.source.getContext();
        views = change === 'close' ? [] : [{ ...views[0]!, name: 'Updated title',
            ...(change === 'remount' ? { viewInstanceId: 'replacement' } : {}) }];
        try {
            if (change === 'retitle') {
                await prepared.adopt!();
                expect(h.desktop.adoptTurn).toHaveBeenCalledOnce();
            } else {
                expect(() => prepared.adopt!()).toThrow(expect.objectContaining({ code: 'SEMANTIC_WINDOW_CHANGED' }));
                expect(h.desktop.adoptTurn).not.toHaveBeenCalled();
            }
        } finally {
            await prepared.release?.();
            h.source.dispose();
        }
    });

    it.each(['retitle', 'remount', 'close'] as const)('checks real mount eligibility during expansion preflight (%s)', async change => {
        const h = harness();
        let views: AppWindows['views'] = [{ viewId: 'workspace', viewInstanceId: 'one-view',
            type: 'AnyView', name: 'Workspace', region: 'dynamic', canClose: true }];
        h.desktop.getAppWindows.mockImplementation(() => ({ appId: 'one', instanceId: 'one-instance', views }));
        const open = await consume(h.source);
        const target = { app_id: 'one', view_id: 'workspace' };
        expect(await open.executeTool!('system-collapse_view', { ...target, note: 'keep' }, 'collapse'))
            .toMatchObject({ outcomeStatus: 'succeeded' });
        const collapsed = await consume(h.source);
        const checkExpansion = vi.fn(async () => {
            if (change === 'close') views = [];
            else views = [{ ...views[0]!, name: 'Updated title',
                ...(change === 'remount' ? { viewInstanceId: 'replacement' } : {}) }];
            return { method: 'utf8-bytes' as const, inputBytes: 10, safety: 0, estimated: 10, inputLimit: 100, outputReserved: 10 };
        });
        try {
            const result = await collapsed.executeTool!('system-expand_view', target, 'expand', { checkExpansion });
            expect(checkExpansion).toHaveBeenCalledOnce();
            if (change === 'retitle') expect(result).toMatchObject({ outcomeStatus: 'succeeded' });
            else expect(result?.error?.code).toBe('VIEW_STATE_CHANGED');
        } finally {
            await collapsed.release?.();
            h.source.dispose();
        }
    });

    it('binds close, collapse and expand to the observed instance and keeps the layout in the Source', async () => {
        const h = harness(), originalId = h.installed[0].appInstanceId!;
        h.desktop.getAppWindows.mockImplementation((appId?: string, instanceId?: string) => ({
            appId: appId!, instanceId: instanceId!, views: [],
        }));
        const running = await consume(h.source);
        expect(running.tools['system-expand_app']).toBeUndefined();
        h.installed[0] = app('one', 'running', 'successor-instance');
        for (const [name, callId] of [['system-close_app', 'old-close'], ['system-collapse_app', 'old-collapse']] as const) {
            const result = await running.executeTool!(name, { app_id: 'one' }, callId);
            expect(result?.error?.code).toBe('APP_INSTANCE_CHANGED');
        }
        expect(h.desktop.beginAppClose).not.toHaveBeenCalled();
        expect(h.desktop.revokeWindowAccess).not.toHaveBeenCalled();

        h.installed[0] = app('one', 'running', originalId);
        expect((await running.executeTool!('system-collapse_app', { app_id: 'one' }, 'original-collapse'))?.outcomeStatus).toBe('succeeded');
        const collapsed = await consume(h.source);
        expect(collapsed.tools['system-collapse_app']).toBeUndefined();
        expect((collapsed.tools['system-expand_app']!.inputSchema as { jsonSchema: unknown }).jsonSchema)
            .toMatchObject({ properties: { app_id: { type: 'string' } } });
        h.installed[0] = app('one', 'running', 'successor-instance');
        const staleShow = await collapsed.executeTool!('system-expand_app', { app_id: 'one' }, 'old-show');
        expect(staleShow?.error?.code).toBe('APP_INSTANCE_CHANGED');

        const latest = await consume(h.source);
        expect(latest.tools['system-expand_app']).toBeUndefined();
        expect((await latest.executeTool!('system-collapse_app', { app_id: 'one' }, 'fresh-collapse'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.revokeWindowAccess).toHaveBeenLastCalledWith(expect.objectContaining({ isCurrent: true }),
            { appId: 'one', instanceId: 'successor-instance' }, 'all');
        const freshFolded = await consume(h.source);
        expect((await freshFolded.executeTool!('system-expand_app', { app_id: 'one' }, 'fresh-show'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.revokeWindowAccess).toHaveBeenCalledTimes(2);
        const freshRunning = await consume(h.source);
        expect((await freshRunning.executeTool!('system-close_app', { app_id: 'one' }, 'fresh-close'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.beginAppClose).toHaveBeenCalledWith('one', 'successor-instance');

        h.installed[0] = app('one', 'running', null);
        const withoutIdentity = await consume(h.source);
        expect(withoutIdentity.tools[closeApp]).toBeDefined();
        expect((await withoutIdentity.executeTool!(closeApp, { app_id: 'one' }, 'no-instance'))?.error?.code).toBe('INVALID_APP_TARGET');
        expect(h.desktop.beginAppClose).toHaveBeenCalledOnce();
        expect(withoutIdentity.tools['system-collapse_app']).toBeUndefined();
        for (const context of [running, collapsed, latest, freshFolded, freshRunning, withoutIdentity]) await context.release!();
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
        expect(h.desktop.beginAppClose).toHaveBeenCalledOnce();
        expect(h.desktop.beginAppClose).toHaveBeenCalledWith('healthy', 'healthy-instance');
        expect(badIdentityReads).toBe(0);
        const bad = await context.executeTool!('system-close_app', { app_id: 'bad' }, 'bad-close');
        expect(bad?.error?.code).toBe('APP_STATE_CHANGED');
        expect(h.desktop.beginAppClose).toHaveBeenCalledOnce();
        expect(badIdentityReads).toBe(1);
        await context.release!(); h.source.dispose();
    });

    it('distinguishes stale admission, known failures and unconfirmed close', async () => {
        const h = harness(), context = await consume(h.source);
        h.desktop.beginAppClose.mockRejectedValueOnce(Object.assign(new Error('stale'), { code: 'APP_INSTANCE_CHANGED' }));
        expect(await context.executeTool!('system-close_app', { app_id: 'one' }, 'admission-race')).toMatchObject({
            outcomeStatus: 'rejected', error: { code: 'APP_INSTANCE_CHANGED' },
        });
        h.desktop.beginAppClose.mockResolvedValueOnce({ ok: false, resourcesReleased: true });
        expect(await context.executeTool!('system-close_app', { app_id: 'one' }, 'confirmed-failure')).toMatchObject({
            outcomeStatus: 'failed', error: { code: 'APP_CLOSE_FAILED' }, result: { resources_released: true },
        });
        h.desktop.beginAppClose.mockRejectedValueOnce(new Error('cleanup failed'));
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
        expect(h.clients[0].client.invoke.mock.calls.map(args => args[0].toolId)).toEqual(['tool', 'tool']);
        await first.release!();

        expect((await first.executeTool!(tool, {}, 'late'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect(h.clients[0].client.invoke).toHaveBeenCalledTimes(2);
        await second.release!();

        h.source.dispose();
    });

    it('supports a ready app with no views or view tools', async () => {
        const h = harness(), empty = observation('one');
        h.observations.set('one', { ...empty, views: [], refs: [], tools: [] });
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
        expect(h.clients[0].client.release).toHaveBeenCalledTimes(300);
        h.source.dispose();
    });

    it('isolates a interaction lookup failure to its App and preserves healthy Apps', async () => {
        const h = harness([app('one'), app('two')]);
        const create = h.desktop.getRunningApp.getMockImplementation()!;
        h.desktop.getRunningApp.mockImplementation((appId, instanceId) => {
            if (appId === 'two') throw new Error('cannot observe');
            return create(appId, instanceId);
        });
        const context = await consume(h.source);
        expect(context.tools['one-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['two-AnyView-multi_open_file']).toBeUndefined();
        expect(context.messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(context.messages.some(message => String(message.content).includes('current two revision 1'))).toBe(false);
        expect(context.messages.some(message => String(message.content).includes('AOTUI_APP_PROJECTION_FAILED'))).toBe(true);
        await context.release!();
        expect(h.clients[0].client.release).toHaveBeenCalledWith('one-observation-1');

        h.source.dispose();
    });

    it('escapes a rejected observation diagnostic and keeps other Apps visible', async () => {
        const h = harness([app('one'), app('two')]);
        const create = h.desktop.getRunningApp.getMockImplementation()!;
        h.desktop.getRunningApp.mockImplementation((appId, instanceId) => {
            const scope = create(appId, instanceId);
            if (appId === 'two') scope.app.observe.mockResolvedValueOnce({
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

    it('passes native cancellation to the original App invocation and preserves its receipt locator', async () => {
        const remember = vi.fn();
        const h = harness(undefined, { onReceiptPending: remember }), context = await consume(h.source);
        const name = findTool(context, '-multi_open_file'), signal = new AbortController().signal;
        expect(context.toolsSettlingOnAbort?.has(name)).toBe(true);
        expect(context.toolsSettlingOnAbort?.has('run_code')).toBe(true);
        h.clients[0].client.invoke.mockResolvedValueOnce({ kind: 'unavailable', code: 'INVOCATION_WAIT_CANCELLED', message: 'wait cancelled', locator: {desktopId:'desktop',appId:'one',instanceId:'one-instance',observationId:'one-observation-1',invocationId:'original-native'} });
        const result = await context.executeTool!(name, {}, 'original-native', undefined, signal);
        const [request, , passedSignal] = h.clients[0].client.invoke.mock.calls[0]!;
        expect(request).not.toHaveProperty('inputMode');
        expect(passedSignal).toBe(signal);
        expect(result?.outcomeStatus).toBe('unknown');
        expect(remember).toHaveBeenCalledWith(expect.objectContaining({ observationId: request.observationId,
            invocationId: 'original-native' }), result, undefined);
        await context.release!(); await h.source.dispose();
    });

    it('revokes a disabled app even for a previously captured context', async () => {
        const h = harness(), context = await consume(h.source);
        h.source.setAppEnabled('one', false);
        const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, 'after-disable');
        expect(result?.outcomeStatus).toBe('rejected');
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        expect((await context.executeTool!(closeApp, { app_id: 'one' }, 'after-disable-close'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect(h.desktop.beginAppClose).not.toHaveBeenCalled();

        await context.release!(); h.source.dispose();
    });

    it('bounds active contexts and disposes its subscription and observations', async () => {
        const h = harness();
        const listener = vi.fn(), unsubscribe = h.source.onUpdate(listener);
        const send = (reason: UpdateSignal['reason'], instanceId = 'one-instance') => {
            for (const update of h.updates) update({ desktopId: h.desktop.id, appId: 'one' as UpdateSignal['appId'], instanceId, reason, timestamp: 0 });
        };
        send('view_updated');
        send('app_opened');
        send('projection_failed');
        send('attention_requested', 'old-instance');
        expect(listener).not.toHaveBeenCalled();
        send('attention_requested');
        expect(listener).toHaveBeenCalledOnce();
        h.source.setAppEnabled('one', false);
        listener.mockClear();
        send('attention_requested');
        expect(listener).not.toHaveBeenCalled();
        h.source.setAppEnabled('one', true);
        const contexts = await Promise.all(Array.from({ length: 2 }, () => h.source.getContext()));
        await expect(h.source.getContext()).rejects.toThrow('SEMANTIC_CONTEXT_CAPACITY');
        h.source.dispose(); unsubscribe();
        expect(h.desktop.output.unsubscribe).toHaveBeenCalledTimes(1);
        expect(h.clients[0].client.release).toHaveBeenCalledTimes(2);
        for (const context of contexts) await context.release!();

    });

    it('isolates an oversized Tool alias and restores the App after its declaration is corrected', async () => {
        const h = harness([app('good'), app('bad')]);
        const oversized = 'x'.repeat(65 - 'bad-'.length);
        h.observations.set('bad', observation('bad', 1, oversized));
        const invalid = await h.source.getContext();
        expect(invalid.tools['good-AnyView-multi_open_file']).toBeDefined();
        expect(invalid.tools['bad-AnyView-' + oversized]).toBeUndefined();
        expect(invalid.messages.some(message => String(message.content).includes('current bad revision 1'))).toBe(true);
        expect(invalid.messages.some(message => String(message.content).includes('AOTUI_TOOL_NAME_INVALID'))).toBe(true);
        await invalid.adopt?.();
        expect(h.clients.find(entry => entry.appId === 'bad')!.client.release).toHaveBeenCalledWith('bad-observation-1');

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
        const request = { invocationId: 'c', observationId: 'o', toolId: 'tool', input: {} };
        const completed = await executeMappedResult({ kind: 'receipt', receipt: receipt(request,
            { status: 'succeeded', value: { success: true, data: { message: 'Edited.', view_id: 'file' } } }) });
        expect(completed.result).toEqual({ message: 'Edited.', view_id: 'file' });
        const failed = await executeMappedResult({ kind: 'receipt', receipt: receipt(request, {
            status: 'failed', code: 'TOOL_FAILED', message: 'The application reported a task failure', details: { kind: 'tool-result', phase: 'entered-returned',
                result: { success: false, error: { code: 'EDIT_NOT_MATCHED', message: 'Original text was not found.' }, data: { checked: 1 } } },
        }) });
        expect(failed).toMatchObject({ outcomeStatus: 'failed', error: { code: 'EDIT_NOT_MATCHED', message: 'Original text was not found.' }, result: { checked: 1 } });
        expect(JSON.stringify([completed, failed])).not.toContain('receipt');
    });
    const outcomes: InvocationOutcome[] = [
        { status: 'succeeded', value: null }, { status: 'rejected', code: 'NO', message: 'rejected' },
        { status: 'failed', code: 'FAILED', message: 'failed' },
        { status: 'unknown', code: 'ACTION_OUTCOME_UNKNOWN', message: 'The final business outcome could not be established' },
    ];
    it.each(outcomes)('keeps $status internal without leaking a receipt', async outcome => {
        const value = receipt({ invocationId: 'call', observationId: 'obs', toolId: 'tool', input: {} }, outcome);
        const result = await executeMappedResult({ kind: 'receipt', receipt: value });
        expect(result.outcomeStatus).toBe(outcome.status);
        expect(JSON.stringify(result)).not.toContain('observationId');
        expect(JSON.stringify(result)).not.toContain('receipt');
        expect(Boolean(result.error)).toBe(['rejected', 'failed', 'unknown'].includes(outcome.status));
        if (outcome.status === 'unknown') expect(result.error).toEqual({ code: 'ACTION_OUTCOME_UNKNOWN', message: outcome.message });
        if (outcome.status === 'failed') expect(result.error).toEqual({ code: 'FAILED', message: 'failed' });
    });
    it('distinguishes a known refusal from an unavailable execution result', async () => {
        expect((await executeMappedResult({ kind: 'refused', code: 'FULL', message: 'full' })).outcomeStatus).toBe('rejected');
        expect((await executeMappedResult({ kind: 'unavailable', code: 'GONE', message: 'gone' })).outcomeStatus).toBe('unknown');
    });
    it.each([
        { code: 'INVOCATION_DEADLINE_EXCEEDED', message: 'Invocation deadline elapsed before dispatch', status: 'rejected' },
        {
            code: 'INVOCATION_WAIT_TIMEOUT',
            message: 'Waiting for the invocation receipt timed out. Use readReceipt with the original observationId and invocationId.',
            status: 'unknown',
            agentMessage: 'Timed out waiting for the result of the original operation. It may still be running. ' +
                'Check the current App View for its effects before repeating the operation.',
        },
    ])('maps $code to $status and supplies Agent-facing guidance', async ({ code, message, status, agentMessage }) => {
        const result = await executeMappedResult({ kind: 'unavailable', code, message, ...(status === 'rejected' ? {executionPhase:'not-dispatched' as const} : {}) });
        expect(result).toEqual({ toolName: expect.any(String), toolCallId: 'call', outcomeStatus: status,
            error: { code, message: agentMessage ?? message } });
    });
});

it('reuses a budget report without extending its original lifetime', async () => {
    const h = harness([app('one')], { includeInstruction: false });
    const prior = h.observations.get('one')!;
    h.observations.set('one', { ...prior, views: [{ ...prior.views[0]!,
        content: { format: 'markdown-v1', value: 'body '.repeat(800) } }] });
    h.desktop.getAppWindows.mockReturnValue({ appId: h.installed[0]!.appId!, instanceId: 'one-instance',
        views: [{ viewId: 'workspace', viewInstanceId: 'one-view', type: 'AnyView', name: 'Workspace', canClose: false, region: 'dynamic' }] });
    const measure: MeasureModelRequest = async context => {
        const inputBytes = Buffer.byteLength(JSON.stringify(context.messages.map(({ role, content }) => ({ role, content }))));
        return { method: 'utf8-bytes', inputBytes, estimated: inputBytes + 256, safety: 256, inputLimit: 2500, outputReserved: 500 };
    };
    const reportTool = 'system-read_window_budget';
    const time = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const prepare = async () => {
        const candidate = await h.source.getContext();
        const plan = await candidate.fitModelBudget!(measure, false);
        const view = plan.context!;
        const id = view.messages.map(message => String(message.content).match(/report_id ([a-f0-9-]+)/)?.[1]).find(Boolean);
        expect(id).toBeDefined();
        await view.adopt!();
        return { view, id };
    };
    try {
        const first = await prepare();
        await first.view.release!();
        time.mockReturnValue(300_999);
        const reused = await prepare();
        expect(reused.id).toBe(first.id);
        expect(await reused.view.executeTool!(reportTool, { report_id: first.id, page: 1 }, 'before-expiration'))
            .toMatchObject({ outcomeStatus: 'succeeded', result: { report_id: first.id } });
        time.mockReturnValue(301_000);
        expect(await reused.view.executeTool!(reportTool, { report_id: first.id, page: 1 }, 'after-expiration'))
            .toMatchObject({ error: { code: 'WINDOW_BUDGET_REPORT_UNAVAILABLE' } });
        await reused.view.release!();
        const fresh = await prepare();
        expect(fresh.id).not.toBe(first.id);
        expect(await fresh.view.executeTool!(reportTool, { report_id: fresh.id, page: 1 }, 'fresh'))
            .toMatchObject({ outcomeStatus: 'succeeded' });
    } finally { h.source.dispose(); time.mockRestore(); }
});

it('withdraws hinted business routes and fixed optional Console according to the Provider contract', async () => {
    const h = harness([app('one')], { includeInstruction: false });
    const prior = h.observations.get('one')!;
    h.observations.set('one', { ...prior, views: [{ ...prior.views[0]!,
        content: { format: 'markdown-v1', value: 'body '.repeat(800) } }] });
    h.desktop.getAppWindows.mockReturnValue({ appId: h.installed[0]!.appId!, instanceId: 'one-instance',
        views: [{ viewId: 'workspace', viewInstanceId: 'one-view', type: 'AnyView', name: 'Workspace', canClose: true, region: 'dynamic' }] });
    const strictPolicy = await createProviderToolSchemaPolicy({ model: 'fixture', provider: { id: 'openai', toolSchemaMode: 'strict' } });
    const strictContext = await h.source.getContext(strictPolicy);
    expect(strictContext.tools.run_code).toBeUndefined();
    expect(strictContext.tools['system-collapse_view']).toBeUndefined();
    expect(strictContext.messages.some(message => String(message.content).startsWith('## Console bindings'))).toBe(false);
    await strictContext.release!();
    const policy = await createProviderToolSchemaPolicy({ model: 'fixture', provider: { id: 'openai', toolSchemaMode: 'non-strict' } });
    const fit = (messagesBudget: boolean) => h.source.getContext(policy).then(async candidate => {
        const plan = await candidate.fitModelBudget!(async context => {
            const inputBytes = messagesBudget ? Buffer.byteLength(JSON.stringify(context.messages)) : context.managementOnly ? 100 : 4000;
            return { method: 'utf8-bytes', inputBytes, estimated: inputBytes, safety: 0, inputLimit: 2500, outputReserved: 500 };
        }, false);
        return { candidate, context: plan.context! };
    });
    try {
        const complete = await h.source.getContext(policy);
        const bindings = (context: typeof complete) => context.messages.find(message =>
            String(message.content).startsWith('## Console bindings for this request'));
        expect(bindings(complete)).toMatchObject({ role: 'user', region: 'dynamic', content: expect.stringContaining('one-AnyView-multi_open_file') });
        await complete.release?.();
        const hinted = await fit(true);
        expect(hinted.context.messages.some(message => String(message.content).includes('This View is open.'))).toBe(true);
        expect(hinted.context.tools['one-AnyView-multi_open_file']).toBeUndefined();
        expect(bindings(hinted.context)).toBeDefined();
        expect(String(bindings(hinted.context)!.content)).not.toContain('one-AnyView-multi_open_file');
        expect(hinted.context.tools.run_code?.description).toBe(complete.tools.run_code?.description);
        expect(hinted.context.tools.run_code?.inputSchema).toEqual(complete.tools.run_code?.inputSchema);
        expect(hinted.context.messages.some(message => String(message.content).includes('input tokens'))).toBe(false);
        await hinted.context.adopt?.();
        expect(h.desktop.adoptTurn.mock.calls.at(-1)?.[0].apps).toEqual([]);
        expect(hinted.context.tools.run_code).toBeDefined();
        const reportId = hinted.context.messages.map(message => String(message.content).match(/report_id ([a-f0-9-]+)/)?.[1]).find(Boolean);
        expect(reportId).toBeDefined();
        const reportTool = hinted.context.tools['system-read_window_budget']!;
        expect((reportTool.inputSchema as any).jsonSchema.properties.page).toEqual({ type: 'integer', minimum: 1 });
        expect(await hinted.context.executeTool!('system-read_window_budget', { report_id: reportId, page: 0 }, 'bad-page'))
            .toMatchObject({ error: { code: 'WINDOW_BUDGET_REPORT_UNAVAILABLE' } });
        expect(await hinted.context.executeTool!('system-read_window_budget', { report_id: reportId, page: 1 }, 'valid-page'))
            .toMatchObject({ outcomeStatus: 'succeeded' });
        hinted.candidate.release?.();
        const management = await fit(false);
        expect(management.context.managementOnly).toBe(true);
        expect(Object.keys(management.context.tools)).toContain('system-open_app');
        expect(management.context.tools.run_code).toBeUndefined();
        expect(management.context.tools['one-AnyView-multi_open_file']).toBeUndefined();
        expect(bindings(management.context)).toBeUndefined();
        management.candidate.release?.();
    } finally { await h.source.dispose(); }
});

describe('model-visible presentation contract', () => {
    it('keeps Tools with the same name distinct across different View types', async () => {
        const h = harness(), source = observation('one', 1, 'inspect');
        const tool = { ...source.tools[0]!,  };
        h.observations.set('one', { ...source,
            views: [...source.views, { ...source.views[0]!, id: 'other', viewInstanceId: 'other-instance', type: 'OtherType' }],
            tools: [tool, { ...tool, id: 'other-tool', viewType: 'OtherType' }],
        });
        const context = await consume(h.source);
        expect(Object.keys(context.tools).filter(name => name.endsWith('-inspect'))).toEqual(['one-AnyView-inspect', 'one-OtherType-inspect']);
        await context.release!(); h.source.dispose();
    });

    it('reserves all Desktop aliases even when a corresponding system control is unavailable', async () => {
        const h = harness([{ ...app('system'), installationId: 'business' }, app('pending', 'pending')]);
        const source = observation('system');
        const names = ['open_app', 'close_app', 'collapse_app', 'expand_app'];
        h.observations.set('system', { ...source, tools: names.map(name => ({ ...source.tools[0]!, id: name, name, multiplicity: 'multiple' })) });

        const first = await consume(h.source);
        for (const name of names) expect(first.tools['system-AnyView-' + name]).toBeDefined();
        expect(first.tools['system-expand_app']).toBeUndefined();
        expect((await first.executeTool!('system-AnyView-open_app', { view_id: 'workspace' }, 'app-open'))?.outcomeStatus).toBe('succeeded');
        expect(h.clients[0]!.client.invoke.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ toolId: 'open_app' }));
        expect(h.desktop.openApp).not.toHaveBeenCalled();
        expect((await first.executeTool!(openApp, { installation_id: 'pending' }, 'desktop-open'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.openApp).toHaveBeenCalledWith('pending');
        await first.release!();

        h.installed.push(app('hidden'));
        h.observations.set('hidden', observation('hidden'));
        h.desktop.getAppWindows.mockImplementation((appId?: string, instanceId?: string) => appId === 'hidden'
            ? { appId, instanceId: instanceId!, views: [] } : undefined);
        const beforeFold = await consume(h.source);
        expect((await beforeFold.executeTool!('system-collapse_app', { app_id: 'hidden' }, 'fold'))?.outcomeStatus).toBe('succeeded');
        const second = await consume(h.source);
        expect((await second.executeTool!('system-AnyView-expand_app', { view_id: 'workspace' }, 'app-show'))?.outcomeStatus).toBe('succeeded');
        expect(h.clients[0]!.client.invoke.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ toolId: 'expand_app' }));
        expect((await second.executeTool!('system-expand_app', { app_id: 'hidden' }, 'desktop-show'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.revokeWindowAccess).toHaveBeenCalledOnce();
        await second.release!(); h.source.dispose();
    });

    it('normalizes DOM and plain bodies once, preserves content and keeps instruction Views static', async () => {
        const h = harness(), source = observation('one');
        const body = '# Content\n\n```xml\n<record id="business">keep</record>\n```';
        h.observations.set('one', { ...source, views: [
            { ...source.views[0], region: 'static', content: { format: 'markdown-v1', value: body } },
            { ...source.views[0], id: 'plain', viewInstanceId: 'plain-instance', content: { format: 'markdown-v1', value: body } },
        ], refs: [{ viewId: 'workspace', viewInstanceId: 'one-view', refId: 'items', scope: 'protected', array: true,
            refType: 'Item', kind: 'snapshot-value', valueSchema: { type: 'array', items: { type: 'object' } } }] });
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
        expect(views[0].content).toContain('Available references\n- protected $ref.one.workspace.items (Item[])');
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
        expect(message.split('\n')[0]).toBe('<view view_id="workspace" view_type="AnyView" app_id="one" app_name="one" region="dynamic">');
        expect(message).toContain('\n&lt;view id="literal"&gt;body from file&lt;/view&gt;\n</view>');
        expect(message.match(/<view\b/g)).toHaveLength(1);
        await context.release!(); h.source.dispose();
    });

    it('retains timestamps for unchanged content across unrelated revisions and releases presentation cache on disable', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
        const h = harness(), source = observation('one');
        const first = await consume(h.source);
        await first.release!();
        clock.mockReturnValue(200);
        h.observations.set('one', { ...source, source: { ...source.source, revision: 2 } });
        const second = await h.source.getContext();
        expect(second.messages).toEqual(first.messages);
        await second.release!();
        h.observations.set('one', observation('one', 3));
        const changed = await h.source.getContext();
        expect(changed.messages.find(message => String(message.content).startsWith('<view '))?.timestamp).toBeGreaterThanOrEqual(200);
        await changed.release!();
        h.source.setEnabled(false); h.source.setEnabled(true); clock.mockReturnValue(300);
        const resumed = await h.source.getContext();
        expect(resumed.messages.find(message => String(message.content).startsWith('<view '))?.timestamp).toBeGreaterThanOrEqual(300);
        await resumed.release!(); h.source.dispose();
    });

    it('restores a bounded Desktop activity list without bypassing application visibility', async () => {
        const h = harness();
        h.desktop.getSystemLogs.mockReturnValue(Array.from({length: 8}, (_, i) => ({timestamp: i, message: `activity-${i}`})));
        const first = await h.source.getContext();
        const desktop = String(first.messages.find(message => String(message.content).startsWith('<desktop>'))?.content);
        expect(desktop).toContain('## Installed TUI Applications');
        expect(desktop).toContain('app_id: one');
        expect(desktop).toContain('## System Logs');
        expect(desktop).not.toContain('activity-2');
        expect(desktop).toContain('activity-3'); expect(desktop).toContain('activity-7');
        await first.release!();
        h.source.setAppEnabled('one', false);
        const hidden = await consume(h.source);
        expect(JSON.stringify(hidden.messages)).not.toContain('activity-');
        expect(JSON.stringify(hidden.messages)).toContain('No applications enabled for this context.');
        expect(JSON.stringify(hidden.messages)).not.toContain('No applications installed.');
        expect(JSON.stringify(hidden.messages)).toContain('logs are hidden');
        expect(hidden.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(0);
        expect(Object.keys(hidden.tools).sort()).toEqual(['run_code', closeApp, openApp]);
        expect(baseControls(hidden)).toEqual(baseControls(first));
        for (const name of [openApp, closeApp]) {
            expect((await hidden.executeTool!(name, { [name === openApp ? 'installation_id' : 'app_id']: 'one' }, 'disabled-target'))?.error?.code).toBe('INVALID_APP_TARGET');
        }
        h.source.setEnabled(false);
        expect(await h.source.getContext()).toEqual({ messages: [], tools: {} });
        expect((await hidden.executeTool!(openApp, { installation_id: 'one' }, 'disabled-source'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect(h.desktop.openApp).not.toHaveBeenCalled();
        expect(h.desktop.beginAppClose).not.toHaveBeenCalled();
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

    it('exposes one Tool for many Views and forwards the requested receiver and business arguments', async () => {
        const h = harness(), source = observation('one');
        const schema = { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'], additionalProperties: false };
        const single: Observation = { ...source, tools: [{ ...source.tools[0]!, multiplicity: 'multiple', inputSchema: schema }] };
        h.observations.set('one', single);
        const one = await h.source.getContext(), name = 'one-AnyView-multi_open_file';
        h.observations.set('one', { ...single, observationId: 'two-views',
            views: [...source.views, { ...source.views[0]!, id: 'second', viewInstanceId: 'second-instance' }],
        });
        const two = await consume(h.source);
        expect(Object.keys(two.tools).filter(key => key.endsWith('-multi_open_file'))).toEqual([name]);
        const projected = (one.tools[name].inputSchema as any).jsonSchema;
        expect(projected).toEqual({ ...schema, properties: { ...schema.properties,
            view_id: { type: 'string', description: 'Receiving AnyView page XML view_id.' } }, required: ['view_id', 'filePath'] });
        expect((two.tools[name].inputSchema as any).jsonSchema).toEqual(projected);
        const getReceiver = vi.fn(() => 'second');
        const invalid = Object.defineProperty({ filePath: '/b.txt' }, 'view_id', { enumerable: true, get: getReceiver });
        expect(await two.executeTool!(name, invalid, 'getter')).toMatchObject({ outcomeStatus: 'rejected', error: { code: 'TOOL_INVALID_ARGS' } });
        expect(getReceiver).not.toHaveBeenCalled();
        await two.executeTool!(name, { view_id: 'second', filePath: '/b.txt' }, 'business-id');
        expect(h.clients[0].client.invoke.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            observationId: 'two-views', toolId: 'tool', viewId: 'second', input: {  filePath: '/b.txt' },
        }));
        await one.release!(); await two.release!(); h.source.dispose();
    });

    it('uses the observed receiver choices while preserving every open View body', async () => {
        const h = harness(), source = observation('one');
        h.observations.set('one', { ...source,
            views: [...source.views, { ...source.views[0]!, id: 'second', viewInstanceId: 'second-instance' }],
            tools: [{ ...source.tools[0]!, multiplicity: 'multiple', eligibleViewIds: ['second'] }],
        });
        const context = await consume(h.source), name = 'one-AnyView-multi_open_file';
        expect((context.tools[name].inputSchema as any).jsonSchema.properties.view_id).toMatchObject({ type: 'string' });
        expect((context.tools[name].inputSchema as any).jsonSchema.properties.view_id).not.toHaveProperty('enum');
        expect(context.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(2);
        await context.executeTool!(name, { view_id: 'second' }, 'receiver');
        expect(h.clients[0].client.invoke.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            observationId: 'one-observation-1', toolId: 'tool', viewId: 'second', input: {  },
        }));
        await context.release!(); h.source.dispose();
    });

    it('uses distinct tool aliases for simultaneous instances of one declared App name', async () => {
        const h = harness([{ ...app('two'), name: 'same' }, { ...app('one'), name: 'same' }, app('healthy')]);
        const context = await consume(h.source);
        expect(context.tools['one-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['two-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(context.messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(context.messages.some(message => String(message.content).includes('current two revision 1'))).toBe(true);
        expect(context.messages.some(message => String(message.content).includes('current healthy revision 1'))).toBe(true);
        await context.executeTool!('one-AnyView-multi_open_file', {}, 'first');
        await context.executeTool!('two-AnyView-multi_open_file', {}, 'second');
        await context.executeTool!('healthy-AnyView-multi_open_file', {}, 'healthy');
        expect(h.clients.find(entry => entry.appId === 'one')!.client.invoke).toHaveBeenCalledOnce();
        expect(h.clients.find(entry => entry.appId === 'healthy')!.client.invoke).toHaveBeenCalledOnce();
        expect(h.clients.find(entry => entry.appId === 'two')!.client.invoke).toHaveBeenCalledOnce();
        await context.release!();

        h.source.dispose();
    });

    it('rejects a hyphen in an included ViewType without taking down healthy Apps', async () => {
        const h = harness([app('bad'), app('healthy')]);
        const source = observation('bad');
        const tool = { ...source.tools[0]!, viewType: 'A-B', name: 'read' };
        h.observations.set('bad', { ...source, tools: [{ ...source.tools[0]!, name: 'read' }, { ...tool, id: 'other-tool' }] });
        const context = await consume(h.source);
        expect(context.tools['healthy-AnyView-multi_open_file']).toBeDefined();
        expect(context.tools['bad-A-B-read']).toBeUndefined();
        const desktop = String(context.messages.find(message => String(message.content).startsWith('<desktop>'))?.content);
        expect(desktop).toContain('AOTUI_TOOL_NAME_INVALID: viewType');
        expect(desktop).toContain('Replace hyphens or other separators with underscores.');
        await context.release!();
        h.observations.set('bad', { ...source, tools: [{ ...source.tools[0]!, name: 'read' }] });
        const short = await consume(h.source);
        expect(short.tools['bad-AnyView-read']).toBeDefined();
        await short.release!();
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
        expect(desktop).toContain('AOTUI_APP_IDENTITY_INVALID:');
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
        expect(invalid.messages.some(message => String(message.content).includes('current bad revision 1'))).toBe(true);
        expect(invalid.messages.some(message => String(message.content).includes('MODEL_TOOL_SCHEMA_UNSUPPORTED'))).toBe(true);
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
        expect(badClient.release).toHaveBeenCalledWith('bad-observation-2');

        await previous.executeTool!('bad-AnyView-multi_open_file', {}, 'prior-binding');
        expect(badClient.invoke).toHaveBeenCalledOnce();
        await previous.release!();

        await current.release!();
        expect(badClient.release).toHaveBeenCalledWith('bad-observation-2');
        h.source.dispose();
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

it('B4-T04 rejects a required system schema before adopting, and validates actual fixed Console input', async () => {
    const h = harness();
    try {
        const previous = await consume(h.source);
        await expect(h.source.getContext({ label: 'restricted', check: schema => {
            const properties = (schema as { properties?: Record<string, unknown> }).properties;
            return properties && Object.hasOwn(properties, 'installation_id')
                ? { path: '$.properties.installation_id', reason: 'required control cannot be represented' } : undefined;
        }})).rejects.toMatchObject({ code: 'MODEL_TOOL_SCHEMA_UNSUPPORTED' });
        expect(h.desktop.adoptTurn).toHaveBeenCalledTimes(1);
        const getter = vi.fn(() => 'console.log(1)');
        for (const [index, input] of [
            {}, { code: ' ' }, { code: 'x'.repeat(24 * 1024 + 1) },
            { code: 'console.log(1)', imports: null },
            { code: 'console.log(1)', imports: ['not-an-address'] },
            { code: 'console.log(1)', imports: Array(257).fill('$ref.one.workspace.valid') },
            { code: 'console.log(1)', reset: null },
            { code: 'console.log(1)', extra: false },
            Object.defineProperty({}, 'code', { get: getter, enumerable: true }),
        ].entries()) {
            expect(await previous.executeTool!('run_code', input, 'invalid-' + index)).toMatchObject({
                outcomeStatus: 'rejected', error: { code: 'CONSOLE_INVALID_INPUT' },
            });
        }
        expect(getter).not.toHaveBeenCalled();
        expect(h.clients[0]!.client.invoke).not.toHaveBeenCalled();
        await previous.release!();
    } finally { await h.source.dispose(); }
});

it('B4-T02 measures multiple layouts without another observation after exactly one narrow preparation', async () => {
    const h = harness([app('one')], { includeInstruction: false });
    const source = h.observations.get('one')!;
    h.observations.set('one', { ...source, views: [{ ...source.views[0]!,
        content: { format: 'markdown-v1', value: 'original body '.repeat(1000) } }],
        tools: [...source.tools, { ...source.tools[0]!, id: 'bad', name: 'x'.repeat(80) }] });
    h.desktop.getAppWindows.mockReturnValue({ appId: h.installed[0]!.appId!, instanceId: 'one-instance',
        views: [{ viewId: 'workspace', viewInstanceId: 'one-view', type: 'AnyView', name: 'Workspace', canClose: false, region: 'dynamic' }] });
    try {
        const prepared = await h.source.getContext();
        const client = h.clients[0]!.client;
        expect(client.observe).toHaveBeenCalledTimes(2);
        expect(client.observe).toHaveBeenLastCalledWith({ excludeToolIds: ['bad'] });
        expect(client.release).toHaveBeenCalledWith(source.observationId);
        const trial = await prepared.fitModelBudget!(async context => {
            const inputBytes = Buffer.byteLength(JSON.stringify(context.messages));
            return { method: 'utf8-bytes', inputBytes, estimated: inputBytes, safety: 0, inputLimit: 2800, outputReserved: 500 };
        }, false);
        expect(trial.context!.messages.some(message => String(message.content).includes('This View is open.'))).toBe(true);
        expect(client.observe).toHaveBeenCalledTimes(2);
        await trial.context!.adopt!();
        expect(client.observe).toHaveBeenCalledTimes(2);
        expect(h.desktop.adoptTurn).toHaveBeenCalledTimes(1);
        await prepared.release!();
    } finally { await h.source.dispose(); }
});
