import {
    AOTUIError, APP_LIFECYCLE_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL, DEFAULT_SNAPSHOT_LIMITS,
    captureAppMetadata, normalizeProjectionLimits, readAppFactory,
} from '@aotui/core';
import { WORKER_PROTOCOL } from '../spi/worker-protocol/types.js';
import { initializationFailure } from '../adapters/initialization-error.js';
import { captureAppLifecycleAck } from '../adapters/app-lifecycle-protocol.js';
import { parentPort } from 'node:worker_threads';

import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    InitMessage,
    WorkerError,
    WorkerInitializationDiagnostic,
    RequestID,
    AppID,
    AppEventMessage,
} from '../spi/worker-protocol/index.js';

import { createAppId } from '../spi/core/id-factory.js';
import { captureSnapshotDraftEnvelope, captureSnapshotPrepareIssue, type SnapshotDraftEnvelope } from '@aotui/core/producer';

import { AppKernel } from './app-kernel/AppKernel.js';
import { invokeViewTool } from './tool-invocation.js';
import { toolInvocationResponse } from '../adapters/tool-invocation.js';

type WorkerApp = Readonly<{
    kernel: AppKernel;
    appId: AppID;
    instanceId: string;
    toolsEnabled: boolean;
    generation: number;
}>;
let app: WorkerApp | undefined;
let initAttempted = false;
let lifecycleGeneration = 0;

const appUnmountFailure = { code: 'APP_UNMOUNT_FAILED', message: 'App cleanup did not complete successfully' };

async function closeApplication(kernel: AppKernel): Promise<WorkerError | undefined> {
    try { await kernel.onClose(); }
    catch { return appUnmountFailure; }
}

let projectionUnsubscribe: (() => void) | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

// ============================================================================
// IPC 消息处理
// ============================================================================

parentPort?.on('message', async (msg: MainToWorkerMessage) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'FLUSH_PROJECTION') {
        const current = app;
        try {
            if (!current || current.generation !== lifecycleGeneration) throw new Error('Projection source unavailable');
            const known = captureSnapshotDraftEnvelope(msg.known);
            flushInteractionProjection(msg.requestId, known && Reflect.ownKeys(msg.known!).length === 4 ? known : undefined);
        } catch { sendError(msg.requestId, 'PROJECTION_CLOSED', 'Projection source unavailable'); }
        return;
    }
    if (msg.type === 'VIEW_TOOL_INVOKE') {
        try {
            const current = app;
            const kernel = current?.kernel;
            const response = await invokeViewTool(msg, current && kernel ? {
                appId: current.appId, instanceId: current.instanceId,
                toolsEnabled: current.toolsEnabled && current.generation === lifecycleGeneration,
                validateBinding: (tool, receiver) => kernel.validateBoundTypeTool(tool, receiver),
                isRefViewLive: (id, instanceId) => kernel.isRefViewLive(id, instanceId),
                refDescriptor: (id, instanceId, refId) => kernel.refDescriptor(id, instanceId, refId),
                invokeBinding: (tool, receiver, args, capture) => kernel.invokeBoundTypeTool(tool, receiver, args, capture),
            } : undefined);
            if (response) parentPort?.postMessage(response);
        } catch { /* No trusted terminal: Host records unknown. */ }
        return;
    }
    if (msg.type === 'VIEW_CLOSE') {
        const current = app;
        let response: ReturnType<typeof toolInvocationResponse> = null;
        if (!current?.toolsEnabled || current.generation !== lifecycleGeneration ||
            current.appId !== msg.appId || current.instanceId !== msg.instanceId) {
            response = toolInvocationResponse(msg, { phase: 'not-entered', result: { success: false,
                error: { code: 'VIEW_CLOSE_UNAVAILABLE', message: 'The App no longer accepts this close action.' } } });
        } else {
            try {
                response = await current.kernel.closeView(msg.viewId, msg.viewInstanceId, msg.closeActivationId, terminal => toolInvocationResponse(msg, terminal));
            } catch { /* No confirmed terminal. */ }
        }
        response ??= toolInvocationResponse(msg, { phase: 'finished-unknown' });
        if (response) parentPort?.postMessage(response);
        return;
    }
    if (msg.type === 'APP_STOP' || msg.type === 'APP_CLOSE') lifecycleGeneration++;
    // STOP revokes business admission. Final close joins any active initialization.
    if (msg.type === 'APP_STOP') app?.kernel.stopApplication();
    try {
        switch (msg.type) {
            case 'INIT':
                await handleInit(msg);
                break;
            case 'APP_OPEN':
                await handleAppOpen(msg.requestId);
                break;
            case 'APP_STOP':
                sendLifecycleResponse(msg.requestId);
                break;
            case 'APP_CLOSE':
                await handleAppClose(msg.requestId);
                break;
        }
    } catch (error) {
        sendError(
            (msg as any).requestId || 'unknown',
            'E_HANDLER_ERROR',
            error instanceof Error ? error.message : String(error)
        );
    }
});

// ============================================================================
// 消息处理函数
// ============================================================================

