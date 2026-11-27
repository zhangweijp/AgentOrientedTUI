import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DEFAULT_SNAPSHOT_LIMITS, SNAPSHOT_SCHEMA_VERSION, refKey, type PreparedAppSnapshotDraft,
    type SnapshotIssue, type RefScope, type ViewToolReceiver, type InvocationContext } from '@aotui/core';
import { createAppInteraction, createSnapshotCore } from '@aotui/core/host';
import type { SnapshotDraftEnvelope } from '@aotui/core/host';

const appId = 'd3', instanceId = 'd3-run';
const selectedKey = refKey('file', 'm:1', 'selected');
type Lanes = readonly [number, number, number];
type Frame = Readonly<{
    draft: PreparedAppSnapshotDraft;
    healthySince: number;
    continuity: Readonly<Record<string, Lanes>>;
    closeActivation: string;
}>;
type Publication = Frame & { type: 'publish'; id: string; requestId: string; kind: 'open' | 'observe';
    mode: 'authoritative' | 'candidate' };
type Reply = { type: 'reply'; id: string; kind: 'open' | 'observe'; status: 'done' | 'failed';
    publication?: SnapshotDraftEnvelope; code?: string };
type State = { type: 'state'; id: string; current: Frame | null; pending: boolean; stopped: boolean;
    faulted: boolean; entries: number; closes: number };
type Business = { type: 'business'; id: string; phase: 'entered-returned' | 'not-entered';
    entries: number; closes: number; value: string | null };
type Fault = SnapshotDraftEnvelope & { type: 'fault'; issue: SnapshotIssue };
type Packet = Publication | Reply | State | Business | Fault | { type: 'stopped'; id: string };

function stamp(frame: Frame): SnapshotDraftEnvelope {
    const { appId, instanceId, producerSeq, sourceEpoch } = frame.draft;
    return { appId, instanceId, producerSeq, sourceEpoch };
}
function equal(a: SnapshotDraftEnvelope | undefined, b: SnapshotDraftEnvelope | undefined) {
    return a !== undefined && b !== undefined && a.appId === b.appId && a.instanceId === b.instanceId &&
        a.producerSeq === b.producerSeq && a.sourceEpoch === b.sourceEpoch;
}
function nextLanes(previous: Lanes | undefined, scope: RefScope, epoch: number): Lanes {
    return [previous?.[0] || epoch, scope === 'private' ? 0 : previous?.[1] || epoch,
        scope === 'public' ? previous?.[2] || epoch : 0];
}

async function peer(run: (io: {
    send(packet: object): void;
    receive<T extends Packet['type']>(type: T): Promise<Extract<Packet, { type: T }>>;
}) => Promise<void>) {
    const child = spawn('python3', ['-u', fileURLToPath(new URL('./fixtures/d3-producer.py', import.meta.url)),
        String(SNAPSHOT_SCHEMA_VERSION)], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exit = once(child, 'close');
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const iterator = lines[Symbol.asyncIterator]();
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += String(bytes); });
    const send = (packet: object) => { child.stdin.write(JSON.stringify(packet) + '\n'); };
    async function receive<T extends Packet['type']>(type: T) {
        const line = await iterator.next();
        if (line.done) throw Error('Python peer ended: ' + stderr);
        const parsed: Packet = JSON.parse(line.value);
        expect(parsed.type).toBe(type);
        return parsed as Extract<Packet, { type: T }>;
    }
    try {
        await run({ send, receive });
        send({ type: 'exit' });
        child.stdin.end();
        expect(await exit).toEqual([0, null]);
        expect(stderr).toBe('');
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exit;
    }
}

/**
 * Candidate protocol harness, NOT a second production receiver.
 * Real Core validates and commits the v8 draft. Only the not-yet-supported
 * continuity fields and request correlation are prototyped in this test.
 * Fused candidate acceptance uses the actual Core mode-aware commit port;
 * continuity evidence still lives in this test, not the v8 wire/store.
 */
