import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSnapshotCore } from '../snapshot/store.js';
import { createAppInteraction } from './app-interaction.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { canonicalJson, copyJson, utf8Size } from '../snapshot/json.js';
import type { AppSnapshot, JsonValue, PreparedAppSnapshotDraft, SnapshotStoreOptions, ToolDescriptor } from '../snapshot/types.js';
import { createViewOwnedTools } from '../tool/view-owned-tools.js';
import { compileToolParameters } from '../tool/tool-parameters.js';
import { createObservationOperations, hostedObservationCapacityIssue, hostedObservationNamespace, normalizeProjectionLimits,
    type ObservationState, DEFAULT_PROJECTION_LIMITS as HARD } from './observation-registry.js';
import type { Observation, ObservationGrant, ProjectionLimitOverrides } from './observation-types.js';

const fixtureJsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'object' }, { type: 'array', items: {} }] };



const context = { appId: 'app', instanceId: 'run' };
type RegistryOptions = Parameters<typeof createObservationOperations>[1] & { readonly now: () => number };

function createObservationRegistry(store: Parameters<typeof createObservationOperations>[0], options: RegistryOptions,
    identity = context) {
    const state: ObservationState = { ...identity, closing: false, reservations: new Map(), observations: new Map() };
    let lastNow = -1;
    function refresh() {
        const time = options.now();
        if (!Number.isSafeInteger(time) || time < 0 || time < lastNow) throw new Error('Invalid clock');
        lastNow = time;
        if (!state.closing && !operations.isCurrent()) {
            state.closing = true;
            operations.releaseAll();
        }
        return time;
    }
    const { now: _, ...config } = Object.getOwnPropertyDescriptors(options);
    const operations = createObservationOperations(store, Object.defineProperties({}, config) as RegistryOptions, state, refresh);
    return {
        ...operations,
        active() { refresh(); return !state.closing; },
        close() {
            const before = operations.stats();
            state.closing = true;
            operations.releaseAll();
            const after = operations.stats();
            return { ...after, releasedObservations: before.observations - after.observations };
        },
        inspect() {
            try { refresh(); return operations.stats(); } catch (error) { return operations.stats(error); }
        },
    };
}

