import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotCore, refKey } from '../snapshot/index.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshotV2, JsonValue, PreparedAppSnapshotDraftV2, SnapshotStoreOptions } from '../snapshot/types.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { createObservationRegistry, DEFAULT_OBSERVATION_REGISTRY_LIMITS as HARD } from './observation-registry.js';
import type { Observation, ObservationGrant, ObservationRegistryLimitOverrides, ScopeHandle } from './observation-types.js';

afterEach(() => vi.restoreAllMocks());
const context = { appId: 'app', instanceId: 'run' };
const emptyGrant = (): ObservationGrant => ({ views: [], refs: [], targets: [], content: [] });
it('captures business target selectors and refuses a policy that rewrites their value', () => {
    const f = fixture({ views: 1, tools: 0, refs: 0, ready: false });
    f.tools.registerTool(f.owners[0].viewInstanceId, { name: 'edit', description: 'Edit selected document', isMutating: true,
        inputSchema: { type: 'object', properties: { document: { type: 'string' } }, required: ['document'] },
        target: { param: 'document', value: 'document-A' } }, f.handler);
    const published = f.publish();
    const scope = f.scope(), prepared = f.begin(scope), grant = f.grant(published);
    const forged = { ...grant, targets: grant.targets.map(t => ({ ...t, target: { ...t.target, selector: { param: 'document', value: 'document-B' } } })) };
    expect(f.registry.complete(scope, prepared.reservation, forged)).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_PROJECTION_INVALID' } });
    const observation = f.observe(scope, grant);
    expect(observation.bindings[0].target.selector).toEqual({ param: 'document', value: 'document-A' });
    f.registry.close(); f.core.lifecycle.dispose();
});
function fixture(options: { views?: number; refs?: number; tools?: number; content?: JsonValue;
    payload?: JsonValue; store?: SnapshotStoreOptions; limits?: ObservationRegistryLimitOverrides; ready?: boolean;
    lifetime?: 'scope' | 'ttl' } = {}) {
    let time = 0, sequence = 0;
    const now = () => time;
    const core = createSnapshotCore({ now, ...options.store });
    core.lifecycle.startApp(context.appId, context.instanceId);
    const tools = createViewOwnedTools(context.appId, context.instanceId);
    const handler = vi.fn(async () => ({ success: true }));
    const owners = Array.from({ length: options.views ?? 2 }, (_, i) => tools.mount('v' + i, 'File'));
    const declarations = Array.from({ length: options.tools ?? 1 }, (_, i) => ({
        name: 'tool' + i, description: 'Synthetic tool', inputSchema: { type: 'object', properties: {} }, isMutating: i % 2 === 1,
    }));
    const releases = owners.map(owner => declarations.map(declaration => tools.registerTool(owner.viewInstanceId, declaration, handler)));
    function rebindTool(viewIndex = 0, toolIndex = 0) {
        releases[viewIndex]![toolIndex]!();
        releases[viewIndex]![toolIndex] = tools.registerTool(owners[viewIndex]!.viewInstanceId, declarations[toolIndex]!, handler);
    }
    function draft(patch: Partial<PreparedAppSnapshotDraftV2> = {}): PreparedAppSnapshotDraftV2 {
        const seq = ++sequence;
        return { schemaVersion: 2, ...context, producerSeq: seq, sourceEpoch: seq, capturedAt: time,
            views: owners.map(v => ({ id: v.viewId, viewInstanceId: v.viewInstanceId, type: 'File', name: v.viewId, kind: 'state',
                content: options.content === undefined ? { format: 'markdown-v1', value: 'content-secret-' + v.viewId }
                    : { format: 'semantic-v1', value: options.content } })),
            refs: Object.fromEntries(owners.flatMap(v => Array.from({ length: options.refs ?? 2 }, (_, i) => [refKey(v.viewId, v.viewInstanceId, 'r' + i), {
                id: 'r' + i, ownerViewId: v.viewId, ownerViewInstanceId: v.viewInstanceId, refType: 'unknown',
                target: i === 1 ? { kind: 'entity', entityType: 'File', entityId: 'entity-secret', entityVersion: '1' }
                    : { kind: 'snapshot-value', payload: options.payload ?? { value: 'payload-secret-' + v.viewId } },
            }]))),
            tools: Object.fromEntries(tools.listTools().map(t => [t.id, { id: t.id, name: t.name, description: t.description,
                viewType: t.viewType, inputSchema: t.inputSchema, isMutating: t.isMutating, targets: t.targets }])), ...patch };
    }
    function publish(patch: Partial<PreparedAppSnapshotDraftV2> = {}): AppSnapshotV2 {
        const result = core.committer.accept(draft(patch));
        expect(result.status).toBe('published');
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 2) throw new Error('Expected V2 fixture');
        return result.snapshot;
    }
    const source = options.ready === false ? undefined : publish();
    const registry = createObservationRegistry(core.store, { namespace: 'test', now, limits: options.limits, lifetime: options.lifetime });
    function scope() {
        const result = registry.openScope(context);
        expect(result.status).toBe('opened'); if (result.status !== 'opened') throw new Error('Expected scope');
        return result.scope;
    }
    function begin(handle: ScopeHandle, viewIds = owners.map(v => v.viewId)) {
        const result = registry.begin(handle, { viewIds });
        expect(result.status).toBe('reserved'); if (result.status !== 'reserved') throw new Error('Expected reservation');
        return result;
    }
    function grant(snapshot = source!, visible = snapshot.views.map(v => v.id), retain = false): ObservationGrant {
        return { views: snapshot.views.filter(v => visible.includes(v.id)).map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
            refs: Object.values(snapshot.refs).filter(r => visible.includes(r.ownerViewId)).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            targets: Object.values(snapshot.tools).flatMap(t => t.targets.filter(v => visible.includes(v.viewId)).map(target => ({ toolId: t.id, target }))),
            content: retain ? snapshot.views.filter(v => visible.includes(v.id)).map(v => ({ view: { viewId: v.id, viewInstanceId: v.viewInstanceId }, decision: 'retain' as const })) : [] };
    }
    function observe(handle: ScopeHandle, permission = grant()) {
        const preparation = begin(handle);
        const result = registry.complete(handle, preparation.reservation, permission);
        expect(result.status).toBe('observed'); if (result.status !== 'observed') throw new Error('Expected observation');
        return result.observation;
    }
    return { core, registry, tools, handler, owners, source: source!, now, setTime: (n: number) => { time = n; }, draft, publish, scope, begin, grant, observe, rebindTool };
}
type Fixture = ReturnType<typeof fixture>;
function key(observation: Observation, i = 0) { return { observationId: observation.observationId, bindingId: observation.bindings[i]!.bindingId }; }
function code(result: unknown): string | undefined { return (result as { issue?: { code: string } }).issue?.code; }
function zero(f: Fixture) {
    f.registry.close();
    expect(f.registry.inspect()).toMatchObject({ scopes: 0, observations: 0, reservations: 0, sources: 0,
        sourceBytes: 0, observationBytes: 0, metadataBytes: 0, totalBytes: 0 });
    expect(f.core.store.inspect().activeLeases).toBe(0); expect(f.handler).not.toHaveBeenCalled();
}

