import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/types.js';
import { canonicalJson } from '../snapshot/json.js';
import type {
    ObservedToolExecutionV3, SnapshotIssue, SnapshotIssueCode, SnapshotStore, ToolDescriptorV3,
} from '../snapshot/types.js';

export interface ToolSourceRequest {
    readonly snapshotId: string;
    readonly appId: string;
    readonly instanceId: string;
    readonly toolId: string;
    readonly execution: ObservedToolExecutionV3;
}

export type ToolSourceSelection =
    | Readonly<{ status: 'rejected'; issue: SnapshotIssue }>
    | Readonly<{
        status: 'found';
        tool: ToolDescriptorV3;
        execution: ObservedToolExecutionV3;
        snapshotId: string;
        release(): void;
    }>;

function denied(code: SnapshotIssueCode, message: string, snapshotId: string): Extract<ToolSourceSelection, { status: 'rejected' }> {
    return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message, snapshotId }) });
}

function samePublicTool(a: ToolDescriptorV3, b: ToolDescriptorV3): boolean {
    return a.id === b.id && a.name === b.name && a.viewType === b.viewType &&
        a.description === b.description &&
        canonicalJson(a.inputSchema) === canonicalJson(b.inputSchema);
}

/** Resolve one exact observed execution binding against both the retained and current V3 snapshot. */
export function acquireToolSource(store: SnapshotStore, request: ToolSourceRequest): ToolSourceSelection {
    const latest = store.readLatest(request.appId);
    if (latest.status !== 'ready') return denied('SNAPSHOT_UNREADY', 'App snapshot is not currently ready', request.snapshotId);
    if (latest.snapshot.instanceId !== request.instanceId) return denied('APP_INSTANCE_MISMATCH', 'App execution instance has changed', request.snapshotId);
    const acquired = store.acquire(request.snapshotId);
    if (acquired.status === 'rejected') return acquired;
    let keepLease = false;
    try {
        const snapshot = acquired.lease.snapshot;
        if (snapshot.appId !== request.appId || snapshot.instanceId !== request.instanceId) {
            return denied('APP_INSTANCE_MISMATCH', 'Tool source is from another App execution', request.snapshotId);
        }
        if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return denied('SNAPSHOT_INVALID', 'Tool source requires Snapshot V3', request.snapshotId);
        const tool = snapshot.tools[request.toolId];
        if (!tool || tool.id !== request.toolId) return denied('TOOL_UNAVAILABLE', 'Tool is absent from its source snapshot', request.snapshotId);
        const execution = request.execution;
        if (tool.execution.kind !== request.execution.kind) return denied('TOOL_SOURCE_CONFLICT', 'Execution kind changed since observation', request.snapshotId);
        if (execution.kind !== 'view-type' || tool.execution.kind !== 'view-type' ||
            tool.execution.activationId !== execution.activationId) {
            return denied('TOOL_SOURCE_CONFLICT', 'Observed type activation does not match its source Tool', request.snapshotId);
        }

        const current = latest.snapshot;
        if (current.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return denied('SNAPSHOT_SOURCE_CONFLICT', 'Current App projection is not V3', request.snapshotId);
        const currentTool = current.tools[request.toolId];
        if (!currentTool) return denied('TOOL_UNAVAILABLE', 'Current App no longer offers this Tool', request.snapshotId);
        if (!samePublicTool(currentTool, tool) || currentTool.execution.kind !== execution.kind) {
            return denied('TOOL_SOURCE_STALE', 'Current Tool contract has changed since observation', request.snapshotId);
        }
        if (currentTool.execution.kind !== 'view-type' || currentTool.execution.activationId !== execution.activationId) {
            return denied('TOOL_SOURCE_STALE', 'Type Tool activation has changed since observation', request.snapshotId);
        }
        if (!current.views.some(view => view.type === currentTool.viewType)) {
            return denied('TOOL_UNAVAILABLE', 'No matching ViewType is active', request.snapshotId);
        }
        keepLease = true;
        return Object.freeze({ status: 'found', tool, execution: request.execution, snapshotId: snapshot.id,
            release: acquired.lease.release });
    } finally {
        if (!keepLease) acquired.lease.release();
    }
}
