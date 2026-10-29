import { canonicalJson, copyJson, diagnosticDigest, SnapshotDataError, utf8Size } from './json.js';
import { validateVersionedToolRefDeclarations } from '../tool/versioned-ref-declarations.js';
import type {
    JsonValue, PreparedAppSnapshotDraft, RefDescriptor, SnapshotIssue, SnapshotLimits,
    ToolDescriptor, ViewSnapshot,
} from './types.js';

export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
    maxDepth: 48,
    maxNodes: 100_000,
    maxSnapshotBytes: 4 * 1024 * 1024,
    maxViews: 1_000,
    maxRefs: 10_000,
    maxTools: 1_000,
    maxViewContentBytes: 512 * 1024,
    maxRefPayloadBytes: 512 * 1024,
    maxToolSchemaBytes: 64 * 1024,
});

export type DraftEnvelope = Readonly<{
    appId: string;
    instanceId: string;
    producerSeq: number;
    sourceEpoch: number;
}>;

export interface ValidatedDraft {
    readonly draft: PreparedAppSnapshotDraft;
    readonly canonicalContent: string;
    readonly contentDigest: string;
    readonly bytes: number;
}

export type ValidationResult =
    | Readonly<{ ok: true; value: ValidatedDraft }>
    | Readonly<{ ok: false; issue: SnapshotIssue; envelope?: DraftEnvelope }>;

type V1ProxyDataResult =
    | Readonly<{ ok: true; value: Omit<ValidatedDraft, 'contentDigest'> }>
    | Extract<ValidationResult, { ok: false }>;

type RecordJson = Readonly<Record<string, JsonValue>>;

function fail(path: string, message: string): never {
    throw new SnapshotDataError('SNAPSHOT_INVALID', path, message);
}
function record(input: JsonValue, path: string): RecordJson {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(path, 'Expected object');
    return input as RecordJson;
}
function array(input: JsonValue | undefined, path: string): readonly JsonValue[] {
    if (!Array.isArray(input)) fail(path, 'Expected array');
    return input as readonly JsonValue[];
}
function string(input: JsonValue | undefined, path: string): string {
    if (typeof input !== 'string' || input.trim().length === 0) fail(path, 'Expected non-empty string');
    return input;
}
function integer(input: JsonValue | undefined, path: string, min = 0): number {
    if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min) {
        fail(path, 'Expected safe integer >= ' + min);
    }
    return input;
}
function flag(input: JsonValue | undefined, path: string): boolean {
    if (typeof input !== 'boolean') fail(path, 'Expected boolean');
    return input;
}
function exact(value: RecordJson, required: readonly string[], optional: readonly string[], path: string): void {
    for (const key of required) {
        if (!Object.hasOwn(value, key)) fail(path + '.' + key, 'Required field missing');
    }
    for (const key of Object.keys(value)) {
        if (!required.includes(key) && !optional.includes(key)) fail(path + '.' + key, 'Unknown schema field');
    }
}
function withinBytes(value: JsonValue, max: number, path: string): void {
    if (utf8Size(canonicalJson(value)) > max) {
        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Serialized byte budget exceeded');
    }
}
function notMore(items: number, max: number, path: string): void {
    if (items > max) {
        throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', path, 'Collection budget exceeded');
    }
}

/** View-scoped, generation-scoped key; no ambiguous delimiters or suffix lookup. */
export function refKey(viewId: string, viewGeneration: string, refId: string): string {
    return JSON.stringify([viewId, viewGeneration, refId]);
}

function parseEnvelope(input: JsonValue): DraftEnvelope | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const data = input as RecordJson;
    if (
        typeof data.appId !== 'string' || !data.appId.trim() ||
        typeof data.instanceId !== 'string' || !data.instanceId.trim() ||
        typeof data.producerSeq !== 'number' ||
        !Number.isSafeInteger(data.producerSeq) || data.producerSeq <= 0 ||
        typeof data.sourceEpoch !== 'number' ||
        !Number.isSafeInteger(data.sourceEpoch) || data.sourceEpoch < 0
    ) return undefined;
    return Object.freeze({
        appId: data.appId, instanceId: data.instanceId,
        producerSeq: data.producerSeq, sourceEpoch: data.sourceEpoch,
    });
}

/**
 * Reads only own data property descriptors, without invoking root accessors.
 * This lets Core mark an authenticated App degraded if a nested Ref fails cloning.
 * Caller/transport must STILL independently bind sender identity in M2.
 */
