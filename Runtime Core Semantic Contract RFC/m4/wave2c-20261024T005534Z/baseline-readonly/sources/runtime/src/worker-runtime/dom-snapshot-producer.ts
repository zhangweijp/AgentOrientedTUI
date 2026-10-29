/**
 * M2 DOM-specific, best-effort shadow Producer.
 *
 * This adapts the *existing* Preact/DOM projection and AppKernel registries
 * to the pure AppSnapshot Draft contract. It is NOT yet a strict Producer:
 * SDK passive effects can register after DOM paint, and refs can change without
 * a DOM mutation (M0 evidence). M3 must supply an actual projection barrier.
 */
import { refKey } from '../core/snapshot/validator.js';
import type {
    JsonValue, PreparedAppSnapshotDraft, RefDescriptor, RefTarget,
    ToolDescriptor, ViewSnapshot, PreparedAppSnapshotDraftV2,
    ViewSnapshotV2, RefDescriptorV2, ToolDescriptorV2,
} from '../core/snapshot/types.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';
import type { AggregatedViewTool, ViewInstance } from '../core/tool/view-owned-tools.js';

export interface LegacyTypeTool {
    readonly id: string;
    readonly name: string;
    readonly viewType: string;
    readonly description: string;
    readonly declaredByViewId?: string;
    readonly declaredByViewGeneration?: string;
    readonly params: Record<string, unknown>;
}

export interface LegacySnapshotRegistry {
    exportRefsToIndexMap?(): Record<string, unknown>;
    getAllTypeTools?(): Map<string, LegacyTypeTool[]>;
    getViewOwnedViewInstances?(): readonly ViewInstance[];
    getViewOwnedToolDefinitions?(): readonly AggregatedViewTool[];
}

export interface DomCaptureInput {
    readonly appId: string;
    readonly instanceId: string;
    readonly sourceEpoch: number;
    readonly producerSeq: number;
    readonly capturedAt: number;
    readonly container: Element;
    readonly fragments: readonly WorkerRuntimeViewFragment[];
    readonly kernel: LegacySnapshotRegistry | null;
}

/** V2-only SDK entity marker, never a permission or a model-supplied Ref. */
function projectedRefTarget(payload: unknown): RefTarget {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { kind: 'snapshot-value', payload: payload as JsonValue };
    }
    const descriptors = Object.getOwnPropertyDescriptors(payload);
    const marker = descriptors.$aotuiEntityRefV1;
    if (!marker) return { kind: 'snapshot-value', payload: payload as JsonValue };
    if (Object.keys(descriptors).length !== 1 || !('value' in marker) ||
        !marker.enumerable || !marker.value || typeof marker.value !== 'object' ||
        Array.isArray(marker.value)) throw new Error('Invalid SDK entity Ref marker');
    const parts = Object.getOwnPropertyDescriptors(marker.value);
    const keys = ['entityType', 'entityId', 'entityVersion'];
    if (Object.keys(parts).length !== 3 || keys.some(key =>
        !parts[key] || !('value' in parts[key]) ||
        !parts[key].enumerable || typeof parts[key].value !== 'string' ||
        !parts[key].value.trim())) {
        throw new Error('Invalid SDK versioned entity identity');
    }
    return {
        kind: 'entity',
        entityType: parts.entityType.value,
        entityId: parts.entityId.value,
        entityVersion: parts.entityVersion.value,
    };
}

interface ViewMountIdentity {
    readonly node: Element;
    readonly generation: string;
}

/** Deliberately a Worker/DOM adapter; none of these dependencies enter Core. */
export class DomSnapshotShadowProducer {
    private viewIdentities = new Map<string, ViewMountIdentity>();
    private nextMount = 0;