describe('B1 projection and real source ownership', () => {
    it('clips a shared Tool to its original approved owner, hides content by default and never exports Ref payload/entity identity', () => {
        const f = fixture({ tools: 2 }), scope = f.scope();
        const permission = f.grant(f.source, ['v1']);
        const observation = f.observe(scope, permission);
        expect(observation.views.map(v => v.id)).toEqual(['v1']);
        expect(observation.views[0]).not.toHaveProperty('content');
        expect(observation.tools).toHaveLength(2);
        expect(observation.tools.every(t => t.targets.length === 1 && t.targets[0]!.viewId === 'v1')).toBe(true);
        expect(observation.bindings.map(b => b.target.viewId)).toEqual(['v1', 'v1']);
        expect(observation.bindings.every(b => !Object.hasOwn(b, 'arguments'))).toBe(true);
        expect(JSON.stringify(observation)).not.toMatch(/payload-secret|entity-secret|content-secret|"payload"|"entityVersion"|"viewId":"v0"/);
        const result = f.registry.resolveBinding(scope, key(observation));
        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.sourceRequest.snapshotId).toBe(f.source.id);
            expect(result.target).toBe(f.source.tools[result.tool.id]!.targets[1]);
            expect(result.visibleRefIds).toEqual(['r0', 'r1']);
            expect(Object.isFrozen(result.visibleRefIds)).toBe(true);
        }
        expect(f.core.store.inspect().activeLeases).toBe(1); zero(f);
    });
    it('retains only explicitly approved complete content and preserves source order despite reordered grants', () => {
        const f = fixture({ tools: 2 }), scope = f.scope(), grant = f.grant(f.source, ['v0', 'v1'], true);
        const observation = f.observe(scope, { views: [...grant.views].reverse(), refs: [...grant.refs].reverse(),
            targets: [...grant.targets].reverse(), content: [...grant.content].reverse() });
        expect(observation.views.map(v => v.id)).toEqual(['v0', 'v1']);
        expect(observation.refs.map(r => r.viewId + r.refId)).toEqual(['v0r0', 'v0r1', 'v1r0', 'v1r1']);
        expect(observation.tools.map(t => t.id)).toEqual(Object.keys(f.source.tools));
        expect(observation.bindings.map(b => b.target.viewId)).toEqual(['v0', 'v1', 'v0', 'v1']);
        expect(observation.views[0]!.content).toEqual(f.source.views[0]!.content);
        expect(Object.isFrozen(observation.views[0]!.content)).toBe(true); zero(f);
    });
    it('accepts an empty projection without manufacturing a Binding', () => {
        const f = fixture(), scope = f.scope(), observation = f.observe(scope, emptyGrant());
        expect(observation).toMatchObject({ views: [], refs: [], tools: [], bindings: [] });
        expect(code(f.registry.resolveBinding(scope, { observationId: observation.observationId, bindingId: 'absent' }))).toBe('BINDING_UNAVAILABLE'); zero(f);
    });
    it('detaches selection/grant and keeps genuine frozen handles without retaining caller aliases', () => {
        const f = fixture(), scope = f.scope(), selection = { viewIds: ['v0'] };
        const preparation = f.registry.begin(scope, selection);
        expect(preparation.status).toBe('reserved'); if (preparation.status !== 'reserved') return;
        selection.viewIds[0] = 'v1';
        expect(preparation.selection.viewIds).toEqual(['v0']); expect(preparation.source).toBe(f.source);
        expect(Object.isFrozen(scope)).toBe(true); expect(Object.isFrozen(preparation.reservation)).toBe(true);
        const grant = structuredClone(f.grant(f.source, ['v0'], true));
        const completed = f.registry.complete(scope, preparation.reservation, grant);
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        (grant.views as { viewId: string }[])[0]!.viewId = 'tampered';
        expect(completed.observation.views[0]!.id).toBe('v0');
        expect(Object.isFrozen(preparation.selection.viewIds)).toBe(true); zero(f);
    });
});