afterEach(() => vi.restoreAllMocks());
const emptyGrant = (): ObservationGrant => ({ refs: [], toolIds: [] });
it('derives the receiver from the source without exposing activation fields', () => {
    const f = fixture({views:2,tools:1,refs:0});
    const grant = f.grant();
    const before = f.begin();
    expect(f.registry.complete(before.reservation, {...grant, toolBindings:[{activationId:'forged'}]}))
        .toMatchObject({status:'rejected',issue:{code:'OBSERVATION_PROJECTION_INVALID'}});
    const observation = f.observe(grant);
    expect(observation).not.toHaveProperty('bindings');
    expect(observation.views[0]).not.toHaveProperty('toolBindings');
    expect(f.registry.resolveTool(key(observation))).toMatchObject({status:'found',receiver:{
        viewId:'v_1',viewInstanceId:f.source.views[0]!.viewInstanceId,
        activationId:f.source.views[0]!.toolBindings[0]!.activationId,
    }});
    zero(f);
});
function fixture(options: { views?: number; refs?: number; tools?: number; content?: string;
    payload?: JsonValue; valueSchema?: JsonValue; store?: Omit<SnapshotStoreOptions, 'appId' | 'instanceId'>;
    limits?: ProjectionLimitOverrides; ready?: boolean; namespace?: string; instanceId?: string } = {}) {
    let time = 0, sequence = 0;
    const now = () => time;
    const identity = { ...context, instanceId: options.instanceId ?? context.instanceId };
    const core = createSnapshotCore({ ...identity, now, ...options.store });
    const tools = createViewOwnedTools(identity.appId, identity.instanceId);
    const handler = vi.fn(async () => ({success:true as const}));
    let pages = Array.from({length:options.views ?? 2}, (_, i) => ({idPrefix:'v',type:'File',owner:{}}));
    let owners: ReturnType<ReturnType<typeof createViewOwnedTools>['prepareFrame']>['instances'];
    const declarations = Array.from({length:options.tools ?? 1}, (_, i) => ({
        name:'tool'+i,description:'Synthetic tool',inputSchema:{type:'object',properties:{selected:{
            'x-aotui-ref-kind':'unknown','x-aotui-ref-value':{type:'object'},
        }},required:['selected'],additionalProperties:true},
    }));
    tools.defineViewTypes([{ name: 'File', multiplicity: 'multiple', tools: declarations }]);
    function prepare(disabledView = -1, disabledTool = -1) {
        const plan = tools.prepareFrame(pages.map((page, i) => ({ ...page, bindings:declarations.map(({name}, j) => ({
            name,enabled:i !== disabledView || j !== disabledTool,execute:handler,
        }))})));
        plan.accept();
        owners=plan.instances;
        return plan.tools;
    }
    function rebindTool(viewIndex = 0, toolIndex = 0) { prepare(viewIndex,toolIndex); }
    function remountAllViews() { pages = pages.map(page => ({...page,owner:{}})); }
    function draft(patch: Partial<PreparedAppSnapshotDraft> = {}): PreparedAppSnapshotDraft {
        const available = prepare();
        const seq = ++sequence;
        return { schemaVersion: 8, ...identity, producerSeq: seq, sourceEpoch: seq, capturedAt: time,
            views: owners.map(v => ({ toolBindings: v.toolBindings, id: v.viewId, viewInstanceId: v.viewInstanceId, type: 'File', name: v.viewId, region: 'dynamic',
                content: { format: 'markdown-v1', value: options.content ?? 'content-secret-' + v.viewId } })),
            refs: Object.fromEntries(owners.flatMap(v => Array.from({ length: options.refs ?? 2 }, (_, i) => [refKey(v.viewId, v.viewInstanceId, 'r' + i), { valueSchema: fixtureJsonSchema, scope: 'protected',
                id: 'r' + i, ownerViewId: v.viewId, ownerViewInstanceId: v.viewInstanceId, refType: 'unknown',
                ...(options.valueSchema === undefined ? {} : { valueSchema: options.valueSchema }),
                target: { kind: 'snapshot-value', payload: options.payload ?? { value: `payload-secret-${v.viewId}-${i}` } },
            }]))),
            tools: Object.fromEntries(available.map(t => [t.id, t])), ...patch };
    }
    function publish(patch: Partial<PreparedAppSnapshotDraft> = {}): AppSnapshot {
        const result = core.committer.accept(draft(patch));
        expect(result.status).toBe('published');
        if (result.status !== 'published' || result.snapshot.schemaVersion !== 8) throw new Error('Expected a published Snapshot fixture');
        return result.snapshot;
    }
    const source = options.ready === false ? undefined : publish();
    const registry = createObservationRegistry(core.store, { namespace: options.namespace ?? 'test', now, limits: options.limits }, identity);
    function begin() {
        const result = registry.begin();
        expect(result.status).toBe('reserved'); if (result.status !== 'reserved') throw new Error('Expected reservation');
        return result;
    }
    function grant(snapshot = source!, refViews = snapshot.views.map(view => view.id)): ObservationGrant {
        return { refs: Object.values(snapshot.refs).filter(ref => refViews.includes(ref.ownerViewId))
            .map(ref => ({viewId:ref.ownerViewId,viewInstanceId:ref.ownerViewInstanceId,refId:ref.id})),
            toolIds: Object.keys(snapshot.tools) };
    }
    function observe(permission = grant(), adopt = true) {
        const preparation = begin();
        const result = registry.complete(preparation.reservation, permission);
        expect(result.status).toBe('observed'); if (result.status !== 'observed') throw new Error('Expected observation');
        if (adopt) expect(registry.adoptObservation(result.observation.observationId)).toEqual({ status: 'adopted' });
        return result.observation;
    }
    return { core, registry, tools, handler, owners, source: source!, now, setTime: (n: number) => { time = n; }, draft, publish, begin, grant, observe, rebindTool, remountAllViews };
}
type Fixture = ReturnType<typeof fixture>;
it('keeps the current observation during preparation and transfers qualification only on adoption', () => {
    const f = fixture(), first = f.observe(), pending = f.begin();
    expect(f.registry.adoptObservation(first.observationId)).toEqual({ status: 'adopted' });
    expect(f.registry.inspect()).toMatchObject({ observations: 1, reservations: 1, cancelledReservations: 0 });
    const next = f.registry.complete(pending.reservation, f.grant());
    expect(next.status).toBe('observed'); if (next.status !== 'observed') return;
    expect(f.registry.adoptObservation(first.observationId)).toEqual({ status: 'adopted' });
    expect(code(f.registry.resolveTool(key(next.observation)))).toBe('OBSERVATION_NOT_ADOPTED');
    expect(f.registry.resolveTool(key(first)).status).toBe('found');
    expect(f.registry.adoptObservation(next.observation.observationId)).toEqual({ status: 'adopted' });
    expect(f.registry.inspect()).toMatchObject({ observations: 1, reservations: 0 });
    expect(code(f.registry.resolveTool(key(first)))).toBe('OBSERVATION_UNAVAILABLE');
    expect(f.registry.resolveTool(key(next.observation)).status).toBe('found'); zero(f);
});
it('invalid or cross-instance adoption leaves the current qualification unchanged', () => {
    const f = fixture(), g = fixture({ namespace: 'other' }), first = f.observe(), other = g.observe();
    expect(code(f.registry.adoptObservation(''))).toBe('OBSERVATION_INVALID');
    expect(code(f.registry.adoptObservation(other.observationId))).toBe('OBSERVATION_UNAVAILABLE');
    expect(f.registry.resolveTool(key(first)).status).toBe('found');
    expect(g.registry.resolveTool(key(other)).status).toBe('found'); zero(f); zero(g);
});
function key(observation: Observation, i = 0) { return { observationId: observation.observationId, toolId: observation.tools[i]!.id, viewId: 'v_1' }; }
function code(result: unknown): string | undefined { return (result as { issue?: { code: string } }).issue?.code; }
function zero(f: Fixture) {
    f.registry.close();
    expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 0 });
    expect(f.core.store.inspect().activeHolds).toBe(0); expect(f.handler).not.toHaveBeenCalled();
}