async function handleInit(msg: InitMessage): Promise<void> {
    if (initAttempted) {
        sendError(msg.requestId, 'APP_INSTANCE_REUSE_UNSUPPORTED', 'A Worker can initialize one App instance');return;
    }
    initAttempted = true;
    for (const identity of [msg.appId, msg.desktopId, msg.appInstanceId]) {
        if (typeof identity !== 'string' || !identity.trim()) {
            sendError(msg.requestId, 'APP_INSTANCE_MISMATCH', 'App, Desktop and execution identities are required'); return;
        }
    }
    if (msg.protocol !== WORKER_PROTOCOL) {
        sendError(msg.requestId, 'WORKER_PROTOCOL_UNSUPPORTED', 'Worker requires ' + WORKER_PROTOCOL); return;
    }
    const { toolsEnabled } = msg;
    if (typeof toolsEnabled !== 'boolean') {
        sendError(msg.requestId, 'APP_INIT_INVALID', 'INIT.toolsEnabled must be a boolean'); return;
    }
    if (msg.config && Object.hasOwn(msg.config, 'AOTUI_APP_NAME')) {
        sendError(msg.requestId, 'APP_CONFIG_UNSUPPORTED', 'AOTUI_APP_NAME cannot be overridden via launchConfig; App identity comes from the generated manifest');return;
    }
    const generation = ++lifecycleGeneration;
    const launchConfig = msg.config;
    try {
        const projectionLimits = normalizeProjectionLimits(msg.projectionLimits, 'INIT.projectionLimits', true);
        const appModule = await import(msg.appModulePath);
        if (generation !== lifecycleGeneration) {
            sendError(msg.requestId, 'E_INIT_INVALIDATED', 'App initialization was invalidated');
            return;
        }

        const factory = readAppFactory(appModule.default);
        if (factory === 'APP_INVALID_EXPORT') {
            throw new AOTUIError(factory, { modulePath: msg.appModulePath });
        }
        if (factory === 'APP_LIFECYCLE_UNSUPPORTED') {
            sendFactoryRejection(msg.requestId, factory, 'factory.appLifecycleSupport', APP_LIFECYCLE_PROTOCOL);
            return;
        }
        if (factory === 'APP_AUTHORING_PROTOCOL_UNSUPPORTED') {
            sendFactoryRejection(msg.requestId, factory, 'factory.toolAuthoringProtocol', VIEW_TYPE_TOOL_PROTOCOL);
            return;
        }
        const metadata = captureAppMetadata({ app_name: factory.app_name });
        if (msg.appName !== undefined && msg.appName !== metadata.app_name) {
            const error = new AOTUIError('APP_IDENTITY_MISMATCH', { expected: metadata.app_name, actual: msg.appName, path: 'INIT.appName' });
            sendError(msg.requestId, error.code, error.message);
            return;
        }
        if (!captureAppLifecycleAck(msg.appLifecycle, msg.appInstanceId))
            throw new Error('APP_LIFECYCLE_UNSUPPORTED');

        const kernel = new AppKernel({ factory, launchConfig,
            appId: msg.appId, desktopId: msg.desktopId, instanceId: msg.appInstanceId, projectionLimits,
            requestAttention: () => emitAppEvent('attention_requested'),
        });
        app = { kernel, appId: msg.appId, instanceId: msg.appInstanceId, toolsEnabled, generation };
        parentPort?.postMessage({ type: 'INIT_RESPONSE', requestId: msg.requestId, success: true,
            appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, instanceId: msg.appInstanceId },
            protocol: WORKER_PROTOCOL, toolsEnabled,
            appInstanceId: msg.appInstanceId,
            projectionLimits,
        } satisfies WorkerToMainMessage);
    } catch (error) {
        const failure = startupFailure('INIT', error);
        if (generation === lifecycleGeneration) lifecycleGeneration++;
        if (app) await closeApplication(app.kernel);
        sendError(msg.requestId, failure.code, failure.message, failure.diagnostic);
    }
}

async function handleAppOpen(requestId: RequestID): Promise<void> {
    const openingApp = app;
    const generation = lifecycleGeneration;
    if (!openingApp) {
        sendError(requestId, 'E_NOT_INITIALIZED', 'App not initialized');
        return;
    }

    const { kernel } = openingApp;
    try { await kernel.onOpen(); }
    catch (error) {
        const failure = startupFailure('OPEN', error);
        await closeApplication(kernel);
        sendLifecycleResponse(requestId, failure, kernel);
        return;
    }
    if (generation !== lifecycleGeneration) {
        sendError(requestId, 'E_OPEN_INVALIDATED', 'App opening was invalidated');
        return;
    }

    projectionUnsubscribe?.();
    const projection = kernel.getProjectionCoordinator();
    let fault = projection.failure, epoch = projection.token().epoch;
    projectionUnsubscribe = projection.subscribe(current => {
        if (generation !== lifecycleGeneration) return;
        const nextFault = projection.failure;
        if (nextFault !== fault) {
            clearTimeout(updateTimer);
            updateTimer = undefined;
            if (nextFault) pushSemanticSnapshot();
            else emitAppEvent('projection_recovered');
        } else if (!nextFault && current.epoch !== epoch && !updateTimer) {
            updateTimer = setTimeout(() => {
                updateTimer = undefined;
                emitAppEvent('view_updated');
            }, 16);
        }
        fault = nextFault;
        epoch = current.epoch;
    });
    const publication = pushSemanticSnapshot(requestId);
    if (!publication) { sendError(requestId, "SNAPSHOT_UNAVAILABLE", "Initial Frame is not healthy"); return; }
    sendLifecycleResponse(requestId, undefined, kernel, publication);
}

