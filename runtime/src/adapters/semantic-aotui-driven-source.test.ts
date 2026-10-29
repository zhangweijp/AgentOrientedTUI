import { describe, expect, it, vi } from 'vitest';
import { SemanticAOTUIDrivenSource, semanticToolResult } from './semantic-aotui-driven-source.js';
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
function harness(installed = [app('one')]) {
    const observations = new Map(installed.map(item => [String(item.appId), observation(String(item.appId))]));
    const clients: Array<{ appId: string; client: ScopeClient & { observe: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>; releaseObservation: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } }> = [];
    const updates = new Set<() => void>();
    const desktop = {
        id: 'desktop', getInstalledApps: vi.fn(() => installed),
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
    const source = new SemanticAOTUIDrivenSource(desktop as unknown as IDesktop, kernel as unknown as IKernel);
    return { source, desktop, kernel, observations, clients, installed, updates };
}
const findTool = (context: Awaited<ReturnType<SemanticAOTUIDrivenSource['getContext']>>, fragment: string) => {
    const name = Object.keys(context.tools).find(name => name.includes(fragment));
    expect(name).toBeDefined(); return name!;
};

describe('SemanticAOTUIDrivenSource', () => {
    it('projects multiple apps through semantic scopes and opens pending apps through the Desktop lifecycle', async () => {
        const h = harness([app('one'), app('two'), app('pending', 'pending')]);
        const context = await h.source.getContext();
        const one = findTool(context, '_one_'), two = findTool(context, '_two_');
        expect(one).not.toBe(two);
        expect(context.tools.aotui_read_receipt).toBeUndefined();
        expect(context.messages.filter(message => String(message.content).startsWith('<view '))).toHaveLength(2);
        expect(context.messages.some(message => String(message.content).includes('id="pending"'))).toBe(true);
        for (const entry of h.clients) expect(entry.client.observe).toHaveBeenCalledWith({ all: true });
        await context.executeTool!(one, {}, 'one-call');
        await context.executeTool!(two, {}, 'two-call');
        expect(h.clients[0].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'one-observation-1', bindingId: 'one-binding-1' }));
        expect(h.clients[1].client.invoke).toHaveBeenCalledWith(expect.objectContaining({ observationId: 'two-observation-1', bindingId: 'two-binding-1' }));
        expect((await context.executeTool!('aotui_open_app', { app_id: 'pending' }, 'open'))?.outcomeStatus).toBe('succeeded');
        expect(h.desktop.openApp).toHaveBeenCalledWith('pending');
        expect(h.kernel.acquireSnapshot).not.toHaveBeenCalled();
        expect(h.kernel.execute).not.toHaveBeenCalled();
        expect(h.desktop.getSnapshotFragments).not.toHaveBeenCalled();
        await context.release!();
        const next = await h.source.getContext();
        expect(Object.keys(next.tools).some(name => name.includes('_pending_'))).toBe(true);
        await next.release!(); h.source.dispose();
    });

    it('pins each call to its observed binding and closes scopes only after the last context releases', async () => {
        const h = harness();
        const first = await h.source.getContext(), tool = findTool(first, '_multi_open_file_');
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
        expect(Object.keys(context.tools).some(name => name.includes('_multi_open_file_'))).toBe(false);
        expect(context.tools.aotui_close_app).toBeDefined();
        await context.release!(); h.source.dispose();
    });

    it('shares one capture for compatibility message and tool reads started together', async () => {
        const h = harness();
        const [messages, tools] = await Promise.all([h.source.getMessages(), h.source.getTools()]);
        expect(messages.some(message => String(message.content).includes('current one revision 1'))).toBe(true);
        expect(Object.keys(tools).some(name => name.includes('_multi_open_file_'))).toBe(true);
        expect(h.clients).toHaveLength(1);
        expect(h.clients[0].client.observe).toHaveBeenCalledTimes(1);
        h.source.dispose();
    });

    it('does not accumulate a session-wide invocation ledger over more than 256 rounds', async () => {
        const h = harness();
        for (let round = 0; round < 300; round++) {
            const context = await h.source.getContext();
            const result = await context.executeTool!(findTool(context, '_multi_open_file_'), {}, `call-${round}`);
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
        const result = await context.executeTool!(findTool(context, '_multi_open_file_'), {}, 'uncertain');
        expect(result?.outcomeStatus).toBe('unknown');
        expect(h.clients[0].client.invoke).toHaveBeenCalledOnce();
        await context.release!(); h.source.dispose();
    });

    it('revokes a disabled app even for a previously captured context', async () => {
        const h = harness(), context = await h.source.getContext();
        h.source.setAppEnabled('one', false);
        const result = await context.executeTool!(findTool(context, '_multi_open_file_'), {}, 'after-disable');
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
        h.observations.set('long-application-name', observation('long-application-name', 1, 'send_command_to_exist_terminal'));
        const context = await h.source.getContext();
        const name = findTool(context, '_send_command_to_exist_terminal_');
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^[A-Za-z0-9_]+$/);
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