describe('B1 handles, isolation and strict data', () => {
    it('rejects cloned handles and cross-Scope reservations without consuming the original work', () => {
        const f = fixture(), a = f.scope(), b = f.scope(), preparation = f.begin(a);
        expect(code(f.registry.begin({ ...a }, { viewIds: ['v0'] }))).toBe('SCOPE_INVALID');
        expect(code(f.registry.complete(b, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        expect(code(f.registry.complete(a, { ...preparation.reservation }, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        f.registry.abandon(b, preparation.reservation); f.registry.closeScope({ ...a });
        expect(f.registry.inspect().reservations).toBe(1);
        const completed = f.registry.complete(a, preparation.reservation, f.grant());
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        expect(code(f.registry.resolveBinding(b, key(completed.observation)))).toBe('OBSERVATION_UNAVAILABLE');
        f.registry.releaseObservation(b, completed.observation.observationId);
        expect(f.registry.resolveBinding(a, key(completed.observation)).status).toBe('found');
        expect(code(f.registry.complete(a, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE'); zero(f);
    });
    it('does not revive released IDs or bind an old observation ID to a new Binding', () => {
        const f = fixture(), scope = f.scope(), first = f.observe(scope);
        f.registry.releaseObservation(scope, first.observationId); f.registry.releaseObservation(scope, first.observationId);
        const second = f.observe(scope);
        expect(second.observationId).not.toBe(first.observationId);
        expect(second.bindings[0]!.bindingId).not.toBe(first.bindings[0]!.bindingId);
        expect(code(f.registry.resolveBinding(scope, key(first)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(code(f.registry.resolveBinding(scope, { observationId: second.observationId, bindingId: first.bindings[0]!.bindingId }))).toBe('BINDING_UNAVAILABLE'); zero(f);
    });
    const badSelections: [string, () => unknown][] = [
        ['null', () => null], ['extra field', () => ({ viewIds: ['v0'], extra: true })],
        ['mixed selectors', () => ({ all: true, viewIds: ['v0'] })], ['false all', () => ({ all: false })],
        ['nonboolean all', () => ({ all: 'true' })],
        ['duplicate', () => ({ viewIds: ['v0', 'v0'] })], ['empty', () => ({ viewIds: [] })],
        ['absent View', () => ({ viewIds: ['other'] })], ['nonfinite', () => ({ viewIds: [NaN] })],
        ['sparse', () => ({ viewIds: new Array(1) })], ['cycle', () => { const x: unknown[] = []; x.push(x); return { viewIds: x }; }],
        ['symbol', () => ({ viewIds: ['v0'], [Symbol('hidden')]: true })],
        ['class', () => new (class { viewIds = ['v0']; })()],
    ];
    it.each(badSelections)('rejects %s selection before keeping resources', (_, input) => {
        const f = fixture(), scope = f.scope();
        expect(code(f.registry.begin(scope, input()))).toBe('OBSERVATION_INVALID');
        expect(f.registry.inspect()).toMatchObject({ reservations: 0, sources: 0, totalBytes: 0 }); zero(f);
    });
    it('does not call getters, stringify thrown exceptions, or print caller data', () => {
        const f = fixture(), scope = f.scope(); let getterReads = 0, exceptionReads = 0;
        const spies = ['log', 'warn', 'error'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
        const data = { get viewIds() { getterReads++; throw new Error('payload-secret'); } };
        expect(code(f.registry.begin(scope, data))).toBe('OBSERVATION_INVALID');
        const badClock = createObservationRegistry({ ...f.core.store, readLatest() { throw { get message() { exceptionReads++; return 'payload-secret'; },
            toString() { exceptionReads++; return 'payload-secret'; } }; } }, { namespace: 'bad-port', now: f.now });
        const opened = badClock.openScope(context); expect(opened.status).toBe('opened');
        if (opened.status === 'opened') expect(badClock.begin(opened.scope, { viewIds: ['v0'] })).toEqual({ status: 'rejected',
            issue: { code: 'OBSERVATION_INTERNAL_ERROR', message: 'Observation registry operation could not be completed' } });
        expect(getterReads).toBe(0); expect(exceptionReads).toBe(0); expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true); zero(f);
    });
    const invalidGrants: [string, (g: ObservationGrant) => unknown][] = [
        ['extra root', g => ({ ...g, extra: true })], ['extra identity', g => ({ ...g, views: [{ ...g.views[0], extra: true }] })],
        ['duplicate View', g => ({ ...g, views: [...g.views, g.views[0]] })], ['duplicate Ref', g => ({ ...g, refs: [...g.refs, g.refs[0]] })],
        ['duplicate target', g => ({ ...g, targets: [...g.targets, g.targets[0]] })],
        ['wrong instance', g => ({ ...g, views: [{ ...g.views[0], viewInstanceId: 'other' }] })],
        ['unclosed Ref', g => ({ ...g, views: [] })], ['forged Ref', g => ({ ...g, refs: [{ ...g.refs[0], refId: 'other' }] })],
        ['wrong owner', g => ({ ...g, refs: [{ ...g.refs[0], viewId: 'v1' }] })],
        ['forged binding', g => ({ ...g, targets: [{ ...g.targets[0], target: { ...g.targets[0]!.target, bindingVersion: 999 } }] })],
        ['unknown Tool', g => ({ ...g, targets: [{ ...g.targets[0], toolId: 'other' }] })],
        ['duplicate content', g => ({ ...g, content: [g.content[0], g.content[0]] })],
        ['replacement content', g => ({ ...g, content: [{ ...g.content[0], value: 'substitute' }] })],
        ['invalid decision', g => ({ ...g, content: [{ ...g.content[0], decision: 'replace' }] })],
        ['unclosed content', g => ({ ...g, views: [], refs: [], targets: [] })],
        ['nonfinite', g => ({ ...g, targets: [{ ...g.targets[0], target: { ...g.targets[0]!.target, bindingVersion: Infinity } }] })],
        ['sparse', g => ({ ...g, refs: new Array(1) })], ['symbol', g => ({ ...g, [Symbol('hidden')]: 'payload-secret' })],
        ['cycle', g => { const x = { ...g } as unknown as Record<string, unknown>; x.content = x; return x; }],
        ['getter', g => ({ ...g, get refs() { throw new Error('payload-secret'); } })],
    ];
    it.each(invalidGrants)('settles invalid %s grant atomically and leaks no input', (_, corrupt) => {
        const f = fixture(), scope = f.scope(), preparation = f.begin(scope), result = f.registry.complete(scope, preparation.reservation, corrupt(f.grant(f.source, ['v0'], true)));
        expect(code(result)).toBe('OBSERVATION_PROJECTION_INVALID'); expect(JSON.stringify(result)).not.toContain('payload-secret');
        expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 0, sources: 0, totalBytes: 0 }); zero(f);
    });
    it('rejects an existing View omitted from selection and retain with any hidden same-owner Ref', () => {
        const f = fixture(), scope = f.scope();
        let preparation = f.begin(scope, ['v0']);
        expect(code(f.registry.complete(scope, preparation.reservation, f.grant(f.source, ['v1'])))).toBe('OBSERVATION_PROJECTION_INVALID');
        preparation = f.begin(scope);
        const grant = f.grant(f.source, ['v0'], true);
        expect(code(f.registry.complete(scope, preparation.reservation, { ...grant, refs: grant.refs.slice(0, 1) }))).toBe('OBSERVATION_PROJECTION_INVALID');
        const safe = f.observe(scope, { ...grant, refs: grant.refs.slice(0, 1), content: [] });
        expect(safe.views[0]).not.toHaveProperty('content'); expect(safe.refs).toHaveLength(1); zero(f);
    });
});

describe('B1 original source, lifecycle and deadlines', () => {
    it('keeps the default Scope and original Observation usable through a long model turn until explicit release', () => {
        const f = fixture({ store: { historyTtlMs: 10, leaseTtlMs: 10 } }), scope = f.scope(), preparation = f.begin(scope);
        expect(preparation.expiresAt).toBeNull();
        f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r,
            target: { kind: 'snapshot-value', payload: { value: 'updated' } } }])) });
        f.setTime(1_000_000);
        expect(f.registry.checkScope(scope)).toEqual({ status: 'active', expiresAt: null });
        const completed = f.registry.complete(scope, preparation.reservation, f.grant());
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        expect(completed.observation.expiresAt).toBeNull();
        const resolved = f.registry.resolveBinding(scope, key(completed.observation));
        expect(resolved.status).toBe('found');
        if (resolved.status === 'found') expect(resolved.sourceRequest.snapshotId).toBe(f.source.id);
        expect(f.core.store.inspect().activeLeases).toBe(1);
        f.registry.releaseObservation(scope, completed.observation.observationId);
        expect(code(f.registry.resolveBinding(scope, key(completed.observation)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(f.core.store.getById(f.source.id).status).toBe('rejected');
        expect(f.registry.inspect()).toMatchObject({ observations: 0, sources: 0, totalBytes: 0 }); zero(f);
    });
    it('keeps owner-based observations bounded without evicting an active model turn', () => {
        const f = fixture({ limits: { maxObservationsPerScope: 1 } }), scope = f.scope(), observation = f.observe(scope);
        f.setTime(1_000_000);
        expect(code(f.registry.begin(scope, { all: true }))).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.resolveBinding(scope, key(observation)).status).toBe('found');
        f.registry.releaseObservation(scope, observation.observationId);
        const next = f.registry.begin(scope, { all: true });
        expect(next.status).toBe('reserved');
        if (next.status === 'reserved') f.registry.abandon(scope, next.reservation); zero(f);
    });
    it('resolves all from the current semantic source and publishes an empty observation after the last View closes', () => {
        const f = fixture(), scope = f.scope(), first = f.registry.begin(scope, { all: true });
        expect(first.status).toBe('reserved'); if (first.status !== 'reserved') return;
        expect(first.selection).toEqual({ viewIds: ['v0', 'v1'] });
        expect(Object.isFrozen(first.selection.viewIds)).toBe(true);
        f.registry.abandon(scope, first.reservation);
        for (const owner of f.owners) f.tools.unmount(owner.viewInstanceId);
        const source = f.publish({ views: [], refs: {}, tools: {} });
        const empty = f.registry.begin(scope, { all: true });
        expect(empty.status).toBe('reserved'); if (empty.status !== 'reserved') return;
        expect(empty.source).toBe(source); expect(empty.selection).toEqual({ viewIds: [] });
        const completed = f.registry.complete(scope, empty.reservation, emptyGrant());
        expect(completed).toMatchObject({ status: 'observed', observation: { views: [], refs: [], tools: [], bindings: [] } });
        expect(code(f.registry.begin(scope, { viewIds: [] }))).toBe('OBSERVATION_INVALID'); zero(f);
    });
    it('can open before readiness, refuses unready/degraded and never exposes lastGood', () => {
        const f = fixture({ ready: false }), scope = f.scope();
        expect(code(f.registry.begin(scope, { viewIds: ['v0'] }))).toBe('SNAPSHOT_UNREADY');
        f.publish();
        const bad = f.draft({ views: [] }); expect(f.core.committer.accept(bad).status).toBe('rejected');
        expect(f.core.store.readLatest('app').status).toBe('degraded');
        expect(code(f.registry.begin(scope, { viewIds: ['v0'] }))).toBe('SNAPSHOT_UNREADY'); zero(f);
    });
    it('rejects Snapshot V1 before an observation can be manufactured', () => {
        const f = fixture({ ready: false }), scope = f.scope();
        expect(f.core.committer.accept({ schemaVersion: 1, ...context, producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
            views: [{ id: 'v0', generation: 'g', type: 'File', name: 'v0', kind: 'state', content: { format: 'markdown-v1', value: 'x' } }],
            refs: {}, tools: {} }).status).toBe('rejected');
        expect(code(f.registry.begin(scope, { viewIds: ['v0'] }))).toBe('SNAPSHOT_UNREADY'); zero(f);
    });
    it('completes and resolves the exact historical source after a Ref-only update', () => {
        const f = fixture(), scope = f.scope(), preparation = f.begin(scope);
        const next = f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r,
            target: { kind: 'snapshot-value', payload: { value: 'new-payload-secret' } } }])) });
        expect(next.id).not.toBe(f.source.id);
        const done = f.registry.complete(scope, preparation.reservation, f.grant());
        expect(done.status).toBe('observed'); if (done.status !== 'observed') return;
        expect(done.observation.source.snapshotId).toBe(f.source.id);
        const result = f.registry.resolveBinding(scope, key(done.observation));
        expect(result.status).toBe('found'); if (result.status === 'found') expect(result.tool).toBe(f.source.tools[result.tool.id]);
        expect(preparation.source).toBe(f.source); zero(f);
    });
    it.each(['disable', 'remount', 'schema', 'version', 'remove', 'degraded'] as const)('refuses %s when resolving the original Binding', mode => {
        const f = fixture(), scope = f.scope(), observation = f.observe(scope), first = Object.values(f.source.tools)[0]!;
        if (mode === 'degraded') f.core.committer.accept(f.draft({ refs: { bad: null as never } }));
        else if (mode === 'disable') { f.rebindTool(); f.publish(); }
        else if (mode === 'remove') f.publish({ views: f.source.views.slice(1), refs: Object.fromEntries(Object.entries(f.source.refs).filter(([, r]) => r.ownerViewId !== 'v0')),
            tools: { [first.id]: { ...first, targets: first.targets.slice(1) } } });
        else if (mode === 'remount') {
            f.tools.unmount(f.owners[0]!.viewInstanceId); f.owners[0] = f.tools.mount('v0', 'File');
            f.tools.registerTool(f.owners[0]!.viewInstanceId, { name: 'tool0', description: 'Synthetic tool', inputSchema: { type: 'object', properties: {} }, isMutating: false }, f.handler); f.publish();
        } else f.publish({ tools: { [first.id]: { ...first, ...(mode === 'schema' ? { inputSchema: { type: 'object', properties: { x: { type: 'number' } } } } : {}),
            targets: first.targets.map((t, i) => i === 0 && mode === 'version' ? { ...t, bindingVersion: t.bindingVersion + 1 } : t) } } });
        expect(code(f.registry.resolveBinding(scope, key(observation)))).toBe(mode === 'disable' ? 'TOOL_SOURCE_STALE'
            : mode === 'remove' || mode === 'remount' ? 'VIEW_INSTANCE_REVOKED' : mode === 'degraded' ? 'SNAPSHOT_UNREADY' : 'TOOL_SOURCE_STALE'); zero(f);
    });
    it.each(['stop', 'restart'] as const)('revokes %s Scopes without rebinding the instance', mode => {
        const f = fixture(), scope = f.scope(), preparation = f.begin(scope), observation = f.observe(scope);
        f.core.lifecycle.stopApp('app', 'run');
        if (mode === 'restart') { f.core.lifecycle.startApp('app', 'run-2'); f.publish({ instanceId: 'run-2' }); }
        expect(f.registry.resolveBinding(scope, key(observation)).status).toBe('rejected');
        expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 1, cancelledReservations: 1, scopes: 1 });
        expect(code(f.registry.complete(scope, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE'); zero(f);
    });
    it.each([['observation', 10, 50, 100], ['scope', 50, 10, 100], ['lease', 50, 100, 10]] as const)('fixes the %s deadline at begin and refuses equality without renewal', (_, observationTtlMs, scopeTtlMs, leaseTtlMs) => {
        const f = fixture({ lifetime: 'ttl', limits: { observationTtlMs, scopeTtlMs }, store: { leaseTtlMs } }), scope = f.scope(), preparation = f.begin(scope);
        expect(preparation.expiresAt).toBe(10); f.setTime(9);
        const result = f.registry.complete(scope, preparation.reservation, f.grant());
        expect(result.status).toBe('observed'); if (result.status !== 'observed') return;
        expect(result.observation.expiresAt).toBe(10); f.setTime(10);
        expect(f.registry.resolveBinding(scope, key(result.observation)).status).toBe('rejected');
        const current = f.core.store.acquire(f.source.id); expect(current.status).toBe('acquired'); if (current.status === 'acquired') current.lease.release(); zero(f);
    });
    it('does not complete at the deadline, while retaining a cancelled preparation until settlement', () => {
        const f = fixture({ lifetime: 'ttl', limits: { observationTtlMs: 10 } }), scope = f.scope(), preparation = f.begin(scope);
        const before = f.registry.inspect(); f.setTime(10);
        expect(f.registry.sweepExpired()).toMatchObject({ reservations: 1, cancelledReservations: 1, totalBytes: before.totalBytes });
        expect(code(f.registry.complete(scope, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        expect(f.registry.inspect().totalBytes).toBe(0); zero(f);
    });
    it.each(['complete', 'resolve'] as const)('rejects history TTL at %s despite the pinned getById result', mode => {
        const f = fixture({ lifetime: 'ttl', store: { historyTtlMs: 10 } }), scope = f.scope(), preparation = f.begin(scope);
        const observation = mode === 'resolve' ? f.observe(scope) : undefined;
        f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r, refType: 'different' }])) });
        f.setTime(10); expect(f.core.store.getById(f.source.id).status).toBe('found');
        const result = mode === 'complete' ? f.registry.complete(scope, preparation.reservation, f.grant()) : f.registry.resolveBinding(scope, key(observation!));
        expect(code(result)).toBe('SNAPSHOT_EXPIRED');
        f.registry.abandon(scope, preparation.reservation); zero(f);
    });
});

