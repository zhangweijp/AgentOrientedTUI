import { MARKDOWN_VIEW_FORMAT, SNAPSHOT_SCHEMA_VERSION } from './types.js';
import { canonicalJson, checkJsonLimits, copyJson, SnapshotDataError, utf8Size } from './json.js';
import { DEFAULT_SNAPSHOT_LIMITS, MAX_VIEW_TOOL_BINDINGS, REF_VALUE_LIMITS, VIEW_METADATA_BYTES, refKey } from './snapshot-support.js';
import { compileCapturedToolParameters } from '../tool/tool-parameters.js';
import type { SnapshotDraftEnvelope } from './types.js';
import type {
    JsonValue, PreparedAppSnapshotDraft, SnapshotIssue, SnapshotLimits, ToolDescriptor,
} from './types.js';

type Plain = Readonly<Record<string, JsonValue>>;
type SnapshotValidation =
    | Readonly<{ ok: true; value: Readonly<{
        draft: PreparedAppSnapshotDraft;
        canonicalContent: string;
        contentBytes: Uint8Array;
        bytes: number;
    }> }>
    | Readonly<{ ok: false; issue: SnapshotIssue; envelope?: SnapshotDraftEnvelope }>;

function fail(path: string, message: string): never {
    throw new SnapshotDataError('SNAPSHOT_INVALID', path, message);
}
function obj(value: JsonValue, path: string): Plain {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Expected object');
    return value as Plain;
}
function list(value: JsonValue | undefined, path: string): readonly JsonValue[] {
    if (!Array.isArray(value)) fail(path, 'Expected array');
    return value as readonly JsonValue[];
}
function str(value: JsonValue | undefined, path: string): string {
    if (typeof value !== 'string' || !value.trim()) fail(path, 'Expected non-empty string');
    return value;
}
function int(value: JsonValue | undefined, path: string, min = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        fail(path, 'Expected safe integer >= ' + min);
    }
    return value;
}
function exact(value: Plain, fields: readonly string[], path: string): void {
    for (const field of fields) {
        if (!Object.hasOwn(value, field)) fail(path + '.' + field, 'Required field missing');
    }
    for (const field of Object.keys(value)) {
        if (!fields.includes(field)) fail(path + '.' + field, 'Unknown Snapshot field');
    }
}
function withinBytes(value: JsonValue, max: number, path: string): string {
    const canonical = canonicalJson(value);
    if (utf8Size(canonical) > max) {
        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Serialized byte budget exceeded');
    }
    return canonical;
}
function envelopeFromOwnDescriptors(input: unknown): SnapshotDraftEnvelope | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    try {
        const props = Object.getOwnPropertyDescriptors(input);
        const val = (key: string): unknown => {
            const prop = props[key];
            return prop?.enumerable && 'value' in prop ? prop.value : undefined;
        };
        const appId = val('appId');
        const instanceId = val('instanceId');
        const producerSeq = val('producerSeq');
        const sourceEpoch = val('sourceEpoch');
        if (typeof appId !== 'string' || !appId.trim() ||
            typeof instanceId !== 'string' || !instanceId.trim() ||
            typeof producerSeq !== 'number' || !Number.isSafeInteger(producerSeq) || producerSeq <= 0 ||
            typeof sourceEpoch !== 'number' || !Number.isSafeInteger(sourceEpoch) || sourceEpoch < 0) {
            return undefined;
        }
        return Object.freeze({ appId, instanceId, producerSeq, sourceEpoch });
    } catch {
        return undefined;
    }
}
function rejected(error: unknown, envelope?: SnapshotDraftEnvelope): SnapshotValidation {
    const issue: SnapshotIssue = error instanceof SnapshotDataError
        ? Object.freeze({ code: error.code, path: error.path, message: error.message })
        : Object.freeze({
            code: 'SNAPSHOT_SERIALIZATION_ERROR',
            path: '$',
            message: error instanceof Error ? error.message : 'Invalid Snapshot',
        });
    return Object.freeze({ ok: false, issue, ...(envelope ? { envelope } : {}) });
}

