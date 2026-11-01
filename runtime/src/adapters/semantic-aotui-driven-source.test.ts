import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource, semanticToolResult } from './semantic-aotui-driven-source.js';
import { DEFAULT_AOTUI_SYSTEM_INSTRUCTION } from './system-instruction.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticAOTUIDrivenSourceOptions } from './semantic-aotui-driven-source.js';
import type { IDesktop, IKernel, AppDiscoveryInfo } from '../spi/runtime/kernel.interface.js';
import type { Observation } from '../core/invocation/observation-types.js';
import type { InvocationOutcome, InvocationReceipt, ScopedInvocation, ScopeClient } from '../core/invocation/scoped-interaction-types.js';

const app = (id: string, status: AppDiscoveryInfo['status'] = 'running', appInstanceId: string | null =
    status === 'pending' || status === 'closed' ? null : `${id}-instance`): AppDiscoveryInfo => ({ appId: id as any, name: id, status,
        ...(appInstanceId === null ? {} : { appInstanceId }) });
function observation(appId: string, revision = 1, name = 'multi_open_file'): Observation {
    const target = { viewId: 'workspace', viewInstanceId: `${appId}-view`, bindingVersion: revision };
    return {
        observationId: `${appId}-observation-${revision}`, expiresAt: null,
        source: { appId, instanceId: `${appId}-instance`, snapshotId: `${appId}-snapshot-${revision}`, revision },
        views: [{ id: target.viewId, viewInstanceId: target.viewInstanceId, type: 'AnyView', name: 'Workspace', kind: 'state',
            content: { format: 'markdown-v1', value: `current ${appId} revision ${revision}` } }],
        refs: [], tools: [{ id: 'tool', name, viewType: 'AnyView', description: 'Current view operation',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, isMutating: false, targets: [target] }],
        bindings: [{ bindingId: `${appId}-binding-${revision}`, toolId: 'tool', target }],
    };
}
function receipt(request: ScopedInvocation, outcome: InvocationOutcome = { status: 'succeeded', value: null }): InvocationReceipt {
    return { invocationId: request.invocationId, observationId: request.observationId, bindingId: request.bindingId,
        source: null, completedAt: 1, expiresAt: 60001, executionPhase: 'entered-returned', outcome };
}
function harness(installed = [app('one')], options: SemanticAOTUIDrivenSourceOptions = {}) {
    const observations = new Map(installed.map(item => [String(item.appId), observation(String(item.appId))]));
    const clients: Array<{ appId: string; client: ScopeClient & { observe: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>; releaseObservation: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }> = [];
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
        createAppScope: vi.fn((_desktopId: string, appId: string) => {
            let closed = false;
            const results = new Map<string, InvocationReceipt>();
            const client = {
                observe: vi.fn(async () => closed ? { status: 'rejected', issue: { code: 'SCOPE_UNAVAILABLE', message: 'closed' } } :
                    { status: 'observed', observation: observations.get(appId)! }),
                invoke: vi.fn(async (request: ScopedInvocation) => {
                    if (closed) return { kind: 'refused', code: 'SCOPE_UNAVAILABLE', message: 'closed' };
                    if (results.has(request.invocationId)) return { kind: 'receipt', receipt: results.get(request.invocationId)! };
                    if (results.size >= 256) return { kind: 'refused', code: 'INVOCATION_CAPACITY', message: 'full' };
                    const value = receipt(request); results.set(request.invocationId, value);
                    return { kind: 'receipt', receipt: value };
                }),
                readReceipt: vi.fn(async (id: string) => results.has(id) ? { kind: 'receipt', receipt: results.get(id)! } :
                    { kind: 'unavailable', code: 'RECEIPT_UNAVAILABLE', message: 'not in this scope' }),
                releaseObservation: vi.fn(), close: vi.fn(() => { closed = true; results.clear(); }),
            } as unknown as (typeof clients)[number]['client'];
            clients.push({ appId, client });
            return { status: 'opened', client };
        }),
    };
    const source = new SemanticAOTUIDrivenSource(desktop as unknown as IDesktop, kernel as unknown as IKernel, options);
    return { source, desktop, kernel, observations, clients, installed, updates };
}
const findTool = (context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>, fragment: string) => {
    const name = Object.keys(context.tools).find(name => name.includes(fragment));
    expect(name).toBeDefined(); return name!;
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('SemanticAOTUIDrivenSource', () => {
    it('projects multiple apps through semantic scopes and opens pending apps through the Desktop lifecycle', async () => {
        const h = harness([app('one'), app('two'), app('pending', 'pending')]);
        const context = await h.source.getContext();
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
        const running = await h.source.getContext();
        h.installed[0] = app('one', 'collapsed', originalId);
        const collapsed = await h.source.getContext();

        h.installed[0] = app('one', 'running', 'successor-instance');
        for (const [name, callId] of [['system-close_app', 'old-close'], ['system-collapse_app', 'old-collapse']] as const) {
            const result = await running.executeTool!(name, { app_id: 'one' }, callId);
            expect(result?.error?.code).toBe('APP_INSTANCE_CHANGED');
        }
        expect(h.desktop.closeApp).not.toHaveBeenCalled();
        expect(h.desktop.collapseApp).not.toHaveBeenCalled();

        h.installed[0] = app('one', 'collapsed', 'successor-instance');
        const staleShow = await collapsed.executeTool!('system-show_app', { app_id: 'one' }, 'old-show');
        expect(staleShow?.error?.code).toBe('APP_INSTANCE_CHANGED');
        expect(h.desktop.showApp).not.toHaveBeenCalled();

        const latest = await h.source.getContext();
        expect((await latest.executeTool!('system-show_app', { app_id: 'one' }, 'fresh-show'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.showApp).toHaveBeenCalledWith('one', 'successor-instance');
        h.installed[0] = app('one', 'running', 'successor-instance');
        const freshRunning = await h.source.getContext();
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

    it('maps the manager admission mismatch as rejected while real lifecycle failures remain unknown', async () => {
        const h = harness(), context = await h.source.getContext();
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

    it('pins each call to its observed binding and closes scopes only after the last context releases', async () => {
        const h = harness();
        const first = await h.source.getContext(), tool = findTool(first, '-multi_open_file');
        h.observations.set('one', observation('one', 2));
        const second = await h.source.getContext();
        await first.executeTool!(tool, {}, 'old');
        await second.executeTool!(tool, {}, 'new');
        expect(h.clients[0].client.invoke.mock.calls.map(args => args[0].bindingId)).toEqual(['one-binding-1', 'one-binding-2']);
        await first.release!();
        expect(h.clients[0].client.close).not.toHaveBeenCalled();
        expect((await first.executeTool!(tool, {}, 'late'))?.error?.code).toBe('SEMANTIC_CONTEXT_RELEASED');
        expect(h.clients[0].client.invoke).toHaveBeenCalledTimes(2);
        await second.release!();
        expect(h.clients[0].client.close).toHaveBeenCalledTimes(1);
        h.source.dispose();
    });

    it('supports a ready app with no views or view tools', async () => {
        const h = harness(), empty = observation('one');
        h.observations.set('one', { ...empty, views: [], refs: [], tools: [], bindings: [] });
        const context = await h.source.getContext();
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
        const context = await h.source.getContext();
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
            const context = await h.source.getContext();
            const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, `call-${round}`);
            expect(result?.outcomeStatus).toBe('succeeded');
            await context.release!();
        }
        expect(h.clients).toHaveLength(300);
        expect(h.clients.every(({ client }) => client.close.mock.calls.length === 1)).toBe(true);
        h.source.dispose();
    });

    it('releases a partially captured context if a later app fails', async () => {
        const h = harness([app('one'), app('two')]);
        const create = h.kernel.createAppScope.getMockImplementation()!;
        h.kernel.createAppScope.mockImplementation((id, appId) => {
            if (appId === 'two') throw new Error('cannot observe');
            return create(id, appId);
        });
        await expect(h.source.getContext()).rejects.toThrow('cannot observe');
        expect(h.clients[0].client.releaseObservation).toHaveBeenCalledWith('one-observation-1');
        expect(h.clients[0].client.close).toHaveBeenCalledOnce();
        h.source.dispose();
    });

    it('does not retarget or retry a call whose result is unknown', async () => {
        const h = harness(), context = await h.source.getContext();
        h.clients[0].client.invoke.mockRejectedValueOnce(new Error('reply lost'));
        const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, 'uncertain');
        expect(result?.outcomeStatus).toBe('unknown');
        expect(h.clients[0].client.invoke).toHaveBeenCalledOnce();
        await context.release!(); h.source.dispose();
    });

    it('revokes a disabled app even for a previously captured context', async () => {
        const h = harness(), context = await h.source.getContext();
        h.source.setAppEnabled('one', false);
        const result = await context.executeTool!(findTool(context, '-multi_open_file'), {}, 'after-disable');
        expect(result?.outcomeStatus).toBe('rejected');
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        expect(h.clients[0].client.close).toHaveBeenCalledOnce();
        await context.release!(); h.source.dispose();
    });

    it('bounds active contexts and disposes its subscription and observations', async () => {
        const h = harness();
        const listener = vi.fn(), unsubscribe = h.source.onUpdate(listener);
        for (const update of h.updates) update();
        expect(listener).toHaveBeenCalledOnce();
        const contexts = await Promise.all(Array.from({ length: 8 }, () => h.source.getContext()));
        await expect(h.source.getContext()).rejects.toThrow('SEMANTIC_CONTEXT_CAPACITY');
        h.source.dispose(); unsubscribe();
        expect(h.desktop.output.unsubscribe).toHaveBeenCalledTimes(1);
        expect(h.clients[0].client.releaseObservation).toHaveBeenCalledTimes(8);
        for (const context of contexts) await context.release!();
        expect(h.clients[0].client.close).toHaveBeenCalledTimes(1);
    });

    it('rejects an oversized public name with an actionable diagnostic instead of renaming it', async () => {
        const h = harness([app('long-application-name')]);
        h.observations.set('long-application-name', observation('long-application-name', 1, 'send_command_to_exist_terminal_with_an_extremely_long_suffix'));
        await expect(h.source.getContext()).rejects.toThrow('AOTUI_TOOL_NAME_INVALID');
        expect(h.clients[0].client.releaseObservation).toHaveBeenCalledOnce();
        expect(h.clients[0].client.close).toHaveBeenCalledOnce();
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        h.source.dispose();
    });
});

describe('semantic receipt mapping', () => {
    it('unwraps ordinary completion and preserves the business error and recovery details', () => {
        const request = { invocationId: 'c', observationId: 'o', bindingId: 'b', input: {} };
        const completed = semanticToolResult('tool', 'c', { kind: 'receipt', receipt: receipt(request,
            { status: 'succeeded', value: { success: true, data: { message: 'Edited.', view_id: 'file' } } }) });
        expect(completed.result).toEqual({ message: 'Edited.', view_id: 'file' });
        const failed = semanticToolResult('tool', 'c', { kind: 'receipt', receipt: receipt(request, {
            status: 'unknown', code: 'TOOL_OUTCOME_UNKNOWN', message: 'uncertain', details: { kind: 'operation-result', phase: 'entered-returned',
                result: { success: false, error: { code: 'EDIT_NOT_MATCHED', message: 'Original text was not found.' }, data: { checked: 1 } } },
        }) });
        expect(failed).toMatchObject({ outcomeStatus: 'unknown', error: { code: 'EDIT_NOT_MATCHED', message: 'Original text was not found.' }, result: { checked: 1 } });
        expect(JSON.stringify([completed, failed])).not.toContain('receipt');
    });
    const outcomes: InvocationOutcome[] = [
        { status: 'succeeded', value: null }, { status: 'rejected', code: 'NO', message: 'rejected' },
        { status: 'failed', code: 'FAILED', message: 'failed', effects: 'partial' },
        { status: 'accepted', operationId: 'job' }, { status: 'unknown', code: 'UNKNOWN', message: 'uncertain' },
    ];
    it.each(outcomes)('keeps $status internal without leaking a receipt', outcome => {
        const value = receipt({ invocationId: 'call', observationId: 'obs', bindingId: 'binding', input: {} }, outcome);
        const result = semanticToolResult('tool', 'call', { kind: 'receipt', receipt: value });
        expect(result.outcomeStatus).toBe(outcome.status);
        expect(JSON.stringify(result)).not.toContain('observationId');
        expect(JSON.stringify(result)).not.toContain('receipt');
        expect(Boolean(result.error)).toBe(['rejected', 'failed', 'unknown', 'accepted'].includes(outcome.status));
    });
    it('distinguishes a known refusal from an unavailable execution result', () => {
        expect(semanticToolResult('tool', 'call', { kind: 'refused', code: 'FULL', message: 'full' }).outcomeStatus).toBe('rejected');
        expect(semanticToolResult('tool', 'call', { kind: 'unavailable', code: 'GONE', message: 'gone' }).outcomeStatus).toBe('unknown');
    });
});

describe('model-visible presentation contract', () => {
    it('keeps tools with the same operation name distinct across different View types', async () => {
        const h = harness(), source = observation('one', 1, 'inspect');
        const target = { viewId: 'other', viewInstanceId: 'other-instance', bindingVersion: 1 };
        h.observations.set('one', { ...source,
            views: [...source.views, { ...source.views[0], id: target.viewId, viewInstanceId: target.viewInstanceId, type: 'OtherType' }],
            tools: [...source.tools, { ...source.tools[0], id: 'other-tool', viewType: 'OtherType', targets: [target] }],
            bindings: [...source.bindings, { bindingId: 'other-binding', toolId: 'other-tool', target }],
        });
        const context = await h.source.getContext();
        expect(Object.keys(context.tools).filter(name => name.endsWith('-inspect'))).toEqual(['one-AnyView-inspect', 'one-OtherType-inspect']);
        await context.release!(); h.source.dispose();
    });

    it('normalizes DOM and plain bodies once, preserves content and keeps instruction Views static', async () => {
        const h = harness(), source = observation('one');
        const body = '# Content\n\n```xml\n<record id="business">keep</record>\n```';
        h.observations.set('one', { ...source, views: [
            { ...source.views[0], kind: 'instruction', content: { format: 'markdown-v1', value: `<view id="workspace" name="Workspace">\n${body}\n</view>` } },
            { ...source.views[0], id: 'plain', viewInstanceId: 'plain-instance', content: { format: 'markdown-v1', value: body } },
        ], refs: [{ viewId: 'workspace', viewInstanceId: 'one-view', refId: 'items[0]', refType: 'Item', kind: 'snapshot-value' }] });
        const context = await h.source.getContext();
        const views = context.messages.filter(message => String(message.content).startsWith('<view '));
        expect(views).toHaveLength(2);
        for (const message of views) {
            expect(String(message.content).match(/<view\b/g)).toHaveLength(1);
            expect(String(message.content).match(/<\/view>/g)).toHaveLength(1);
            expect(message.content).toContain(body);
            expect(message.content).not.toMatch(/ instance=| revision=/);
            expect(message.content).toContain('app_id="one" app_name="one"');
        }
        expect(views.map(view => view.region)).toEqual(['static', 'dynamic']);
        expect(views[0].content).toContain('Available references: items[0] (Item)');
        expect(Object.keys(context.tools)).toContain('one-AnyView-multi_open_file');
        expect((context.tools['one-AnyView-multi_open_file'].inputSchema as any).jsonSchema).toEqual(source.tools[0].inputSchema);
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
        const h = harness([]), context = await h.source.getContext();
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
                const h = harness([], options), context = await h.source.getContext();
                expect(context.messages.find(message => message.region === 'static')?.content).toBe(expected);
                await context.release!(); h.source.dispose();
            }
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const h = harness([], { instructionPath: join(directory, 'missing') }), context = await h.source.getContext();
            expect(context.messages[0].content).toBe(DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
            await context.release!(); h.source.dispose();
        } finally { rmSync(directory, {recursive: true, force: true}); }
    });

    it('keeps the declared schema stable for one or multiple Views and pins business targets', async () => {
        const h = harness(), source = observation('one');
        const schema = { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'], additionalProperties: false };
        const first = { ...source.bindings[0].target, selector: { param: 'filePath', value: '/a.txt' } };
        const other = { ...first, viewId: 'second', viewInstanceId: 'second-instance', selector: { param: 'filePath', value: '/b.txt' } };
        const single = { ...source, tools: [{ ...source.tools[0], inputSchema: schema, targets: [first] }],
            bindings: [{ ...source.bindings[0], target: first }] };
        h.observations.set('one', single);
        const one = await h.source.getContext(), name = 'one-AnyView-multi_open_file';
        h.observations.set('one', { ...single, observationId: 'two-views',
            views: [...source.views, { ...source.views[0], id: 'second', viewInstanceId: other.viewInstanceId }],
            tools: [{ ...single.tools[0], targets: [first, other] }],
            bindings: [...single.bindings, { bindingId: 'second-binding', toolId: 'tool', target: other }],
        });
        const two = await h.source.getContext();
        expect(Object.keys(two.tools).filter(key => key.endsWith('-multi_open_file'))).toEqual([name]);
        expect((one.tools[name].inputSchema as any).jsonSchema).toEqual(schema);
        expect((two.tools[name].inputSchema as any).jsonSchema).toEqual(schema);
        for (const input of [{}, { filePath: '/unseen.txt' }, { filePath: 1 }])
            expect((await two.executeTool!(name, input, 'invalid'))?.error?.code).toBe('INVALID_VIEW_TARGET');
        expect((await one.executeTool!(name, { filePath: '/b.txt' }, 'unseen'))?.error?.code).toBe('INVALID_VIEW_TARGET');
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        // A later observation cannot rewrite either old route.
        h.observations.set('one', single);
        const later = await h.source.getContext();
        await two.executeTool!(name, { filePath: '/b.txt' }, 'original-second');
        await one.executeTool!(name, { filePath: '/a.txt' }, 'original-first');
        expect(h.clients[0].client.invoke.mock.calls.map(([r]) => [r.observationId, r.bindingId, r.input])).toEqual([
            ['two-views', 'second-binding', { filePath: '/b.txt' }], ['one-observation-1', 'one-binding-1', { filePath: '/a.txt' }],
        ]);
        await one.release!(); await two.release!(); await later.release!(); h.source.dispose();
    });

    it('rejects ambiguous targets instead of injecting a parameter or choosing the first View', async () => {
        const h = harness(), source = observation('one');
        const other = { ...source.bindings[0].target, viewId: 'second', viewInstanceId: 'second-instance' };
        h.observations.set('one', { ...source,
            tools: [{ ...source.tools[0], targets: [source.bindings[0].target, other] }],
            bindings: [...source.bindings, { bindingId: 'second-binding', toolId: 'tool', target: other }],
        });
        await expect(h.source.getContext()).rejects.toThrow('TOOL_TARGET_REQUIRED');
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        expect(h.clients[0].client.close).toHaveBeenCalledOnce(); h.source.dispose();
    });

    it('rejects duplicate public names across applications without appending App IDs', async () => {
        const h = harness([{ ...app('one'), name: 'same' }, { ...app('two'), name: 'same' }]);
        await expect(h.source.getContext()).rejects.toThrow('AOTUI_TOOL_NAME_COLLISION: "same-AnyView-multi_open_file"');
        for (const { client } of h.clients) expect(client.close).toHaveBeenCalledOnce();
        h.source.dispose();
    });

    it('rejects ambiguous composite names instead of hashing them', async () => {
        const h = harness();
        const source = observation('one');
        h.observations.set('one', { ...source, tools: [
            {...source.tools[0], id: 'a', viewType: 'A-B', name: 'C'},
            {...source.tools[0], id: 'b', viewType: 'A', name: 'B-C'},
        ], bindings: [ {...source.bindings[0], toolId: 'a'}, {...source.bindings[0], toolId: 'b', bindingId: 'other'} ] });
        await expect(h.source.getContext()).rejects.toThrow('AOTUI_TOOL_NAME_COLLISION: "one-A-B-C"');
        h.source.dispose();
    });

    it.each(['has space', '名字', 'has/slash'])('rejects invalid name %s without sanitizing it', async name => {
        const h = harness([{ ...app('one'), name }]);
        await expect(h.source.getContext()).rejects.toThrow('AOTUI_TOOL_NAME_INVALID');
        h.source.dispose();
    });

    it.each([63, 64, 65])('validates the full composite length at %i characters', async length => {
        const h = harness(), name = 'x'.repeat(length - 'one-AnyView-'.length);
        h.observations.set('one', observation('one', 1, name));
        if (length > 64) await expect(h.source.getContext()).rejects.toThrow('65 characters');
        else {
            const context = await h.source.getContext();
            expect(context.tools[`one-AnyView-${name}`]).toBeDefined();
            await context.release!();
        }
        h.source.dispose();
    });

    it('uses the Legacy Desktop instruction verbatim by default', async () => {
        vi.stubEnv('AOTUI_SYSTEM_INSTRUCTION_PATH', undefined);
        const h = harness(), context = await h.source.getContext();
        expect(context.messages[0].content).toBe(DEFAULT_AOTUI_SYSTEM_INSTRUCTION);
        await context.release!(); h.source.dispose();
    });
});