describe('B1 settlement, counts and shared-source fees', () => {
    it.each(['abandon', 'complete'] as const)('keeps cancelled work charged through %s and frees the closing Scope only at settlement', mode => {
        const f = fixture({ limits: { maxScopes: 1 } }), scope = f.scope(), preparation = f.begin(scope), before = f.registry.inspect();
        expect(f.registry.closeScope(scope)).toMatchObject({ scopes: 1, observations: 0, reservations: 1, cancelledReservations: 1, totalBytes: before.totalBytes });
        expect(code(f.registry.openScope(context))).toBe('OBSERVATION_CAPACITY');
        f.registry.closeScope(scope);
        if (mode === 'abandon') f.registry.abandon(scope, preparation.reservation);
        else expect(code(f.registry.complete(scope, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        f.registry.abandon(scope, preparation.reservation);
        expect(f.registry.inspect()).toMatchObject({ scopes: 0, reservations: 0, totalBytes: 0 });
        expect(f.scope().scopeId).not.toBe(scope.scopeId); zero(f);
    });
    it('global close releases published observations but accurately retains all unfinished preparations', () => {
        const f = fixture(), a = f.scope(), b = f.scope(), pa = f.begin(a), pb = f.begin(b); f.observe(a);
        const closed = f.registry.close();
        expect(closed).toMatchObject({ closed: true, releasedObservations: 1, observations: 0, reservations: 2, scopes: 2, sources: 1 });
        expect(code(f.registry.openScope(context))).toBe('SCOPE_UNAVAILABLE');
        expect(f.registry.close().releasedObservations).toBe(0);
        f.registry.abandon(a, pa.reservation); f.registry.abandon(b, pb.reservation); zero(f);
    });
    it('retains an expired Scope and its source fees until the last preparation settles', () => {
        const f = fixture({ lifetime: 'ttl', limits: { maxScopes: 1, scopeTtlMs: 10 } }), scope = f.scope(), p = f.begin(scope), before = f.registry.inspect();
        f.setTime(10);
        expect(f.registry.sweepExpired()).toMatchObject({ scopes: 1, reservations: 1, cancelledReservations: 1, totalBytes: before.totalBytes });
        expect(code(f.registry.openScope(context))).toBe('OBSERVATION_CAPACITY');
        f.registry.abandon(scope, p.reservation);
        expect(f.registry.inspect()).toMatchObject({ scopes: 0, sources: 0, totalBytes: 0 });
        expect(f.scope().scopeId).not.toBe(scope.scopeId); zero(f);
    });
    it('charges one immutable source across Scopes and returns actual output fees after each complete', () => {
        const f = fixture(), a = f.scope(), b = f.scope(), pa = f.begin(a), first = f.registry.inspect(), pb = f.begin(b);
        expect(pa.source).toBe(pb.source); expect(f.registry.inspect()).toMatchObject({ sources: 1, sourceBytes: first.sourceBytes,
            observationBytes: 2 * HARD.observation.maxCanonicalBytes, metadataBytes: 2 * HARD.metadata.maxCanonicalBytes });
        const done = f.registry.complete(a, pa.reservation, f.grant()); expect(done.status).toBe('observed');
        if (done.status !== 'observed') return;
        expect(f.registry.inspect().observationBytes).toBe(HARD.observation.maxCanonicalBytes + utf8Size(canonicalJson(done.observation as unknown as JsonValue)));
        f.registry.releaseObservation(a, done.observation.observationId);
        expect(f.registry.inspect().sourceBytes).toBe(first.sourceBytes);
        f.registry.abandon(b, pb.reservation); expect(f.registry.inspect().totalBytes).toBe(0); zero(f);
    });
    it('separately charges two source versions and refunds only their final references', () => {
        const f = fixture(), scope = f.scope(), a = f.begin(scope), before = f.registry.inspect();
        const newer = f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r, refType: 'new-type' }])) });
        const b = f.begin(scope), after = f.registry.inspect();
        expect(b.source).toBe(newer); expect(after.sources).toBe(2); expect(after.sourceBytes).toBeGreaterThan(before.sourceBytes);
        f.registry.abandon(scope, a.reservation); expect(f.registry.inspect().sources).toBe(1);
        f.registry.abandon(scope, b.reservation); expect(f.registry.inspect().totalBytes).toBe(0); zero(f);
    });
    it('settles repeated failing grants without residual slots or leases', () => {
        const f = fixture(), scope = f.scope();
        for (let i = 0; i < 40; i++) {
            const p = f.begin(scope); expect(code(f.registry.complete(scope, p.reservation, { invalid: 'payload-secret' }))).toBe('OBSERVATION_PROJECTION_INVALID');
            expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 0, sources: 0, totalBytes: 0 });
            expect(f.core.store.inspect().activeLeases).toBe(0);
        }
        zero(f);
    });
    it.each(['maxScopes', 'maxObservationsPerScope', 'maxObservations', 'maxReservationsPerScope', 'maxReservations'] as const)('enforces the lowered %s count without eviction or partial commit', limit => {
        const f = fixture({ limits: { [limit]: 2 } }), scopes: ScopeHandle[] = [];
        if (limit === 'maxScopes') {
            scopes.push(f.scope(), f.scope()); expect(code(f.registry.openScope(context))).toBe('OBSERVATION_CAPACITY');
        } else if (limit.startsWith('maxReservations')) {
            const a = f.scope(), b = limit === 'maxReservations' ? f.scope() : a;
            const p = f.begin(a), q = f.begin(b); expect(code(f.registry.begin(a, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY');
            expect(f.registry.inspect().reservations).toBe(2); f.registry.abandon(a, p.reservation); f.registry.abandon(b, q.reservation);
        } else {
            const a = f.scope(), b = limit === 'maxObservations' ? f.scope() : a;
            const first = f.observe(a), second = f.observe(b);
            expect(code(f.registry.begin(a, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY');
            expect(f.registry.resolveBinding(a, key(first)).status).toBe('found');
            f.registry.releaseObservation(a, first.observationId); f.registry.releaseObservation(b, second.observationId);
        }
        zero(f);
    });
    it.each(['maxViews', 'maxRefs', 'maxTools', 'maxBindings'] as const)('separately checks %s at N-1/N/N+1', limit => {
        for (const count of [1, 2, 3]) {
            const f = fixture({ views: limit === 'maxViews' || limit === 'maxBindings' ? 3 : 1,
                refs: limit === 'maxRefs' ? 3 : 0, tools: limit === 'maxTools' ? 3 : 1, limits: { [limit]: 2 } }), scope = f.scope();
            {
                const p = f.begin(scope), g = limit === 'maxViews' ? f.grant(f.source, f.owners.slice(0, count).map(v => v.viewId)) : f.grant(), grant = { ...g,
                    ...(limit === 'maxRefs' ? { refs: g.refs.slice(0, count) } : {}),
                    ...(limit === 'maxTools' || limit === 'maxBindings' ? { targets: g.targets.slice(0, count) } : {}) };
                const result = f.registry.complete(scope, p.reservation, grant);
                expect(result.status).toBe(count <= 2 ? 'observed' : 'rejected');
                if (count > 2) expect(code(result)).toBe('OBSERVATION_CAPACITY');
            }
            zero(f);
        }
    });
    it('keeps the 256-View selection contract independent from a lower visible-View quota', () => {
        const f = fixture({ views: 257, refs: 0, limits: { maxViews: 2 } }), scope = f.scope();
        const selected = f.owners.slice(0, 256).map(v => v.viewId), p = f.registry.begin(scope, { viewIds: selected });
        expect(p.status).toBe('reserved'); if (p.status !== 'reserved') return;
        expect(f.registry.complete(scope, p.reservation, f.grant(f.source, ['v0', 'v1'])).status).toBe('observed');
        expect(code(f.registry.begin(scope, { viewIds: f.owners.map(v => v.viewId) }))).toBe('OBSERVATION_INVALID'); zero(f);
    });
    it('does not enlarge the Store lease quota and preserves independent reservations on short-lease failure', () => {
        const f = fixture({ store: { maxActiveLeases: 1 } }), scope = f.scope(), p = f.begin(scope);
        expect(code(f.registry.begin(scope, { viewIds: ['v0'] }))).toBe('SNAPSHOT_CAPACITY');
        expect(f.registry.inspect().reservations).toBe(1);
        expect(code(f.registry.complete(scope, p.reservation, f.grant()))).toBe('SNAPSHOT_CAPACITY'); zero(f);
    });
});

describe('B1 independently bounded JSON and total budgets', () => {
    // Derive codec thresholds with the existing codec, not a second size estimator.
    function threshold(value: unknown, field: 'maxDepth' | 'maxNodes' | 'maxApproxBytes'): number {
        let low = 0, high = field === 'maxApproxBytes' ? 8 * 1024 * 1024 : 100_016;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            try { copyJson(value, { maxDepth: 100, maxNodes: 200_000, maxApproxBytes: 16 * 1024 * 1024, [field]: middle }); high = middle; }
            catch { low = middle + 1; }
        }
        return low;
    }
    const bytes = (value: unknown) => utf8Size(canonicalJson(copyJson(value, { maxDepth: 100, maxNodes: 200_000, maxApproxBytes: 16 * 1024 * 1024 })));
    it.each(['array', 'object'] as const)('keeps source byte limits exact with inherited %s toJSON', prototype => {
        const probe = fixture({ views: 1, refs: 1, payload: { nested: ['漢字', -0, 1e21] } });
        const expected = bytes(probe.source); zero(probe);
        for (const delta of [-1, 0]) {
            const f = fixture({ views: 1, refs: 1, payload: { nested: ['漢字', -0, 1e21] },
                limits: { source: { maxCanonicalBytes: expected + delta } } });
            const scope = f.scope(), target = prototype === 'array' ? Array.prototype : Object.prototype;
            const previous = Object.getOwnPropertyDescriptor(target, 'toJSON');
            let getterReads = 0, functionCalls = 0;
            const descriptor: PropertyDescriptor = prototype === 'array'
                ? { configurable: true, get() { getterReads++; return () => { functionCalls++; return 'changed'; }; } }
                : { configurable: true, writable: true, value() { functionCalls++; return 'changed'; } };
            let result: ReturnType<typeof f.registry.begin> | undefined;
            try {
                Object.defineProperty(target, 'toJSON', descriptor);
                result = f.registry.begin(scope, { viewIds: ['v0'] });
            } finally {
                if (previous) Object.defineProperty(target, 'toJSON', previous);
                else Reflect.deleteProperty(target, 'toJSON');
            }
            expect(getterReads).toBe(0); expect(functionCalls).toBe(0);
            expect(result?.status).toBe(delta < 0 ? 'rejected' : 'reserved');
            if (result?.status === 'reserved') {
                expect(f.registry.inspect().sourceBytes).toBe(expected);
                f.registry.abandon(scope, result.reservation);
            } else expect(code(result)).toBe('OBSERVATION_CAPACITY');
            zero(f);
        }
    });
    it.each(['maxSourceBytes', 'maxObservationBytes', 'maxMetadataBytes', 'maxTotalBytes'] as const)('checks %s reservation at exact bytes and refunds failed attempts', limit => {
        const baseline = fixture(), owner = baseline.scope(), p = baseline.begin(owner), amount = baseline.registry.inspect()[limit === 'maxSourceBytes' ? 'sourceBytes'
            : limit === 'maxObservationBytes' ? 'observationBytes' : limit === 'maxMetadataBytes' ? 'metadataBytes' : 'totalBytes'];
        baseline.registry.abandon(owner, p.reservation); zero(baseline);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { [limit]: amount + delta } }), scope = f.scope(), result = f.registry.begin(scope, { viewIds: ['v0', 'v1'] });
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'reserved');
            if (result.status === 'reserved') f.registry.abandon(scope, result.reservation);
            else expect(code(result)).toBe('OBSERVATION_CAPACITY');
            expect(f.registry.inspect().totalBytes).toBe(0); zero(f);
        }
    });
    it('applies global source fees to distinct snapshots while sharing the same snapshot fee', () => {
        const probe = fixture(), scope = probe.scope(), p = probe.begin(scope), sourceBytes = probe.registry.inspect().sourceBytes;
        probe.registry.abandon(scope, p.reservation); zero(probe);
        const f = fixture({ limits: { maxSourceBytes: sourceBytes } }), a = f.scope(), b = f.scope(), one = f.begin(a), two = f.begin(b);
        f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r, refType: 'other-type' }])) });
        expect(code(f.registry.begin(a, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.inspect()).toMatchObject({ reservations: 2, sources: 1, sourceBytes });
        f.registry.abandon(a, one.reservation); f.registry.abandon(b, two.reservation); zero(f);
    });
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds source %s before retaining any source reference', field => {
        const base = fixture({ payload: { nested: ['汉字\u0000', { value: 'source' }] } });
        const n = field === 'maxCanonicalBytes' ? bytes(base.source) : threshold(base.source, field); zero(base);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ payload: { nested: ['汉字\u0000', { value: 'source' }] }, limits: { source: { [field]: n + delta } } }), scope = f.scope();
            const p = f.registry.begin(scope, { viewIds: ['v0'] });
            expect(p.status).toBe(delta < 0 ? 'rejected' : 'reserved');
            if (p.status === 'reserved') f.registry.abandon(scope, p.reservation);
            else expect(code(p)).toBe('OBSERVATION_CAPACITY'); zero(f);
        }
    });
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds selection capture %s independently', field => {
        const input = { viewIds: Array.from({ length: 8 }, (_, i) => 'v' + i) }, n = field === 'maxCanonicalBytes' ? bytes(input) : threshold(input, field);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ views: 8 }), registry = createObservationRegistry(f.core.store, { namespace: 'capture', now: f.now, limits: { capture: { [field]: n + delta } } });
            const opened = registry.openScope(context);
            expect(opened.status).toBe('opened'); if (opened.status !== 'opened') throw new Error('Expected scope with smaller context');
            const result = registry.begin(opened.scope, input);
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'reserved');
            if (result.status === 'reserved') registry.abandon(opened.scope, result.reservation);
            else expect(code(result)).toBe('OBSERVATION_INVALID');
            registry.close(); zero(f);
        }
    });
    it.each(['maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds openScope capture %s before creating an entry', field => {
        const n = field === 'maxCanonicalBytes' ? bytes(context) : threshold(context, field);
        for (const delta of [-1, 0, 1]) {
            const f = fixture(), registry = createObservationRegistry(f.core.store, { namespace: 'open-capture', now: f.now,
                limits: { capture: { [field]: n + delta } } });
            const result = registry.openScope(context);
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'opened');
            if (result.status === 'rejected') expect(code(result)).toBe('SCOPE_INVALID');
            registry.close(); expect(registry.inspect().scopes).toBe(0); zero(f);
        }
    });
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds grant and final internal metadata %s as a shared profile', field => {
        const probe = fixture(), scope = probe.scope(), permission = probe.grant(), observation = probe.observe(scope, permission);
        const metadata = { scopeId: scope.scopeId, observationId: observation.observationId, source: observation.source, expiresAt: observation.expiresAt,
            views: observation.views.map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
            refs: observation.refs.map(({ viewId, viewInstanceId, refId }) => ({ viewId, viewInstanceId, refId })), bindings: observation.bindings };
        const measure = (v: unknown) => field === 'maxCanonicalBytes' ? bytes(v) : threshold(v, field);
        const n = Math.max(measure(permission), measure(metadata)); zero(probe);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { metadata: { [field]: n + delta } } }), owner = f.scope(), p = f.begin(owner);
            const result = f.registry.complete(owner, p.reservation, f.grant());
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'observed');
            if (result.status === 'rejected') expect(['OBSERVATION_CAPACITY', 'OBSERVATION_PROJECTION_INVALID']).toContain(code(result)); zero(f);
        }
    });
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds final public Observation %s at N-1/N/N+1', field => {
        const probe = fixture({ content: ['\u0000'.repeat(30), { nested: { text: '汉字' } }] }), scope = probe.scope(), observation = probe.observe(scope, probe.grant(probe.source, ['v0', 'v1'], true));
        const n = field === 'maxCanonicalBytes' ? bytes(observation) : threshold(observation, field); zero(probe);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ content: ['\u0000'.repeat(30), { nested: { text: '汉字' } }], limits: { observation: { [field]: n + delta } } }), owner = f.scope(), p = f.begin(owner);
            const result = f.registry.complete(owner, p.reservation, f.grant(f.source, ['v0', 'v1'], true));
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'observed');
            if (result.status === 'rejected') expect(code(result)).toBe('OBSERVATION_CAPACITY'); zero(f);
        }
    });
    it('rejects the A near-content boundary, then succeeds only when a new explicit policy hides content', () => {
        const f = fixture({ views: 1, refs: 0, content: 'x'.repeat(524286) }), scope = f.scope(), p = f.begin(scope);
        expect(code(f.registry.complete(scope, p.reservation, f.grant(f.source, ['v0'], true)))).toBe('OBSERVATION_CAPACITY');
        const observation = f.observe(scope, f.grant(f.source, ['v0'])); expect(observation.views[0]).not.toHaveProperty('content'); zero(f);
    });
    it('checks canonical escape expansion separately from the approximate source budget', () => {
        const f = fixture({ views: 1, refs: 1, payload: '\u0000'.repeat(1500), limits: { source: { maxCanonicalBytes: 4000 } } }), scope = f.scope();
        expect(bytes(f.source)).toBeGreaterThan(4000);
        expect(code(f.registry.begin(scope, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY'); zero(f);
    });
});

describe('B1 immutable configuration and clock faults', () => {
    it('freezes every approved default profile and has no undeclared extension fields', () => {
        expect(HARD).toMatchObject({ maxScopes: 16, maxObservationsPerScope: 8, maxObservations: 128,
            maxReservationsPerScope: 2, maxReservations: 16, maxViews: 256, maxRefs: 512, maxTools: 256, maxBindings: 256,
            scopeTtlMs: 600000, observationTtlMs: 30000, source: { maxDepth: 50, maxNodes: 100016, maxApproxBytes: 8388608, maxCanonicalBytes: 8388608 } });
        expect(Object.isFrozen(HARD)).toBe(true); expect(Object.isFrozen(HARD.source)).toBe(true);
    });
    it.each(Object.entries(HARD).flatMap(([key, value]) => typeof value === 'number' ? [[key, value, undefined] as const]
        : Object.entries(value).map(([field, n]) => [key, n, field] as const)))('rejects raising or zeroing %s / %s / %s', (key, hard, field) => {
        const f = fixture();
        for (const value of [0, -1, NaN, Infinity, 1.5, (hard as number) + 1]) {
            const limits = { [key]: field === undefined ? value : { [field]: value } };
            expect(() => createObservationRegistry(f.core.store, { namespace: 'invalid', now: f.now, limits })).toThrow('Invalid observation registry configuration');
        }
        zero(f);
    });
    it('rejects extra configuration, namespace overflow and configuration getters with fixed errors', () => {
        const f = fixture(); let reads = 0;
        for (const options of [{ namespace: '', now: f.now }, { namespace: '汉'.repeat(43), now: f.now },
            { namespace: 'n', now: f.now, lifetime: 'forever' },
            { namespace: 'n', now: f.now, limits: { unsupported: 1 } }, { namespace: 'n', now: f.now, limits: { source: { extra: 1 } } },
            { namespace: 'n', now: f.now, extra: true }, { get namespace() { reads++; throw new Error('payload-secret'); }, now: f.now }]) {
            expect(() => createObservationRegistry(f.core.store, options as never)).toThrow('Invalid observation registry configuration');
        }
        expect(reads).toBe(0);
        const max = createObservationRegistry(f.core.store, { namespace: '汉'.repeat(42) + 'ab', now: f.now });
        const scope = max.openScope(context); expect(scope.status).toBe('opened');
        if (scope.status === 'opened') expect(utf8Size(scope.scope.scopeId)).toBeLessThanOrEqual(256);
        max.close(); zero(f);
    });
    it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects initial invalid clock %s with a fixed error', value => {
        const f = fixture(); expect(() => createObservationRegistry(f.core.store, { namespace: 'clock', now: () => value })).toThrow('Invalid observation registry clock'); zero(f);
    });
    it('refuses clock rollback/throws and still permits owned preparation settlement and explicit close', () => {
        const f = fixture(); let time = 10, throws = false, reads = 0;
        const registry = createObservationRegistry(f.core.store, { namespace: 'clock', now: () => {
            if (throws) throw { get message() { reads++; return 'payload-secret'; } }; return time;
        } });
        const opened = registry.openScope(context); expect(opened.status).toBe('opened'); if (opened.status !== 'opened') return;
        const p = registry.begin(opened.scope, { viewIds: ['v0'] }); expect(p.status).toBe('reserved'); if (p.status !== 'reserved') return;
        time = 9; expect(code(registry.begin(opened.scope, { viewIds: ['v0'] }))).toBe('OBSERVATION_INTERNAL_ERROR');
        throws = true; expect(code(registry.complete(opened.scope, p.reservation, f.grant()))).toBe('OBSERVATION_INTERNAL_ERROR');
        expect(registry.inspect()).toMatchObject({ reservations: 0, totalBytes: 0, issue: { code: 'OBSERVATION_INTERNAL_ERROR' } });
        expect(registry.close().scopes).toBe(0); expect(reads).toBe(0); zero(f);
    });
});

