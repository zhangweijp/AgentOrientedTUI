import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource, semanticToolResult } from './semantic-aotui-driven-source.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SemanticAOTUIDrivenSourceOptions } from './semantic-aotui-driven-source.js';
import type { IDesktop, IKernel, AppDiscoveryInfo } from '../spi/runtime/kernel.interface.js';
import type { Observation } from '../core/invocation/observation-types.js';
import type { InvocationOutcome, InvocationReceipt, ScopedInvocation, ScopeClient } from '../core/invocation/scoped-interaction-types.js';

const app = (id: string, status: AppDiscoveryInfo['status'] = 'running'): AppDiscoveryInfo => ({ appId: id as any, name: id, status });
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
        experimentalCreateAppScope: vi.fn((_desktopId: string, appId: string) => {
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

    it('shares one capture for compatibility message and tool reads started together', async () => {
        const h = harness();
        const [messages, tools] = await Promise.all([h.source.getMessages(), h.source.getTools()]);
        expect(messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(Object.keys(tools).some(name => name.includes('-multi_open_file'))).toBe(true);
        expect(h.clients).toHaveLength(1);
        expect(h.clients[0].client.observe).toHaveBeenCalledTimes(1);
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
        const create = h.kernel.experimentalCreateAppScope.getMockImplementation()!;
        h.kernel.experimentalCreateAppScope.mockImplementation((id, appId) => {
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

    it('keeps a long readable tool name within the provider name length limit', async () => {
        const h = harness([app('long-application-name')]);
        h.observations.set('long-application-name', observation('long-application-name', 1, 'send_command_to_exist_terminal_with_an_extremely_long_suffix'));
        const context = await h.source.getContext();
        const name = findTool(context, 'send_command');
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
        await context.release!(); h.source.dispose();
    });
});

describe('semantic receipt mapping', () => {
    const outcomes: InvocationOutcome[] = [
        { status: 'succeeded', value: null }, { status: 'rejected', code: 'NO', message: 'rejected' },
        { status: 'failed', code: 'FAILED', message: 'failed', effects: 'partial' },
        { status: 'accepted', operationId: 'job' }, { status: 'unknown', code: 'UNKNOWN', message: 'uncertain' },
    ];
    it.each(outcomes)('preserves the $status receipt and exposes its actual status', outcome => {
        const value = receipt({ invocationId: 'call', observationId: 'obs', bindingId: 'binding', input: {} }, outcome);
        const result = semanticToolResult('tool', 'call', { kind: 'receipt', receipt: value });
        expect(result.outcomeStatus).toBe(outcome.status);
        expect(result.result).toEqual({ receipt: value });
        expect(Boolean(result.error)).toBe(['rejected', 'failed', 'unknown'].includes(outcome.status));
    });
    it('distinguishes a known refusal from an unavailable execution result', () => {
        expect(semanticToolResult('tool', 'call', { kind: 'refused', code: 'FULL', message: 'full' }).outcomeStatus).toBe('rejected');
        expect(semanticToolResult('tool', 'call', { kind: 'unavailable', code: 'GONE', message: 'gone' }).outcomeStatus).toBe('unknown');
    });
});

describe('model-visible presentation contract', () => {
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
        await hidden.release!(); h.source.dispose();
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
            expect(context.messages[0].content).toContain('# AOTUI Desktop System Instruction');
            expect(context.messages[0].content).toContain('Operation Receipts and Updated Views');
            await context.release!(); h.source.dispose();
        } finally { rmSync(directory, {recursive: true, force: true}); }
    });

    it('groups a Tool across Views and routes only to its original observed target', async () => {
        const h = harness(), source = observation('one');
        const other = { ...source.bindings[0].target, viewId: 'second', viewInstanceId: 'second-instance' };
        h.observations.set('one', { ...source,
            views: [...source.views, { ...source.views[0], id: 'second', viewInstanceId: other.viewInstanceId }],
            tools: [{ ...source.tools[0], targets: [source.bindings[0].target, other] }],
            bindings: [...source.bindings, {bindingId: 'second-binding', toolId: 'tool', target: other}],
        });
        const context = await h.source.getContext(), name = 'one-AnyView-multi_open_file';
        expect(Object.keys(context.tools).filter(name => name.endsWith('-multi_open_file'))).toEqual([name]);
        expect((context.tools[name].inputSchema as any).jsonSchema).toMatchObject({
            required: ['aotui_view_id'], additionalProperties: false,
            properties: { aotui_view_id: { enum: ['workspace', 'second'] } },
        });
        for (const input of [{}, {aotui_view_id: 'invented'}, {aotui_view_id: 1}])
            expect((await context.executeTool!(name, input, 'invalid'))?.error?.code).toBe('INVALID_VIEW_TARGET');
        expect(h.clients[0].client.invoke).not.toHaveBeenCalled();
        h.observations.set('one', observation('one', 2));
        const next = await h.source.getContext();
        expect((next.tools[name].inputSchema as any).jsonSchema).toEqual(source.tools[0].inputSchema);
        await context.executeTool!(name, { aotui_view_id: 'second' }, 'original-second');
        await context.executeTool!(name, { aotui_view_id: 'workspace' }, 'original-first');
        await next.executeTool!(name, {}, 'new-first');
        expect(h.clients[0].client.invoke.mock.calls.map(([request]) => [request.observationId, request.bindingId, request.input])).toEqual([
            ['one-observation-1', 'second-binding', {}], ['one-observation-1', 'one-binding-1', {}], ['one-observation-2', 'one-binding-2', {}],
        ]);
        await context.release!(); await next.release!(); h.source.dispose();
    });

    it('does not overwrite application parameters when injecting a multi-View selector', async () => {
        const h = harness(), source = observation('one');
        const other = { ...source.bindings[0].target, viewId: 'second', viewInstanceId: 'second-instance' };
        h.observations.set('one', { ...source,
            tools: [{ ...source.tools[0], inputSchema: { type: 'object', properties: {
                aotui_view_id: {type: 'string'}, _aotui_view_id: {type: 'string'}, view_id: {type: 'string'},
            }, required: ['view_id'], additionalProperties: false }, targets: [source.bindings[0].target, other] }],
            bindings: [...source.bindings, { bindingId: 'second-binding', toolId: 'tool', target: other }],
        });
        const context = await h.source.getContext(), name = 'one-AnyView-multi_open_file';
        expect((context.tools[name].inputSchema as any).jsonSchema.required).toEqual(['view_id', '__aotui_view_id']);
        const business = {aotui_view_id: 'business', _aotui_view_id: 'also business', view_id: 'owned by application'};
        await context.executeTool!(name, { ...business, __aotui_view_id: 'second' }, 'selected');
        expect(h.clients[0].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ bindingId: 'second-binding', input: business }));
        await context.release!(); h.source.dispose();
    });

    it('disambiguates duplicate App names, ambiguous logical names and illegal provider names', async () => {
        const h = harness([{ ...app('one'), name: 'same' }, { ...app('two'), name: 'same' }, { ...app('three'), name: '名字 / app' }]);
        const source = observation('one');
        h.observations.set('one', { ...source, tools: [
            {...source.tools[0], id: 'a', viewType: 'A-B', name: 'C'},
            {...source.tools[0], id: 'b', viewType: 'A', name: 'B-C'},
        ], bindings: [ {...source.bindings[0], toolId: 'a'}, {...source.bindings[0], toolId: 'b', bindingId: 'other'} ] });
        const context = await h.source.getContext(), names = Object.keys(context.tools);
        expect(names).toContain('same_two-AnyView-multi_open_file');
        expect(names.filter(name => name.startsWith('same_one-A-B-C_'))).toHaveLength(2);
        for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
        expect(names.filter(name => name.includes('multi_open_file'))).toHaveLength(2);
        await context.release!();
        const again = await h.source.getContext();
        expect(Object.keys(again.tools)).toEqual(names);
        await again.release!(); h.source.dispose();
    });
});
