import React, { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SessionManagerV3 } from '../../src/core/session-manager-v3.js';
import { HostManagerV2 } from '../../src/core/host-manager-v2.js';
import { ChatBridge } from '../../src/gui/ChatBridge.js';
import { TuiDesktopViewer } from '../../src/gui/components/TuiDesktopViewer.js';
import { appRouter } from '../../src/trpc/router.js';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';
import { createSnapshotCore, createAppInteraction, createViewOwnedTools, compileOrdinarySchema,
    type ExecutionBinding } from '@aotui/runtime/core';

// Existing DI boundaries: no singleton DesktopManager, user database/config,
// Electron process/IPC, skills scan, MCP server or model is started by this test.
vi.mock('../../src/core/desktop-manager.js', () => { throw Error('Forbidden ambient DesktopManager import'); });
vi.mock('../../src/db/index.js', () => ({ getTopic: () => undefined, getDb: () => { throw Error('Unexpected DB access'); } }));
vi.mock('../../src/config/config.js', () => ({ Config: { get: async () => ({ agents: { list: [] }, mcp: {} }) } }));
vi.mock('../../src/core/message-service-v2.js', () => ({ MessageServiceV2: class { getMessages() { return []; } } }));
vi.mock('../../src/core/llm-config-service.js', () => ({ LLMConfigService: class {} }));
vi.mock('../../src/mcp/index.js', () => ({ MCP: { tools: async () => ({}) } }));
vi.mock('../../src/skills/skill-catalog-service.js', () => ({ SkillCatalogService: class {} }));
vi.mock('electron', () => ({ dialog: {} }));
vi.mock('electron-trpc/renderer', () => ({ ipcLink: () => { throw Error('Unexpected Electron IPC'); } }));

function deferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function assembly(topicId: string, instanceId: string) {
    const core = createSnapshotCore(); core.lifecycle.startApp('preview_app', instanceId);
    const registry = createViewOwnedTools('preview_app', instanceId);
    const view = registry.mount('work', 'Workspace');
    const input = compileOrdinarySchema({ type: 'object', properties: {}, additionalProperties: false }, 'view-type-parameters-v1');
    if (!input.ok) throw Error('Invalid controlled Schema');
    let entries = 0;
    const unregister = registry.registerTypeTool({ viewType: 'Workspace', name: 'inspect', description: 'Inspect current work.', inputSchema: input.contract.schema }, {
        safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => async () => {
            entries++; return { phase: 'entered-returned', result: { success: true, data: { completed: true } } };
        },
    });
    const binding: ExecutionBinding = { identity: {}, mode: 'view-type-parameters-v1',
        validateInput: (_source, value) => ({ ok: true, value }),
        isLive: source => ({ ok: registry.validateTypeToolBinding(source.tool, source.execution).success }),
        execute: async () => { entries++; return { kind: 'tool-result', phase: 'entered-returned', result: { success: true } }; },
    };
    const authority = createAppInteraction(core.store, { namespace: 'preview:' + instanceId, now: Date.now, appId: 'preview_app', instanceId,
        policy: { project({ source }) {
            const views = source.views.map(view => ({ viewId: view.id, viewInstanceId: view.viewInstanceId }));
            return { views, refs: [], toolBindings: Object.values(source.tools).map(tool => ({ toolId: tool.id, execution: tool.execution })),
                content: views.map(view => ({ view, decision: 'retain' })) };
        }, authorize: () => true, canReadReceipt: () => true }, execution: { resolve: () => binding } });
    const listeners = new Set<() => void>();
    let hold: { started: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> } | undefined;
    const gates: Array<ReturnType<typeof deferred>> = [];
    let sequence = 0, businessValue = '';
    const desktop = { id: topicId,
        output: { subscribe: (fn: () => void) => { listeners.add(fn); }, unsubscribe: (fn: () => void) => { listeners.delete(fn); } },
        getInstalledApps: () => [{ appId: 'preview_app', appInstanceId: instanceId, name: 'preview_app', status: 'running' }],
        getSystemLogs: () => [],
    };
    function publish(body: string, notify = true) {
        businessValue = body;
        const accepted = core.committer.accept({ schemaVersion: 3, appId: 'preview_app', instanceId,
            producerSeq: ++sequence, sourceEpoch: sequence, capturedAt: Date.now(),
            views: [{ id: view.viewId, viewInstanceId: view.viewInstanceId, type: 'Workspace', kind: 'state', name: 'Current work',
                content: { format: 'markdown-v1', value: body } }], refs: {},
            tools: Object.fromEntries(registry.listTools().map(tool => [tool.id, tool])),
        });
        expect(accepted.status).toBe('published');
        if (notify) for (const listener of [...listeners]) listener();
    }
    publish('Initial ' + topicId, false);
    return { desktop, core, authority, listeners, publish, instanceId, stage(body: string) { businessValue = body; }, businessValue: () => businessValue, entries: () => entries,
        holdNextRead() { const barrier = { started: deferred(), resume: deferred() }; hold = barrier; gates.push(barrier.resume); return barrier; },
        interaction: () => ({ status: 'ready' as const, interaction: { ...authority, preview: async () => {
            const barrier = hold; hold = undefined;
            const result = await authority.preview();
            if (barrier) { barrier.started.resolve(); await barrier.resume.promise; }
            return result;
        } } }),
        async dispose() { for (const gate of gates) gate.resolve(); authority.close(); await authority.whenClosed(); unregister(); registry.dispose(); core.lifecycle.dispose(); },
    };
}
function fixture() {
    const sessions = new Map<string, any>();
    const assemblies: ReturnType<typeof assembly>[] = [];
    const ensure = vi.fn(async (id: string) => {
        if (!sessions.has(id)) {
            const app = assembly(id, 'run_' + (assemblies.length + 1)); assemblies.push(app);
            sessions.set(id, { topicId: id, desktop: app.desktop, state: 'paused', app });
        }
        return sessions.get(id);
    });
    const manager = { ensureSession: ensure,
        getSession: SessionManagerV3.prototype.getSession.bind({ sessions, logger: { debug() {} } }),
        shutdownSession: async (id: string) => { const session = sessions.get(id); if (session) session.state = 'destroyed'; sessions.delete(id); } };
    const kernel = { getDesktop: (id: string) => sessions.get(id)?.desktop,
        getAppInteraction: (id: string, _appId: string, _instanceId: string) => sessions.get(id).app.interaction() };
    const host = new HostManagerV2('unused', {} as any);
    Object.assign(host, { sessionManager: manager, kernel });
    const caller = appRouter.createCaller({ hostManager: host } as any);
    const bridge = ChatBridge.getInstance();
    const wires: Array<{ unsubscribe(): void }> = [];
    const subscribed = deferred();
    const observers: any[] = [];
    let attach: Promise<void> | undefined;
    const client = { session: {
        create: { mutate: (value: { id: string }) => caller.session.create(value) },
        snapshot: { query: (value: { id: string }) => caller.session.snapshot(value) },
        shutdown: { mutate: (value: { id: string }) => caller.session.shutdown(value) },
        destroy: { mutate: (value: { id: string }) => caller.session.destroy(value) },
        events: { subscribe: (input: { id: string }, observer: any) => {
            observers.push(observer);
            let inner: { unsubscribe(): void } | undefined, cancelled = false;
            void caller.session.events(input).then(async stream => {
                if (attach) await attach;
                if (!cancelled) inner = stream.subscribe({ next: observer.onData, error: observer.onError });
                subscribed.resolve();
            });
            const wire = { unsubscribe() { cancelled = true; inner?.unsubscribe(); } }; wires.push(wire); return wire;
        } },
    } };
    vi.spyOn(bridge, 'getTrpcClient').mockReturnValue(client as any);
    return { host, manager, ensure, sessions, assemblies, bridge, client, subscribed, observers, delayAttach(promise: Promise<void>) { attach = promise; },
        async dispose() { for (const wire of wires) wire.unsubscribe(); for (const app of assemblies) await app.dispose(); } };
}
function LivePreview({ bridge, topicId }: { bridge: ChatBridge; topicId: string }) {
    const [snapshot, setSnapshot] = useState(bridge.getSnapshot(topicId));
    useEffect(() => bridge.subscribe(() => setSnapshot(bridge.getSnapshot(topicId))), [bridge, topicId]);
    return <TuiDesktopViewer snapshot={snapshot} />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); (ChatBridge as any).instance = null; });