function receiver() {
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, maxViews: 2 };
    const core = createSnapshotCore({ appId, instanceId, limits });
    type Pending = { kind: 'open' | 'observe'; known?: SnapshotDraftEnvelope;
        sampled?: SnapshotDraftEnvelope; issue?: SnapshotIssue; expired: boolean };
    const pending = new Map<string, Pending>();
    let accepted: Frame | undefined;
    let stopped = false;
    function begin(id: string, kind: Pending['kind']) {
        if (pending.has(id)) throw Error('Duplicate request id');
        const known = core.currentPublication();
        pending.set(id, { kind, ...(known ? { known } : {}), expired: false });
    }
    function accept(frame: Publication) {
        if (stopped) throw Error('Receiver stopped');
        const request = pending.get(frame.requestId);
        expect(request?.kind).toBe(frame.kind);
        const source = stamp(frame), prior = accepted && stamp(accepted);
        expect(source.appId).toBe(appId);
        expect(source.instanceId).toBe(instanceId);
        expect(source.sourceEpoch).toBeGreaterThan(prior?.sourceEpoch ?? 0);
        expect(source.producerSeq).toBeGreaterThan(prior?.producerSeq ?? 0);
        // Validate explicit witness against last actually accepted producer epoch,
        // NOT the epoch of a rejected frame or a reset inferred from Receiver health.
        const healthy = accepted?.healthySince === frame.healthySince;
        expect(Number.isSafeInteger(frame.healthySince)).toBe(true);
        expect(frame.healthySince).toBeGreaterThanOrEqual(accepted?.healthySince ?? 1);
        expect(frame.healthySince).toBeLessThanOrEqual(source.sourceEpoch);
        for (const [key, ref] of Object.entries(frame.draft.refs)) {
            const starts = frame.continuity[key];
            expect(starts).toHaveLength(3);
            const previous = healthy ? accepted?.continuity[key] : undefined;
            for (const [i, start] of starts!.entries()) {
                const permitted = i === 0 || i === 1 && ref.scope !== 'private' || i === 2 && ref.scope === 'public';
                expect(Number.isSafeInteger(start)).toBe(true);
                if (!permitted) { expect(start).toBe(0); continue; }
                expect(start).toBeGreaterThanOrEqual(frame.healthySince);
                expect(start).toBeLessThanOrEqual(source.sourceEpoch);
                if (!previous?.[i] || start !== previous[i]) {
                    expect(start).toBeGreaterThan(prior?.sourceEpoch ?? 0);
                }
            }
        }
        const result = core.committer.accept(frame.draft, frame.mode);
        if (result.status === 'rejected') { request!.issue = result.issue; return result; }
        // Only after the real accept may the companion test-only witness be installed.
        accepted = frame;
        request!.sampled = source;
        expect(core.currentPublication()).toEqual(source);
        return result;
    }
    function reply(packet: Reply) {
        const request = pending.get(packet.id);
        if (!request || request.kind !== packet.kind) return 'unmatched';
        pending.delete(packet.id);
        if (request.expired) return 'expired';
        if (stopped || packet.status !== 'done' || !equal(packet.publication, request.sampled ?? request.known) ||
            !equal(packet.publication, core.currentPublication())) return request.issue?.code ?? packet.code ?? 'rejected';
        return 'accepted';
    }
    return { core, begin, accept, reply,
        get accepted() { return accepted; },
        expire(id: string) { pending.get(id)!.expired = true; },
        has(id: string) { return pending.has(id); },
        fault(packet: Fault) { return core.committer.reportPrepareFailure(packet); },
        stop() { stopped = true; core.lifecycle.stop(); },
    };
}
function publish(id: string, value: string, options: object = {}) {
    return { type: 'publish', id: 'pub-' + id, requestId: id, kind: id === 'open' ? 'open' : 'observe', value, ...options };
}
const toolReceiver = (n: number): ViewToolReceiver => ({ viewId: 'reader', viewInstanceId: 'm:2', activationId: 'a:' + (2 * n - 1) });
const closeReceiver = (n: number): ViewToolReceiver => ({ ...toolReceiver(n), activationId: 'a:' + (2 * n) });

