import { canonicalJson, copyJson, utf8Size, type JsonCopyLimits } from '../snapshot/json.js';
import { SNAPSHOT_SCHEMA_VERSION, type JsonValue, type RefScope, type SnapshotStore, type ViewToolReceiver } from '../snapshot/types.js';
import type { ToolParameterContract } from './tool-parameters.js';
import type { InvocationSource, Issue } from '../invocation/app-interaction-types.js';
import type { RefConsumer, RefGrant } from '../invocation/observation-types.js';
import { decodeRefParameters, isArrayElementPath, parseRefAddress, pathStartsWith, readRefPath, refPath, scopeAllows,
    type RefAddress, type RefSlot } from './ref-parameters.js';
import { RAW_TOOL_ARGUMENT_LIMITS as RAW, RESOLVED_TOOL_ARGUMENT_LIMITS as ARGUMENTS,
    RESOLVED_TOOL_ENVELOPE_LIMITS as ENVELOPE, refKey, snapshotId } from '../snapshot/snapshot-support.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type Rejected = Readonly<{ status: 'rejected'; issue: Issue }>;
export interface RefArgumentSource {
    readonly appId: string;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly observationId: string;
    readonly visibleRefs: readonly RefGrant[];
    readonly store: Pick<SnapshotStore, 'resolveRef'>;
}
export interface SnapshotValueRefSource extends RefAddress {
    readonly param: string;
    readonly index?: number;
    readonly address: string;
    readonly kind: 'snapshot-value';
    readonly refType?: string;
    readonly arrayElement?: true;
    readonly scope: RefScope;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly observationId: string;
    readonly viewInstanceId: string;
    readonly consumerInstanceId: string;
    readonly consumerObservationId: string;
    readonly consumerViewInstanceId: string;
    readonly consumerActivationId: string;
    readonly value: JsonValue;
}
type InvocationBinding = Readonly<{
    appId: string; instanceId: string; snapshotId: string; observationId: string; receiver: ViewToolReceiver;
}>;

export function checkRefViews(sources: readonly SnapshotValueRefSource[],
    isLive: (viewId: string, viewInstanceId: string) => boolean) {
    for (const { param, index, viewId, viewInstanceId } of sources) {
        if (!isLive(viewId, viewInstanceId)) return { code: 'REF_VIEW_UNAVAILABLE',
            message: 'The original View is closed or was reopened. Choose a Ref from a current observation.', path: refPath(param, index) };
    }
}

/** Resolve selected slots in the retained original observation, independently of the receiver. */
export function prepareViewTypeParameters(
    store: SnapshotStore, source: InvocationSource, contract: ToolParameterContract, input: JsonObject,
    visibleRefs: readonly RefGrant[], observationId: string,
    external?: (appId: string) => RefArgumentSource | { issue: Issue } | undefined,
) {
    const indexes = new Map<string, { origin: RefArgumentSource; refs: Map<string, RefGrant | null> }>();
    const own = { ...source, observationId, visibleRefs, store };
    const receiver: RefConsumer = { appId: source.appId, instanceId: source.instanceId,
        viewId: source.receiver.viewId, viewInstanceId: source.receiver.viewInstanceId };
    function forApp(appId: string, slot: RefSlot) {
        const existing = indexes.get(appId);
        if (existing) return existing;
        const origin = appId === source.appId ? own : external?.(appId);
        if (!origin) fail('REF_NOT_VISIBLE', 'Choose a Ref from an App in this request.', slot);
        if ('issue' in origin) fail(origin.issue.code, origin.issue.message, slot);
        const refs = new Map<string, RefGrant | null>();
        for (const ref of origin.visibleRefs) {
            const key = JSON.stringify([ref.viewId, ref.refId]);
            refs.set(key, refs.has(key) ? null : ref);
        }
        const indexed = { origin, refs };
        indexes.set(appId, indexed);
        return indexed;
    }
    const refSources: SnapshotValueRefSource[] = [];
    const result = bindParameters(contract, input, (slot, address) => {
        const { appId, viewId, refId, path } = address;
        const { origin, refs } = forApp(appId, slot);
        const owner = refs.get(JSON.stringify([viewId, refId]));
        if (owner === null) fail('REF_TARGET_UNSUPPORTED', 'The address does not identify a unique Ref.', slot);
        if (!owner || (owner.paths !== undefined && !owner.paths.some(grant => {
            const target = grant.consumer;
            return pathStartsWith(path, grant.path) && (!target || (target !== 'console' && target.appId === receiver.appId &&
                target.instanceId === receiver.instanceId && target.viewId === receiver.viewId &&
                target.viewInstanceId === receiver.viewInstanceId));
        }))) fail('REF_NOT_VISIBLE', 'Choose a Ref path granted to the receiving View in this observation.', slot);
        const resolved = origin.store.resolveRef({ appId: origin.appId, instanceId: origin.instanceId,
            snapshotId: origin.snapshotId, refId, viewId, viewInstanceId: owner.viewInstanceId });
        if (resolved.status === 'rejected') fail(resolved.issue.code, 'Original Ref source is unavailable.', slot);
        const { scope, refType, array } = resolved.ref;
        if (!scopeAllows(scope, owner.viewInstanceId, source.receiver.viewInstanceId,
            appId === source.appId && origin.instanceId === source.instanceId))
            fail('TOOL_PERMISSION_DENIED', 'This Ref does not grant access to the receiving View.', slot);
        const selected = readRefPath(resolved.target.payload, path);
        if (!selected.found) fail('REF_TARGET_UNSUPPORTED', 'Ref path segment ' + (selected.segment + 1) + ' ' + selected.reason + '.', slot);
        const arrayElement = array && isArrayElementPath(path);
        const record: SnapshotValueRefSource = {
            ...address, param: slot.param, ...(slot.index === undefined ? {} : { index: slot.index }), address: slot.address,
            kind: 'snapshot-value', scope, ...(!path.length || arrayElement ? { refType } : {}),
            ...(arrayElement ? { arrayElement } : {}), instanceId: origin.instanceId, snapshotId: origin.snapshotId, observationId: origin.observationId,
            consumerInstanceId: source.instanceId, consumerObservationId: observationId,
            viewInstanceId: owner.viewInstanceId, consumerViewInstanceId: source.receiver.viewInstanceId,
            consumerActivationId: source.receiver.activationId, value: selected.value,
        };
        refSources.push(record);
        return record;
    });
    if (result.status === 'rejected') return result;
    try {
        const copied = bounded({ source: { appId: source.appId, instanceId: source.instanceId,
            snapshotId: source.snapshotId, toolId: source.tool.id, receiver: source.receiver }, refSources }, ENVELOPE) as JsonObject;
        return Object.freeze({ ...result, refSources: copied.refSources as unknown as readonly SnapshotValueRefSource[] });
    } catch { return rejected('REF_ARGUMENT_BUDGET_EXCEEDED', 'Selected values exceed the call limit.', '$'); }
}

