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
            canonicalJson(currentTarget.selector ? { ...currentTarget.selector } : null) !== canonicalJson(sourceTarget.selector ? { ...sourceTarget.selector } : null) ||
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