describe('Ref visibility and receiver grants', () => {
    it('publishes the whole declared schema without runtime values', () => {
        const schema = { type: 'object', properties: { email: { type: 'string' } } };
        const f = fixture({ refs: 1, views: 1, valueSchema: schema, payload: { email: 'private@example.test' } });
        const grant = f.grant();
        const consumers = [{ appId: 'receiver', instanceId: 'run', viewId: 'draft', viewInstanceId: 'actual-mount' }];
        const only = f.observe({ ...grant, refs: [{ ...grant.refs[0]!, consumers }] });
        expect(only.refs).toEqual([{ ...grant.refs[0], scope: 'protected', refType: 'unknown', valueSchema: schema, consumers }]);
        expect(JSON.stringify(only.refs)).not.toContain('private@example.test');
        zero(f);
    });
    it.each([
        { paths: [] }, { consumers: null },
        { consumers: [{ appId: 'mail', viewId: 'draft', viewInstanceId: 'mount' }] },
        { consumers: [{ appId: 'bad.name', instanceId: 'run', viewId: 'draft', viewInstanceId: 'mount' }] },
    ])('rejects invalid Ref grants %#', patch => {
        const f = fixture({ refs: 1, views: 1 }), grant = f.grant();
        expect(f.registry.complete(f.begin().reservation, { ...grant, refs: [{ ...grant.refs[0]!, ...patch }] }))
            .toMatchObject({ status: 'rejected', issue: { code: 'OBSERVATION_PROJECTION_INVALID' } });
        zero(f);
    });
});

describe('B1 projection and real source ownership', () => {
    it('applies a read-only capability to both the observation and its adopted Tool grants', () => {
        const f = fixture();
        const grant = f.grant();
        const result = f.registry.complete(f.begin().reservation, grant, () => false);
        expect(result).toMatchObject({ status: 'observed', observation: { tools: [] } });
        if (result.status !== 'observed') throw Error(result.issue.code);
        const { observationId, refs } = result.observation;
        expect(refs).toHaveLength(grant.refs.length);
        expect(f.registry.adoptObservation(observationId).status).toBe('adopted');
        expect(code(f.registry.resolveTool({ observationId, toolId: grant.toolIds[0]!, viewId: 'v_1' }))).toBe('TOOL_UNAVAILABLE');
        expect(grant.toolIds).toHaveLength(1);
        zero(f);
    });

    it('preserves every View and grants only the allowed Refs and Tools in source order', () => {
        const f = fixture({tools:2});
        const grant = f.grant(f.source,['v_2']);
        const observation = f.observe({refs:[...grant.refs].reverse(),toolIds:[...grant.toolIds].reverse()});
        expect(observation.views.map(v => v.id)).toEqual(['v_1','v_2']);
        expect(observation.views[0]!.content).toEqual(f.source.views[0]!.content);
        expect(observation.tools.map(tool => tool.id)).toEqual(Object.keys(f.source.tools));
        expect(JSON.stringify(observation)).not.toMatch(/payload-secret|activationId|toolBindings/);
        expect(observation.refs.map(ref => ref.viewId)).toEqual(['v_2','v_2']);
        expect(f.registry.resolveTool(key(observation))).toMatchObject({status:'found',
            snapshotId:f.source.id,visibleRefs:grant.refs.slice().reverse()});
        expect(f.core.store.inspect().activeHolds).toBe(1); zero(f);
    });
    it('supports an empty grant while continuing to present every open View', () => {
        const f = fixture(), observation = f.observe(emptyGrant());
        expect(observation).toMatchObject({ refs:[],tools:[] });
        expect(observation.views.map(view => view.id)).toEqual(['v_1','v_2']);
        expect(code(f.registry.resolveTool({observationId:observation.observationId,toolId:'absent',viewId:'v_1'}))).toBe('TOOL_UNAVAILABLE');
        zero(f);
    });
    it('captures the grant and rejects detached reservation objects', () => {
        const f=fixture(), preparation=f.begin();
        expect(Object.isFrozen(preparation.reservation)).toBe(true);
        const grant=structuredClone(f.grant());
        const completed=f.registry.complete(preparation.reservation,grant);
        if(completed.status !== 'observed') throw Error(completed.issue.code);
        const refs=grant.refs as {refId:string}[];
        refs[0]!.refId='tampered';
        expect(completed.observation.refs[0]!.refId).toBe('r0');
        zero(f);
    });
});

