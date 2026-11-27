import { DEFAULT_SNAPSHOT_LIMITS, MARKDOWN_VIEW_FORMAT, SNAPSHOT_SCHEMA_VERSION,
    SnapshotDataError, compileToolParameters, copyJson, refKey } from '@aotui/core';
import type { PreparedAppSnapshotDraft, RefDescriptor, SnapshotIssue, ToolDescriptor } from '@aotui/core';
import { captureSnapshotDraftEnvelope } from '@aotui/core/producer';
import type { AppExecutionBackend, AppExecutionEvent, AppExecutionHandle, AppExecutionIssue, AppExecutionLaunch,
    AppExecutionProjection, AppExecutionRequest, AppExecutionAcceptance } from '../spi/runtime/execution-backend.js';

/** Private adapter facts, never a synthesized Node IPC acknowledgement. */
export type TransportEvent = AppExecutionEvent
    | Readonly<{ kind: 'error'; error: Error }>
    | Readonly<{ kind: 'waitFailed'; id: string; error: Error }>
    | Readonly<{ kind: 'requestFailed'; id: string; error: Error; cleanup?: import('../spi/runtime/app-lifecycle.interface.js').AppCleanupReport }>;
export type TransportEvents = (event: TransportEvent) => void;
export type ExecutionTransport = Pick<AppExecutionHandle, 'send'>;
export const startupControl = Symbol('raw startup control');
export interface StartupControl {
    readonly cleanupRequired: boolean;
    sealStartup(): 'not-dispatched' | 'cleanup-required';
}
export interface ExecutionConnection {
    readonly transport: ExecutionTransport;
    readonly terminate: () => void | Promise<unknown>;
    readonly startup?: StartupControl;
}
export type ExecutionOptions = Omit<AppExecutionLaunch, 'acceptProjection'>;
export type FrameIntake = { draft: PreparedAppSnapshotDraft; viewTypes?: unknown } |
    { rejected: SnapshotIssue; envelope: import('@aotui/core/producer').SnapshotDraftEnvelope | undefined };
export type AcceptFrame = (intake: FrameIntake, mode: 'authoritative' | 'candidate', requestId?: string) => AppExecutionAcceptance;

const claimedExecutions = new WeakSet<AppExecutionHandle>();

function toolId(appId: string, viewType: string, name: string): string {
    return JSON.stringify([appId, viewType, name]);
}

function draftOf(raw: AppExecutionProjection, source: Pick<AppExecutionLaunch, 'appId' | 'instanceId'>): Extract<FrameIntake, { draft: PreparedAppSnapshotDraft }> {
    const { appId, instanceId } = source;
    const limits = DEFAULT_SNAPSHOT_LIMITS;
    const frame = copyJson(raw, { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes,
        maxApproxBytes: limits.maxSnapshotBytes * 2 }) as unknown as AppExecutionProjection;
    function exact(value: unknown, required: readonly string[], optional: readonly string[], path: string): void {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SnapshotDataError('SNAPSHOT_INVALID', path, 'Expected object');
        for (const key of required) if (!Object.hasOwn(value, key))
            throw new SnapshotDataError('SNAPSHOT_INVALID', path + '.' + key, 'Required field missing');
        for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key))
            throw new SnapshotDataError('SNAPSHOT_INVALID', path + '.' + key, 'Unknown projection field');
    }
    exact(frame, ['producerSeq', 'sourceEpoch', 'healthySince', 'views', 'refs', 'tools'], ['viewTypes'], '$');
    for (const [index, view] of frame.views.entries()) {
        const path = '$.views[' + index + ']';
        exact(view, ['id', 'type', 'name', 'region', 'body', 'viewInstanceId', 'tools'], ['closeActivationId'], path);
        for (const [binding, value] of view.tools.entries()) exact(value, ['name', 'activationId'], [], path + '.tools[' + binding + ']');
    }
    for (const [index, ref] of frame.refs.entries()) exact(ref, ['id', 'viewId', 'viewInstanceId', 'scope', 'continuity', 'valueSchema', 'value'], ['refType', 'array'], '$.refs[' + index + ']');
    for (const [index, tool] of frame.tools.entries()) exact(tool, ['viewType', 'name', 'multiplicity', 'description', 'inputSchema'], [], '$.tools[' + index + ']');
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
    for (const { id, viewId, viewInstanceId, scope, continuity, refType, array, valueSchema, value } of frame.refs) {
        const key = refKey(viewId, viewInstanceId, id);
        if (Object.hasOwn(refs, key)) throw new SnapshotDataError('SNAPSHOT_INVALID', '$.refs', 'Duplicate Ref in App frame');
        refs[key] = { id, ownerViewId: viewId, ownerViewInstanceId: viewInstanceId, scope, continuity, refType: refType ?? 'unknown',
            ...(array === undefined ? {} : { array }), valueSchema, target: { kind: 'snapshot-value', payload: value } };
    }
    return { ...(frame.viewTypes === undefined ? {} : { viewTypes: frame.viewTypes }), draft: {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION, appId, instanceId, producerSeq: frame.producerSeq, sourceEpoch: frame.sourceEpoch, healthySince: frame.healthySince, capturedAt: Date.now(),
        views: frame.views.map(({ id: viewId, type, name, region, body, viewInstanceId, closeActivationId, tools }) => ({
            id: viewId, type, name, region, viewInstanceId, content: { format: MARKDOWN_VIEW_FORMAT, value: body },
            toolBindings: tools.map(({ name, activationId }) => ({ toolId: toolId(appId, type, name), activationId })),
            ...(closeActivationId === undefined ? {} : { closeActivationId }),
        })),
        refs, tools,
    } };
}

