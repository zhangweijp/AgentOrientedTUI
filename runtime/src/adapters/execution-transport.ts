import { APP_LIFECYCLE_PROTOCOL, DEFAULT_SNAPSHOT_LIMITS, MARKDOWN_VIEW_FORMAT, SNAPSHOT_SCHEMA_VERSION,
    SnapshotDataError, compileToolParameters, copyJson, refKey } from '@aotui/core';
import type { PreparedAppSnapshotDraft, RefDescriptor, SnapshotIssue, ToolDescriptor } from '@aotui/core';
import { captureSnapshotPrepareIssue, hostedObservationCapacityIssue, validatePreparedSnapshot } from '@aotui/core/producer';
import type { AppExecutionBackend, AppExecutionEvent, AppExecutionHandle, AppExecutionIssue, AppExecutionLaunch,
    AppExecutionProjection, AppExecutionRequest } from '../spi/runtime/execution-backend.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../spi/worker-protocol/index.js';
import { WORKER_PROTOCOL } from '../spi/worker-protocol/types.js';

export type TransportEvent =
    | { readonly kind: 'message'; readonly message: WorkerToMainMessage }
    | { readonly kind: 'error'; readonly error: Error }
    | { readonly kind: 'channelEnded' | 'exited'; readonly issue?: AppExecutionIssue };
export type TransportEvents = (event: TransportEvent) => void;
export interface ExecutionTransport {
    postMessage(message: MainToWorkerMessage): void;
}
export interface ExecutionConnection {
    readonly transport: ExecutionTransport;
    readonly terminate: () => void | Promise<unknown>;
}

const claimedExecutions = new WeakSet<AppExecutionHandle>();

function toolId(appId: string, viewType: string, name: string): string {
    return JSON.stringify([appId, viewType, name]);
}

function draftOf(raw: AppExecutionProjection, source: Pick<AppExecutionLaunch, 'appId' | 'instanceId'>,
    producerSeq: number): PreparedAppSnapshotDraft {
    const { appId, instanceId } = source;
    const limits = DEFAULT_SNAPSHOT_LIMITS;
    const frame = copyJson(raw, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes,
        maxApproxBytes: limits.maxSnapshotBytes * 2 }) as unknown as AppExecutionProjection;
    const tools: Record<string, ToolDescriptor> = Object.create(null);
    for (const [index, tool] of frame.tools.entries()) {
        const key = toolId(appId, tool.viewType, tool.name);
        if (Object.hasOwn(tools, key)) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.tools', 'Duplicate Tool definition');
        const compiled = compileToolParameters(tool.inputSchema);
        if (!compiled.ok) {
            const { code, path, message } = compiled.issue;
            const issueCode = code === 'PARAMETER_DECLARATION_CAPACITY' ? 'TOOL_SCHEMA_CAPACITY'
                : code === 'PARAMETER_DECLARATION_UNSUPPORTED' ? 'TOOL_SCHEMA_UNSUPPORTED' : 'TOOL_SCHEMA_INVALID';
            throw new SnapshotDataError(issueCode,
                '$.tools[' + index + '].inputSchema' + path.slice(1), message);
        }
        tools[key] = { ...tool, id: key, inputSchema: compiled.contract.schema };
    }
    const refs: Record<string, RefDescriptor> = Object.create(null);
    for (const { id, viewId, viewInstanceId, scope, refType, array, valueSchema, value } of frame.refs) {
        const key = refKey(viewId, viewInstanceId, id);
        if (Object.hasOwn(refs, key)) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.refs', 'Duplicate Ref in App frame');
        refs[key] = { id, ownerViewId: viewId, ownerViewInstanceId: viewInstanceId, scope, refType: refType ?? 'unknown',
            ...(array === undefined ? {} : { array }), valueSchema, target: { kind: 'snapshot-value', payload: value } };
    }
    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION, appId, instanceId, producerSeq, sourceEpoch: frame.revision, capturedAt: Date.now(),
        views: frame.views.map(({ id: viewId, type, name, region, body, viewInstanceId, canClose, tools }) => ({
            id: viewId, type, name, region, viewInstanceId, content: { format: MARKDOWN_VIEW_FORMAT, value: body },
            toolBindings: tools.map(({ name, activationId }) => ({ toolId: toolId(appId, type, name), activationId })),
            ...(canClose === undefined ? {} : { canClose }),
        })),
        refs, tools,
    };
}

function badFrame(error: unknown): SnapshotIssue {
    return error instanceof SnapshotDataError
        ? { code: error.code, message: error.message, path: error.path }
        : { code: 'SNAPSHOT_INVALID', message: 'Expected a complete execution projection', path: '$' };
}

