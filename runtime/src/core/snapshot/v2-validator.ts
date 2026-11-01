/** Validate the sole supported V2 snapshot contract before it reaches storage. */
import { canonicalJson, copyJson, diagnosticDigest, SnapshotDataError, utf8Size } from './json.js';
import { validateVersionedToolRefDeclarations } from '../tool/versioned-ref-declarations.js';
import { DEFAULT_SNAPSHOT_LIMITS, refKey } from './snapshot-support.js';
import { validTargetSelector } from '../tool/target-selector.js';
import type { SnapshotDraftEnvelope } from './types.js';
import type {
    JsonValue, PreparedAppSnapshotDraftV2, SnapshotIssue, SnapshotLimits,
} from './types.js';

type Plain = Readonly<Record<string, JsonValue>>;
type V2Result =
    | Readonly<{ ok: true; value: Readonly<{
        draft: PreparedAppSnapshotDraftV2;
        canonicalContent: string;
        contentDigest: string;
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
function flag(value: JsonValue | undefined, path: string): boolean {
    if (typeof value !== 'boolean') fail(path, 'Expected boolean');
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
        if (!fields.includes(field)) fail(path + '.' + field, 'Unknown V2 field');
    }
}
function withinBytes(value: JsonValue, max: number, path: string): void {
    if (utf8Size(canonicalJson(value)) > max) {
        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Serialized byte budget exceeded');
    }
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
function rejected(error: unknown, envelope?: SnapshotDraftEnvelope): V2Result {
    const issue: SnapshotIssue = error instanceof SnapshotDataError
        ? Object.freeze({ code: error.code, path: error.path, message: error.message })
        : Object.freeze({
            code: 'SNAPSHOT_SERIALIZATION_ERROR',
            path: '$',
            message: error instanceof Error ? error.message : 'Invalid V2 Snapshot',
        });
    return Object.freeze({ ok: false, issue, ...(envelope ? { envelope } : {}) });
}

/** Validate cross-View Tool targets and source identities, never any Handler. */
export function validatePreparedV2Draft(
    input: unknown,
    overrides: Partial<SnapshotLimits> = {},
): V2Result {
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...overrides };
    const envelope = envelopeFromOwnDescriptors(input);
    let copied: JsonValue;
    try {
        copied = copyJson(input, {
            ...limits, maxApproxBytes: limits.maxSnapshotBytes * 2,
        });
    } catch (error) {
        return rejected(error, envelope);
    }

    try {
        const root = obj(copied, '$');
        exact(root, ['schemaVersion', 'appId', 'instanceId', 'producerSeq', 'sourceEpoch',
            'capturedAt', 'views', 'refs', 'tools'], '$');
        if (root.schemaVersion !== 2) fail('$.schemaVersion', 'Expected Snapshot V2');
        const appId = str(root.appId, '$.appId');
        str(root.instanceId, '$.instanceId');
        int(root.producerSeq, '$.producerSeq', 1);
        int(root.sourceEpoch, '$.sourceEpoch');
        int(root.capturedAt, '$.capturedAt');

        const views = list(root.views, '$.views');
        if (views.length > limits.maxViews) fail('$.views', 'View capacity exceeded');
        const mounted = new Map<string, { instanceId: string; type: string }>();
        const ids = new Set<string>();
        for (const [index, value] of views.entries()) {
            const path = '$.views[' + index + ']';
            const view = obj(value, path);
            exact(view, ['id', 'viewInstanceId', 'type', 'name', 'kind', 'content'], path);
            const id = str(view.id, path + '.id');
            const instanceId = str(view.viewInstanceId, path + '.viewInstanceId');
            const type = str(view.type, path + '.type');
            if (mounted.has(id) || ids.has(instanceId)) fail(path + '.id', 'Duplicate View instance or viewId');
            str(view.name, path + '.name');
            if (view.kind !== 'state' && view.kind !== 'instruction') fail(path + '.kind', 'Unknown View kind');
            const content = obj(view.content, path + '.content');
            exact(content, ['format', 'value'], path + '.content');
            if (content.format === 'markdown-v1') {
                if (typeof content.value !== 'string') fail(path + '.content.value', 'Markdown content must be string');
            } else if (content.format !== 'semantic-v1') {
                fail(path + '.content.format', 'Unknown View content format');
            }
            withinBytes(content.value!, limits.maxViewContentBytes, path + '.content.value');
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
            const owner = str(ref.ownerViewId, path + '.ownerViewId');
            const instanceId = str(ref.ownerViewInstanceId, path + '.ownerViewInstanceId');
            str(ref.refType, path + '.refType');
            if (key !== refKey(owner, instanceId, id)) fail(path, 'Ref key does not match V2 instance identity');
            if (mounted.get(owner)?.instanceId !== instanceId) fail(path, 'Ref has stale or missing View instance');
            const target = obj(ref.target, path + '.target');
            if (target.kind === 'snapshot-value') {
                exact(target, ['kind', 'payload'], path + '.target');
                withinBytes(target.payload!, limits.maxRefPayloadBytes, path + '.target.payload');
            } else if (target.kind === 'entity') {
                exact(target, ['kind', 'entityType', 'entityId', ...(Object.hasOwn(target, 'entityVersion') ? ['entityVersion'] : [])], path + '.target');
                str(target.entityType, path + '.target.entityType');
                str(target.entityId, path + '.target.entityId');
                if (Object.hasOwn(target, 'entityVersion')) str(target.entityVersion, path + '.target.entityVersion');
            } else {
                fail(path + '.target.kind', 'Unknown Ref target kind');
            }
        }

        const tools = obj(root.tools, '$.tools');
        if (Object.keys(tools).length > limits.maxTools) fail('$.tools', 'Tool capacity exceeded');
        for (const [key, value] of Object.entries(tools)) {
            const path = '$.tools[' + JSON.stringify(key) + ']';
            const tool = obj(value, path);
            exact(tool, ['id', 'name', 'viewType', 'description', 'inputSchema', 'isMutating', 'targets'], path);
            const id = str(tool.id, path + '.id');
            const name = str(tool.name, path + '.name');
            const viewType = str(tool.viewType, path + '.viewType');
            if (id !== key || id !== JSON.stringify([appId, viewType, name])) {
                fail(path + '.id', 'V2 Tool ID must be the canonical App + ViewType + name');
            }
            str(tool.description, path + '.description');
            const isMutating = flag(tool.isMutating, path + '.isMutating');
            const schema = obj(tool.inputSchema, path + '.inputSchema');
            if (schema.type !== 'object') fail(path + '.inputSchema.type', 'Tool inputs must have an object JSON schema');
            withinBytes(schema, limits.maxToolSchemaBytes, path + '.inputSchema');
            validateVersionedToolRefDeclarations(schema, isMutating, true, path + '.inputSchema');
            const targets = list(tool.targets, path + '.targets');
            if (!targets.length || targets.length > limits.maxViews) {
                fail(path + '.targets', 'Visible V2 Tool requires bounded live View targets');
            }
            const seenTargets = new Set<string>();
            for (const [index, candidate] of targets.entries()) {
                const targetPath = path + '.targets[' + index + ']';
                const target = obj(candidate, targetPath);
                exact(target, ['viewId', 'viewInstanceId', 'bindingVersion', ...(Object.hasOwn(target, 'selector') ? ['selector'] : [])], targetPath);
                if (Object.hasOwn(target, 'selector') && !validTargetSelector(target.selector, schema))
                    fail(targetPath + '.selector', 'Target selector must bind an existing required string parameter');
                const viewId = str(target.viewId, targetPath + '.viewId');
                const instanceId = str(target.viewInstanceId, targetPath + '.viewInstanceId');
                int(target.bindingVersion, targetPath + '.bindingVersion', 1);
                const owner = mounted.get(viewId);
                if (!owner || owner.instanceId !== instanceId || owner.type !== viewType) {
                    fail(targetPath, 'Tool target is not the current View instance of its declared type');
                }
                if (seenTargets.has(instanceId)) fail(targetPath, 'Duplicate Tool target instance');
                seenTargets.add(instanceId);
            }
        }
        const bytes = utf8Size(canonicalJson(copied));
        if (bytes > limits.maxSnapshotBytes) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$',
                'V2 Snapshot byte budget exceeded');
        }
        const canonicalContent = canonicalJson({
            schemaVersion: 2, views: root.views!, refs: root.refs!, tools: root.tools!,
        });
        return Object.freeze({
            ok: true,
            value: Object.freeze({
                draft: copied as unknown as PreparedAppSnapshotDraftV2,
                canonicalContent,
                contentDigest: diagnosticDigest(canonicalContent),
                bytes,
            }),
        });
    } catch (error) {
        return rejected(error, envelope);
    }
}
