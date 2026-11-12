import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { createAppInteraction } from './app-interaction.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshotV3, JsonValue, PreparedAppSnapshotDraftV3, SnapshotStoreOptions, ToolDescriptorV3 } from '../snapshot/types.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { compileOrdinarySchema } from '../tool/ordinary-parameter-contract.js';
import { ordinaryParameterProfile } from '../tool/ordinary-parameter-profile.js';
import { createObservationOperations, type ObservationState, DEFAULT_OBSERVATION_REGISTRY_LIMITS as HARD } from './observation-registry.js';
import type { Observation, ObservationGrant, ObservationRegistryLimitOverrides } from './observation-types.js';


type Owner = Readonly<{ appId: string; instanceId: string }>;
const context = { appId: 'app', instanceId: 'run' };
type RegistryOptions = Parameters<typeof createObservationOperations>[1] & { readonly now: () => number };

function createObservationRegistry(store: Parameters<typeof createObservationOperations>[0], options: RegistryOptions,
    identity: Owner = context) {
    const owner = Object.freeze({ ...identity });
    const state: ObservationState = { ...owner, closing: false, reservations: new Map(), observations: new Map() };
    let lastNow = -1;
    const failure = (code: string) => ({ status: 'rejected' as const, issue: { code } });
    function refresh() {
        const time = options.now();
        if (!Number.isSafeInteger(time) || time < 0 || time < lastNow) throw new Error('Invalid clock');
        lastNow = time;
        if (!state.closing && !operations.isCurrent(state)) {
            state.closing = true;
            operations.releaseAll(state);
        }
        return time;
    }
    const { now: _, ...config } = Object.getOwnPropertyDescriptors(options);
    const operations = createObservationOperations(store, Object.defineProperties({}, config) as RegistryOptions, state, refresh);
    return {
        owner,
        active() { refresh(); return !state.closing; },
        begin(handle: Owner, input: unknown) {
            return handle === owner ? operations.begin(state, input) : failure('APP_INTERACTION_UNAVAILABLE');
        },
        complete(handle: Owner, token: Parameters<typeof operations.complete>[1], grant: unknown) {
            return handle === owner ? operations.complete(state, token, grant) : failure('RESERVATION_UNAVAILABLE');
        },
        abandon(handle: Owner, token: Parameters<typeof operations.abandon>[1]) {
            if (handle === owner) operations.abandon(state, token);
        },
        adoptObservation(handle: Owner, id: string) {
            return handle === owner ? operations.adoptObservation(state, id) : failure('APP_INTERACTION_UNAVAILABLE');
        },
        resolveBinding(handle: Owner, input: unknown) {
            return handle === owner ? operations.resolveBinding(state, input) : failure('APP_INTERACTION_UNAVAILABLE');
        },
        releaseObservation(handle: Owner, id: string) {
            if (handle === owner) operations.releaseObservation(state, id);
        },
        close() {
            const before = operations.stats();
            state.closing = true;
            operations.releaseAll(state);
            const after = operations.stats();
            return { ...after, releasedObservations: before.observations - after.observations };
        },
        inspect() {
            try { refresh(); return operations.stats(); } catch (error) { return operations.stats(error); }
        },
    };
}

