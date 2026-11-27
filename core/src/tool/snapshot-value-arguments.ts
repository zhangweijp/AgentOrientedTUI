import type { JsonValue, RefScope, SnapshotStore } from '../snapshot/types.js';
import type { ToolParameterContract } from './tool-parameters.js';
import type { InvocationSource, Issue } from '../invocation/app-interaction-types.js';
import type { RefConsumer, RefGrant } from '../invocation/observation-types.js';
import { parseRefAddress } from './ref-parameters.js';
import { REF_ADDRESS_PREFIX, decodeRefLiteral, isArrayElementPath, readRefPath, refConsumerAllowed, refPath, scopeAllows, refLane,
    type LocalRefUse, type RefAddress } from './ref-path.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type Slot = Readonly<{ param: string; index?: number }>;
export interface RefArgumentSource {
    readonly appId: string;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly observationId: string;
    readonly visibleRefs: readonly RefGrant[];
    readonly store: Pick<SnapshotStore, 'resolveRef'>;
}
export interface SnapshotValueRefSource extends LocalRefUse, RefAddress {
    readonly address: string;
    readonly refType?: string;
    readonly scope: RefScope;
    readonly instanceId: string;
    readonly snapshotId: string;
    readonly observationId: string;
    readonly value: JsonValue;
}

