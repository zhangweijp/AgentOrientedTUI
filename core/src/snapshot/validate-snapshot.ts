import { isInstanceName, isRefId, isViewTypeName, MARKDOWN_VIEW_FORMAT, SNAPSHOT_SCHEMA_VERSION } from './types.js';
import { canonicalJson, checkJsonLimits, copyJson, copyWireJson, JsonCopyLimitError, SnapshotDataError, utf8Size } from './json.js';
import { DEFAULT_SNAPSHOT_LIMITS, MAX_VIEW_TOOL_BINDINGS, REF_VALUE_LIMITS, VIEW_METADATA_BYTES, refKey } from './snapshot-support.js';
import { compileCapturedToolParameters, compileValueSchema } from '../tool/tool-parameters.js';
import type { SnapshotDraftEnvelope, MinimalViewType, ViewTypeSeal } from './types.js';
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
function exact(value: Plain, fields: readonly string[], path: string, optional: readonly string[] = []): void {
    for (const field of fields) {
        if (!Object.hasOwn(value, field)) fail(path + '.' + field, 'Required field missing');
    }
    for (const field of Object.keys(value)) {
        if (!fields.includes(field) && !optional.includes(field)) fail(path + '.' + field, 'Unknown Snapshot field');
    }
}
function withinBytes(value: JsonValue, max: number, path: string): string {
    const canonical = canonicalJson(value);
    if (utf8Size(canonical) > max) {
        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Serialized byte budget exceeded');
    }
    return canonical;
}
export function monotonicId(value: string, prefix: 'a:' | 'm:', path: string): number {
    const suffix = value.slice(2);
    const n = Number(suffix);
    if (!value.startsWith(prefix) || !Number.isSafeInteger(n) || n <= 0 || String(n) !== suffix)
        fail(path, 'Expected a monotonic ' + prefix + ' positive integer');
    return n;
}
export function captureSnapshotDraftEnvelope(input: unknown): SnapshotDraftEnvelope | undefined {
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

/** One bounded minimal declaration table, independent of active Tool visibility. */
export function captureViewTypes(input: unknown, limits: Parameters<typeof copyWireJson>[1]): readonly MinimalViewType[] {
    if (!Array.isArray(input)) fail('$.viewTypes', 'The first complete publication requires viewTypes');
    if (input.length > DEFAULT_SNAPSHOT_LIMITS.maxViews)
        throw new SnapshotDataError('SNAPSHOT_CAPACITY', '$.viewTypes', 'ViewType declaration count exceeds ' + DEFAULT_SNAPSHOT_LIMITS.maxViews);
    let captured: JsonValue;
    try {
        checkJsonLimits(input, limits);
        captured = copyWireJson(input, limits);
    } catch (error) {
        if (error instanceof JsonCopyLimitError)
            throw new SnapshotDataError('SNAPSHOT_CAPACITY', '$.viewTypes', 'ViewType declaration exceeds metadata limits: ' + error.message +
                ' (maxDepth=' + limits.maxDepth + ', maxNodes=' + limits.maxNodes + ', maxApproxBytes=' + limits.maxApproxBytes +
                ', maxCanonicalBytes=' + limits.maxCanonicalBytes + ')');
        if (error instanceof SnapshotDataError) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.viewTypes' + error.path.slice(1), error.message);
        throw error;
    }
    const names = new Set<string>();
    for (const [i, raw] of list(captured, '$.viewTypes').entries()) {
        const path = '$.viewTypes[' + i + ']';
        const type = obj(raw, path);
        exact(type, ['name', 'multiplicity'], path);
        if (!isViewTypeName(type.name) || names.has(type.name)) fail(path + '.name', 'Invalid or duplicate ViewType name');
        if (type.multiplicity !== 'single' && type.multiplicity !== 'multiple') fail(path + '.multiplicity', 'Invalid ViewType multiplicity');
        names.add(type.name);
    }
    return captured as unknown as readonly MinimalViewType[];
}

/** Validate cross-View identities and type activation references, never any Handler. */
export function validatePreparedSnapshot(
    input: unknown,
    limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
    previousTools?: (appId: string, instanceId: string) => Readonly<Record<string, ToolDescriptor>> | undefined,
    seal?: ViewTypeSeal,
): SnapshotValidation {
    const envelope = captureSnapshotDraftEnvelope(input);
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
            'healthySince', 'capturedAt', 'views', 'refs', 'tools'], '$');
        if (root.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) fail('$.schemaVersion', 'Unsupported Snapshot schema version');
        const appId = str(root.appId, '$.appId');
        if (!isInstanceName(appId)) fail('$.appId', 'Invalid App ID');
        const instanceId = str(root.instanceId, '$.instanceId');
        const previous = previousTools?.(appId, instanceId);
        const producerSeq = int(root.producerSeq, '$.producerSeq', 1);
        const sourceEpoch = int(root.sourceEpoch, '$.sourceEpoch', 1);
        const healthySince = int(root.healthySince, '$.healthySince', 1);
        if (healthySince > sourceEpoch) fail('$.healthySince', 'Health period cannot start after the publication epoch');
        const capturedAt = int(root.capturedAt, '$.capturedAt');

        const views = list(root.views, '$.views');
        if (views.length > limits.maxViews) fail('$.views', 'View capacity exceeded');
        const mounted = new Map<string, { instanceId: string; type: string }>();
        const countsByType = new Map<string, number>();
        const declaredTypes = seal && new Map(seal.types.map(type => [type.name, type.multiplicity]));
        const ids = new Set<string>();
        for (const [index, value] of views.entries()) {
            const path = '$.views[' + index + ']';
            const view = obj(value, path);
            exact(view, ['id', 'viewInstanceId', 'type', 'name', 'region', 'content', 'toolBindings'], path, ['closeActivationId']);
            const id = str(view.id, path + '.id');
            if (!isInstanceName(id)) fail(path + '.id', 'Invalid View ID');
            const instanceId = str(view.viewInstanceId, path + '.viewInstanceId');
            monotonicId(instanceId, 'm:', path + '.viewInstanceId');
            const type = str(view.type, path + '.type');
            if (!isViewTypeName(type)) fail(path + '.type', 'Invalid ViewType name');
            if (declaredTypes && !declaredTypes.has(type)) fail(path + '.type', 'ViewType is not declared');
            if (declaredTypes?.get(type) === 'single' && countsByType.has(type)) fail(path + '.type', 'Single ViewType already mounted');
            if (mounted.has(id) || ids.has(instanceId)) fail(path + '.id', 'Duplicate View instance or viewId');
            const name = str(view.name, path + '.name');
            if (view.region !== 'static' && view.region !== 'dynamic') fail(path + '.region', 'Unknown View region');
            withinBytes({ id, viewInstanceId: instanceId, type, name, region: view.region,
                ...(view.closeActivationId === undefined ? {} : { closeActivationId: view.closeActivationId }) }, VIEW_METADATA_BYTES, path);
            const content = obj(view.content, path + '.content');
            exact(content, ['format', 'value'], path + '.content');
            if (content.format !== MARKDOWN_VIEW_FORMAT) fail(path + '.content.format', 'Unknown View content format');
            if (typeof content.value !== 'string') fail(path + '.content.value', 'Markdown content must be string');
            withinBytes(content.value, limits.maxViewContentBytes, path + '.content.value');
            mounted.set(id, { instanceId, type });
            countsByType.set(type, (countsByType.get(type) ?? 0) + 1);
            ids.add(instanceId);
        }

        const refs = obj(root.refs, '$.refs');
        if (Object.keys(refs).length > limits.maxRefs) fail('$.refs', 'Ref capacity exceeded');
        for (const [key, value] of Object.entries(refs)) {
            const path = '$.refs[' + JSON.stringify(key) + ']';
            const ref = obj(value, path);
            exact(ref, ['id', 'ownerViewId', 'ownerViewInstanceId', 'refType', 'scope', 'continuity', 'target', 'valueSchema',
                ...(Object.hasOwn(ref, 'array') ? ['array'] : [])], path);
            const id = ref.id;
            if (!isRefId(id)) fail(path + '.id', 'Ref ID must match [A-Za-z_][A-Za-z0-9_]*.');
            const owner = str(ref.ownerViewId, path + '.ownerViewId');
            const instanceId = str(ref.ownerViewInstanceId, path + '.ownerViewInstanceId');
            str(ref.refType, path + '.refType');
            if (ref.scope !== 'private' && ref.scope !== 'protected' && ref.scope !== 'public')
                fail(path + '.scope', 'Unknown Ref scope');
            const continuity = list(ref.continuity, path + '.continuity');
            if (continuity.length !== 3) fail(path + '.continuity', 'Expected three continuity lanes');
            for (const [i, raw] of continuity.entries()) {
                const start = int(raw, path + '.continuity[' + i + ']');
                const allowed = i === 0 || i === 1 && ref.scope !== 'private' || i === 2 && ref.scope === 'public';
                if (allowed ? start < healthySince || start > sourceEpoch : start !== 0)
                    fail(path + '.continuity[' + i + ']', 'Ref lane conflicts with scope or health period');
            }
            if (key !== refKey(owner, instanceId, id)) fail(path, 'Ref key does not match its owning View mount');
            if (mounted.get(owner)?.instanceId !== instanceId) fail(path, 'Ref has stale or missing View instance');
            const target = obj(ref.target, path + '.target');
            if (target.kind !== 'snapshot-value') fail(path + '.target.kind', 'Unknown Ref target kind');
            exact(target, ['kind', 'payload'], path + '.target');
            if (Object.hasOwn(ref, 'array') && (ref.array !== true || !Array.isArray(target.payload)))
                fail(path + '.array', 'ArrayRef requires an array payload');
            const payloadPath = path + '.target.payload';
            withinBytes(target.payload!, Math.min(limits.maxRefPayloadBytes, REF_VALUE_LIMITS.maxCanonicalBytes), payloadPath);
            try { checkJsonLimits(target.payload, REF_VALUE_LIMITS); }
            catch (error) {
                if (error instanceof SnapshotDataError) throw new SnapshotDataError(error.code, payloadPath + error.path.slice(1), error.message);
                throw error;
            }
            const schema = obj(ref.valueSchema, path + '.valueSchema');
            withinBytes(schema, limits.maxToolSchemaBytes, path + '.valueSchema');
            const compiled = compileValueSchema(schema);
            if (!compiled.ok) {
                const issuePath = path + '.valueSchema' + compiled.issue.path.slice(1);
                throw new SnapshotDataError('SNAPSHOT_INVALID', issuePath, compiled.issue.message);
            }
            const mismatch = compiled.validate(target.payload!);
            if (mismatch) {
                throw new SnapshotDataError('SNAPSHOT_INVALID', payloadPath + mismatch.path.slice(1), mismatch.message);
            }
        }

        const tools = obj(root.tools, '$.tools');
        if (Object.keys(tools).length > limits.maxTools) fail('$.tools', 'Tool capacity exceeded');
        const activationIds = new Set<string>();
        const activeTools = new Set<string>();
        for (const [index, value] of views.entries()) {
            const view = value as Plain;
            const path = '$.views[' + index + '].toolBindings';
            if (view.closeActivationId !== undefined) {
                const close = str(view.closeActivationId, '$.views[' + index + '].closeActivationId');
                monotonicId(close, 'a:', '$.views[' + index + '].closeActivationId');
                if (activationIds.has(close)) fail(path, 'Duplicate close activation');
                activationIds.add(close);
            }
            const names = new Set<string>();
            for (const [offset, entry] of list(view.toolBindings, path).entries()) {
                const bindingPath = path + '[' + offset + ']';
                const binding = obj(entry, bindingPath);
                exact(binding, ['toolId', 'activationId'], bindingPath);
                const id = str(binding.toolId, bindingPath + '.toolId');
                const activation = str(binding.activationId, bindingPath + '.activationId');
                monotonicId(activation, 'a:', bindingPath + '.activationId');
                if (!Object.hasOwn(tools, id) || obj(tools[id]!, bindingPath).viewType !== view.type)
                    fail(bindingPath, 'Binding requires a Tool from the same ViewType');
                if (names.has(id) || activationIds.has(activation)) fail(bindingPath, 'Duplicate Tool binding or activation');
                names.add(id);
                activationIds.add(activation);
                if (activationIds.size > MAX_VIEW_TOOL_BINDINGS) fail(path, 'View Tool binding capacity exceeded');
                activeTools.add(id);
            }
        }
        const multiplicities = new Map<string, JsonValue>();
        for (const [key, value] of Object.entries(tools)) {
            const path = '$.tools[' + JSON.stringify(key) + ']';
            const tool = obj(value, path);
            exact(tool, ['id', 'name', 'viewType', 'multiplicity', 'description', 'inputSchema'], path);
            const id = str(tool.id, path + '.id');
            const name = str(tool.name, path + '.name');
            const viewType = str(tool.viewType, path + '.viewType');
            if (!isViewTypeName(viewType)) fail(path + '.viewType', 'Invalid ViewType name');
            const multiplicity = tool.multiplicity;
            if (declaredTypes && !declaredTypes.has(viewType)) fail(path + '.viewType', 'ViewType is not declared');
            if (declaredTypes && declaredTypes.get(viewType) !== multiplicity) fail(path + '.multiplicity', 'Tool multiplicity differs from sealed ViewType');
            if ((multiplicity !== 'single' && multiplicity !== 'multiple') ||
                (multiplicity === 'single' && countsByType.get(viewType) !== 1) ||
                (multiplicities.has(viewType) && multiplicities.get(viewType) !== multiplicity))
                fail(path + '.multiplicity', 'Inconsistent ViewType multiplicity');
            multiplicities.set(viewType, multiplicity);
            if (id !== key || id !== JSON.stringify([appId, viewType, name])) {
                fail(path + '.id', 'Tool ID must be the canonical App + ViewType + name');
            }
            str(tool.description, path + '.description');
            const schema = obj(tool.inputSchema, path + '.inputSchema');
            if (schema.type !== 'object') fail(path + '.inputSchema.type', 'Tool inputs must have an object JSON schema');
            const canonical = withinBytes(schema, limits.maxToolSchemaBytes, path + '.inputSchema');
            if (!compileCapturedToolParameters(schema, canonical, previous?.[id]?.inputSchema)) fail(path + '.inputSchema', 'Expected a supported normalized Tool parameter schema');
            if (!activeTools.has(id)) fail(path, 'Tool requires at least one enabled View binding');
        }
        const canonicalContent = canonicalJson({
            schemaVersion: SNAPSHOT_SCHEMA_VERSION, healthySince, views: root.views!, refs: root.refs!, tools: root.tools!,
        });
        const contentBytes = new TextEncoder().encode(canonicalContent);
        const envelopeBytes = utf8Size(canonicalJson({ appId, instanceId, producerSeq, sourceEpoch, capturedAt }));
        // Both objects are nonempty and their keys are disjoint. Joining them
        // replaces the two inner braces with one comma. Key order costs no bytes.
        const declarationBytes = seal?.first ? utf8Size(canonicalJson({ viewTypes: seal.types })) - 1 : 0;
        if (seal?.first) checkJsonLimits({ ...root, viewTypes: seal.types }, {
            maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxApproxBytes: limits.maxSnapshotBytes * 2,
        });
        const bytes = contentBytes.byteLength + envelopeBytes - 1 + declarationBytes;
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
