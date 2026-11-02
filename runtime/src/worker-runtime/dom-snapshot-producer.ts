import { refKey } from '../core/snapshot/snapshot-support.js';
import type { JsonValue, RefTarget, PreparedAppSnapshotDraftV2, ViewSnapshotV2, RefDescriptorV2, ToolDescriptorV2 } from '../core/snapshot/types.js';
import type { WorkerRuntimeViewFragment } from './view-fragment-extractor.js';
import type { AggregatedViewTool, ViewInstance } from '../core/tool/view-owned-tools.js';

export interface DomSnapshotSource {
    getViewOwnedViewInstances(): readonly ViewInstance[];
    getViewOwnedToolDefinitions(): readonly AggregatedViewTool[];
    getViewRefs(): readonly { viewId: string; refId: string; value: object }[];
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


export function captureDOMSnapshot(input: DomCaptureInput): PreparedAppSnapshotDraftV2 {
    if (typeof input.kernel?.getViewOwnedViewInstances !== 'function' ||
        typeof input.kernel.getViewOwnedToolDefinitions !== 'function' ||
        typeof input.kernel.getViewRefs !== 'function') throw new Error('V2 requires Runtime-owned inventory interfaces');
    const registeredViews = input.kernel.getViewOwnedViewInstances();
    const definitions = input.kernel.getViewOwnedToolDefinitions();
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
    for (const { viewId, refId: id, value } of input.kernel.getViewRefs()) {
        const view = byId.get(viewId);
        if (!view) throw new Error('V2 Ref owner is not mounted');
        refs[refKey(viewId, view.viewInstanceId, id)] = {
            id, ownerViewId: viewId, ownerViewInstanceId: view.viewInstanceId,
            refType: 'unknown',
            target: projectedRefTarget(value),
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
                ...(target.selector ? { selector: target.selector } : {}),
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