    capture(input: DomCaptureInput): PreparedAppSnapshotDraft {
        const nodes = Array.from(input.container.querySelectorAll('[data-view-id]'));
        const next = new Map<string, ViewMountIdentity>();
        for (const node of nodes) {
            const id = node.getAttribute('data-view-id');
            if (!id) continue;
            const existing = this.viewIdentities.get(id);
            const sdkGeneration = node.getAttribute('data-view-generation');
            next.set(id, {
                node,
                // Prefer SDK owner token: DOM nodes may be recycled across distinct mounts.
                generation: sdkGeneration || (existing && existing.node === node ? existing.generation
                    : 'dom_mount_' + ++this.nextMount),
            });
        }
        this.viewIdentities = next;

        const views: ViewSnapshot[] = input.fragments.map(view => ({
            id: view.viewId,
            generation: next.get(view.viewId)?.generation ?? 'missing_dom_owner',
            type: view.viewType,
            name: view.viewName || view.viewId,
            kind: view.kind === 'application-instruction' ? 'instruction' : 'state',
            content: { format: 'markdown-v1', value: view.markup },
        }));

        const refs: Record<string, RefDescriptor> = Object.create(null);
        for (const [fullKey, payload] of Object.entries(input.kernel?.exportRefsToIndexMap?.() ?? {})) {
            const separator = fullKey.indexOf(':');
            if (separator <= 0 || separator === fullKey.length - 1) {
                throw new Error('Malformed Ref registry identity');
            }
            const viewId = fullKey.slice(0, separator);
            const refId = fullKey.slice(separator + 1);
            const generation = next.get(viewId)?.generation ?? 'missing_dom_owner';
            const key = refKey(viewId, generation, refId);
            refs[key] = {
                id: refId, ownerViewId: viewId, ownerViewGeneration: generation,
                refType: 'unknown', // SDK registration currently does not preserve itemType.
                target: {
                    kind: 'snapshot-value',
                    // The Core validator owns strict JSON copying; this is an untrusted
                    // legacy object and could fail structured clone in IPC.
                    payload: payload as JsonValue,
                },
            };
        }

        const mountedViewTypes = new Set(views.map(view => view.type));
        const tools: Record<string, ToolDescriptor> = Object.create(null);
        const entries = input.kernel?.getAllTypeTools?.() ?? new Map<string, LegacyTypeTool[]>();
        for (const [viewType, toolsForType] of entries) {
            for (const tool of toolsForType) {
                if (Object.hasOwn(tools, tool.id)) throw new Error('Duplicate Tool identity');
                tools[tool.id] = {
                    id: tool.id,
                    name: tool.name,
                    viewType,
                    description: tool.description,
                    inputSchema: paramsToJsonSchema(tool.params),
                    ...(tool.declaredByViewId && tool.declaredByViewGeneration ? {
                        declaredByViewId: tool.declaredByViewId,
                        declaredByViewGeneration: tool.declaredByViewGeneration,
                    } : {}),
                    visible: mountedViewTypes.has(viewType),
                    isMutating: true, // SDK has no read-only contract; fail conservative.
                };
            }
        }
        return {
            schemaVersion: 1,
            appId: input.appId,
            instanceId: input.instanceId,
            producerSeq: input.producerSeq,
            sourceEpoch: input.sourceEpoch,
            capturedAt: input.capturedAt,
            views, refs, tools,
        };
    }