function schemaObject(value: JsonValue | undefined): JsonObject | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Resolve only complete argument slots using the retained original observations. */
export function prepareViewTypeParameters(
    store: SnapshotStore, source: Pick<InvocationSource, 'appId' | 'instanceId' | 'snapshotId'> & { readonly receiver: Pick<InvocationSource['receiver'], 'viewId' | 'viewInstanceId'> }, contract: ToolParameterContract, input: JsonObject,
    visibleRefs: readonly RefGrant[], observationId: string,
    external?: (appId: string) => RefArgumentSource | { issue: Issue } | undefined,
) {
    const origins = new Map<string, RefArgumentSource>();
    origins.set(source.appId, { ...source, observationId, visibleRefs, store });
    const receiver: RefConsumer = { appId: source.appId, instanceId: source.instanceId,
        viewId: source.receiver.viewId, viewInstanceId: source.receiver.viewInstanceId };
    const refSources: SnapshotValueRefSource[] = [];

    function resolve(value: JsonValue, slot: Slot, schema?: JsonObject): JsonValue {
        const expectedType = schema?.['x-aotui-ref-kind'];
        if (typeof value !== 'string' || !value.startsWith(REF_ADDRESS_PREFIX)) {
            if (expectedType !== undefined) fail('REF_TYPE_MISMATCH', 'Choose a published Ref of type ' + expectedType + '.', slot);
            return typeof value === 'string' ? decodeRefLiteral(value) : value;
        }
        const address = parseRefAddress(value);
        if (!address) fail('TOOL_INVALID_ARGS', 'Use a complete $ref.app_id.view_id.ref_id address. To quote literal text starting with dollar signs followed by ref., add one leading $.', slot);
        const { appId, viewId, refId, path } = address;
        const origin = origins.get(appId) ?? external?.(appId);
        if (!origin) fail('REF_NOT_VISIBLE', 'Choose a Ref from an App in this request.', slot);
        if ('issue' in origin) fail(origin.issue.code, origin.issue.message, slot);
        origins.set(appId, origin);
        const owner = origin.visibleRefs.find(ref => ref.viewId === viewId && ref.refId === refId);
        if (!owner || !refConsumerAllowed(owner.consumers, receiver))
            fail('REF_NOT_VISIBLE', 'Choose a Ref granted to the receiving View in this observation.', slot);
        const resolved = origin.store.resolveRef({ appId, instanceId: origin.instanceId,
            snapshotId: origin.snapshotId, refId, viewId, viewInstanceId: owner.viewInstanceId });
        if (resolved.status === 'rejected') fail(resolved.issue.code, 'Original Ref source is unavailable.', slot);
        const { scope } = resolved.ref;
        if (!scopeAllows(scope, owner.viewInstanceId, receiver.viewInstanceId,
            appId === receiver.appId && origin.instanceId === receiver.instanceId))
            fail('TOOL_PERMISSION_DENIED', 'This Ref does not grant access to the receiving View.', slot);
        const refType = !path.length || resolved.ref.array && isArrayElementPath(path) ? resolved.ref.refType : undefined;
        if (expectedType !== undefined && refType !== expectedType)
            fail('REF_TYPE_MISMATCH', 'Choose a published Ref of type ' + expectedType + '.', slot);
        const selected = readRefPath(resolved.target.payload, path);
        if (!selected.found) fail('REF_TARGET_UNSUPPORTED', 'Ref path segment ' + (selected.segment + 1) + ' ' + selected.reason + '.', slot);
        const since = resolved.ref.continuity[refLane(owner.viewInstanceId, receiver.viewInstanceId, appId === receiver.appId && origin.instanceId === receiver.instanceId)];
        if (!since) fail('REF_NOT_VISIBLE', 'The original Ref is not granted to this receiver.', slot);
        refSources.push(Object.freeze({ ...address, ...slot, since, address: value, scope, ...(refType === undefined ? {} : { refType }),
            instanceId: origin.instanceId, snapshotId: origin.snapshotId, observationId: origin.observationId,
            viewInstanceId: owner.viewInstanceId, value: selected.value }));
        return selected.value;
    }

    try {
        if (Object.hasOwn(input, 'view_id')) fail('TOOL_INVALID_ARGS', 'Supply the receiving View separately.', { param: 'view_id' });
        const properties = schemaObject(contract.schema.properties);
        const additional = schemaObject(contract.schema.additionalProperties);
        const effective = Object.freeze(Object.fromEntries(Object.entries(input).map(([param, value]) => {
            const schema = (properties && Object.hasOwn(properties, param) ? schemaObject(properties[param]) : additional);
            if (typeof value === 'string' && value.startsWith(REF_ADDRESS_PREFIX) && schema?.type === 'array' &&
                schemaObject(schema.items)?.['x-aotui-ref-kind'] !== undefined)
                fail('TOOL_INVALID_ARGS', 'Supply an array of published Ref addresses.', { param });
            if (!Array.isArray(value) || schema?.['x-aotui-ref-kind'] !== undefined) return [param, resolve(value, { param }, schema)];
            const positions = schema?.prefixItems;
            let changed = false;
            const values = value.map((item, index) => {
                const itemSchema = Array.isArray(positions) && index < positions.length ? positions[index] : schema?.items;
                const resolved = resolve(item, { param, index }, schemaObject(itemSchema));
                changed ||= resolved !== item;
                return resolved;
            });
            return [param, changed ? Object.freeze(values) : value];
        }))) as JsonObject;
        const result = contract.validateResolvedInput(effective);
        if (result.ok) return Object.freeze({ status: 'prepared' as const, effectiveArgs: result.value, refSources: Object.freeze(refSources) });
        if (result.code === 'PARAMETER_INPUT_CAPACITY')
            return rejected('REF_ARGUMENT_BUDGET_EXCEEDED', 'Combined business parameters exceed the call limit.', '$');
        const diagnostic = result.diagnostics[0];
        const path = diagnostic?.path;
        const selectedRef = refSources.some(ref => {
            const slot = refPath(ref.param, ref.index);
            return path === slot || path?.startsWith(slot + '.') || path?.startsWith(slot + '[');
        });
        return rejected(selectedRef ? 'REF_VALUE_UNSUPPORTED' : 'TOOL_INVALID_ARGS',
            diagnostic?.message ?? 'Effective parameters do not match the contract.', path);
    } catch (error) {
        if (!(error instanceof BindingIssue)) throw error;
        return rejected(error.code, error.message, error.path);
    }
}

class BindingIssue extends Error {
    constructor(readonly code: string, message: string, readonly path: string) { super(message); }
}
function fail(code: string, message: string, slot: Slot): never {
    throw new BindingIssue(code, message, refPath(slot.param, slot.index));
}
function rejected(code: string, message: string, path?: string) {
    return Object.freeze({ status: 'rejected' as const, issue: Object.freeze({ code, message, ...(path === undefined ? {} : { path }) }) });
}