function parseUntrustedEnvelope(input: unknown): DraftEnvelope | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    try {
        const descriptors = Object.getOwnPropertyDescriptors(input);
        const pick = (key: string): unknown => {
            const field = descriptors[key];
            return field && field.enumerable && 'value' in field ? field.value : undefined;
        };
        const appId = pick('appId');
        const instanceId = pick('instanceId');
        const producerSeq = pick('producerSeq');
        const sourceEpoch = pick('sourceEpoch');
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

/** Validates and returns a completely detached, immutable application draft. */
export function validatePreparedDraft(
    input: unknown,
    overrides: Partial<SnapshotLimits> = {},
): ValidationResult {
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...overrides };
    const candidateEnvelope = parseUntrustedEnvelope(input);
    let copied: JsonValue;
    try {
        copied = copyJson(input, {
            ...limits,
            maxApproxBytes: limits.maxSnapshotBytes * 2,
        });
    } catch (error) {
        return Object.freeze({ ok: false, issue: asIssue(error),
            ...(candidateEnvelope ? { envelope: candidateEnvelope } : {}) });
    }
    return validateCopiedV1Proxy(copied, overrides);
}

export function validateCopiedV1Proxy(
    copied: JsonValue,
    overrides: Partial<SnapshotLimits> = {},
    viewOwnedRefDeclarations = false,
): ValidationResult {
    const checked = validateCopiedV1ProxyData(copied, overrides, viewOwnedRefDeclarations);
    if (!checked.ok) return checked;
    try {
        const { draft, canonicalContent, bytes } = checked.value;
        return Object.freeze({
            ok: true,
            value: Object.freeze({
                draft,
                canonicalContent,
                contentDigest: diagnosticDigest(canonicalContent),
                bytes,
            }),
        });
    } catch (error) {
        const envelope = parseEnvelope(copied);
        return Object.freeze({ ok: false, issue: asIssue(error), ...(envelope ? { envelope } : {}) });
    }
}

/**
 * INTERNAL: validate a proxy assembled exclusively from a previously
 * copyJson-verified V2 draft. Never pass caller-owned/untrusted objects here.
 * V1's public validator always performs its own defensive copy first.
 */