describe('B2 checkScope accessor preserves B1 authority', () => {
    it('checks genuine handles without requiring ready state or renewing the deadline', () => {
        const f = fixture({ lifetime: 'ttl', ready: false, limits: { scopeTtlMs: 10 } }), scope = f.scope();
        expect(f.registry.checkScope(scope)).toEqual({ status: 'active', expiresAt: 10 });
        expect(code(f.registry.checkScope({ ...scope }))).toBe('SCOPE_UNAVAILABLE');
        f.setTime(9); expect(f.registry.checkScope(scope)).toEqual({ status: 'active', expiresAt: 10 });
        f.setTime(10); expect(code(f.registry.checkScope(scope))).toBe('SCOPE_UNAVAILABLE'); zero(f);
    });
    it('does not expose stopped, closed or newly rebound App scopes', () => {
        const f = fixture(), scope = f.scope(); f.registry.closeScope(scope);
        expect(code(f.registry.checkScope(scope))).toBe('SCOPE_UNAVAILABLE');
        const other = f.scope(); f.core.lifecycle.stopApp('app', 'run');
        expect(code(f.registry.checkScope(other))).toBe('SCOPE_UNAVAILABLE'); zero(f);
    });
});

describe('B2-Q01 lifecycle identity capability', () => {
    it('requires identity capability instead of silently falling back to a legacy SnapshotStore', () => {
        const f = fixture(); const { readAppIdentity: _, ...legacy } = f.core.store;
        expect(() => createObservationRegistry(legacy as never, { namespace: 'legacy', now: f.now })).toThrow('Invalid observation registry store'); zero(f);
    });
    it('allows pre-start Scope creation, then rejects replacement even before the new instance publishes', () => {
        const core = createSnapshotCore({ now: () => 0 }), registry = createObservationRegistry(core.store, { namespace: 'prestart', now: () => 0 });
        const opened = registry.openScope({ appId: 'app', instanceId: 'first' }); expect(opened.status).toBe('opened'); if (opened.status !== 'opened') return;
        expect(registry.checkScope(opened.scope).status).toBe('active');
        expect(code(registry.begin(opened.scope, { viewIds: ['v0'] }))).toBe('SNAPSHOT_UNREADY');
        core.lifecycle.startApp('app', 'first'); expect(registry.checkScope(opened.scope).status).toBe('active');
        core.lifecycle.stopApp('app', 'first'); core.lifecycle.startApp('app', 'second');
        expect(core.store.readLatest('app')).toEqual({ status: 'unready' });
        expect(code(registry.checkScope(opened.scope))).toBe('SCOPE_UNAVAILABLE');
        registry.close(); expect(registry.inspect().totalBytes).toBe(0);
    });
    it('keeps cancelled preparation fees through a direct instance replacement until settlement', () => {
        const f = fixture(), scope = f.scope(), preparation = f.begin(scope), before = f.registry.inspect();
        f.core.lifecycle.startApp('app', 'new-unready');
        expect(f.registry.inspect()).toMatchObject({ scopes: 1, reservations: 1, cancelledReservations: 1, totalBytes: before.totalBytes });
        expect(code(f.registry.complete(scope, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE'); zero(f);
    });
});