/** Worker validates and reconstructs input using only raw arguments and the trusted IPC records. */
export function reconstructToolParameters(contract: ToolParameterContract, input: JsonObject, binding: InvocationBinding,
    records: readonly SnapshotValueRefSource[]) {
    let cursor = 0;
    const origins = new Map<string, SnapshotValueRefSource>();
    const result = bindParameters(contract, input, (slot, address) => {
        const record = records[cursor++];
        if (!record || typeof record !== 'object')
            fail('E_INVALID_ARGS', 'Ref provenance does not match the supplied parameter and receiver.', slot);
        const labeled = !address.path.length || record.arrayElement === true;
        const keys = 17 + (slot.index === undefined ? 0 : 1) + (labeled ? 1 : 0) + (record.arrayElement === true ? 1 : 0);
        const sameApp = address.appId === binding.appId;
        if (Object.keys(record).length !== keys || record.param !== slot.param || record.index !== slot.index ||
            record.address !== slot.address || record.kind !== 'snapshot-value' ||
            (labeled ? typeof record.refType !== 'string' || !record.refType : Object.hasOwn(record, 'refType')) ||
            (Object.hasOwn(record, 'arrayElement') && (record.arrayElement !== true || !isArrayElementPath(address.path))) ||
            record.appId !== address.appId || record.viewId !== address.viewId || record.refId !== address.refId ||
            !Array.isArray(record.path) || record.path.length !== address.path.length || !pathStartsWith(record.path, address.path) ||
            (sameApp ? record.instanceId !== binding.instanceId || record.snapshotId !== binding.snapshotId ||
                record.observationId !== binding.observationId : record.instanceId === binding.instanceId || !validHostedSource(record)) ||
            typeof record.viewInstanceId !== 'string' || !record.viewInstanceId ||
            record.consumerInstanceId !== binding.instanceId || record.consumerObservationId !== binding.observationId ||
            record.consumerViewInstanceId !== binding.receiver.viewInstanceId || record.consumerActivationId !== binding.receiver.activationId ||
            !Object.hasOwn(record, 'value') || !scopeAllows(record.scope, record.viewInstanceId, binding.receiver.viewInstanceId, sameApp))
            fail('E_INVALID_ARGS', 'Ref provenance does not match the supplied parameter and receiver.', slot);
        const origin = origins.get(record.appId);
        if (origin && (origin.instanceId !== record.instanceId || origin.snapshotId !== record.snapshotId ||
            origin.observationId !== record.observationId))
            fail('E_INVALID_ARGS', 'All selected Refs from an App must belong to its original observation.', slot);
        origins.set(record.appId, record);
        return record;
    });
    if (result.status === 'rejected') return result;
    return cursor === records.length ? result : rejected('E_INVALID_ARGS', 'Unexpected Ref provenance record.', '$');
}