describe('current Host preview subscription', () => {
    it('renders two accepted updates while remaining on a paused Topic without another user command or page switch', async () => {
        const f = fixture();
        try {
            const requests = vi.spyOn(f.bridge, 'requestSnapshot');
            const queries = vi.spyOn(f.client.session.snapshot, 'query');
            render(<LivePreview bridge={f.bridge} topicId="topic_a" />);
            await act(async () => { await f.bridge.requestSnapshot('topic_a'); await f.subscribed.promise; });
            expect(screen.getByText('Initial topic_a')).toBeInTheDocument();
            const initialQueries = queries.mock.calls.length;
            const app = f.sessions.get('topic_a').app;
            const agent = new SemanticAOTUIDrivenSource(app.desktop as any, (f.host as any).kernel, { includeInstruction: false });
            try {
                const context = await agent.getContext(); await context.adopt!();
                await act(async () => {
                    app.publish('Committed one');
                    expect((await f.host.getSnapshot('topic_a'))?.markup).toContain('Committed one');
                    await vi.waitFor(() => expect(f.bridge.getSnapshot('topic_a')).toContain('Committed one'));
                });
                expect(screen.getByText('Committed one')).toBeInTheDocument();
                await act(async () => {
                    app.publish('Committed two');
                    await vi.waitFor(() => expect(f.bridge.getSnapshot('topic_a')).toContain('Committed two'));
                });
                expect(screen.getByText('Committed two')).toBeInTheDocument();
                expect(screen.queryByText('Initial topic_a')).toBeNull();
                expect(f.sessions.get('topic_a').state).toBe('paused');
                expect((await context.executeTool!('preview_app-Workspace-inspect', {}, 'agent-still-qualified'))?.outcomeStatus).toBe('succeeded');
                expect(app.entries()).toBe(1);
                // The GUI initiates no second request; notifications drive independent reads.
                expect(queries.mock.calls.length).toBeGreaterThan(initialQueries);
                expect(requests).toHaveBeenCalledTimes(1);
                await context.release?.();
            } finally { agent.dispose(); }
            expect(app.authority.inspect().observations.observationSlots).toBe(0);
            expect(app.authority.inspect()).toMatchObject({ sourceBytes: 0, workBytes: 0 });
            expect(app.core.store.inspect().activeLeases).toBe(0);
        } finally { await f.dispose(); }
    });
    it('covers publication between the initial query and IPC subscription attachment', async () => {
        const f = fixture(), attach = deferred(); f.delayAttach(attach.promise);
        const stop = f.bridge.subscribe(() => {});
        try {
            await f.bridge.requestSnapshot('handoff');
            expect(f.bridge.getSnapshot('handoff')).toContain('Initial handoff');
            f.sessions.get('handoff').app.publish('Published during handoff');
            attach.resolve(); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('handoff')).toContain('Published during handoff'));
        } finally { attach.resolve(); stop(); await f.dispose(); }
    });

    it('re-reads a notification received while an older query is still in flight', async () => {
        const f = fixture(), entered = deferred(), finish = deferred();
        const stop = f.bridge.subscribe(() => {});
        try {
            await f.bridge.requestSnapshot('order'); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('order')).toContain('Initial order'));
            const query = f.client.session.snapshot.query;
            f.client.session.snapshot.query = async value => { const result = await query(value); entered.resolve(); await finish.promise; return result; };
            const pending = f.bridge.requestSnapshot('order'); await entered.promise;
            f.sessions.get('order').app.publish('New push wins');
            finish.resolve(); await pending;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('order')).toContain('New push wins'));
            expect(f.bridge.getSnapshot('order')).toContain('New push wins');
        } finally { finish.resolve(); stop(); await f.dispose(); }
    });

    it('lets the latest explicit query win when responses are reordered', async () => {
        const f = fixture(), entered = deferred(), finish = deferred();
        const stop = f.bridge.subscribe(() => {});
        try {
            await f.bridge.requestSnapshot('queries'); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('queries')).toContain('Initial queries'));
            const query = f.client.session.snapshot.query; let first = true;
            f.client.session.snapshot.query = async value => {
                const result = await query(value);
                if (first) { first = false; entered.resolve(); await finish.promise; }
                return result;
            };
            const older = f.bridge.requestSnapshot('queries'); await entered.promise;
            f.sessions.get('queries').app.publish('Explicit latest', false);
            const newer = f.bridge.requestSnapshot('queries');
            finish.resolve(); await Promise.all([older, newer]);
            expect(f.bridge.getSnapshot('queries')).toContain('Explicit latest');
        } finally { finish.resolve(); stop(); await f.dispose(); }
    });

    it('isolates two Topics and discards the old same-id Session response after shutdown/reopen', async () => {
        const f = fixture(), entered = deferred(), finish = deferred();
        const stop = f.bridge.subscribe(() => {});
        try {
            await f.bridge.requestSnapshot('one'); await f.subscribed.promise;
            await f.bridge.requestSnapshot('two');
            await vi.waitFor(() => expect(f.bridge.getSnapshot('two')).toContain('Initial two'));
            f.sessions.get('one').app.publish('Only topic one');
            await vi.waitFor(() => expect(f.bridge.getSnapshot('one')).toContain('Only topic one'));
            expect(f.bridge.getSnapshot('two')).toContain('Initial two');
            const query = f.client.session.snapshot.query; let first = true;
            f.client.session.snapshot.query = async value => {
                const result = await query(value);
                if (value.id === 'one' && first) { first = false; entered.resolve(); await finish.promise; }
                return result;
            };
            const oldSession = f.sessions.get('one');
            const pending = f.bridge.requestSnapshot('one'); await entered.promise;
            await f.bridge.shutdownDesktop('one');
            expect(f.bridge.getSnapshot('one')).toBe('');
            await f.bridge.requestSnapshot('one');
            expect(f.sessions.get('one')).not.toBe(oldSession);
            await vi.waitFor(() => expect(f.bridge.getSnapshot('one')).toContain('Initial one'));
            finish.resolve(); await pending;
            oldSession.app.publish('Old instance must stay gone');
            expect(f.bridge.getSnapshot('one')).not.toContain('Only topic one');
            expect(f.bridge.getSnapshot('one')).not.toContain('Old instance');
            expect(f.bridge.getSnapshot('two')).toContain('Initial two');
        } finally { finish.resolve(); stop(); await f.dispose(); }
    });

    it('discards the actual pending preview after unsubscribe without late emits or recreation', async () => {
        const f = fixture(); const events = vi.fn(), stop = f.bridge.subscribe(events);
        try {
            await f.bridge.requestSnapshot('release'); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('release')).toContain('Initial release'));
            const app = f.sessions.get('release').app, barrier = app.holdNextRead();
            app.publish('Held preview'); await barrier.started.promise;
            expect(app.authority.inspect().observations.observationSlots).toBe(0);
            expect(app.core.store.inspect().activeLeases).toBe(0);
            const ensureCalls = f.ensure.mock.calls.length;
            const cached = f.bridge.getSnapshot('release');
            stop(); const eventCount = events.mock.calls.length;
            expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(0);
            // Cancellation revokes publishing; the preview has no observation to release.
            expect(app.authority.inspect().observations.observationSlots).toBe(0);
            barrier.resume.resolve();
            await vi.waitFor(() => expect(app.authority.inspect().observations.observationSlots).toBe(0));
            expect(app.core.store.inspect().activeLeases).toBe(0);
            expect(app.authority.inspect()).toMatchObject({ sourceBytes: 0, workBytes: 0 });
            expect(f.bridge.getSnapshot('release')).toBe(cached);
            expect(app.listeners.size).toBe(0);
            app.publish('After cancellation');
            expect(events).toHaveBeenCalledTimes(eventCount);
            expect(f.ensure).toHaveBeenCalledTimes(ensureCalls);
        } finally { stop(); await f.dispose(); }
    });

    it('does not attach or query after shutdown while the initial create reply is pending', async () => {
        const f = fixture(), created = deferred(), reply = deferred();
        const stop = f.bridge.subscribe(() => {});
        try {
            const create = f.client.session.create.mutate;
            f.client.session.create.mutate = async value => { const result = await create(value); created.resolve(); await reply.promise; return result; };
            const query = vi.spyOn(f.client.session.snapshot, 'query');
            const pending = f.bridge.requestSnapshot('starting'); await created.promise;
            await f.bridge.shutdownDesktop('starting'); reply.resolve(); await pending;
            expect(query).not.toHaveBeenCalled(); expect(f.sessions.has('starting')).toBe(false);
            expect(f.ensure).toHaveBeenCalledTimes(1);
            expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(0);
        } finally { reply.resolve(); stop(); await f.dispose(); }
    });

    it('reports preview errors without clearing valid data or terminating chat, and recovers on publication', async () => {
        const f = fixture(), events: any[] = [], stop = f.bridge.subscribe(event => events.push(event));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await f.bridge.requestSnapshot('error'); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('error')).toContain('Initial error'));
            const app = f.sessions.get('error').app;
            const discovery = vi.spyOn(app.desktop, 'getInstalledApps').mockImplementation(() => { throw Error('Controlled preview capture failed'); });
            app.publish('Not readable yet');
            await vi.waitFor(() => expect(events.some(event => event.type === 'snapshot_error' && String(event.data).includes('Controlled preview capture failed'))).toBe(true));
            expect(f.bridge.getSnapshot('error')).toContain('Initial error');
            expect(errors).toHaveBeenCalled();
            (f.host as any).emitGuiUpdate({ topicId: 'error', type: 'assistant', message: { role: 'assistant', content: 'Chat still alive' } });
            expect(f.bridge.getMessages('error').some(message => message.content === 'Chat still alive')).toBe(true);
            discovery.mockRestore(); app.publish('Preview recovered');
            await vi.waitFor(() => expect(f.bridge.getSnapshot('error')).toContain('Preview recovered'));
            expect(app.authority.inspect().observations.observationSlots).toBe(0);
        } finally { stop(); await f.dispose(); }
    });

    it('does not poll silent publications or invent an uncommitted manual View', async () => {
        const f = fixture(), stop = f.bridge.subscribe(() => {});
        try {
            await f.bridge.requestSnapshot('signals'); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('signals')).toContain('Initial signals'));
            const app = f.sessions.get('signals').app;
            app.publish('Silent committed value', false); // never: accepted, no output notification
            expect(f.bridge.getSnapshot('signals')).toContain('Initial signals');
            await f.bridge.requestSnapshot('signals');
            expect(f.bridge.getSnapshot('signals')).toContain('Silent committed value');
            // A manual background business change has no accepted publication to expose.
            app.stage('Uncommitted manual value');
            expect(app.businessValue()).toBe('Uncommitted manual value');
            await f.bridge.requestSnapshot('signals');
            expect(f.bridge.getSnapshot('signals')).toContain('Silent committed value');
            expect(f.bridge.getSnapshot('signals')).not.toContain('Uncommitted manual value');
            stop();
            await expect(f.host.getSnapshot('absent')).rejects.toThrow('Session not available');
            expect(f.sessions.has('absent')).toBe(false);
        } finally { stop(); await f.dispose(); }
    });

    it('skips an outdated in-flight read and coalesces notifications into one current read', async () => {
        const f = fixture(), seen: string[] = [], stop = f.bridge.subscribe(() => seen.push(f.bridge.getSnapshot('coalesce')));
        try {
            await f.bridge.requestSnapshot('coalesce'); await f.subscribed.promise;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('coalesce')).toContain('Initial coalesce'));
            const calls = vi.spyOn(f.host, 'getSnapshot');
            const app = f.sessions.get('coalesce').app, barrier = app.holdNextRead();
            app.publish('Outdated push'); await barrier.started.promise;
            app.publish('Intermediate value'); app.publish('Current committed value');
            barrier.resume.resolve();
            await vi.waitFor(() => expect(f.bridge.getSnapshot('coalesce')).toContain('Current committed value'));
            expect(seen.some(value => value.includes('Outdated push') || value.includes('Intermediate value'))).toBe(false);
            expect(calls).toHaveBeenCalledTimes(2);
            expect(app.authority.inspect().observations.observationSlots).toBe(0);
        } finally { stop(); await f.dispose(); }
    });

    it('observes a newer silent commit through the same in-flight reader', async () => {
        const f = fixture(), stop = f.bridge.subscribe(() => {});
        try {
            await f.bridge.requestSnapshot('mixed'); await f.subscribed.promise;
            const app = f.sessions.get('mixed').app, barrier = app.holdNextRead();
            const query = f.client.session.snapshot.query; let active = 0, peak = 0;
            f.client.session.snapshot.query = async value => {
                active++; peak = Math.max(peak, active);
                try { return await query(value); } finally { active--; }
            };
            app.publish('Older notified value'); await barrier.started.promise;
            app.publish('Newer silent value', false);
            const explicit = f.bridge.requestSnapshot('mixed');
            barrier.resume.resolve(); await explicit;
            await vi.waitFor(() => expect(f.bridge.getSnapshot('mixed')).toContain('Newer silent value'));
            expect(peak).toBe(1); expect(active).toBe(0);
        } finally { stop(); await f.dispose(); }
    });

});