afterEach(() => vi.restoreAllMocks());
const emptyGrant = (): ObservationGrant => ({ views: [], refs: [], toolBindings: [], content: [] });
it('captures type activations and refuses policy activation rewrites or retired selectors', () => {
    const f = fixture({ views: 1, tools: 1, refs: 0 }); const scope = f.scope();
    const grant = f.grant();
    for (const execution of [{ kind: 'view-type', activationId: 'forged' },
        { ...grant.toolBindings[0]!.execution, target: { selector: { param: 'document', value: 'document-B' } } }]) {
        const prepared = f.begin(scope);
        const forged = { ...grant, toolBindings: [{ ...grant.toolBindings[0]!, execution }] };
        expect(f.registry.complete(scope, prepared.reservation, forged)).toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_PROJECTION_INVALID' } });
    }
    const observation = f.observe(scope, grant);
    expect(observation.bindings[0]!.execution).toEqual(grant.toolBindings[0]!.execution);
    f.registry.close(); f.core.lifecycle.dispose();
});
function fixture(options: { views?: number; refs?: number; tools?: number; content?: JsonValue;
    payload?: JsonValue; store?: SnapshotStoreOptions; limits?: ObservationRegistryLimitOverrides; ready?: boolean; namespace?: string } = {}) {
    let time = 0, sequence = 0;
    const now = () => time;
    const core = createSnapshotCore({ now, ...options.store });
    core.lifecycle.startApp(context.appId, context.instanceId);
    const tools = createViewOwnedTools(context.appId, context.instanceId);
    const handler = vi.fn(async () => ({ success: true }));
    const owners = Array.from({ length: options.views ?? 2 }, (_, i) => tools.mount('v' + i, 'File'));
    const declarations = Array.from({ length: options.tools ?? 1 }, (_, i) => ({
        name: 'tool' + i, description: 'Synthetic tool', inputSchema: { type: 'object', properties: {} }, 
    }));
    const register = (declaration: typeof declarations[number]) => tools.registerTypeTool({
        ...declaration, viewType: 'File', inputSchema: { type: 'object', properties: { selected: {
            type: 'string', minLength: 1, 'x-aotui-ref-kind': 'unknown', 'x-aotui-ref-value': { type: 'object' },
        } }, required: ['selected'], additionalProperties: true },
    }, { safeOrdinaryParametersInvocationMode: 'ordinary-v2', createSafeOrdinaryParametersInvoker: () => async args => {
        await handler(args); return { phase: 'entered-returned', result: { success: true } };
    } });
    const releases = declarations.map(register);
    function rebindTool(_viewIndex = 0, toolIndex = 0) {
        releases[toolIndex]!(); releases[toolIndex] = register(declarations[toolIndex]!);
    }
    function remountAllViews() {
        for (const owner of owners) tools.unmount(owner.viewInstanceId);
        owners.splice(0, owners.length, ...owners.map(owner => tools.mount(owner.viewId, owner.viewType)));
    }
    function draft(patch: Partial<PreparedAppSnapshotDraftV3> = {}): PreparedAppSnapshotDraftV3 {
        const seq = ++sequence;
        return { schemaVersion: 3, ...context, producerSeq: seq, sourceEpoch: seq, capturedAt: time,
            views: owners.map(v => ({ id: v.viewId, viewInstanceId: v.viewInstanceId, type: 'File', name: v.viewId, kind: 'state',
                content: options.content === undefined ? { format: 'markdown-v1', value: 'content-secret-' + v.viewId }
                    : { format: 'semantic-v1', value: options.content } })),
            refs: Object.fromEntries(owners.flatMap(v => Array.from({ length: options.refs ?? 2 }, (_, i) => [refKey(v.viewId, v.viewInstanceId, 'r' + i), {
                id: 'r' + i, ownerViewId: v.viewId, ownerViewInstanceId: v.viewInstanceId, refType: 'unknown',
                target: i === 1 ? { kind: 'entity', entityType: 'File', entityId: 'entity-secret', entityVersion: '1' }
                    : { kind: 'snapshot-value', payload: options.payload ?? { value: 'payload-secret-' + v.viewId } },
            }]))),
            tools: Object.fromEntries(tools.listTools().map(t => [t.id, t])), ...patch };
    }
    function publish(patch: Partial<PreparedAppSnapshotDraftV3> = {}): AppSnapshotV3 {
        const result = core.committer.accept(draft(patch));
        expect(result.status).toBe('published');
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 3) throw new Error('Expected V3 fixture');
        return result.snapshot;
    }
    const source = options.ready === false ? undefined : publish();
    const registry = createObservationRegistry(core.store, { namespace: options.namespace ?? 'test', now, limits: options.limits });
    function scope() { return registry.owner; }
    function begin(handle: Owner, viewIds = owners.map(v => v.viewId)) {
        const result = registry.begin(handle, { viewIds });
        expect(result.status).toBe('reserved'); if (result.status !== 'reserved') throw new Error('Expected reservation');
        return result;
    }
    function grant(snapshot = source!, visible = snapshot.views.map(v => v.id), retain = false): ObservationGrant {
        return { views: snapshot.views.filter(v => visible.includes(v.id)).map(v => ({ viewId: v.id, viewInstanceId: v.viewInstanceId })),
            refs: Object.values(snapshot.refs).filter(r => visible.includes(r.ownerViewId)).map(r => ({ viewId: r.ownerViewId, viewInstanceId: r.ownerViewInstanceId, refId: r.id })),
            toolBindings: Object.values(snapshot.tools).filter(tool => snapshot.views.some(view => view.type === tool.viewType && visible.includes(view.id)))
                .map(tool => ({ toolId: tool.id, execution: tool.execution })),
            content: retain ? snapshot.views.filter(v => visible.includes(v.id)).map(v => ({ view: { viewId: v.id, viewInstanceId: v.viewInstanceId }, decision: 'retain' as const })) : [] };
    }
    function observe(handle: Owner, permission = grant(), adopt = true) {
        const preparation = begin(handle);
        const result = registry.complete(handle, preparation.reservation, permission);
        expect(result.status).toBe('observed'); if (result.status !== 'observed') throw new Error('Expected observation');
        if (adopt) expect(registry.adoptObservation(handle, result.observation.observationId)).toEqual({ status: 'adopted' });
        return result.observation;
    }
    return { core, registry, tools, handler, owners, source: source!, now, setTime: (n: number) => { time = n; }, draft, publish, scope, begin, grant, observe, rebindTool, remountAllViews };
}
type Fixture = ReturnType<typeof fixture>;
it('keeps the current observation during preparation and transfers qualification only on adoption', () => {
    const f = fixture(), owner = f.scope(), first = f.observe(owner), pending = f.begin(owner);
    expect(f.registry.adoptObservation(owner, first.observationId)).toEqual({ status: 'adopted' });
    expect(f.registry.inspect()).toMatchObject({ observations: 1, reservations: 1, cancelledReservations: 0 });
    const next = f.registry.complete(owner, pending.reservation, f.grant());
    expect(next.status).toBe('observed'); if (next.status !== 'observed') return;
    expect(code(f.registry.resolveBinding(owner, key(next.observation)))).toBe('OBSERVATION_NOT_ADOPTED');
    expect(f.registry.resolveBinding(owner, key(first)).status).toBe('found');
    expect(f.registry.adoptObservation(owner, next.observation.observationId)).toEqual({ status: 'adopted' });
    expect(f.registry.inspect()).toMatchObject({ observations: 1, reservations: 0 });
    expect(code(f.registry.resolveBinding(owner, key(first)))).toBe('OBSERVATION_UNAVAILABLE');
    expect(f.registry.resolveBinding(owner, key(next.observation)).status).toBe('found'); zero(f);
});
it('invalid or cross-instance adoption leaves the current qualification unchanged', () => {
    const f = fixture(), g = fixture({ namespace: 'other' }), a = f.scope(), b = g.scope(), first = f.observe(a), other = g.observe(b);
    expect(code(f.registry.adoptObservation(a, ''))).toBe('OBSERVATION_INVALID');
    expect(code(f.registry.adoptObservation(a, other.observationId))).toBe('OBSERVATION_UNAVAILABLE');
    expect(f.registry.resolveBinding(a, key(first)).status).toBe('found');
    expect(g.registry.resolveBinding(b, key(other)).status).toBe('found'); zero(f); zero(g);
});
function key(observation: Observation, i = 0) { return { observationId: observation.observationId, bindingId: observation.bindings[i]!.bindingId }; }
function code(result: unknown): string | undefined { return (result as { issue?: { code: string } }).issue?.code; }
function zero(f: Fixture) {
    f.registry.close();
    expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 0, sources: 0,
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
        expect(observation.tools.every(t => t.execution.kind === 'view-type' && !Object.hasOwn(t.execution, 'targets'))).toBe(true);
        expect(observation.bindings.map(b => b.execution.kind)).toEqual(['view-type', 'view-type']);
        expect(observation.bindings.every(b => !Object.hasOwn(b, 'arguments'))).toBe(true);
        expect(JSON.stringify(observation)).not.toMatch(/payload-secret|entity-secret|content-secret|"payload"|"entityVersion"|"viewId":"v0"/);
        const result = f.registry.resolveBinding(scope, key(observation));
        expect(result.status).toBe('found');
        if (result.status === 'found') {
            expect(result.sourceRequest.snapshotId).toBe(f.source.id);
            expect(result.execution).toEqual(f.source.tools[result.tool.id]!.execution);
            expect(result.visibleRefs).toEqual(['r0', 'r1'].map(refId => ({ refId, viewId: 'v1', viewInstanceId: f.owners[1]!.viewInstanceId })));
            expect(Object.isFrozen(result.visibleRefs)).toBe(true);

        }
        expect(f.core.store.inspect().activeLeases).toBe(1); zero(f);
    });
    it('retains only explicitly approved complete content and preserves source order despite reordered grants', () => {
        const f = fixture({ tools: 2 }), scope = f.scope(), grant = f.grant(f.source, ['v0', 'v1'], true);
        const observation = f.observe(scope, { views: [...grant.views].reverse(), refs: [...grant.refs].reverse(),
            toolBindings: [...grant.toolBindings].reverse(), content: [...grant.content].reverse() });
        expect(observation.views.map(v => v.id)).toEqual(['v0', 'v1']);
        expect(observation.refs.map(r => r.viewId + r.refId)).toEqual(['v0r0', 'v0r1', 'v1r0', 'v1r1']);
        expect(observation.tools.map(t => t.id)).toEqual(Object.keys(f.source.tools));
        expect(observation.bindings.map(b => b.execution.kind)).toEqual(['view-type', 'view-type']);
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
    it('rejects a copied reservation or a reservation from another instance without consuming the original', () => {
        const f = fixture(), g = fixture({ namespace: 'other' }), a = f.scope(), b = g.scope(), preparation = f.begin(a);
        expect(code(g.registry.complete(b, preparation.reservation, g.grant()))).toBe('RESERVATION_UNAVAILABLE');
        expect(code(f.registry.complete(a, { ...preparation.reservation }, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        g.registry.abandon(b, preparation.reservation);
        expect(f.registry.inspect().reservations).toBe(1);
        const completed = f.registry.complete(a, preparation.reservation, f.grant());
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        expect(code(g.registry.resolveBinding(b, key(completed.observation)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(f.registry.adoptObservation(a, completed.observation.observationId)).toEqual({ status: 'adopted' });
        expect(f.registry.resolveBinding(a, key(completed.observation)).status).toBe('found');
        expect(code(f.registry.complete(a, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        zero(f); zero(g);
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
        expect(badClock.begin(badClock.owner, { viewIds: ['v0'] })).toEqual({ status: 'rejected',
            issue: { code: 'OBSERVATION_INTERNAL_ERROR', message: 'Observation registry request could not be completed' } });
        expect(getterReads).toBe(0); expect(exceptionReads).toBe(0); expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true); zero(f);
    });
    const invalidGrants: [string, (g: ObservationGrant) => unknown][] = [
        ['extra root', g => ({ ...g, extra: true })], ['extra identity', g => ({ ...g, views: [{ ...g.views[0], extra: true }] })],
        ['duplicate View', g => ({ ...g, views: [...g.views, g.views[0]] })], ['duplicate Ref', g => ({ ...g, refs: [...g.refs, g.refs[0]] })],
        ['duplicate target binding', g => ({ ...g, toolBindings: [...g.toolBindings, g.toolBindings[0]] })],
        ['wrong instance', g => ({ ...g, views: [{ ...g.views[0], viewInstanceId: 'other' }] })],
        ['unclosed Ref', g => ({ ...g, views: [] })], ['forged Ref', g => ({ ...g, refs: [{ ...g.refs[0], refId: 'other' }] })],
        ['wrong owner', g => ({ ...g, refs: [{ ...g.refs[0], viewId: 'v1' }] })],
        ['forged binding', g => {
            const first = g.toolBindings[0]!;
            return { ...g, toolBindings: [{ ...first, execution: { ...first.execution,
                activationId: 'forged' } }] };
        }],
        ['unknown Tool', g => ({ ...g, toolBindings: [{ ...g.toolBindings[0]!, toolId: 'other' }] })],
        ['duplicate content', g => ({ ...g, content: [g.content[0], g.content[0]] })],
        ['replacement content', g => ({ ...g, content: [{ ...g.content[0], value: 'substitute' }] })],
        ['invalid decision', g => ({ ...g, content: [{ ...g.content[0], decision: 'replace' }] })],
        ['unclosed content', g => ({ ...g, views: [], refs: [], toolBindings: [] })],
        ['nonfinite', g => {
            const first = g.toolBindings[0]!;
            return { ...g, toolBindings: [{ ...first, execution: { ...first.execution,
                activationId: Infinity } }] };
        }],
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
    it('keeps the instance and original Observation usable through a long model turn until explicit release', () => {
        const f = fixture({ store: { historyTtlMs: 10, leaseTtlMs: 10 } }), scope = f.scope(), preparation = f.begin(scope);
        f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r,
            target: { kind: 'snapshot-value', payload: { value: 'updated' } } }])) });
        f.setTime(1_000_000);
        expect(f.registry.active()).toBe(true);
        const completed = f.registry.complete(scope, preparation.reservation, f.grant());
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        expect(completed.observation.expiresAt).toBeNull();
        expect(f.registry.adoptObservation(scope, completed.observation.observationId)).toEqual({ status: 'adopted' });
        const resolved = f.registry.resolveBinding(scope, key(completed.observation));
        expect(resolved.status).toBe('found');
        if (resolved.status === 'found') expect(resolved.sourceRequest.snapshotId).toBe(f.source.id);
        expect(f.core.store.inspect().activeLeases).toBe(1);
        f.registry.releaseObservation(scope, completed.observation.observationId);
        expect(code(f.registry.resolveBinding(scope, key(completed.observation)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(f.core.store.getById(f.source.id).status).toBe('rejected');
        expect(f.registry.inspect()).toMatchObject({ observations: 0, sources: 0, totalBytes: 0 }); zero(f);
    });
    it('bounds prepared observations without evicting the current observation', () => {
        const f = fixture(), owner = f.scope(), observation = f.observe(owner);
        f.setTime(1_000_000);
        const pending = f.begin(owner);
        expect(code(f.registry.begin(owner, { all: true }))).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.resolveBinding(owner, key(observation)).status).toBe('found');
        f.registry.abandon(owner, pending.reservation);
        const candidate = f.observe(owner, f.grant(), false);
        expect(code(f.registry.begin(owner, { all: true }))).toBe('OBSERVATION_CAPACITY');
        f.registry.releaseObservation(owner, candidate.observationId);
        expect(f.registry.resolveBinding(owner, key(observation)).status).toBe('found'); zero(f);
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
        expect(f.registry.adoptObservation(scope, done.observation.observationId)).toEqual({ status: 'adopted' });
        const result = f.registry.resolveBinding(scope, key(done.observation));
        expect(result.status).toBe('found'); if (result.status === 'found') expect(result.tool).toBe(f.source.tools[result.tool.id]);
        expect(preparation.source).toBe(f.source); zero(f);
    });
    // D2: these cases retire the entire type activation. Removing only v0 while v1 remains is covered by the shared registry tests and real Worker D2 counts.
    it.each(['disable', 'all-views-remount', 'schema', 'version', 'last-view-remove', 'degraded'] as const)('refuses %s when resolving the original Binding', mode => {
        const f = fixture(), scope = f.scope(), observation = f.observe(scope), first = Object.values(f.source.tools)[0]!;
        if (mode === 'degraded') f.core.committer.accept(f.draft({ refs: { bad: null as never } }));
        else if (mode === 'disable') { f.rebindTool(); f.publish(); }
        else if (mode === 'last-view-remove') f.publish({ views: [], refs: {}, tools: {} });
        else if (mode === 'all-views-remount') { f.remountAllViews(); f.publish(); }
        else {
            const schema = first.inputSchema as Record<string, any>;
            const changedSchema = compileOrdinarySchema({ type: 'object', properties: { ...schema.properties, optional: { type: 'string' } },
                required: schema.required, additionalProperties: true }, 'view-type-parameters-v1');
            if (!changedSchema.ok) throw Error('Changed parameter fixture');
            f.publish({ tools: { [first.id]: { ...first, ...(mode === 'schema' ? { inputSchema: ordinaryParameterProfile(changedSchema.contract) } : {}),
                execution: { kind: 'view-type', activationId: mode === 'version' ? 'replacement' : first.execution.activationId } } } });
        }
        expect(code(f.registry.resolveBinding(scope, key(observation)))).toBe(mode === 'degraded' ? 'SNAPSHOT_UNREADY' : mode === 'last-view-remove' ? 'TOOL_UNAVAILABLE' : 'TOOL_SOURCE_STALE'); zero(f);
    });
    it.each(['stop', 'restart'] as const)('revokes observations on %s without rebinding the instance', mode => {
        const f = fixture(), owner = f.scope(), observation = f.observe(owner), preparation = f.begin(owner);
        f.core.lifecycle.stopApp('app', 'run');
        if (mode === 'restart') { f.core.lifecycle.startApp('app', 'run-2'); f.publish({ instanceId: 'run-2' }); }
        expect(f.registry.resolveBinding(owner, key(observation)).status).toBe('rejected');
        expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 1, cancelledReservations: 1 });
        expect(code(f.registry.complete(owner, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE'); zero(f);
    });
});

describe('B1 settlement, counts and shared-source fees', () => {
    it.each(['abandon', 'complete'] as const)('keeps a cancelled reservation charged until %s', mode => {
        const f = fixture(), owner = f.scope(), preparation = f.begin(owner), before = f.registry.inspect();
        expect(f.registry.close()).toMatchObject({ closed: true, observations: 0, reservations: 1, cancelledReservations: 1, totalBytes: before.totalBytes });
        expect(code(f.registry.begin(owner, { all: true }))).toBe('APP_INTERACTION_UNAVAILABLE');
        f.registry.close();
        if (mode === 'abandon') f.registry.abandon(owner, preparation.reservation);
        else expect(code(f.registry.complete(owner, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        f.registry.abandon(owner, preparation.reservation);
        expect(f.registry.inspect()).toMatchObject({ reservations: 0, totalBytes: 0 }); zero(f);
    });
    it('close releases the current observation but retains the unfinished preparation until it settles', () => {
        const f = fixture(), owner = f.scope(); f.observe(owner); const pending = f.begin(owner);
        const closed = f.registry.close();
        expect(closed).toMatchObject({ closed: true, releasedObservations: 1, observations: 0, reservations: 1, sources: 1 });
        expect(f.registry.close().releasedObservations).toBe(0);
        f.registry.abandon(owner, pending.reservation); zero(f);
    });
    it('charges the current and prepared observation for a shared source once', () => {
        const f = fixture(), owner = f.scope(), current = f.observe(owner), first = f.registry.inspect(), pending = f.begin(owner);
        expect(pending.source).toBe(f.source);
        expect(f.registry.inspect()).toMatchObject({ sources: 1, sourceBytes: first.sourceBytes,
            observationBytes: first.observationBytes + HARD.observation.maxCanonicalBytes,
            metadataBytes: first.metadataBytes + HARD.metadata.maxCanonicalBytes });
        const done = f.registry.complete(owner, pending.reservation, f.grant()); expect(done.status).toBe('observed');
        if (done.status !== 'observed') return;
        expect(f.registry.inspect().observationBytes).toBe(first.observationBytes + utf8Size(canonicalJson(done.observation as unknown as JsonValue)));
        f.registry.releaseObservation(owner, current.observationId);
        expect(f.registry.inspect().sourceBytes).toBe(first.sourceBytes);
        f.registry.releaseObservation(owner, done.observation.observationId);
        expect(f.registry.inspect().totalBytes).toBe(0); zero(f);
    });
    it('separately charges two source versions and refunds only their final references', () => {
        const f = fixture(), owner = f.scope(), first = f.observe(owner), before = f.registry.inspect();
        const newer = f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r, refType: 'new-type' }])) });
        const b = f.begin(owner), after = f.registry.inspect();
        expect(b.source).toBe(newer); expect(after.sources).toBe(2); expect(after.sourceBytes).toBeGreaterThan(before.sourceBytes);
        f.registry.releaseObservation(owner, first.observationId); expect(f.registry.inspect().sources).toBe(1);
        f.registry.abandon(owner, b.reservation); expect(f.registry.inspect().totalBytes).toBe(0); zero(f);
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
    it.each(['maxViews', 'maxRefs', 'maxTools', 'maxBindings'] as const)('separately checks %s at N-1/N/N+1', limit => {
        for (const count of [1, 2, 3]) {
            const f = fixture({ views: limit === 'maxViews' ? 3 : 1,
                refs: limit === 'maxRefs' ? 3 : 0, tools: limit === 'maxTools' || limit === 'maxBindings' ? 3 : 1, limits: { [limit]: 2 } }), scope = f.scope();
            {
                const p = f.begin(scope), g = limit === 'maxViews' ? f.grant(f.source, f.owners.slice(0, count).map(v => v.viewId)) : f.grant(), grant = { ...g,
                    ...(limit === 'maxRefs' ? { refs: g.refs.slice(0, count) } : {}),
                    ...(limit === 'maxTools' || limit === 'maxBindings' ? { toolBindings: g.toolBindings.slice(0, count) } : {}) };
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
    it('honors the Store lease limit without dropping an existing preparation', () => {
        const f = fixture({ store: { maxActiveLeases: 1 } }), owner = f.scope(), pending = f.begin(owner);
        expect(code(f.registry.begin(owner, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.inspect().reservations).toBe(1);
        expect(code(f.registry.complete(owner, pending.reservation, f.grant()))).toBe('SNAPSHOT_CAPACITY'); zero(f);
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
    it('applies the source budget to distinct snapshots while sharing one snapshot fee', () => {
        const probe = fixture(), owner = probe.scope(); probe.observe(owner);
        const sourceBytes = probe.registry.inspect().sourceBytes; zero(probe);
        const f = fixture({ limits: { maxSourceBytes: sourceBytes } }), a = f.scope(), first = f.observe(a), same = f.begin(a);
        expect(same.source).toBe(f.source); f.registry.abandon(a, same.reservation);
        f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r, refType: 'other-type' }])) });
        expect(code(f.registry.begin(a, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.inspect()).toMatchObject({ reservations: 0, observations: 1, sources: 1, sourceBytes });
        expect(f.registry.resolveBinding(a, key(first)).status).toBe('found'); zero(f);
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
            const result = registry.begin(registry.owner, input);
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'reserved');
            if (result.status === 'reserved') registry.abandon(registry.owner, result.reservation);
            else expect(code(result)).toBe('OBSERVATION_INVALID');
            registry.close(); zero(f);
        }
    });
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds grant and final internal metadata %s as a shared profile', field => {
        const probe = fixture(), scope = probe.scope(), permission = probe.grant(), observation = probe.observe(scope, permission);
        const metadata = { observationId: observation.observationId, source: observation.source,
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
    it('retains one View near the content limit and rejects two in the same observation', () => {
        const f = fixture({ views: 2, refs: 0, content: 'x'.repeat(524286) }), owner = f.scope(), p = f.begin(owner);
        expect(code(f.registry.complete(owner, p.reservation, f.grant(f.source, ['v0', 'v1'], true)))).toBe('OBSERVATION_CAPACITY');
        const observation = f.observe(owner, f.grant(f.source, ['v0'], true));
        expect(observation.views[0]!.content).toEqual(f.source.views[0]!.content); zero(f);
    });
    it('observes a near-limit View and rejects oversized metadata at its publication path', () => {
        const f = fixture({ views: 1, refs: 0, tools: 0, content: 'x'.repeat(500 * 1024) }), owner = f.scope();
        const view = { ...f.source.views[0]!, name: 'n'.repeat(16 * 1024 - 128) };
        const source = f.publish({ views: [view] });
        expect(f.observe(owner, f.grant(source, ['v0'], true)).views).toEqual([view]);
        const oversized = { ...view, name: 'n'.repeat(224 * 1024) };
        expect(f.core.committer.accept(f.draft({ views: [oversized] }))).toMatchObject({
            status: 'rejected', issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[0]' },
        });
        zero(f);
    });
    it('checks canonical escape expansion separately from the approximate source budget', () => {
        const f = fixture({ views: 1, refs: 1, payload: '\u0000'.repeat(1500), limits: { source: { maxCanonicalBytes: 4000 } } }), scope = f.scope();
        expect(bytes(f.source)).toBeGreaterThan(4000);
        expect(code(f.registry.begin(scope, { viewIds: ['v0'] }))).toBe('OBSERVATION_CAPACITY'); zero(f);
    });
});

describe('B1 immutable configuration and clock faults', () => {
    it('freezes every approved default profile and has no undeclared extension fields', () => {
        expect(HARD).toMatchObject({ maxViews: 256, maxRefs: 512, maxTools: 256, maxBindings: 256 });
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
        const p = max.begin(max.owner, { all: true });
        expect(p.status).toBe('reserved');
        if (p.status === 'reserved') {
            const result = max.complete(max.owner, p.reservation, f.grant());
            expect(result.status).toBe('observed');
            if (result.status === 'observed') expect(utf8Size(result.observation.observationId)).toBeLessThanOrEqual(256);
        }
        max.close(); zero(f);
    });
    it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects initial invalid clock %s with a fixed error', value => {
        const f = fixture();
        expect(() => createAppInteraction(f.core.store, { ...context, namespace: 'clock', now: () => value,
            policy: { project: () => emptyGrant(), authorize: () => true, canReadReceipt: () => true },
            execution: { resolve: () => null } })).toThrow('Invalid observation registry clock'); zero(f);
    });
    it('refuses clock rollback/throws and still permits owned preparation settlement and explicit close', () => {
        const f = fixture(); let time = 10, throws = false, reads = 0;
        const registry = createObservationRegistry(f.core.store, { namespace: 'clock', now: () => {
            if (throws) throw { get message() { reads++; return 'payload-secret'; } }; return time;
        } });
        const p = registry.begin(registry.owner, { viewIds: ['v0'] }); expect(p.status).toBe('reserved'); if (p.status !== 'reserved') return;
        time = 9; expect(code(registry.begin(registry.owner, { viewIds: ['v0'] }))).toBe('OBSERVATION_INTERNAL_ERROR');
        throws = true; expect(code(registry.complete(registry.owner, p.reservation, f.grant()))).toBe('OBSERVATION_INTERNAL_ERROR');
        expect(registry.inspect()).toMatchObject({ reservations: 0, totalBytes: 0, issue: { code: 'OBSERVATION_INTERNAL_ERROR' } });
        expect(registry.close()).toMatchObject({ closed: true, totalBytes: 0 }); expect(reads).toBe(0); zero(f);
    });
});

describe('B2-Q01 lifecycle identity capability', () => {
    it('requires identity capability instead of silently falling back to a legacy SnapshotStore', () => {
        const f = fixture(); const { readAppIdentity: _, ...legacy } = f.core.store;
        expect(() => createObservationRegistry(legacy as never, { namespace: 'legacy', now: f.now })).toThrow('Invalid observation registry store'); zero(f);
    });
    it('allows a pre-start owner and invalidates it on replacement before a new projection', () => {
        const core = createSnapshotCore({ now: () => 0 }), registry = createObservationRegistry(core.store,
            { namespace: 'prestart', now: () => 0 }, { appId: 'app', instanceId: 'first' });
        expect(registry.active()).toBe(true);
        expect(code(registry.begin(registry.owner, { viewIds: ['v0'] }))).toBe('SNAPSHOT_UNREADY');
        core.lifecycle.startApp('app', 'first'); expect(registry.active()).toBe(true);
        core.lifecycle.stopApp('app', 'first'); core.lifecycle.startApp('app', 'second');
        expect(core.store.readLatest('app')).toEqual({ status: 'unready' });
        expect(registry.active()).toBe(false);
        registry.close(); expect(registry.inspect().totalBytes).toBe(0);
    });
    it('keeps cancelled preparation fees through a direct instance replacement until settlement', () => {
        const f = fixture(), scope = f.scope(), preparation = f.begin(scope), before = f.registry.inspect();
        f.core.lifecycle.startApp('app', 'new-unready');
        expect(f.registry.inspect()).toMatchObject({ reservations: 1, cancelledReservations: 1, totalBytes: before.totalBytes });
        expect(code(f.registry.complete(scope, preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE'); zero(f);
    });
});