function validHostedSource(record: SnapshotValueRefSource): boolean {
    const { appId, instanceId, snapshotId: id, observationId, viewInstanceId } = record;
    if (typeof instanceId !== 'string' || !instanceId || typeof id !== 'string' ||
        typeof observationId !== 'string' || typeof viewInstanceId !== 'string') return false;
    try {
        const prefix = 'aotui-app-snapshot:v' + SNAPSHOT_SCHEMA_VERSION + ':';
        if (!id.startsWith(prefix)) return false;
        const tuple = JSON.parse(id.slice(prefix.length));
        const revision = Array.isArray(tuple) ? tuple[2] : undefined;
        if (!Number.isSafeInteger(revision) || revision < 1 || id !== snapshotId(appId, instanceId, revision)) return false;
        const mount = JSON.parse(viewInstanceId.slice('vi:v1:'.length));
        const observationPrefix = 'host:' + instanceId + ':observation:';
        return Array.isArray(mount) && Number.isSafeInteger(mount[1]) && mount[1] > 0 &&
            viewInstanceId === 'vi:v1:' + JSON.stringify([instanceId, mount[1]]) &&
            observationId.startsWith(observationPrefix) &&
            /^[1-9][0-9]*$/.test(observationId.slice(observationPrefix.length));
    } catch { return false; }
}

function bindParameters(contract: ToolParameterContract, input: JsonObject,
    select: (slot: RefSlot, address: RefAddress) => SnapshotValueRefSource) {
    let rawArgs: JsonObject;
    try { rawArgs = bounded(input, RAW) as JsonObject; }
    catch { return rejected('TOOL_INVALID_ARGS', 'Expected bounded JSON business parameters', '$'); }
    try {
        if (Object.hasOwn(rawArgs, 'view_id')) return rejected('TOOL_INVALID_ARGS', 'Supply only business parameters here.', '$.view_id');
        const model = contract.validateModelInput(rawArgs);
        if (!model.ok) {
            const diagnostic = model.diagnostics[0];
            return rejected('TOOL_INVALID_ARGS', diagnostic?.message ?? 'Invalid model parameters', diagnostic?.path);
        }
        const effectiveArgs = decodeRefParameters(contract.schema.properties as JsonObject, rawArgs, slot => {
            const address = parseRefAddress(slot.address);
            if (!address) fail('TOOL_INVALID_ARGS', 'Use a complete Ref address such as $app_id.view_id.ref_id or $app_id.view_id.ref_id[0].field. Use $$ for literal text.', slot);
            const record = select(slot, address);
            if (slot.expectedType !== undefined && record.refType !== slot.expectedType)
                fail('REF_TYPE_MISMATCH', 'Choose a published Ref of type ' + slot.expectedType + '.', slot);
            return record.value;
        });
        const boundedArgs = bounded(effectiveArgs, ARGUMENTS) as JsonObject;
        const result = contract.validateResolvedInput(boundedArgs);
        if (!result.ok) {
            const diagnostic = result.diagnostics[0];
            return rejected('REF_VALUE_UNSUPPORTED', diagnostic?.message ?? 'Effective parameters do not match the contract', diagnostic?.path);
        }
        return Object.freeze({ status: 'prepared' as const, rawArgs, effectiveArgs: result.value });
    } catch (error) {
        return error instanceof BindingIssue ? rejected(error.code, error.message, error.path)
            : rejected('REF_ARGUMENT_BUDGET_EXCEEDED', 'Combined parameters exceed the call limit.', '$');
    }
}

export function checkCurrentRefScopes(sources: readonly SnapshotValueRefSource[], receiver: ViewToolReceiver,
    current: Readonly<Pick<import('../snapshot/types.js').AppSnapshot, 'refs'>>, sameApp = true) {
    for (const { param, index, viewId, viewInstanceId, refId } of sources) {
        const ref = current.refs[refKey(viewId, viewInstanceId, refId)];
        if (!ref || !scopeAllows(ref.scope, viewInstanceId, receiver.viewInstanceId, sameApp)) return {
            code: 'REF_NOT_VISIBLE', message: 'The publishing View no longer grants access to this Ref.', path: refPath(param, index),
        };
    }
}

type Limits = JsonCopyLimits & { readonly maxCanonicalBytes: number };
function bounded(value: unknown, limits: Limits): JsonValue {
    const copied = copyJson(value, limits);
    if (utf8Size(canonicalJson(copied)) > limits.maxCanonicalBytes) throw new RangeError('Canonical JSON byte budget exceeded');
    return copied;
}
class BindingIssue extends Error {
    constructor(readonly code: string, message: string, readonly path: string) { super(message); }
}
function fail(code: string, message: string, slot: RefSlot): never {
    throw new BindingIssue(code, message, refPath(slot.param, slot.index));
}
function rejected(code: string, message: string, path?: string): Rejected {
    return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message, ...(path === undefined ? {} : { path }) }) });
}
