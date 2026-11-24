import { copyWireJson } from '../snapshot/json.js';
import { refKey } from '../snapshot/snapshot-support.js';
import type { AppSnapshot, JsonValue } from '../snapshot/types.js';
import { parseRefAddress } from '../tool/ref-parameters.js';
import { pathStartsWith, readRefPath, type RefAddress } from '../tool/ref-path.js';
import type { ConsoleInputPath, ConsoleInputs, InspectRefMode, InspectRefResult, Issue } from './app-interaction-types.js';
import type { ObservedRef } from './observation-types.js';
import { declaredRefSchema } from './ref-schema.js';
import type { RefSourceHold } from './request-sources.js';

const limits = { maxDepth: 40, maxNodes: 12_000, maxCanonicalBytes: 128 * 1024 };
const maxPaths = 256;
const hidden: Issue = Object.freeze({ code: 'REF_NOT_VISIBLE', message: 'Choose a published Ref from an open page in this request.' });
const capacity: Issue = Object.freeze({ code: 'CONSOLE_INPUT_CAPACITY', message: 'Console inputs exceed the limit. Supply a smaller imports list.' });
const rejected = (issue: Issue) => Object.freeze({ status: 'rejected' as const, issue: Object.freeze(issue) });

type VisibleApps = ReadonlyMap<string, { readonly visibleRefs: readonly ObservedRef[] }>;
type AcquireSource = (appId: string) => RefSourceHold | { issue: Issue } | undefined;

function selectedRef(hold: RefSourceHold, current: AppSnapshot, refs: readonly ObservedRef[], address: RefAddress, mode: InspectRefMode) {
    const visible = refs.find(ref => ref.viewId === address.viewId && ref.refId === address.refId);
    if (!visible || !hold.isRefView(visible.viewId, visible.viewInstanceId)) return rejected(hidden);
    const key = refKey(visible.viewId, visible.viewInstanceId, visible.refId);
    const original = hold.snapshot.refs[key], live = current.refs[key];
    if (!original || !live) return rejected(hidden);
    if (mode === 'schema') {
        const schema = declaredRefSchema(original.valueSchema, address.path);
        return schema === undefined ? rejected(hidden) : Object.freeze({ status: 'ready' as const, schema });
    }
    if (original.scope !== 'public' || live.scope !== 'public') return rejected({
        code: 'REF_VALUE_PRIVATE', message: 'Only a visible public Ref can be read directly. Pass a private or protected address to an authorized page.',
    });
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
        const latest = hold.current();
        return latest ? selectedRef(hold, latest, visible.visibleRefs, parsed, mode) : rejected(hidden);
    } catch { return rejected(hidden); }
    finally { hold.release(); }
}

export async function readConsoleInputs(apps: VisibleApps, acquire: AcquireSource, imports?: readonly string[]): Promise<ConsoleInputs> {
    const selected = new Map<string, RefAddress[]>();
    if (imports === undefined) {
        for (const [appId, { visibleRefs }] of apps) {
            const paths = visibleRefs.filter(ref => ref.scope === 'public')
                .map(({ viewId, refId }) => ({ appId, viewId, refId, path: [] }));
            if (paths.length) selected.set(appId, paths);
        }
    } else {
        if (!Array.isArray(imports) || imports.length > maxPaths) return rejected(capacity);
        for (const [index, input] of imports.entries()) {
            const address = typeof input === 'string' ? parseRefAddress(input) : undefined;
            if (!address) return rejected({ code: 'REF_INSPECTION_INVALID',
                message: 'Supply a complete $ref.app_id.view_id.ref_id address.', path: '$.imports[' + index + ']' });
            const group = selected.get(address.appId) ?? [];
            group.push(address);
            selected.set(address.appId, group);
        }
    }
    type Value = { readonly entry: ConsoleInputPath; readonly value: JsonValue };
    const values = new Map<string, Value[]>();
    const holds = new Map<string, RefSourceHold>();
    try {
        for (const appId of selected.keys()) {
            if (!apps.has(appId)) return rejected(hidden);
            const hold = acquire(appId);
            if (!hold || 'issue' in hold) return rejected(hidden);
            holds.set(appId, hold);
        }
        if (holds.size) {
            try { await Promise.all([...holds.values()].map(hold => hold.refresh?.())); }
            catch { return rejected(hidden); }
        }
        let count = 0;
        for (const [appId, paths] of selected) {
            const planned = apps.get(appId);
            if (!planned) return rejected(hidden);
            const hold = holds.get(appId)!;
            const current = hold.current();
            if (!current) return rejected(hidden);
            for (const address of paths) {
                const result = selectedRef(hold, current, planned.visibleRefs, address, 'value');
                if (result.status === 'rejected') return result;
                if (!('value' in result)) return rejected(hidden);
                if (++count > maxPaths) return rejected(capacity);
                const { viewId, refId } = address;
                const groupId = JSON.stringify([appId, viewId, refId]);
                const group = values.get(groupId) ?? [];
                group.push({ entry: address, value: result.value });
                values.set(groupId, group);
            }
        }
    } finally { for (const hold of holds.values()) hold.release(); }
    type Root = Record<string, JsonValue>;
    const refs: Root = Object.create(null);
    const paths: ConsoleInputPath[] = [];
    for (const group of values.values()) {
        const roots: ConsoleInputPath[] = [];
        for (const { entry, value } of group.sort((a, b) => a.entry.path.length - b.entry.path.length)) {
            if (roots.some(root => pathStartsWith(entry.path, root.path))) continue;
            roots.push(entry);
            paths.push(entry);
            const location = [entry.appId, entry.viewId, entry.refId, ...entry.path.map(String)];
            const leaf = location.pop()!;
            let parent = refs;
            for (const key of location) parent = (parent[key] ??= Object.create(null)) as Root;
            parent[leaf] = value;
        }
    }
    try { return copyWireJson({ status: 'ready', refs, paths }, limits) as unknown as ConsoleInputs; }
    catch { return rejected(capacity); }
}
