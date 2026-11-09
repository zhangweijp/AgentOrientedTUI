import { MARKDOWN_VIEW_FORMAT } from '../core/snapshot/types.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../core/snapshot/types.js';
import { refKey } from '../core/snapshot/snapshot-support.js';
import type { JsonValue, RefTarget, PreparedAppSnapshotDraftV3, ViewSnapshotV2, RefDescriptorV2, ToolDescriptorV3 } from '../core/snapshot/types.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';
import type { ViewInstance } from '../core/tool/view-owned-tools.js';

export interface DomSnapshotSource {
    getViewOwnedViewInstances(): readonly ViewInstance[];
    getToolDefinitions(): readonly ToolDescriptorV3[];
    getViewRefs(): readonly { viewId: string; refId: string; value: object; refType?: string }[];
}

export interface DomCaptureInput {
    readonly appId: string;
    readonly instanceId: string;
    readonly sourceEpoch: number;
    readonly producerSeq: number;
    readonly capturedAt: number;
    readonly container: Element;
    readonly fragments: readonly WorkerRuntimeViewFragment[];
    readonly kernel: DomSnapshotSource | null;
}

/** Runtime snapshot values are data only; they do not carry entity execution authority. */
function projectedRefTarget(payload: unknown): RefTarget {
    return { kind: 'snapshot-value', payload: payload as JsonValue };
}


export function captureDOMSnapshot(input: DomCaptureInput): PreparedAppSnapshotDraftV3 {
    if (typeof input.kernel?.getViewOwnedViewInstances !== 'function' ||
        typeof input.kernel.getToolDefinitions !== 'function' ||
        typeof input.kernel.getViewRefs !== 'function') throw new Error('V3 requires Runtime-owned inventory interfaces');
    const registeredViews = input.kernel.getViewOwnedViewInstances();
    const definitions = input.kernel.getToolDefinitions();
    const byId = new Map(registeredViews.map(view => [view.viewId, view]));
    if (byId.size !== registeredViews.length) throw new Error('Duplicate Runtime View ID');

    const domNodes = new Map<string, Element>();
    for (const node of Array.from(input.container.querySelectorAll('[data-view-id]'))) {
        const id = node.getAttribute('data-view-id');
        if (!id || domNodes.has(id)) throw new Error('Duplicate or missing DOM View identity');
        domNodes.set(id, node);
    }
    if (registeredViews.length !== input.fragments.length || domNodes.size !== registeredViews.length ||
        new Set(input.fragments.map(fragment => fragment.viewId)).size !== registeredViews.length) {
        throw new Error('Runtime View and DOM projection are not a complete set');
    }
    const views: ViewSnapshotV2[] = input.fragments.map(fragment => {
        const view = byId.get(fragment.viewId);
        const node = domNodes.get(fragment.viewId);
        if (!view || !node ||
            node.getAttribute('data-view-instance-id') !== view.viewInstanceId ||
            view.viewType !== fragment.viewType) {
            throw new Error('V3 View identity is not bound to the mounted Runtime View');
        }
        return {
            id: fragment.viewId,
            viewInstanceId: view.viewInstanceId,
            type: fragment.viewType,
            name: fragment.viewName || fragment.viewId,
            kind: fragment.kind,
            content: { format: MARKDOWN_VIEW_FORMAT, value: fragment.markup },
        };
    });

    const refs: Record<string, RefDescriptorV2> = Object.create(null);
    for (const { viewId, refId: id, value, refType } of input.kernel.getViewRefs()) {
        const view = byId.get(viewId);
        if (!view) throw new Error('V3 Ref owner is not mounted');
        refs[refKey(viewId, view.viewInstanceId, id)] = {
            id, ownerViewId: viewId, ownerViewInstanceId: view.viewInstanceId,
            refType: typeof refType === 'string' && refType.trim() ? refType : 'unknown',
            target: projectedRefTarget(value),
        };
    }

    const tools: Record<string, ToolDescriptorV3> = Object.create(null);
    for (const def of definitions) {
        if (Object.hasOwn(tools, def.id)) throw new Error('Duplicate V3 Tool definition');
        if (def.execution.kind !== 'view-type') throw new Error('Unsupported Tool execution kind');
        if (!def.execution.activationId || !registeredViews.some(view => view.viewType === def.viewType)) {
            throw new Error('V3 ViewType Tool has no live matching View or activation identity');
        }
        tools[def.id] = {
            id: def.id, name: def.name, viewType: def.viewType,
            description: def.description, inputSchema: def.inputSchema,
            execution: { kind: 'view-type', activationId: def.execution.activationId },
        };
    }
    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        appId: input.appId,
        instanceId: input.instanceId,
        producerSeq: input.producerSeq,
        sourceEpoch: input.sourceEpoch,
        capturedAt: input.capturedAt,
        views, refs, tools,
    };
}