export function validateCopiedV1ProxyData(
    copied: JsonValue,
    overrides: Partial<SnapshotLimits> = {},
    viewOwnedRefDeclarations = false,
): V1ProxyDataResult {
    const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...overrides };
    const envelope = parseEnvelope(copied);
    try {
        const root = record(copied, '$');
        exact(root,
            ['schemaVersion', 'appId', 'instanceId', 'producerSeq', 'sourceEpoch', 'capturedAt', 'views', 'refs', 'tools'],
            [], '$');
        if (root.schemaVersion !== 1) fail('$.schemaVersion', 'Unsupported Snapshot schema version');
        string(root.appId, '$.appId');
        string(root.instanceId, '$.instanceId');
        integer(root.producerSeq, '$.producerSeq', 1);
        integer(root.sourceEpoch, '$.sourceEpoch');
        integer(root.capturedAt, '$.capturedAt');

        const viewValues = array(root.views, '$.views');
        notMore(viewValues.length, limits.maxViews, '$.views');
        const viewMap = new Map<string, { generation: string; type: string }>();
        for (const [index, value] of viewValues.entries()) {
            const path = '$.views[' + index + ']';
            const view = record(value, path);
            exact(view, ['id', 'generation', 'type', 'name', 'kind', 'content'], [], path);
            const viewId = string(view.id, path + '.id');
            if (viewMap.has(viewId)) fail(path + '.id', 'Duplicate View ID');
            const generation = string(view.generation, path + '.generation');
            const type = string(view.type, path + '.type');
            string(view.name, path + '.name');
            if (view.kind !== 'state' && view.kind !== 'instruction') fail(path + '.kind', 'Unknown View kind');
            const content = record(view.content, path + '.content');
            exact(content, ['format', 'value'], [], path + '.content');
            if (content.format === 'markdown-v1') {
                if (typeof content.value !== 'string') fail(path + '.content.value', 'Markdown content must be string');
            } else if (content.format !== 'semantic-v1') {
                fail(path + '.content.format', 'Unknown View content format');
            }
            withinBytes(content.value, limits.maxViewContentBytes, path + '.content.value');
            viewMap.set(viewId, { generation, type });
        }

        const refValues = record(root.refs, '$.refs');
        notMore(Object.keys(refValues).length, limits.maxRefs, '$.refs');
        for (const [key, value] of Object.entries(refValues)) {
            const path = '$.refs[' + JSON.stringify(key) + ']';
            const ref = record(value, path);
            exact(ref, ['id', 'ownerViewId', 'ownerViewGeneration', 'refType', 'target'], [], path);
            const id = string(ref.id, path + '.id');
            const viewId = string(ref.ownerViewId, path + '.ownerViewId');
            const generation = string(ref.ownerViewGeneration, path + '.ownerViewGeneration');
            string(ref.refType, path + '.refType');
            if (key !== refKey(viewId, generation, id)) fail(path, 'Ref index key does not match scoped identity');
            const view = viewMap.get(viewId);
            if (!view || view.generation !== generation) fail(path, 'Ref owner View instance not mounted');
            const target = record(ref.target, path + '.target');
            if (target.kind === 'snapshot-value') {
                exact(target, ['kind', 'payload'], [], path + '.target');
                withinBytes(target.payload, limits.maxRefPayloadBytes, path + '.target.payload');
            } else if (target.kind === 'entity') {
                exact(target, ['kind', 'entityType', 'entityId'], ['entityVersion'], path + '.target');
                string(target.entityType, path + '.target.entityType');
                string(target.entityId, path + '.target.entityId');
                if (Object.hasOwn(target, 'entityVersion')) {
                    string(target.entityVersion, path + '.target.entityVersion');
                }
            } else fail(path + '.target.kind', 'Unknown Ref target kind');
        }

        const toolValues = record(root.tools, '$.tools');
        notMore(Object.keys(toolValues).length, limits.maxTools, '$.tools');
        const mountedTypes = new Set([...viewMap.values()].map(view => view.type));
        for (const [key, value] of Object.entries(toolValues)) {
            const path = '$.tools[' + JSON.stringify(key) + ']';
            const tool = record(value, path);
            exact(tool, ['id', 'name', 'viewType', 'description', 'inputSchema', 'visible', 'isMutating'],
                ['declaredByViewId', 'declaredByViewGeneration'], path);
            const id = string(tool.id, path + '.id');
            if (key !== id) fail(path, 'Tool index key does not match Tool ID');
            string(tool.name, path + '.name');
            const viewType = string(tool.viewType, path + '.viewType');
            string(tool.description, path + '.description');
            flag(tool.visible, path + '.visible');
            const isMutating = flag(tool.isMutating, path + '.isMutating');
            const schema = record(tool.inputSchema, path + '.inputSchema');
            if (schema.type !== 'object') fail(path + '.inputSchema.type', 'Tool inputs must have an object JSON schema');
            withinBytes(schema, limits.maxToolSchemaBytes, path + '.inputSchema');
            validateVersionedToolRefDeclarations(schema, isMutating, viewOwnedRefDeclarations, path + '.inputSchema');
            if (tool.visible && !mountedTypes.has(viewType)) {
                fail(path + '.visible', 'Visible Tool has no mounted View of its target ViewType');
            }
            const declaresOwner = Object.hasOwn(tool, 'declaredByViewId');
            const hasGeneration = Object.hasOwn(tool, 'declaredByViewGeneration');
            if (declaresOwner !== hasGeneration) {
                fail(path, 'Tool declaration View identity and generation must be supplied together');
            }
            if (declaresOwner) {
                const viewId = string(tool.declaredByViewId, path + '.declaredByViewId');
                const generation = string(tool.declaredByViewGeneration, path + '.declaredByViewGeneration');
                if (viewMap.get(viewId)?.generation !== generation) fail(path, 'Tool declaration owner has unmounted');
            }
        }

        const content = {
            views: viewValues,
            refs: refValues,
            tools: toolValues,
        } as const;
        const canonicalContent = canonicalJson(content);
        const bytes = utf8Size(canonicalJson(copied));
        if (bytes > limits.maxSnapshotBytes) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$', 'App Snapshot byte budget exceeded');
        }
        return Object.freeze({
            ok: true,
            value: Object.freeze({
                draft: copied as unknown as PreparedAppSnapshotDraft,
                canonicalContent,
                bytes,
            }),
        });
    } catch (error) {
        return Object.freeze({ ok: false, issue: asIssue(error), ...(envelope ? { envelope } : {}) });
    }
}

function asIssue(error: unknown): SnapshotIssue {
    if (error instanceof SnapshotDataError) {
        return Object.freeze({ code: error.code, message: error.message, path: error.path });
    }
    return Object.freeze({
        code: 'SNAPSHOT_SERIALIZATION_ERROR',
        message: error instanceof Error ? error.message : 'Invalid Snapshot payload',
        path: '$',
    });
}