/** Validate cross-View identities and type activation references, never any Handler. */
export function validatePreparedSnapshot(
    input: unknown,
    limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
    previousTools?: (appId: string, instanceId: string) => Readonly<Record<string, ToolDescriptor>> | undefined,
): SnapshotValidation {
    const envelope = envelopeFromOwnDescriptors(input);
    let copied: JsonValue;
    try {
        copied = copyJson(input, {
            maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxApproxBytes: limits.maxSnapshotBytes * 2,
        });
    } catch (error) {
        return rejected(error, envelope);
    }

    try {
        const root = obj(copied, '$');
        exact(root, ['schemaVersion', 'appId', 'instanceId', 'producerSeq', 'sourceEpoch',
            'capturedAt', 'views', 'refs', 'tools'], '$');
        if (root.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('$.schemaVersion', 'Unsupported Snapshot schema version');
        const appId = str(root.appId, '$.appId');
        const instanceId = str(root.instanceId, '$.instanceId');
        const previous = previousTools?.(appId, instanceId);
        const producerSeq = int(root.producerSeq, '$.producerSeq', 1);
        const sourceEpoch = int(root.sourceEpoch, '$.sourceEpoch');
        const capturedAt = int(root.capturedAt, '$.capturedAt');

        const views = list(root.views, '$.views');
        if (views.length > limits.maxViews) fail('$.views', 'View capacity exceeded');
        const mounted = new Map<string, { instanceId: string; type: string }>();
        const ids = new Set<string>();
        for (const [index, value] of views.entries()) {
            const path = '$.views[' + index + ']';
            const view = obj(value, path);
            exact(view, ['id', 'viewInstanceId', 'type', 'name', 'kind', 'content', 'toolBindings'], path);
            const id = str(view.id, path + '.id');
            if (id.includes('.')) fail(path + '.id', 'View ID cannot contain a dot');
            const instanceId = str(view.viewInstanceId, path + '.viewInstanceId');
            const type = str(view.type, path + '.type');
            if (mounted.has(id) || ids.has(instanceId)) fail(path + '.id', 'Duplicate View instance or viewId');
            const name = str(view.name, path + '.name');
            if (view.kind !== 'state' && view.kind !== 'instruction') fail(path + '.kind', 'Unknown View kind');
            withinBytes({ id, viewInstanceId: instanceId, type, name, kind: view.kind }, VIEW_METADATA_BYTES, path);
            const content = obj(view.content, path + '.content');
            exact(content, ['format', 'value'], path + '.content');
            if (content.format !== MARKDOWN_VIEW_FORMAT) fail(path + '.content.format', 'Unknown View content format');
            if (typeof content.value !== 'string') fail(path + '.content.value', 'Markdown content must be string');
            withinBytes(content.value, limits.maxViewContentBytes, path + '.content.value');
            mounted.set(id, { instanceId, type });
            ids.add(instanceId);
        }

        const refs = obj(root.refs, '$.refs');
        if (Object.keys(refs).length > limits.maxRefs) fail('$.refs', 'Ref capacity exceeded');
        for (const [key, value] of Object.entries(refs)) {
            const path = '$.refs[' + JSON.stringify(key) + ']';
            const ref = obj(value, path);
            exact(ref, ['id', 'ownerViewId', 'ownerViewInstanceId', 'refType', 'target'], path);
            const id = str(ref.id, path + '.id');
            if (id.includes('.')) fail(path + '.id', 'Ref ID cannot contain a dot');
            const owner = str(ref.ownerViewId, path + '.ownerViewId');
            const instanceId = str(ref.ownerViewInstanceId, path + '.ownerViewInstanceId');
            str(ref.refType, path + '.refType');
            if (key !== refKey(owner, instanceId, id)) fail(path, 'Ref key does not match V2 instance identity');
            if (mounted.get(owner)?.instanceId !== instanceId) fail(path, 'Ref has stale or missing View instance');
            const target = obj(ref.target, path + '.target');
            if (target.kind !== 'snapshot-value') fail(path + '.target.kind', 'Unknown Ref target kind');
            exact(target, ['kind', 'payload'], path + '.target');
            const payloadPath = path + '.target.payload';
            withinBytes(target.payload!, Math.min(limits.maxRefPayloadBytes, REF_VALUE_LIMITS.maxCanonicalBytes), payloadPath);
            try { checkJsonLimits(target.payload, REF_VALUE_LIMITS); }
            catch (error) {
                if (error instanceof SnapshotDataError) throw new SnapshotDataError(error.code, payloadPath + error.path.slice(1), error.message);
                throw error;
            }
        }

        const tools = obj(root.tools, '$.tools');
        if (Object.keys(tools).length > limits.maxTools) fail('$.tools', 'Tool capacity exceeded');
        const activationIds = new Set<string>();
        const activeTools = new Set<string>();
        for (const [index, value] of views.entries()) {
            const view = value as Plain;
            const path = '$.views[' + index + '].toolBindings';
            const names = new Set<string>();
            for (const [offset, entry] of list(view.toolBindings, path).entries()) {
                const bindingPath = path + '[' + offset + ']';
                const binding = obj(entry, bindingPath);
                exact(binding, ['toolId', 'activationId'], bindingPath);
                const id = str(binding.toolId, bindingPath + '.toolId');
                const activation = str(binding.activationId, bindingPath + '.activationId');
                if (!Object.hasOwn(tools, id) || obj(tools[id]!, bindingPath).viewType !== view.type)
                    fail(bindingPath, 'Binding requires a Tool from the same ViewType');
                if (names.has(id) || activationIds.has(activation)) fail(bindingPath, 'Duplicate Tool binding or activation');
                names.add(id);
                activationIds.add(activation);
                if (activationIds.size > MAX_VIEW_TOOL_BINDINGS) fail(path, 'View Tool binding capacity exceeded');
                activeTools.add(id);
            }
        }
        const sharedNames = new Map<string, boolean>();
        for (const [key, value] of Object.entries(tools)) {
            const path = '$.tools[' + JSON.stringify(key) + ']';
            const tool = obj(value, path);
            exact(tool, ['id', 'name', 'viewType', 'nameSharedAcrossViewTypes', 'description', 'inputSchema'], path);
            const id = str(tool.id, path + '.id');
            const name = str(tool.name, path + '.name');
            const viewType = str(tool.viewType, path + '.viewType');
            if (id !== key || id !== JSON.stringify([appId, viewType, name])) {
                fail(path + '.id', 'Tool ID must be the canonical App + ViewType + name');
            }
            const sharedName = tool.nameSharedAcrossViewTypes;
            if (typeof sharedName !== 'boolean') fail(path + '.nameSharedAcrossViewTypes', 'Expected boolean');
            const previousShared = sharedNames.get(name);
            if (previousShared !== undefined && (!previousShared || !sharedName))
                fail(path + '.nameSharedAcrossViewTypes', 'Tools with the same name across ViewTypes must both mark it shared');
            sharedNames.set(name, sharedName);
            str(tool.description, path + '.description');
            const schema = obj(tool.inputSchema, path + '.inputSchema');
            if (schema.type !== 'object') fail(path + '.inputSchema.type', 'Tool inputs must have an object JSON schema');
            const canonical = withinBytes(schema, limits.maxToolSchemaBytes, path + '.inputSchema');
            if (!compileCapturedToolParameters(schema, canonical, previous?.[id]?.inputSchema)) fail(path + '.inputSchema', 'Expected a supported normalized Tool parameter schema');
            if (!activeTools.has(id)) fail(path, 'Tool requires at least one enabled View binding');
        }
        const canonicalContent = canonicalJson({
            schemaVersion: SNAPSHOT_SCHEMA_VERSION, views: root.views!, refs: root.refs!, tools: root.tools!,
        });
        const contentBytes = new TextEncoder().encode(canonicalContent);
        const envelopeBytes = utf8Size(canonicalJson({ appId, instanceId, producerSeq, sourceEpoch, capturedAt }));
        // Both objects are nonempty and their keys are disjoint. Joining them
        // replaces the two inner braces with one comma. Key order costs no bytes.
        const bytes = contentBytes.byteLength + envelopeBytes - 1;
        if (bytes > limits.maxSnapshotBytes) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$',
                'Snapshot byte budget exceeded');
        }
        return Object.freeze({
            ok: true,
            value: Object.freeze({
                draft: copied as unknown as PreparedAppSnapshotDraft,
                canonicalContent,
                contentBytes,
                bytes,
            }),
        });
    } catch (error) {
        return rejected(error, envelope);
    }
}
