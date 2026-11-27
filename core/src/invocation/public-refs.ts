import { copyWireJson } from '../snapshot/json.js';
import { refKey } from '../snapshot/snapshot-support.js';
import { currentPublishedSnapshot } from '../snapshot/store.js';
import { parseRefAddress } from '../tool/ref-parameters.js';
import { readRefPath, type RefAddress } from '../tool/ref-path.js';
import type { InspectRefMode, InspectRefResult, Issue, PublicRefValue, ReadPublicRefsResult } from './app-interaction-types.js';
import type { ObservedRef } from './observation-types.js';
import { declaredRefSchema } from './ref-schema.js';
import type { RefSourceHold } from './request-sources.js';

const limits = { maxDepth: 40, maxNodes: 12_000, maxCanonicalBytes: 128 * 1024 };
const maxPaths = 256;
const hidden: Issue = Object.freeze({ code: 'REF_NOT_VISIBLE', message: 'Choose a published Ref from an open page in this request.' });
const capacity: Issue = Object.freeze({ code: 'REF_READ_CAPACITY', message: 'Public Ref reads exceed the limit. Supply fewer addresses.' });
const rejected = (issue: Issue) => Object.freeze({ status: 'rejected' as const, issue: Object.freeze(issue) });

type VisibleApps = ReadonlyMap<string, { readonly visibleRefs: readonly ObservedRef[] }>;
type AcquireSource = (appId: string) => RefSourceHold | { issue: Issue } | undefined;

function invalidAddresses(index?: number) {
    return rejected(index === undefined ? {
        code: 'REF_INSPECTION_INVALID', message: 'Supply an array of complete $ref.app_id.view_id.ref_id addresses.',
    } : {
        code: 'REF_INSPECTION_INVALID', message: 'Supply a complete $ref.app_id.view_id.ref_id address.',
        path: '$.addresses[' + index + ']',
    });
}

function selectedRef(hold: RefSourceHold, refs: readonly ObservedRef[], address: RefAddress, mode: InspectRefMode) {
    const visible = refs.find(ref => ref.viewId === address.viewId && ref.refId === address.refId);
    if (!visible || !hold.isRefView(visible.viewId, visible.viewInstanceId)) return rejected(hidden);
    const key = refKey(visible.viewId, visible.viewInstanceId, visible.refId);
    // A different App's read adapter can publish while the batch checks its sources.
    const current = currentPublishedSnapshot(hold.snapshot);
    if (!current || current.admissionSinceRevision !== hold.snapshot.admissionSinceRevision) return rejected(hidden);
    const original = hold.snapshot.refs[key], live = current.refs[key];
    if (!original || !live || original.continuity[0] !== live.continuity[0]) return rejected(hidden);
    if (mode === 'schema') {
        const schema = declaredRefSchema(original.valueSchema, address.path);
        return schema === undefined ? rejected(hidden) : Object.freeze({ status: 'ready' as const, schema });
    }
    if (original.scope !== 'public' || live.scope !== 'public') return rejected({
        code: 'REF_VALUE_PRIVATE', message: 'Only a visible public Ref can be read directly. Pass a private or protected address to an authorized page.',
    });
    if (original.continuity[2] !== live.continuity[2]) return rejected(hidden);
    const value = readRefPath(original.target.payload, address.path);
    return value.found ? Object.freeze({ status: 'ready' as const, value: value.value }) : rejected(hidden);
}

export async function inspectTurnRef(apps: VisibleApps, acquire: AcquireSource, address: string, mode: InspectRefMode): Promise<InspectRefResult> {
    const parsed = typeof address === 'string' && parseRefAddress(address);
    if (!parsed || (mode !== 'schema' && mode !== 'value')) return rejected({
        code: 'REF_INSPECTION_INVALID', message: 'Supply a complete $ref.app_id.view_id.ref_id address and schema or value mode.',
    });
    const visible = apps.get(parsed.appId);
    if (!visible) return rejected(hidden);
    const hold = acquire(parsed.appId);
    if (!hold || 'issue' in hold) return rejected(hidden);
    try {
        if (hold.refresh) await hold.refresh();
        return hold.current() ? selectedRef(hold, visible.visibleRefs, parsed, mode) : rejected(hidden);
    } catch { return rejected(hidden); }
    finally { hold.release(); }
}

export async function readTurnPublicRefs(apps: VisibleApps, acquire: AcquireSource, addresses?: readonly string[]): Promise<ReadPublicRefsResult> {
    const requested: RefAddress[] = [];
    if (addresses === undefined) {
        for (const [appId, { visibleRefs }] of apps) {
            for (const ref of visibleRefs) {
                if (ref.scope !== 'public') continue;
                requested.push({ appId, viewId: ref.viewId, refId: ref.refId, path: [] });
                if (requested.length > maxPaths) return rejected(capacity);
            }
        }
    } else {
        let index: number | undefined;
        try {
            if (!Array.isArray(addresses)) return invalidAddresses();
            const length: unknown = Object.getOwnPropertyDescriptor(addresses, 'length')?.value;
            if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return invalidAddresses();
            if (length > maxPaths) return rejected(capacity);
            for (index = 0; index < length; index++) {
                const descriptor = Object.getOwnPropertyDescriptor(addresses, String(index));
                const address = descriptor?.enumerable && 'value' in descriptor && typeof descriptor.value === 'string'
                    ? parseRefAddress(descriptor.value) : undefined;
                if (!address) return invalidAddresses(index);
                requested.push(address);
            }
        } catch { return invalidAddresses(index); }
    }
    if (!requested.length) return Object.freeze({ status: 'ready' as const, refs: Object.freeze([]) });

    const holds = new Map<string, RefSourceHold>();
    const refs: PublicRefValue[] = [];
    try {
        for (const address of requested) {
            if (holds.has(address.appId)) continue;
            if (!apps.has(address.appId)) return rejected(hidden);
            const hold = acquire(address.appId);
            if (!hold || 'issue' in hold) return rejected(hidden);
            holds.set(address.appId, hold);
        }
        if (holds.size) {
            try { await Promise.all([...holds.values()].map(hold => hold.refresh?.())); }
            catch { return rejected(hidden); }
        }
        for (const hold of holds.values()) if (!hold.current()) return rejected(hidden);
        const seen = new Set<string>();
        for (const address of requested) {
            const planned = apps.get(address.appId);
            const hold = holds.get(address.appId);
            if (!planned || !hold) return rejected(hidden);
            const result = selectedRef(hold, planned.visibleRefs, address, 'value');
            if (result.status === 'rejected') return result;
            if (!('value' in result)) return rejected(hidden);
            const dedupKey = JSON.stringify([address.appId, address.viewId, address.refId, ...address.path]);
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            refs.push({
                appId: address.appId,
                viewId: address.viewId,
                refId: address.refId,
                path: address.path,
                value: result.value,
            });
        }
    } finally {
        for (const hold of holds.values()) {
            try { hold.release(); } catch { /* Other holds still need release. */ }
        }
    }
    try { return copyWireJson({ status: 'ready', refs }, limits) as unknown as ReadPublicRefsResult; }
    catch { return rejected(capacity); }
}
