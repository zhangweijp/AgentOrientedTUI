import { canonicalJson } from '../snapshot/json.js';
import type {
    SnapshotIssue, SnapshotIssueCode, SnapshotStore, ToolDescriptorV2, ToolTargetV2,
} from '../snapshot/types.js';

export interface ToolSourceRequest {
    readonly snapshotId: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly toolId: string;
    readonly viewId: string;
}

export type ToolSourceSelection =
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>
    | Readonly<{
        status: 'found';
        tool: ToolDescriptorV2;
        target: ToolTargetV2;
        snapshotId: string;
        release(): void;
    }>;

function denied(
    code: SnapshotIssueCode, message: string, snapshotId: string,
): Extract<ToolSourceSelection, { status: 'rejected' }> {
    return Object.freeze({
        status: 'rejected', issue: Object.freeze({ code, message, snapshotId }),
    });
}

/**
 * Internal, read-only M4 Stage-2 source resolver. The source must be an
 * actual Runtime-owned, still-leasable committed AppSnapshot V2, never a
 * caller-supplied Tool JSON. This returns NO Handler and executes NOTHING.
 *
 * A future execution adapter must independently re-check live App/View/Tool
 * identity, operation permissions and business state before invoking a Handler.
 */
export function acquireToolSource(
    store: SnapshotStore,
    request: ToolSourceRequest,
): ToolSourceSelection {
    const latest = store.readLatest(request.appId);
    if (latest.status !== 'ready') {
        return denied('SNAPSHOT_UNREADY', 'App snapshot is not currently ready', request.snapshotId);
    }
    if (latest.snapshot.instanceId !== request.instanceId) {
        return denied('APP_INSTANCE_MISMATCH', 'App execution instance has changed', request.snapshotId);
    }
    const acquired = store.acquire(request.snapshotId);
    if (acquired.status === 'rejected') return acquired;
    let keepLease = false;
    try {
        const snapshot = acquired.lease.snapshot;
        if (snapshot.appId !== request.appId || snapshot.instanceId !== request.instanceId) {
            return denied('APP_INSTANCE_MISMATCH', 'Tool source is from another App execution', request.snapshotId);
        }
        if (snapshot.schemaVersion !== 2) {
            return denied('SNAPSHOT_INVALID', 'View-owned Tool source requires Snapshot V2', request.snapshotId);
        }
        const tool = snapshot.tools[request.toolId];
        const sourceTarget = tool?.targets.find(target => target.viewId === request.viewId);
        if (!tool || !sourceTarget) {
            return denied('TOOL_UNAVAILABLE', 'Tool or target absent from source snapshot', request.snapshotId);
        }

        // A historical V2 viewInstanceId may not be rebound by a newer View
        // reusing the same visible developer-authored viewId.
        const current = latest.snapshot;
        if (current.schemaVersion !== 2) {
            return denied('SNAPSHOT_SOURCE_CONFLICT', 'Current App projection is not V2', request.snapshotId);
        }
        const currentView = current.views.find(view => view.id === sourceTarget.viewId);
        if (!currentView || currentView.viewInstanceId !== sourceTarget.viewInstanceId) {
            return denied('VIEW_INSTANCE_REVOKED', 'Source View instance has closed or changed', request.snapshotId);
        }
        const currentTool = current.tools[request.toolId];
        const currentTarget = currentTool?.targets.find(target => target.viewId === sourceTarget.viewId);
        if (!currentTool || !currentTarget) {
            return denied('TOOL_UNAVAILABLE', 'Current View no longer offers this Tool', request.snapshotId);
        }
        if (currentTarget.viewInstanceId !== sourceTarget.viewInstanceId ||
            currentTarget.bindingVersion !== sourceTarget.bindingVersion ||
            canonicalJson({
                id: currentTool.id, name: currentTool.name, viewType: currentTool.viewType,
                description: currentTool.description, inputSchema: currentTool.inputSchema,
                isMutating: currentTool.isMutating,
            }) !== canonicalJson({
                id: tool.id, name: tool.name, viewType: tool.viewType,
                description: tool.description, inputSchema: tool.inputSchema,
                isMutating: tool.isMutating,
            })) {
            return denied('TOOL_SOURCE_STALE', 'Tool definition or binding has changed', request.snapshotId);
        }
        keepLease = true;
        return Object.freeze({
            status: 'found' as const,
            tool,
            target: sourceTarget,
            snapshotId: snapshot.id,
            release: () => acquired.lease.release(),
        });
    } finally {
        if (!keepLease) acquired.lease.release();
    }
}


export type VersionedEntitySourceSelection =
    | Extract<ToolSourceSelection, { status: 'rejected' }>
    | Readonly<{
        status: 'found';
        tool: ToolDescriptorV2;
        target: ToolTargetV2;
        snapshotId: string;
        resource: Readonly<{
            entityType: string;
            entityId: string;
            entityVersion: string;
        }>;
        release(): void;
    }>;

/**
 * Versioned entity precondition derived from a pinned V2 Snapshot Ref.
 * Still NOT a write permit: the resource adapter must perform the version
 * comparison at the actual mutation, after separate user/role authorization.
 */
export function acquireVersionedEntitySource(
    store: SnapshotStore,
    request: ToolSourceRequest & { readonly refId: string },
): VersionedEntitySourceSelection {
    const selected = acquireToolSource(store, request);
    if (selected.status === 'rejected') return selected;
    let retained = false;
    try {
        if (!selected.tool.isMutating) {
            return denied('RESOURCE_VERSION_REQUIRED',
                'Resource mutation requires an explicitly mutating Tool', request.snapshotId);
        }
        const refSelector = {
            snapshotId: selected.snapshotId,
            appId: request.appId,
            instanceId: request.instanceId,
            viewId: selected.target.viewId,
            viewInstanceId: selected.target.viewInstanceId,
            refId: request.refId,
        };
        const observed = store.resolveRef(refSelector);
        if (observed.status === 'rejected') return observed;
        if (observed.target.kind !== 'entity' || !observed.target.entityVersion) {
            return denied('RESOURCE_VERSION_REQUIRED',
                'Mutation source must have a versioned entity Ref', request.snapshotId);
        }

        const latest = store.readLatest(request.appId);
        if (latest.status !== 'ready' || latest.snapshot.schemaVersion !== 2 ||
            latest.snapshot.instanceId !== request.instanceId) {
            return denied('SNAPSHOT_UNREADY', 'Latest V2 source is unavailable', request.snapshotId);
        }
        const current = store.resolveRef({ ...refSelector, snapshotId: latest.snapshot.id });
        if (current.status === 'rejected') return current;
        if (current.target.kind !== 'entity' ||
            current.target.entityType !== observed.target.entityType ||
            current.target.entityId !== observed.target.entityId ||
            current.target.entityVersion !== observed.target.entityVersion) {
            return denied('RESOURCE_VERSION_STALE',
                'Entity identity or version changed since the source Snapshot', request.snapshotId);
        }
        retained = true;
        return Object.freeze({
            status: 'found' as const,
            tool: selected.tool,
            target: selected.target,
            snapshotId: selected.snapshotId,
            resource: Object.freeze({
                entityType: observed.target.entityType,
                entityId: observed.target.entityId,
                entityVersion: observed.target.entityVersion,
            }),
            release: selected.release,
        });
    } finally {
        if (!retained) selected.release();
    }
}