function semanticRequest(message: MainToWorkerMessage): AppExecutionRequest {
    const { requestId: id } = message;
    switch (message.type) {
        case 'INIT': return { id, kind: 'initialize' };
        case 'APP_OPEN': return { id, kind: 'open' };
        case 'APP_STOP': return { id, kind: 'stop' };
        case 'APP_CLOSE': return { id, kind: 'close' };
        case 'FLUSH_PROJECTION': return { id, kind: 'observe' };
        case 'VIEW_CLOSE': return { id, kind: 'closeView', viewId: message.viewId, viewInstanceId: message.viewInstanceId };
        case 'VIEW_TOOL_INVOKE': {
            const { tool: { viewType, name }, receiver, effectiveArgs: input, localRefs } = message;
            return { id, kind: 'invoke', tool: { viewType, name }, receiver, input, localRefs };
        }
    }
}

/** Adapt public execution semantics to the single controller's request and publication intake. */
export function startExecutionBackend(backend: AppExecutionBackend, options: Omit<AppExecutionLaunch, 'checkProjection'>,
    emit: TransportEvents): ExecutionConnection {
    const { appId, instanceId, projectionLimits, toolsEnabled } = options;
    const appLifecycle = { protocol: APP_LIFECYCLE_PROTOCOL, instanceId };
    let producerSeq = 0, latestEpoch = 0;
    let initializationId: string | undefined, openId: string | undefined;
    const message = (message: WorkerToMainMessage) => emit({ kind: 'message', message });
    const check = (draft: PreparedAppSnapshotDraft) => {
        const checked = validatePreparedSnapshot(draft);
        if (!checked.ok) return checked.issue;
        return hostedObservationCapacityIssue(checked.value.draft, projectionLimits);
    };
    const failedFrame = (requestId: string | undefined, issue: SnapshotIssue, sourceEpoch: number) =>
        message({ type: 'SNAPSHOT_PREPARE_FAILED', ...(requestId === undefined ? {} : { requestId }),
            appId, instanceId, sourceEpoch, producerSeq, error: captureSnapshotPrepareIssue(issue) });
    const launch: AppExecutionLaunch = Object.freeze({ ...options, checkProjection(frame: AppExecutionProjection) {
        try { return check(draftOf(frame, options, 1)); }
        catch (error) { return badFrame(error); }
    } });
    const handle = backend.start(launch, (event: AppExecutionEvent) => {
        switch (event.kind) {
            case 'reply': {
                const requestId = event.id;
                switch (event.status) {
                    case 'ready':
                        return message({ type: 'INIT_RESPONSE', requestId, success: true, protocol: WORKER_PROTOCOL,
                            appInstanceId: instanceId, appLifecycle, toolsEnabled, projectionLimits });
                    case 'done':
                        return message({ type: 'LIFECYCLE_RESPONSE', requestId, success: event.cleanup?.state !== 'failed',
                            ...(event.cleanup ? { appCleanup: { ...event.cleanup, ...appLifecycle } } : {}) });
                    case 'failed': {
                        const { code, message: detail, path } = event.issue;
                        const phase = requestId === initializationId ? 'INIT' : requestId === openId ? 'OPEN' : undefined;
                        return message({ type: 'ERROR_RESPONSE', requestId, success: false, error: { code, message: detail,
                            ...(phase ? { diagnostic: { phase, name: 'AppExecutionError', code, message: detail, ...(path === undefined ? {} : { path }) } } : {}) } });
                    }
                    case 'tool':
                        return message({ type: 'VIEW_TOOL_INVOKE_RESPONSE', requestId, appId, instanceId, success: true, terminal: event.terminal });
                }
                break;
            }
            case 'projection': {
                producerSeq++;
                try {
                    const draft = draftOf(event.frame, options, producerSeq);
                    const issue = check(draft);
                    if (issue) return failedFrame(event.id, issue, latestEpoch);
                    latestEpoch = Math.max(latestEpoch, draft.sourceEpoch);
                    return message({ type: 'SNAPSHOT_PREPARED', ...(event.id === undefined ? {} : { requestId: event.id }), draft });
                } catch (error) { return failedFrame(event.id, badFrame(error), latestEpoch); }
            }
            case 'projectionFailed':
                producerSeq++;
                if (Number.isSafeInteger(event.revision)) latestEpoch = Math.max(latestEpoch, event.revision);
                return failedFrame(event.id, event.issue, latestEpoch);
            case 'update':
                return message({ type: 'APP_EVENT', appId, instanceId, reason: event.reason });
            case 'channelEnded':
            case 'exited':
                return emit(event);
        }
    });
    if (!handle || typeof handle.send !== 'function' || typeof handle.terminate !== 'function')
        throw Object.assign(new TypeError('The backend must return its execution handle'), { code: 'EXECUTION_HANDLE_INVALID' });
    if (claimedExecutions.has(handle))
        throw Object.assign(new Error('Create a new handle for each App execution'), { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' });
    claimedExecutions.add(handle);
    return {
        transport: { postMessage(message) {
            if (message.type === 'INIT') initializationId = message.requestId;
            if (message.type === 'APP_OPEN') openId = message.requestId;
            handle.send(semanticRequest(message));
        } },
        terminate: () => handle.terminate(),
    };
}