it('D3 authoritative publish precedes correlated done without waiting for ACK; actual capacity rejection cannot become success', async () => {
    await peer(async ({ send, receive }) => {
        const rx = receiver();
        try {
            rx.begin('open', 'open');
            send(publish('open', 'A'));
            const first = await receive('publish');
            expect(rx.accept(first).status).toBe('published');
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            const before = rx.core.currentPublication();
            rx.begin('refresh', 'observe');
            send({ type: 'observe', id: 'refresh' });
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            expect(rx.core.currentPublication()).toEqual(before);
            rx.begin('overflow', 'observe');
            send(publish('overflow', 'B', { overCapacity: true }));
            const rejected = rx.accept(await receive('publish'));
            expect(rejected).toMatchObject({ status: 'rejected', issue: { code: 'SNAPSHOT_INVALID', path: '$.views' } });
            expect(rx.reply(await receive('reply'))).toBe('SNAPSHOT_INVALID');
            expect(rx.core.store.readLatest(appId)).toMatchObject({ status: 'degraded', issue: { path: '$.views' } });
            expect(rx.core.currentPublication()).toBeUndefined();
            send({ type: 'inspect', id: 'state' });
            expect((await receive('state')).current?.draft.sourceEpoch).toBe(2);
        } finally { rx.core.lifecycle.dispose(); }
    });
});

it('D3 old/wrong/expired replies never complete a new request or change current actual acceptance; fault and stop invalidate samples', async () => {
    await peer(async ({ send, receive }) => {
        const rx = receiver();
        try {
            rx.begin('open', 'open');
            send(publish('open', 'A'));
            const old = await receive('publish');
            rx.accept(old);
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            rx.begin('old-waiter', 'observe');
            rx.expire('old-waiter');
            rx.begin('new-frame', 'observe');
            send(publish('new-frame', 'B'));
            const fresh = await receive('publish');
            rx.accept(fresh);
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            rx.begin('current', 'observe');
            send({ type: 'staleReply', id: 'unknown', kind: 'observe', publication: stamp(fresh) });
            expect(rx.reply(await receive('reply'))).toBe('unmatched');
            send({ type: 'staleReply', id: 'current', kind: 'open', publication: stamp(fresh) });
            expect(rx.reply(await receive('reply'))).toBe('unmatched');
            expect(rx.has('current')).toBe(true);
            send({ type: 'staleReply', id: 'old-waiter', kind: 'observe', publication: stamp(old) });
            expect(rx.reply(await receive('reply'))).toBe('expired');
            expect(rx.has('current')).toBe(true);
            send({ type: 'staleReply', id: 'current', kind: 'observe', publication: stamp(old) });
            expect(rx.reply(await receive('reply'))).toBe('rejected');
            expect(rx.core.currentPublication()).toEqual(stamp(fresh));
            for (const field of ['appId', 'instanceId', 'producerSeq', 'sourceEpoch'] as const) {
                rx.begin('wrong-' + field, 'observe');
                const wrong = { ...stamp(fresh), [field]: typeof stamp(fresh)[field] === 'string' ? 'foreign' : 999 };
                send({ type: 'staleReply', id: 'wrong-' + field, kind: 'observe', publication: wrong });
                expect(rx.reply(await receive('reply'))).toBe('rejected');
            }
            rx.begin('fault-wait', 'observe');
            send({ type: 'fault' });
            rx.fault(await receive('fault'));
            send({ type: 'staleReply', id: 'fault-wait', kind: 'observe', publication: stamp(fresh) });
            expect(rx.reply(await receive('reply'))).toBe('rejected');
            send({ type: 'invoke', id: 'old-tool', receiver: toolReceiver(1) });
            expect(await receive('business')).toMatchObject({ phase: 'not-entered', entries: 0 });
            send({ type: 'closeView', id: 'old-close', receiver: closeReceiver(1) });
            expect(await receive('business')).toMatchObject({ phase: 'not-entered', closes: 0 });
            rx.begin('repair', 'observe');
            send(publish('repair', 'C', { activation: 3 }));
            const repair = await receive('publish');
            expect(rx.accept(repair).status).toBe('published');
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            rx.begin('stop-wait', 'observe');
            rx.stop();
            send({ type: 'stop', id: 'stop' });
            await receive('stopped');
            send({ type: 'staleReply', id: 'stop-wait', kind: 'observe', publication: stamp(repair) });
            expect(rx.reply(await receive('reply'))).toBe('rejected');
            expect(rx.core.store.readLatest(appId).status).toBe('stopped');
        } finally { rx.core.lifecycle.dispose(); }
    });
});