describe('B1 handles, isolation and strict data', () => {
    it('rejects a copied reservation or a reservation from another instance without consuming the original', () => {
        const f = fixture(), g = fixture({ namespace: 'other', instanceId: 'other-run' });
        const original = f.observe(), other = g.observe(), preparation = f.begin();
        const firstStats = f.registry.inspect(), otherStats = g.registry.inspect();
        expect(code(g.registry.complete(preparation.reservation, g.grant()))).toBe('RESERVATION_UNAVAILABLE');
        expect(code(f.registry.complete({ ...preparation.reservation }, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        g.registry.abandon(preparation.reservation);
        g.registry.releaseObservation(original.observationId);
        expect(code(g.registry.adoptObservation(original.observationId))).toBe('OBSERVATION_UNAVAILABLE');
        expect(code(g.registry.resolveTool(key(original)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(code(g.registry.resolveTool({ ...key(other), viewId: 'unobserved' }))).toBe('TOOL_UNAVAILABLE');
        expect(f.registry.inspect()).toEqual(firstStats);
        expect(g.registry.inspect()).toEqual(otherStats);
        expect(f.core.store.inspect().activeHolds).toBe(2);
        expect(g.core.store.inspect().activeHolds).toBe(1);
        expect(g.registry.resolveTool(key(other)).status).toBe('found');
        const completed = f.registry.complete(preparation.reservation, f.grant());
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        expect(f.registry.adoptObservation(completed.observation.observationId)).toEqual({ status: 'adopted' });
        zero(g);
        expect(f.registry.resolveTool(key(completed.observation)).status).toBe('found');
        expect(code(f.registry.complete(preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        zero(f);
    });
    it('does not revive released IDs or bind an old observation ID to a new Binding', () => {
        const f = fixture(), first = f.observe();
        f.registry.releaseObservation(first.observationId); f.registry.releaseObservation(first.observationId);
        const second = f.observe();
        expect(second.observationId).not.toBe(first.observationId);
        expect(second.tools[0]!.id).toBe(first.tools[0]!.id);
        expect(code(f.registry.resolveTool(key(first)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(f.registry.resolveTool(key(second)).status).toBe('found'); zero(f);
    });
    it('reports a failing snapshot read without stringifying or logging the exception', () => {
        const f = fixture(); let exceptionReads = 0;
        const spies = ['log', 'warn', 'error'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
        const badClock = createObservationRegistry({ ...f.core.store, readLatest() { throw { get message() { exceptionReads++; return 'payload-secret'; },
            toString() { exceptionReads++; return 'payload-secret'; } }; } }, { namespace: 'bad-port', now: f.now });
        expect(badClock.begin()).toEqual({ status: 'rejected',
            issue: { code: 'OBSERVATION_INTERNAL_ERROR', message: 'Observation registry request could not be completed' } });
        expect(exceptionReads).toBe(0); expect(spies.every(spy => spy.mock.calls.length === 0)).toBe(true); zero(f);
    });
    const invalidGrants: [string, (g: ObservationGrant) => unknown][] = [
        ['extra root', g => ({...g, views:[]})], ['extra identity', g => ({...g, refs:[{...g.refs[0],extra:true}]})],
        ['duplicate Ref', g => ({...g,refs:[...g.refs,g.refs[0]]})],
        ['duplicate Tool', g => ({...g,toolIds:[...g.toolIds,g.toolIds[0]]})],
        ['wrong instance', g => ({...g,refs:[{...g.refs[0],viewInstanceId:'other'}]})],
        ['wrong owner', g => ({...g,refs:[{...g.refs[0],viewId:'v_2'}]})],
        ['forged Ref', g => ({...g,refs:[{...g.refs[0],refId:'other'}]})],
        ['unknown Tool', g => ({...g,toolIds:['other']})],
        ['nonfinite', g => ({...g,toolIds:[Infinity]})],
        ['sparse', g => ({...g,refs:new Array(1)})],
        ['symbol', g => ({...g,[Symbol('hidden')]:'payload-secret'})],
        ['cycle', g => {const x={...g,refs:[] as unknown[]};x.refs.push(x);return x;}],
        ['getter', g => ({...g,get refs(){throw Error('payload-secret');}})],
    ];
    it.each(invalidGrants)('settles invalid %s grant atomically and leaks no input', (_, corrupt) => {
        const f = fixture();
        const readOnly = vi.fn(() => false);
        const result = f.registry.complete(f.begin().reservation, corrupt(f.grant(f.source, ['v_1'])), readOnly);
        expect(code(result)).toBe('OBSERVATION_PROJECTION_INVALID'); expect(JSON.stringify(result)).not.toContain('payload-secret');
        expect(readOnly).not.toHaveBeenCalled();
        expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 0 }); zero(f);
    });

});

describe('B1 original source, lifecycle and deadlines', () => {
    it('keeps the instance and original Observation usable through a long model turn until explicit release', () => {
        const f = fixture(), preparation = f.begin();
        f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r,
            target: { kind: 'snapshot-value', payload: { value: 'updated' } } }])) });
        f.setTime(1_000_000);
        expect(f.registry.active()).toBe(true);
        const completed = f.registry.complete(preparation.reservation, f.grant());
        expect(completed.status).toBe('observed'); if (completed.status !== 'observed') return;
        expect(f.registry.adoptObservation(completed.observation.observationId)).toEqual({ status: 'adopted' });
        const resolved = f.registry.resolveTool(key(completed.observation));
        expect(resolved.status).toBe('found');
        if (resolved.status === 'found') expect(resolved.snapshotId).toBe(f.source.id);
        expect(f.core.store.inspect().activeHolds).toBe(1);
        f.registry.releaseObservation(completed.observation.observationId);
        expect(code(f.registry.resolveTool(key(completed.observation)))).toBe('OBSERVATION_UNAVAILABLE');
        expect(f.core.store.getById(f.source.id).status).toBe('rejected');
        expect(f.registry.inspect()).toMatchObject({ observations: 0 }); zero(f);
    });
    it('bounds prepared observations without evicting the current observation', () => {
        const f = fixture(), observation = f.observe();
        f.setTime(1_000_000);
        const pending = f.begin();
        expect(code(f.registry.begin())).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.resolveTool(key(observation)).status).toBe('found');
        f.registry.abandon(pending.reservation);
        const candidate = f.observe(f.grant(), false);
        expect(code(f.registry.begin())).toBe('OBSERVATION_CAPACITY');
        f.registry.releaseObservation(candidate.observationId);
        expect(f.registry.resolveTool(key(observation)).status).toBe('found'); zero(f);
    });
    it('resolves all from the current semantic source and publishes an empty observation after the last View closes', () => {
        const f = fixture(), first = f.registry.begin();
        expect(first.status).toBe('reserved'); if (first.status !== 'reserved') return;
        expect(first.source.views.map(view => view.id)).toEqual(['v_1','v_2']);
        f.registry.abandon(first.reservation);
        const source = f.publish({ views: [], refs: {}, tools: {} });
        const empty = f.registry.begin();
        expect(empty.status).toBe('reserved'); if (empty.status !== 'reserved') return;
        expect(empty.source).toBe(source);
        const completed = f.registry.complete(empty.reservation, emptyGrant());
        expect(completed).toMatchObject({ status: 'observed', observation: { views: [], refs: [], tools: [] } });
        zero(f);
    });
    it('can open before readiness, refuses unready/degraded and never exposes lastGood', () => {
        const f = fixture({ ready: false });
        expect(code(f.registry.begin())).toBe('SNAPSHOT_UNREADY');
        f.publish();
        const bad = f.draft({ views: [] }); expect(f.core.committer.accept(bad).status).toBe('rejected');
        expect(f.core.store.readLatest('app').status).toBe('degraded');
        expect(code(f.registry.begin())).toBe('SNAPSHOT_UNREADY'); zero(f);
    });
    it('rejects Snapshot V1 before an observation can be manufactured', () => {
        const f = fixture({ ready: false });
        expect(f.core.committer.accept({ schemaVersion: 1, ...context, producerSeq: 1, sourceEpoch: 1, capturedAt: 0,
            views: [{ id: 'v0', generation: 'g', type: 'File', name: 'v0', region: 'dynamic', content: { format: 'markdown-v1', value: 'x' } }],
            refs: {}, tools: {} }).status).toBe('rejected');
        expect(code(f.registry.begin())).toBe('SNAPSHOT_UNREADY'); zero(f);
    });
    it('completes and resolves the exact historical source after a Ref-only update', () => {
        const f = fixture(), preparation = f.begin();
        const next = f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r,
            target: { kind: 'snapshot-value', payload: { value: 'new-payload-secret' } } }])) });
        expect(next.id).not.toBe(f.source.id);
        const done = f.registry.complete(preparation.reservation, f.grant());
        expect(done.status).toBe('observed'); if (done.status !== 'observed') return;
        expect(done.observation.source.snapshotId).toBe(f.source.id);
        expect(f.registry.adoptObservation(done.observation.observationId)).toEqual({ status: 'adopted' });
        const result = f.registry.resolveTool(key(done.observation));
        expect(result.status).toBe('found'); if (result.status === 'found') expect(result.tool).toBe(f.source.tools[result.tool.id]);
        expect(preparation.source).toBe(f.source); zero(f);
    });
    // D2: these cases retire the entire type activation. Removing only v0 while v1 remains is covered by the shared registry tests and real Worker D2 counts.
    it.each(['disable', 'all-views-remount', 'schema', 'version', 'last-view-remove', 'degraded'] as const)('refuses %s when resolving the original Binding', mode => {
        const f = fixture(), observation = f.observe(), first = Object.values(f.source.tools)[0]!;
        if (mode === 'degraded') f.core.committer.accept(f.draft({ refs: { bad: null as never } }));
        else if (mode === 'disable') { f.rebindTool(); f.publish(); }
        else if (mode === 'last-view-remove') f.publish({ views: [], refs: {}, tools: {} });
        else if (mode === 'all-views-remount') { f.remountAllViews(); f.publish(); }
        else if (mode === 'version') f.rebindTool();
        else {
            const schema = first.inputSchema as Record<string, any>;
            const changed = compileToolParameters({type:'object',properties:{...schema.properties,optional:{type:'string'}},
                required:schema.required,additionalProperties:true});
            if (!changed.ok) throw Error('Changed parameter fixture');
            f.publish({tools:{[first.id]:{...first,inputSchema:changed.contract.schema}}});
        }
        if (mode === 'version') f.publish();
        expect(code(f.registry.resolveTool(key(observation)))).toBe(mode === 'degraded' ? 'SNAPSHOT_UNREADY'
            : mode === 'last-view-remove' || mode === 'all-views-remount' ? 'VIEW_INSTANCE_REVOKED' : 'TOOL_SOURCE_STALE'); zero(f);
    });
    it('revokes observations on stop and retains cancelled preparation until settlement', () => {
        const f = fixture(), observation = f.observe(), preparation = f.begin();
        const reserved = f.registry.inspect();
        f.core.lifecycle.stop();
        expect(f.registry.resolveTool(key(observation)).status).toBe('rejected');
        const stopped = f.registry.inspect();
        expect(stopped).toMatchObject({ observations: 0, reservations: 1, cancelledReservations: 1 });
        expect(reserved.observationSlots).toBe(2);
        expect(f.core.store.inspect().activeHolds).toBe(1);
        expect(code(f.registry.complete(preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE'); zero(f);
    });
});

describe('Observation lifetime and Snapshot ownership', () => {
    it.each(['abandon', 'complete'] as const)('keeps a cancelled reservation held until %s', mode => {
        const f = fixture(), preparation = f.begin();
        expect(f.registry.close()).toMatchObject({ closed: true, observations: 0, reservations: 1, cancelledReservations: 1 });
        expect(code(f.registry.begin())).toBe('APP_INTERACTION_UNAVAILABLE');
        f.registry.close();
        if (mode === 'abandon') f.registry.abandon(preparation.reservation);
        else expect(code(f.registry.complete(preparation.reservation, f.grant()))).toBe('RESERVATION_UNAVAILABLE');
        f.registry.abandon(preparation.reservation);
        expect(f.registry.inspect()).toMatchObject({ reservations: 0 }); zero(f);
    });
    it('close releases the current observation but retains the unfinished preparation until it settles', () => {
        const f = fixture(); f.observe(); const pending = f.begin();
        const closed = f.registry.close();
        expect(closed).toMatchObject({ closed: true, releasedObservations: 1, observations: 0, reservations: 1 });
        expect(f.registry.close().releasedObservations).toBe(0);
        f.registry.abandon(pending.reservation); zero(f);
    });
    it('one retained Snapshot has one byte size and independent observation holds', () => {
        const f = fixture(), current = f.observe(), first = f.core.store.inspect(), pending = f.begin();
        expect(pending.source).toBe(f.source);
        expect(f.core.store.inspect()).toMatchObject({ activeHolds: 2, currentBytes: first.currentBytes });
        const done = f.registry.complete(pending.reservation, f.grant());
        if (done.status !== 'observed') throw Error(done.issue.code);
        f.registry.releaseObservation(current.observationId);
        expect(f.core.store.inspect().activeHolds).toBe(1);
        f.registry.releaseObservation(done.observation.observationId);
        zero(f);
    });
    it('retains a superseded Snapshot until the last real holder returns it', () => {
        const f = fixture(), first = f.observe();
        const newer = f.publish({ refs: Object.fromEntries(Object.entries(f.source.refs).map(([k, r]) => [k, { ...r, refType: 'new-type' }])) });
        const pending = f.begin();
        expect(pending.source).toBe(newer);
        expect(f.core.store.inspect()).toMatchObject({ activeHolds: 2, heldSnapshots: 1 });
        f.registry.releaseObservation(first.observationId);
        expect(f.core.store.inspect()).toMatchObject({ activeHolds: 1, heldSnapshots: 0 });
        f.registry.abandon(pending.reservation);
        zero(f);
    });
    it('settles repeated failing grants without residual slots or leases', () => {
        const f = fixture();
        for (let i = 0; i < 40; i++) {
            const p = f.begin(); expect(code(f.registry.complete(p.reservation, { invalid: 'payload-secret' }))).toBe('OBSERVATION_PROJECTION_INVALID');
            expect(f.registry.inspect()).toMatchObject({ observations: 0, reservations: 0 });
            expect(f.core.store.inspect().activeHolds).toBe(0);
        }
        zero(f);
    });
    it.each(['maxViews','maxRefs','maxTools'] as const)('separately checks %s at N-1/N/N+1', limit => {
        for (const count of [1,2,3]) {
            const f = fixture({views:limit==='maxViews'?count:1,refs:limit==='maxRefs'?count:0,
                tools:limit==='maxTools'?count:1,limits:{[limit]:2}});
            const pending=f.registry.begin();
            const result=pending.status==='reserved' ? f.registry.complete(pending.reservation,f.grant()) : pending;
            expect(result.status).toBe(count<=2?'observed':'rejected');
            if(count>2) expect(code(result)).toBe('OBSERVATION_CAPACITY');
            zero(f);
        }
    });
    it('rejects too many open Views without clipping the App', () => {
        const f=fixture({views:257,refs:0});
        expect(code(f.registry.begin())).toBe('OBSERVATION_CAPACITY');
        zero(f);
    });
    it('completes a preparation using its existing Snapshot hold at the active limit', () => {
        const f = fixture({ store: { maxActiveHolds: 1 } }), pending = f.begin();
        expect(code(f.registry.begin())).toBe('OBSERVATION_CAPACITY');
        expect(f.registry.inspect().reservations).toBe(1);
        expect(f.registry.complete(pending.reservation, f.grant()).status).toBe('observed');
        expect(f.core.store.inspect().activeHolds).toBe(1);
        zero(f);
    });
});

describe('Observation data limits', () => {
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
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds grant and final internal metadata %s as a shared profile', field => {
        const probe = fixture(), permission = probe.grant(), observation = probe.observe(permission);
        const metadata = { refs: permission.refs, toolIds: observation.tools.map(tool => tool.id) };
        const measure = (v: unknown) => field === 'maxCanonicalBytes' ? bytes(v) : threshold(v, field);
        const n = Math.max(measure(permission), measure(metadata)); zero(probe);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ limits: { metadata: { [field]: n + delta } } }), p = f.begin();
            const result = f.registry.complete(p.reservation, f.grant());
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'observed');
            if (result.status === 'rejected') expect(['OBSERVATION_CAPACITY', 'OBSERVATION_PROJECTION_INVALID']).toContain(code(result)); zero(f);
        }
    });
    it.each(['maxDepth', 'maxNodes', 'maxApproxBytes', 'maxCanonicalBytes'] as const)('bounds final public Observation %s at N-1/N/N+1', field => {
        const content = '\u0000'.repeat(30) + '汉字';
        const probe = fixture({ content }), observation = probe.observe(probe.grant(probe.source, ['v_1', 'v_2']));
        const n = field === 'maxCanonicalBytes' ? bytes(observation) : threshold(observation, field); zero(probe);
        for (const delta of [-1, 0, 1]) {
            const f = fixture({ content, limits: { observation: { [field]: n + delta } } }), p = f.begin();
            const result = f.registry.complete(p.reservation, f.grant(f.source, ['v_1', 'v_2']));
            expect(result.status).toBe(delta < 0 ? 'rejected' : 'observed');
            if (result.status === 'rejected') expect(code(result)).toBe('OBSERVATION_CAPACITY'); zero(f);
        }
    });
    it('retains one View near the content limit and rejects two in the same observation', () => {
        const f = fixture({ views: 2, refs: 0, content: 'x'.repeat(524286) }), p = f.begin();
        expect(code(f.registry.complete(p.reservation, f.grant(f.source, ['v_1', 'v_2'])))).toBe('OBSERVATION_CAPACITY');
        zero(f);
    });
    it('measures hosted capacity with the encoded source IDs and full receiver metadata at the counter bound', () => {
        const instanceId = 'run"界';
        const f = fixture({ content: '', ready: false, instanceId, namespace: hostedObservationNamespace(instanceId) });
        const initial = f.draft();
        const views = [initial.views[0]!, { ...initial.views[1]!, toolBindings: [] }];
        const draft = { ...initial, views };
        const published = f.core.committer.accept(draft);
        if (published.status !== 'published') throw Error('Expected a published reference frame');
        const observation = f.observe(f.grant(published.snapshot));
        expect(observation.tools[0]?.eligibleViewIds).toEqual(['v_1']);
        const revision = Number.MAX_SAFE_INTEGER;
        const envelope = {
            ...observation,
            observationId: observation.observationId.replace(/:\d+$/, ':' + revision),
            source: { ...observation.source, revision,
                snapshotId: observation.source.snapshotId.replace(/,\d+\]$/, ',' + revision + ']') },
        };
        const room = Math.min(HARD.observation.maxCanonicalBytes - bytes(envelope),
            HARD.observation.maxApproxBytes - threshold(envelope, 'maxApproxBytes'));
        const firstLength = Math.floor(room / 2);
        const fill = (extra: number) => ({ ...draft, views: views.map((view, index) => ({
            ...view, content: { ...view.content, value: 'x'.repeat(index === 0 ? firstLength : room - firstLength + extra) },
        })) });
        expect(hostedObservationCapacityIssue(fill(0))).toBeUndefined();
        expect(hostedObservationCapacityIssue(fill(1))).toMatchObject({ code: 'OBSERVATION_CAPACITY', path: '$.observation' });
        expect(f.core.store.inspect().activeHolds).toBe(1);
        expect(f.registry.inspect()).toMatchObject({ observations: 1, reservations: 0 });
        zero(f);
    });
    it.each([
        { limits: { maxRefs: 1 }, path: '$.refs' },
        { limits: { maxTools: 1 }, path: '$.tools' },
        { limits: { metadata: { maxNodes: 5 } }, path: '$.metadata' },
    ])('measures installed $path limits during complete projection preparation', ({ limits, path }) => {
        const f = fixture({ views: 1, refs: 2, tools: 2, ready: false });
        const draft = f.draft();
        expect(hostedObservationCapacityIssue(draft)).toBeUndefined();
        expect(hostedObservationCapacityIssue(draft, normalizeProjectionLimits(limits, 'options.projectionLimits')))
            .toMatchObject({ code: 'OBSERVATION_CAPACITY', path });
        zero(f);
    });
    it('observes a near-limit View and rejects oversized metadata at its publication path', () => {
        const f = fixture({ views: 1, refs: 0, tools: 0, content: 'x'.repeat(500 * 1024) });
        const view = { ...f.source.views[0]!, name: 'n'.repeat(16 * 1024 - 128) };
        const source = f.publish({ views: [view] });
        const {toolBindings:_bindings,...observed}=view;
        expect(f.observe(f.grant(source,['v_1'])).views).toEqual([observed]);
        const oversized = { ...view, name: 'n'.repeat(224 * 1024) };
        expect(f.core.committer.accept(f.draft({ views: [oversized] }))).toMatchObject({
            status: 'rejected', issue: { code: 'SNAPSHOT_SERIALIZATION_ERROR', path: '$.views[0]' },
        });
        zero(f);
    });

});

