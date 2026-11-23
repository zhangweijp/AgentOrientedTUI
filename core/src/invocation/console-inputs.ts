import { copyJson } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { parseRefAddress, pathStartsWith, readRefPath, type RefAddress } from '../tool/ref-parameters.js';
import type { ConsoleInputPath, ConsoleInputs, Issue } from './app-interaction-types.js';
import type { ObservedRef } from './observation-types.js';
import { programRefSchema } from './program-ref-schema.js';
import type { RefSourceHold } from './request-sources.js';

const limits = { maxDepth: 40, maxNodes: 12_000, maxApproxBytes: 128 * 1024 };
const maxPaths = 256;
const hidden: Issue = { code: 'CONSOLE_REF_UNAVAILABLE', message: 'Choose a public Ref path granted to Console in this request.' };
const capacity: Issue = { code: 'CONSOLE_INPUT_CAPACITY', message: 'Console inputs exceed the limit. Supply a smaller imports list.' };
const rejected = (issue: Issue): ConsoleInputs => Object.freeze({ status: 'rejected', issue: Object.freeze(issue) });
const refKey = (viewId: string, refId: string) => JSON.stringify([viewId, refId]);

/** Read only Console grants from the selected, still-adopted original observations. */
export function readConsoleInputs(apps: ReadonlyMap<string, { readonly consoleRefs: readonly ObservedRef[] }>,
    acquire: (appId: string) => RefSourceHold | { issue: Issue } | undefined, imports?: readonly string[]): ConsoleInputs {
    const selected = new Map<string, RefAddress[]>();
    if (imports === undefined) {
        for (const [appId, { consoleRefs }] of apps) {
            const paths = consoleRefs.flatMap(({ viewId, refId, programPaths }) =>
                (programPaths ?? []).map(({ path }) => ({ appId, viewId, refId, path })));
            if (paths.length) selected.set(appId, paths);
        }
    } else {
        if (!Array.isArray(imports) || imports.length > maxPaths) return rejected(capacity);
        for (const [index, input] of imports.entries()) {
            const address = typeof input === 'string' ? parseRefAddress(input) : undefined;
            if (!address) return rejected({ ...hidden, path: `$.imports[${index}]` });
            const group = selected.get(address.appId) ?? [];
            group.push(address);
            selected.set(address.appId, group);
        }
    }
    type Value = { readonly entry: ConsoleInputPath; readonly value: JsonValue };
    const values = new Map<string, Value[]>();
    let count = 0;
    for (const [appId, paths] of selected) {
        const planned = apps.get(appId);
        if (!planned) return rejected(hidden);
        const hold = acquire(appId);
        if (!hold || 'issue' in hold) return rejected(hidden);
        try {
            const current = hold.current();
            if (!current) return rejected(hidden);
            const visible = new Map(planned.consoleRefs.map(ref => [refKey(ref.viewId, ref.refId), ref]));
            const currentRefs = new Map(Object.values(current.refs).map(ref => [refKey(ref.ownerViewId, ref.id), ref]));
            for (const { viewId, refId, path } of paths) {
                const key = refKey(viewId, refId), original = visible.get(key), live = currentRefs.get(key);
                const granted = original?.programPaths?.find(entry => pathStartsWith(path, entry.path));
                if (!original || !granted || live?.scope !== 'public' || live.ownerViewInstanceId !== original.viewInstanceId ||
                    !hold.isRefView(viewId, original.viewInstanceId)) return rejected(hidden);
                const resolved = hold.source.store.resolveRef({ appId, viewId, refId, viewInstanceId: original.viewInstanceId,
                    instanceId: hold.source.instanceId, snapshotId: hold.source.snapshotId });
                if (resolved.status === 'rejected' || resolved.ref.scope !== 'public') return rejected(hidden);
                const value = readRefPath(resolved.target.payload, path);
                if (!value.found) return rejected(hidden);
                if (++count > maxPaths) return rejected(capacity);
                const schema = programRefSchema(granted.schema, path.slice(granted.path.length));
                const groupId = JSON.stringify([appId, viewId, refId]);
                const group = values.get(groupId) ?? [];
                group.push({ entry: { appId, viewId, refId, path, ...(schema === undefined ? {} : { schema }) }, value: value.value });
                values.set(groupId, group);
            }
        } finally { hold.release(); }
    }
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
    try { return copyJson({ status: 'ready', refs, paths }, limits) as unknown as ConsoleInputs; }
    catch { return rejected(capacity); }
}