    /**
     * M4 Stage 2: observational V2 Draft. Not a Strict Producer.
     * Only valid when all TypeTools use View-owned bindings; mixed legacy
     * Root-level tools keep the V1 shadow until their source identity migrates.
     */
    captureV2(input: DomCaptureInput): PreparedAppSnapshotDraftV2 {
        const registeredViews = input.kernel?.getViewOwnedViewInstances?.() ?? [];
        const definitions = input.kernel?.getViewOwnedToolDefinitions?.() ?? [];
        if (!registeredViews.length) throw new Error('No Runtime-owned View instances for V2');
        const byId = new Map(registeredViews.map(view => [view.viewId, view]));
        if (byId.size !== registeredViews.length) throw new Error('Duplicate Runtime View ID');

        const domNodes = new Map<string, Element>();
        for (const node of Array.from(input.container.querySelectorAll('[data-view-id]'))) {
            const id = node.getAttribute('data-view-id');
            if (!id || domNodes.has(id)) throw new Error('Duplicate or missing DOM View identity');
            domNodes.set(id, node);
        }
        if (registeredViews.length !== input.fragments.length) {
            throw new Error('Runtime View and DOM projection are not a complete set');
        }
        const views: ViewSnapshotV2[] = input.fragments.map(fragment => {
            const view = byId.get(fragment.viewId);
            const node = domNodes.get(fragment.viewId);
            if (!view || !node ||
                node.getAttribute('data-view-instance-id') !== view.viewInstanceId ||
                view.viewType !== fragment.viewType) {
                throw new Error('V2 View identity is not bound to the mounted Runtime View');
            }
            return {
                id: fragment.viewId,
                viewInstanceId: view.viewInstanceId,
                type: fragment.viewType,
                name: fragment.viewName || fragment.viewId,
                kind: fragment.kind === 'application-instruction' ? 'instruction' : 'state',
                content: { format: 'markdown-v1', value: fragment.markup },
            };
        });

        const refs: Record<string, RefDescriptorV2> = Object.create(null);
        for (const [fullKey, payload] of Object.entries(input.kernel?.exportRefsToIndexMap?.() ?? {})) {
            const sep = fullKey.indexOf(':');
            if (sep <= 0 || sep === fullKey.length - 1) throw new Error('Malformed V2 Ref registry key');
            const viewId = fullKey.slice(0, sep);
            const id = fullKey.slice(sep + 1);
            const view = byId.get(viewId);
            if (!view) throw new Error('V2 Ref owner is not mounted');
            refs[refKey(viewId, view.viewInstanceId, id)] = {
                id, ownerViewId: viewId, ownerViewInstanceId: view.viewInstanceId,
                refType: 'unknown',
                target: projectedRefTarget(payload),
            };
        }

        const tools: Record<string, ToolDescriptorV2> = Object.create(null);
        for (const def of definitions) {
            if (def.appId !== input.appId || def.appInstanceId !== input.instanceId) {
                throw new Error('V2 Tool definition from another Runtime App instance');
            }
            if (Object.hasOwn(tools, def.id)) throw new Error('Duplicate V2 Tool definition');
            for (const target of def.targets) {
                const bound = byId.get(target.viewId);
                if (!bound || bound.viewInstanceId !== target.viewInstanceId ||
                    bound.viewType !== def.viewType) {
                    throw new Error('V2 Tool references an unmounted View instance');
                }
            }
            tools[def.id] = {
                id: def.id, name: def.name, viewType: def.viewType,
                description: def.description, inputSchema: def.inputSchema,
                isMutating: def.isMutating,
                targets: def.targets.map(target => ({
                    viewId: target.viewId, viewInstanceId: target.viewInstanceId,
                    bindingVersion: target.bindingVersion,
                })),
            };
        }
        return {
            schemaVersion: 2,
            appId: input.appId,
            instanceId: input.instanceId,
            producerSeq: input.producerSeq,
            sourceEpoch: input.sourceEpoch,
            capturedAt: input.capturedAt,
            views, refs, tools,
        };
    }

    reset(): void {
        this.viewIdentities.clear();
        this.nextMount = 0;
    }
}

/** Mapping is intentionally conservative; do not silently invent unsupported types. */
export function paramsToJsonSchema(params: Record<string, unknown>): JsonValue {
    const properties: Record<string, JsonValue> = Object.create(null);
    const required: string[] = [];
    for (const [name, def] of Object.entries(params)) {
        if (def === null || typeof def !== 'object' || Array.isArray(def)) {
            throw new Error('Invalid Tool parameter schema: ' + name);
        }
        const field = def as Record<string, unknown>;
        const type = field.type;
        const prop: Record<string, JsonValue> = Object.create(null);
        switch (type) {
            case 'string':
            case 'number':
            case 'boolean':
            case 'object':
                prop.type = type;
                break;
            case 'reference':
                prop.type = 'string';
                break;
            case 'enum': {
                if (!Array.isArray(field.options) || !field.options.length ||
                    field.options.some(option => typeof option !== 'string')) {
                    throw new Error('Invalid Tool enum parameter: ' + name);
                }
                prop.type = 'string';
                prop.enum = field.options as string[];
                break;
            }
            case 'array': {
                prop.type = 'array';
                const itemType = field.itemType;
                if (itemType !== 'string' && itemType !== 'number' &&
                    itemType !== 'boolean' && itemType !== 'object') {
                    throw new Error('Unsupported array item type for Tool parameter: ' + name);
                }
                prop.items = { type: itemType };
                break;
            }
            default:
                throw new Error('Unsupported Tool parameter type: ' + name);
        }
        if (typeof field.desc === 'string') prop.description = field.desc;
        else if (typeof field.description === 'string') prop.description = field.description;
        if (field.required === true) required.push(name);
        if (field.constraints !== undefined) {
            const constraints = field.constraints;
            if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) {
                throw new Error('Invalid Tool constraints for ' + name);
            }
            const c = constraints as Record<string, unknown>;
            if (typeof c.minLength === 'number') prop.minLength = c.minLength;
            if (typeof c.maxLength === 'number') prop.maxLength = c.maxLength;
            if (typeof c.pattern === 'string') prop.pattern = c.pattern;
            if (typeof c.min === 'number') prop.minimum = c.min;
            if (typeof c.max === 'number') prop.maximum = c.max;
        }
        properties[name] = prop;
    }
    return { type: 'object', properties, required };
}