function badFrame(error: unknown): SnapshotIssue {
    return error instanceof SnapshotDataError
        ? { code: error.code, message: error.message, path: error.path }
        : { code: 'SNAPSHOT_INVALID', message: 'Expected a complete execution projection', path: '$' };
}

/** Custom/raw publish synchronously through the single Receiver. No accepted-frame mirror. */
export function startExecutionBackend(backend: AppExecutionBackend, options: ExecutionOptions,
    emit: TransportEvents, accept: AcceptFrame): ExecutionConnection {
    const { appId, instanceId } = options;
    let bound = false;
    const launch: AppExecutionLaunch = Object.freeze({ ...options, acceptProjection(frame: AppExecutionProjection,
        mode: 'authoritative' | 'candidate', requestId?: string): AppExecutionAcceptance {
        if (!bound) return { status: 'rejected', issue: { code: 'APP_STOPPED', message: 'Execution ownership not transferred' } };
        let intake: FrameIntake;
        try { intake = draftOf(frame, options); }
        catch (error) {
            const value = (key: string): unknown => {
                try {
                    const field = frame && typeof frame === 'object' ? Object.getOwnPropertyDescriptor(frame, key) : undefined;
                    return field?.enumerable && 'value' in field ? field.value : undefined;
                } catch { return undefined; }
            };
            intake = { rejected: badFrame(error), envelope: captureSnapshotDraftEnvelope({
                appId, instanceId, producerSeq: value('producerSeq'), sourceEpoch: value('sourceEpoch'),
            }) };
        }
        return accept(intake, mode, requestId);
    } });
    const handle = backend.start(launch, (event: TransportEvent) => {
        if (event.kind === 'projection') {
            launch.acceptProjection(event.frame, 'authoritative', event.id);
            return;
        }
        emit(event);
    });
    if (!handle || typeof handle.send !== 'function' || typeof handle.terminate !== 'function')
        throw Object.assign(new TypeError('The backend must return its execution handle'), { code: 'EXECUTION_HANDLE_INVALID' });
    if (claimedExecutions.has(handle))
        throw Object.assign(new Error('Create a new handle for each App execution'), { code: 'APP_INSTANCE_REUSE_UNSUPPORTED' });
    claimedExecutions.add(handle);
    bound = true;
    const startup = (handle as AppExecutionHandle & { [startupControl]?: StartupControl })[startupControl];
    return {
        transport: { send: request => handle.send(request) },
        terminate: () => handle.terminate(),
        ...(startup ? { startup } : {}),
    };
}