it('D3 candidate keeps old local state until exact acceptance; handles interleaved observe, invoke, close and STOP', async () => {
    await peer(async ({ send, receive }) => {
        const rx = receiver();
        try {
            rx.begin('open', 'open');
            send(publish('open', 'A'));
            const first = await receive('publish');
            rx.accept(first);
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            rx.begin('reject', 'observe');
            send(publish('reject', 'B', { mode: 'candidate', overCapacity: true, activation: 2 }));
            const bad = await receive('publish');
            expect(rx.accept(bad)).toMatchObject({ status: 'rejected', issue: { path: '$.views' } });
            send({ type: 'publishResult', id: bad.id, publication: stamp(bad), status: 'rejected' });
            expect(rx.reply(await receive('reply'))).toBe('SNAPSHOT_INVALID');
            expect(rx.core.currentPublication()).toEqual(stamp(first));
            rx.begin('candidate', 'observe');
            send(publish('candidate', 'B', { mode: 'candidate', activation: 2 }));
            const candidate = await receive('publish');
            expect(candidate.draft.sourceEpoch).toBe(2);
            // Candidate waiting is not an ACK-read lock; sample the old frame before actual accept.
            rx.begin('during', 'observe');
            send({ type: 'observe', id: 'during' });
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            send({ type: 'invoke', id: 'before-ack-new', receiver: toolReceiver(2) });
            expect(await receive('business')).toMatchObject({ phase: 'not-entered', entries: 0 });
            send({ type: 'closeView', id: 'before-ack-close', receiver: closeReceiver(2) });
            expect(await receive('business')).toMatchObject({ phase: 'not-entered', closes: 0 });
            send({ type: 'invoke', id: 'before-ack-old', receiver: toolReceiver(1) });
            expect(await receive('business')).toMatchObject({ phase: 'entered-returned', entries: 1 });
            expect(rx.accept(candidate).status).toBe('published');
            send({ type: 'publishResult', id: 'wrong', publication: stamp(candidate), status: 'accepted' });
            send({ type: 'publishResult', id: candidate.id, publication: stamp(first), status: 'accepted' });
            send({ type: 'inspect', id: 'inspect' });
            const waiting = await receive('state');
            expect(waiting.pending).toBe(true);
            expect(waiting.current?.draft.sourceEpoch).toBe(1);
            send({ type: 'publishResult', id: candidate.id, publication: stamp(candidate), status: 'accepted' });
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            send({ type: 'invoke', id: 'after-ack-old', receiver: toolReceiver(1) });
            expect(await receive('business')).toMatchObject({ phase: 'not-entered', entries: 1 });
            send({ type: 'closeView', id: 'after-ack-new', receiver: closeReceiver(2) });
            expect(await receive('business')).toMatchObject({ phase: 'entered-returned', closes: 1 });
            rx.begin('stopped-candidate', 'observe');
            send(publish('stopped-candidate', 'C', { mode: 'candidate', activation: 3 }));
            const later = await receive('publish');
            expect(rx.accept(later).status).toBe('published');
            rx.stop();
            send({ type: 'stop', id: 'stop' });
            await receive('stopped');
            send({ type: 'publishResult', id: later.id, publication: stamp(later), status: 'accepted' });
            expect(rx.reply(await receive('reply'))).toBe('APP_STOPPED');
            send({ type: 'inspect', id: 'after-stop' });
            expect(await receive('state')).toMatchObject({ pending: false, stopped: true,
                current: { draft: { sourceEpoch: 2 } }, entries: 1, closes: 1 });
        } finally { rx.core.lifecycle.dispose(); }
    });
});