it('owner: delivers chat after a Session recycled by the backend is recreated', async () => {
    const f = fixture(), stop = f.bridge.subscribe(() => {});
    try {
        await f.bridge.requestSnapshot('evicted'); await f.subscribed.promise;
        const previous = f.sessions.get('evicted');
        await f.manager.shutdownSession('evicted');
        await f.bridge.activateDesktop('evicted');
        expect(f.sessions.get('evicted')).not.toBe(previous);
        (f.host as any).emitGuiUpdate({ topicId: 'evicted', type: 'assistant',
            message: { role: 'assistant', content: 'Reply after backend recycling' } });
        expect(f.bridge.getMessages('evicted').some(message => message.content === 'Reply after backend recycling')).toBe(true);
    } finally { stop(); await f.dispose(); }
});

it('owner: a foreign Topic event does not count as access to an idle Session', async () => {
    const f = fixture(), stop = f.bridge.subscribe(() => {});
    try {
        await f.bridge.requestSnapshot('idle_topic'); await f.subscribed.promise;
        const session = f.sessions.get('idle_topic');
        f.manager.getSession = SessionManagerV3.prototype.getSession.bind({ sessions: f.sessions, logger: { debug() {} } });
        session.lastAccessTime = 1;
        (f.host as any).emitGuiUpdate({ topicId: 'some_other_topic', type: 'assistant',
            message: { role: 'assistant', content: 'Unrelated traffic' } });
        expect(session.lastAccessTime).toBe(1);
    } finally { stop(); await f.dispose(); }
});