async function handleAppClose(requestId: RequestID): Promise<void> {
    projectionUnsubscribe?.();
    projectionUnsubscribe = undefined;
    clearTimeout(updateTimer);
    updateTimer = undefined;
    const closingApp = app;
    if (!closingApp) { sendError(requestId, 'E_NOT_INITIALIZED', 'App not initialized');return; }
    const { kernel } = closingApp;
    const failure = await closeApplication(kernel);
    sendLifecycleResponse(requestId, failure, kernel);
}

// ============================================================================
// 辅助函数
// ============================================================================

function emitAppEvent(reason: AppEventMessage['reason']): void {
    if (app?.generation === lifecycleGeneration)
        parentPort?.postMessage({ type: 'APP_EVENT', appId: app.appId, instanceId: app.instanceId, reason } satisfies AppEventMessage);
}

function flushInteractionProjection(requestId: RequestID, known?: SnapshotDraftEnvelope): void {
    if (known && app?.kernel.getProjectionCoordinator().confirmsPublication(known)) {
        parentPort?.postMessage({ type: 'PROJECTION_CURRENT', requestId, ...known } satisfies WorkerToMainMessage);
    } else pushSemanticSnapshot(requestId);
}

let sentViewTypes = false;

function pushSemanticSnapshot(requestId?: RequestID): SnapshotDraftEnvelope | undefined {
    if (!app || !parentPort) return;
    const projection = app.kernel.getProjectionCoordinator();
    if (!projection.token().ready) return;
    const publication = projection.nextPublication();
    const delivery = requestId ? { requestId } : {};
    if ('draft' in publication) {
        parentPort.postMessage({ type: 'SNAPSHOT_PREPARED', draft: publication.draft, ...delivery,
            ...(!sentViewTypes ? { viewTypes: app.kernel.getViewTypes() } : {}) } satisfies WorkerToMainMessage);
        sentViewTypes = true;
        return captureSnapshotDraftEnvelope(publication.draft);
    }
    const { issue, ...source } = publication.failure;
    parentPort.postMessage({
        type: 'SNAPSHOT_PREPARE_FAILED', ...source, appId: createAppId(source.appId), ...delivery,
        error: captureSnapshotPrepareIssue(issue),
    } satisfies WorkerToMainMessage);
}

function sendLifecycleResponse(requestId: RequestID, failure?: WorkerError, kernel = app?.kernel, publication?: SnapshotDraftEnvelope): void {
    const appCleanup = kernel?.getAppCleanupReport();
    parentPort?.postMessage({
        type: 'LIFECYCLE_RESPONSE',
        requestId,
        success: !failure,
        ...(publication ? { publication } : {}),
        ...(appCleanup ? { appCleanup } : {}),
        ...(failure ? { error: failure } : {}),
    } satisfies WorkerToMainMessage);
}

function sendError(requestID: RequestID, code: string, message: string, diagnostic?: WorkerInitializationDiagnostic): void {
    parentPort?.postMessage({
        type: 'ERROR_RESPONSE',
        requestId: requestID,
        success: false,
        error: { code, message, ...(diagnostic ? { diagnostic } : {}) },
    } as WorkerToMainMessage);
}

function sendFactoryRejection(requestId: RequestID, code: string,
    protocolRejection: 'factory.toolAuthoringProtocol' | 'factory.appLifecycleSupport', required: string): void {
    parentPort?.postMessage({ type: 'ERROR_RESPONSE', requestId, success: false, protocolRejection,
        error: code === 'APP_LIFECYCLE_UNSUPPORTED' ? initializationFailure('INIT', Object.assign(new Error('This Runtime requires a TUIAppFactory using ' + required), { code, path: 'appLifecycleSupport' })) : { code, message: 'This Runtime requires a TUIAppFactory using ' + required } } satisfies WorkerToMainMessage);
}

function startupFailure(phase: 'INIT' | 'OPEN', error: unknown): WorkerError {
    const failure = initializationFailure(phase, error);
    const diagnostic = failure.diagnostic;
    if (diagnostic?.code === 'VIEW_CAPACITY' && diagnostic.path === 'viewTypes' &&
        diagnostic.message.includes('App ViewType definition limit exceeded')) {
        return { code: 'SNAPSHOT_CAPACITY', message: 'ViewType declaration count exceeds ' + DEFAULT_SNAPSHOT_LIMITS.maxViews,
            diagnostic: { ...diagnostic, code: 'SNAPSHOT_CAPACITY', path: '$.viewTypes' } };
    }
    return failure;
}