it('D3 E2 Receiver-only rejection → E3 recovery: explicit producer lanes survive; accepted-only derivation loses an unobserved scope transition', async () => {
    await peer(async ({ send, receive }) => {
        const rx = receiver();
        let interaction: ReturnType<typeof createAppInteraction> | undefined;
        try {
            rx.begin('open', 'open');
            send(publish('open', 'A'));
            const first = await receive('publish');
            expect(rx.accept(first).status).toBe('published');
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            rx.begin('e2', 'observe');
            send(publish('e2', 'B', { scope: 'private', overCapacity: true }));
            const e2 = await receive('publish');
            expect(e2.continuity[selectedKey]).toEqual([1, 0, 0]);
            expect(rx.accept(e2).status).toBe('rejected');
            expect(rx.reply(await receive('reply'))).toBe('SNAPSHOT_INVALID');
            rx.begin('e3', 'observe');
            send(publish('e3', 'C'));
            const e3 = await receive('publish');
            expect(e3.healthySince).toBe(1);
            expect(rx.accept(e3).status).toBe('published');
            expect(rx.reply(await receive('reply'))).toBe('accepted');
            const derived = nextLanes(first.continuity[selectedKey], 'public', 3);
            const explicit = e3.continuity[selectedKey]!;
            expect(derived).toEqual([1, 1, 1]);
            expect(explicit).toEqual([1, 3, 3]);
            // Use actual Core observation, adoption, Ref resolution, policy and invocation.
            // The wire since field below is prototype-only until LocalRefUse is migrated.
            const binding = { identity: {}, isLive: () => true,
                async execute(context: InvocationContext) {
                    expect(context.refSources).toHaveLength(1);
                    const ref = context.refSources[0]!;
                    const key = refKey(ref.viewId, ref.viewInstanceId, ref.refId);
                    expect(ref.value).toBe('C');
                    expect(context.source.receiver).toEqual(toolReceiver(1));
                    const selected = rx.accepted!.continuity[key]!;
                    const lane = ref.viewInstanceId === context.source.receiver.viewInstanceId ? 0 : 1;
                    expect(lane).toBe(1);
                    expect(selected[lane]).toBe(3);
                    send({ type: 'invoke', id: 'from-core', receiver: context.source.receiver,
                        input: context.effectiveInput, localRefs: [{ viewId: ref.viewId, viewInstanceId: ref.viewInstanceId,
                            refId: ref.refId, since: selected[lane] }] });
                    const result = await receive('business');
                    expect(result).toMatchObject({ phase: 'entered-returned', value: 'C', entries: 1 });
                    return { kind: 'tool-result' as const, phase: 'entered-returned' as const, result: { success: true } };
                } };
            interaction = createAppInteraction(rx.core.store, { appId, instanceId, namespace: 'd3-prototype', now: Date.now,
                policy: { project: ({ source }) => ({ toolIds: Object.keys(source.tools),
                    refs: Object.values(source.refs).map(ref => ({ viewId: ref.ownerViewId, viewInstanceId: ref.ownerViewInstanceId, refId: ref.id })) }),
                    authorize: () => true, canReadReceipt: () => true },
                execution: { resolve: () => binding } });
            const observed = await interaction.observe();
            if (observed.status !== 'observed') throw Error(observed.issue.code);
            expect(interaction.adoptObservation(observed.observation.observationId).status).toBe('adopted');
            expect(await interaction.invoke({ observationId: observed.observation.observationId, invocationId: 'read-C',
                toolId: observed.observation.tools[0]!.id, input: { text: '$ref.d3.file.selected' } }))
                .toMatchObject({ kind: 'receipt', receipt: { outcome: { status: 'succeeded' } } });
            // Counterfactual wire using only accepted snapshots would send 1, not 3.
            send({ type: 'invoke', id: 'derived-only', receiver: toolReceiver(1), input: { text: 'C' },
                localRefs: [{ viewId: 'file', viewInstanceId: 'm:1', refId: 'selected', since: derived[1] }] });
            expect(await receive('business')).toMatchObject({ phase: 'not-entered', entries: 1 });
            send({ type: 'inspect', id: 'inspect' });
            expect(await receive('state')).toMatchObject({ entries: 1, current: { continuity: { [selectedKey]: [1, 3, 3] } } });
        } finally {
            interaction?.close();
            await interaction?.whenClosed();
            rx.core.lifecycle.dispose();
        }
    });
});