it('owner: a failing Desktop subscription does not retain a GUI listener', async () => {
    const f = fixture(); let wire: { unsubscribe(): void } | undefined;
    try {
        const session = await f.manager.ensureSession('closing');
        vi.spyOn(session.desktop.output, 'subscribe').mockImplementation(() => { throw Error('Desktop is closing'); });
        const stream = await appRouter.createCaller({ hostManager: f.host } as any).session.events({ id: 'closing' });
        try { wire = stream.subscribe({ next() {}, error() {} }); } catch { /* subscribe can fail synchronously */ }
        expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(0);
    } finally { wire?.unsubscribe(); await f.dispose(); }
});


it('restores the current preview after real Session teardown without accepting the held old page', async () => {
    const f = fixture(), seen: string[] = [], stop = f.bridge.subscribe(() => seen.push(f.bridge.getSnapshot('recycled')));
    try {
        await f.bridge.requestSnapshot('recycled'); await f.subscribed.promise;
        const previous = f.sessions.get('recycled'), app = previous.app;
        app.publish('Old visible page');
        await vi.waitFor(() => expect(f.bridge.getSnapshot('recycled')).toContain('Old visible page'));
        const barrier = app.holdNextRead(); app.publish('Held previous Session'); await barrier.started.promise;
        previous.agentDriver = { stop: vi.fn(), dispose: vi.fn() };
        previous.sources = { aotui: { dispose: vi.fn(async () => {}) } };
        const backend = { sessions: f.sessions, inFlightSessions: new Map(), sourceControlsByTopic: new Map(),
            kernel: { destroyDesktop: vi.fn(async () => {}) }, logger: { info() {}, warn() {}, error() {} } };
        await SessionManagerV3.prototype.destroySession.call(backend as any, 'recycled');
        expect(previous.state).toBe('destroyed'); expect(previous.agentDriver.stop).toHaveBeenCalledOnce();
        await f.bridge.activateDesktop('recycled');
        const current = f.sessions.get('recycled'); expect(current).not.toBe(previous);
        // The old Desktop listener is gone; the pending preview owns only rendered data.
        expect(app.listeners.size).toBe(0); expect(app.authority.inspect().observations.observationSlots).toBe(0);
        expect(app.core.store.inspect().activeLeases).toBe(0);
        (f.host as any).emitGuiUpdate({ topicId: 'recycled', type: 'assistant',
            message: { role: 'assistant', content: 'Current Session reply' } });
        expect(f.bridge.getMessages('recycled').some(message => message.content === 'Current Session reply')).toBe(true);
        current.app.publish('New incarnation page'); barrier.resume.resolve();
        await vi.waitFor(() => expect(f.bridge.getSnapshot('recycled')).toContain('New incarnation page'));
        expect(seen.some(value => value.includes('Held previous Session'))).toBe(false);
        expect(app.listeners.size).toBe(0); expect(app.authority.inspect().observations.observationSlots).toBe(0);
        expect(app.core.store.inspect().activeLeases).toBe(0); expect(app.authority.inspect()).toMatchObject({ sourceBytes: 0, workBytes: 0 });
        app.publish('Late old Desktop notification');
        expect(f.bridge.getSnapshot('recycled')).toContain('New incarnation page');
        current.app.publish('New incarnation second update');
        await vi.waitFor(() => expect(f.bridge.getSnapshot('recycled')).toContain('New incarnation second update'));
    } finally { stop(); await f.dispose(); }
});