describe('B1 immutable configuration and clock faults', () => {
    it('freezes every approved default profile and has no undeclared extension fields', () => {
        expect(HARD).toMatchObject({ maxViews: 256, maxRefs: 512, maxTools: 256 });
        expect(Object.isFrozen(HARD)).toBe(true); expect(Object.isFrozen(HARD.observation)).toBe(true);
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
        const p = max.begin();
        expect(p.status).toBe('reserved');
        if (p.status === 'reserved') {
            const result = max.complete(p.reservation, f.grant());
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
        const p = registry.begin(); expect(p.status).toBe('reserved'); if (p.status !== 'reserved') return;
        time = 9; expect(code(registry.begin())).toBe('OBSERVATION_INTERNAL_ERROR');
        throws = true; expect(code(registry.complete(p.reservation, f.grant()))).toBe('OBSERVATION_INTERNAL_ERROR');
        expect(registry.inspect()).toMatchObject({ reservations: 0, issue: { code: 'OBSERVATION_INTERNAL_ERROR' } });
        expect(registry.close()).toMatchObject({ closed: true }); expect(reads).toBe(0); zero(f);
    });
});

describe('B2-Q01 lifecycle identity capability', () => {
    it('requires identity capability instead of silently falling back to a legacy SnapshotStore', () => {
        const f = fixture(); const { readAppIdentity: _, ...legacy } = f.core.store;
        expect(() => createObservationRegistry(legacy as never, { namespace: 'legacy', now: f.now })).toThrow('Invalid observation registry store'); zero(f);
    });
    it('distinguishes the bound unready instance from foreign and stopped instances', () => {
        const core = createSnapshotCore({ appId: 'app', instanceId: 'first', now: () => 0 });
        const registry = createObservationRegistry(core.store, { namespace: 'first', now: () => 0 },
            { appId: 'app', instanceId: 'first' });
        const foreign = createObservationRegistry(core.store, { namespace: 'foreign', now: () => 0 },
            { appId: 'other', instanceId: 'first' });
        expect(registry.active()).toBe(true);
        expect(code(registry.begin())).toBe('SNAPSHOT_UNREADY');
        expect(foreign.active()).toBe(false);
        expect(code(foreign.begin())).toBe('APP_INTERACTION_UNAVAILABLE');
        core.lifecycle.stop();
        expect(registry.active()).toBe(false);
        expect(code(registry.begin())).toBe('APP_INTERACTION_UNAVAILABLE');
        expect(registry.close()).toMatchObject({ observationSlots: 0 });
    });
});