it('cleans a Desktop registration that adds its callback before throwing', async () => {
    const f = fixture(); let wire: { unsubscribe(): void } | undefined;
    try {
        const session = await f.manager.ensureSession('partial');
        const original = session.desktop.output.subscribe;
        vi.spyOn(session.desktop.output, 'subscribe').mockImplementation((listener: any) => {
            original(listener); throw Error('Controlled partial subscribe');
        });
        const error = vi.fn();
        const stream = await appRouter.createCaller({ hostManager: f.host } as any).session.events({ id: 'partial' });
        wire = stream.subscribe({ next() {}, error });
        expect(error).toHaveBeenCalledOnce(); expect(session.app.listeners.size).toBe(0);
        expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(0);
    } finally { wire?.unsubscribe(); await f.dispose(); }
});

it('retries a failed stream on activation and ignores that old streams late data and errors', async () => {
    const f = fixture(), events: any[] = [], stop = f.bridge.subscribe(event => events.push(event));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const session = await f.manager.ensureSession('retry');
        const original = session.desktop.output.subscribe; let rejectNext = true;
        vi.spyOn(session.desktop.output, 'subscribe').mockImplementation((listener: any) => {
            if (rejectNext) { rejectNext = false; throw Error('Desktop closing during subscription'); }
            original(listener);
        });
        await f.bridge.requestSnapshot('retry'); await f.subscribed.promise;
        expect(events.some(event => event.type === 'snapshot_error' && String(event.data).includes('Desktop closing'))).toBe(true);
        expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(0);
        const failed = f.observers[0];
        await f.bridge.activateDesktop('retry');
        await vi.waitFor(() => expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(1));
        session.app.publish('Recovered preview');
        await vi.waitFor(() => expect(f.bridge.getSnapshot('retry')).toContain('Recovered preview'));
        const count = events.length;
        failed.onData({ topicId: 'retry', type: 'assistant', message: { role: 'assistant', content: 'Late failed-stream message' } });
        failed.onError(Error('Late failed-stream error'));
        expect(events).toHaveLength(count);
        expect(f.bridge.getMessages('retry').some(message => message.content === 'Late failed-stream message')).toBe(false);
        (f.host as any).emitGuiUpdate({ topicId: 'retry', type: 'assistant', message: { role: 'assistant', content: 'Recovered chat' } });
        expect(f.bridge.getMessages('retry').some(message => message.content === 'Recovered chat')).toBe(true);
        expect((f.host as any).guiEventEmitter.listenerCount('gui-update')).toBe(1);
    } finally { stop(); await f.dispose(); }
});

it('invalidates the held old result even if the replacement Desktop refuses its listener', async () => {
    const f = fixture(), seen: string[] = [], stop = f.bridge.subscribe(() => seen.push(f.bridge.getSnapshot('rebind_closing')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await f.bridge.requestSnapshot('rebind_closing'); await f.subscribed.promise;
        const previous = f.sessions.get('rebind_closing'), barrier = previous.app.holdNextRead();
        previous.app.publish('Held old result must not appear'); await barrier.started.promise;
        await f.manager.shutdownSession('rebind_closing');
        f.ensure.mockImplementationOnce(async id => {
            const app = assembly(id, 'replacement_closing'); f.assemblies.push(app);
            app.publish('Current closing snapshot', false);
            vi.spyOn(app.desktop.output, 'subscribe').mockImplementation(() => { throw Error('Replacement is closing'); });
            const session = { topicId: id, desktop: app.desktop, state: 'paused', app };
            f.sessions.set(id, session); return session;
        });
        await f.bridge.activateDesktop('rebind_closing'); barrier.resume.resolve();
        await vi.waitFor(() => expect(f.bridge.getSnapshot('rebind_closing')).toContain('Current closing snapshot'));
        expect(seen.some(value => value.includes('Held old result must not appear'))).toBe(false);
        expect(previous.app.authority.inspect().observations.observationSlots).toBe(0);
        expect(previous.app.core.store.inspect().activeLeases).toBe(0);
        (f.host as any).emitGuiUpdate({ topicId: 'rebind_closing', type: 'assistant',
            message: { role: 'assistant', content: 'Chat while preview listener is unavailable' } });
        expect(f.bridge.getMessages('rebind_closing').some(message => message.content === 'Chat while preview listener is unavailable')).toBe(true);
    } finally { stop(); await f.dispose(); }
});
