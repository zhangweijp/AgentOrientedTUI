import { APP_LIFECYCLE_PROTOCOL, APP_LIFECYCLE_VERSION, STATE_SESSION_VERSION, VIEW_TYPE_TOOL_PROTOCOL, captureAppMetadata } from '../spi/index.js';
import { WORKER_PROTOCOL } from '../spi/worker-protocol/types.js';
import { initializationFailure } from '../adapters/initialization-error.js';
import { captureAppLifecycleAck } from '../adapters/app-lifecycle-protocol.js';
import { hasViewTypeToolAuthoringProtocol } from '../spi/app/app-factory.interface.js';
import { createStateStorageProxy } from './state-storage-proxy.js';
import { createAppStatePersistence } from './state-persistence.js';
import { capturePersistenceOffer, STATE_SESSION_PROTOCOL } from '../adapters/storage/state-storage-protocol.js';
import { parentPort } from 'node:worker_threads';

import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    InitMessage,
    WorkerError,
    WorkerInitializationDiagnostic,
    RequestID,
    AppID,
} from '../spi/worker-protocol/index.js';

import type { SignalPolicy } from '../spi/index.js';
import { createAppId, isTUIAppFactory } from '../spi/index.js';
import { AOTUIError } from '../spi/core/errors.js';
import { captureSnapshotPrepareIssue } from '../core/snapshot/snapshot-support.js';
import { normalizeProjectionLimits } from '../core/invocation/observation-registry.js';

import { AppKernel } from './app-kernel/AppKernel.js';
import { invokeViewTool } from './tool-invocation.js';

type PersistenceRecord = { proxy: ReturnType<typeof createStateStorageProxy>; session: ReturnType<typeof createAppStatePersistence> };
type WorkerApp = Readonly<{
    kernel: AppKernel;
    appId: AppID;
    instanceId: string;
    toolsEnabled: boolean;
    generation: number;
    signalPolicy: SignalPolicy;
    persistence?: PersistenceRecord;
}>;
let app: WorkerApp | undefined;
let initAttempted = false;
let lifecycleGeneration = 0;

const persistenceCloseFailure = { code: 'PERSISTENCE_CLOSE_FAILED', message: 'Managed persistence did not complete successfully' };

async function closeApplication(kernel: AppKernel, record: PersistenceRecord | undefined, failed = false): Promise<WorkerError | undefined> {
    kernel.beginShutdown();
    if (record) {
        const result = await record.session.close(() => kernel.onClose(), failed);
        return result.ok ? undefined : persistenceCloseFailure;
    }
    try { await kernel.onClose(); }
    catch { return { code: 'APP_UNMOUNT_FAILED', message: 'App cleanup did not complete successfully' }; }
}

let projectionUnsubscribe: (() => void) | undefined;
let publicationTimer: ReturnType<typeof setTimeout> | null = null;
const PUBLICATION_THROTTLE_MS = 16;

// ============================================================================
// IPC 消息处理
// ============================================================================

parentPort?.on('message', async (msg: MainToWorkerMessage) => {
    if (msg.type === 'STATE_STORAGE_RESPONSE') { app?.persistence?.proxy.receive(msg);return; }
    if (msg.type === 'FLUSH_PROJECTION') {
        const kernel = app?.kernel;
        try {
            if (!kernel) throw new Error('Projection source unavailable');
            await kernel.whenProjectionCommitted();
            flushInteractionProjection(msg.requestId);
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
                getParameterContract: (tool, receiver) => kernel.getBoundTypeToolContract(tool, receiver),
                isRefViewLive: (id, instanceId) => kernel.isRefViewLive(id, instanceId),
                invokeBinding: (tool, receiver, args) => kernel.invokeBoundTypeTool(tool, receiver, args),
            } : undefined);
            if (response) {
                // Projection is a separate fact. It cannot erase a trusted business terminal.
                try { if (publicationTimer) flushInteractionProjection(); }
                finally { parentPort?.postMessage(response); }
            }
        } catch { /* No trusted terminal: Host records unknown. */ }
        return;
    }
    if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE', 'APP_REINITIALIZE'].includes(msg.type)) lifecycleGeneration++;
    // STOP revokes business admission while allowing an already-started render
    // to commit its sole resource owner. Final close joins that initialization.
    if (msg.type === 'APP_STOP') app?.kernel.stopApplication();
    if (msg.type === 'APP_SHUTDOWN' || msg.type === 'APP_CLOSE') app?.kernel.beginShutdown();
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
            case 'APP_SHUTDOWN':
                await handleAppShutdown(msg.requestId);
                break;
            case 'APP_REINITIALIZE':
                await handleAppReinitialize(msg.requestId, msg.reason);
                break;
            case 'APP_CLOSE':
                await handleAppClose(msg.requestId);
                break;
            case 'APP_DELETE':
                await handleAppDelete(msg.requestId);
                break;
            case 'LLM_USAGE':
                app?.kernel.dispatchLLMUsage(msg.event);
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
    const protocol = Object.getOwnPropertyDescriptor(msg, 'protocol');
    if (!protocol?.enumerable || protocol.value !== WORKER_PROTOCOL) {
        sendError(msg.requestId, 'WORKER_PROTOCOL_UNSUPPORTED', 'Worker requires ' + WORKER_PROTOCOL); return;
    }
    const tools = Object.getOwnPropertyDescriptor(msg, 'toolsEnabled');
    if (!tools?.enumerable || typeof tools.value !== 'boolean') {
        sendError(msg.requestId, 'APP_INIT_INVALID', 'INIT.toolsEnabled must be a boolean'); return;
    }
    const toolsEnabled: boolean = tools.value;
    if (msg.config && Object.hasOwn(msg.config, 'AOTUI_APP_NAME')) {
        sendError(msg.requestId, 'APP_CONFIG_UNSUPPORTED', 'Use AOTUI_APP_KEY for the Host-owned state namespace; App identity comes from the generated manifest');return;
    }
    const generation = ++lifecycleGeneration;
    const launchConfig = msg.config;
    let persistence: PersistenceRecord | undefined;
    try {
        const limitsField = Object.getOwnPropertyDescriptor(msg, 'projectionLimits');
        const projectionLimits = normalizeProjectionLimits(limitsField?.enumerable ? limitsField.value : undefined,
            'INIT.projectionLimits', true);
        const appModule = await import(msg.appModulePath);
        if (generation !== lifecycleGeneration) {
            sendError(msg.requestId, 'E_INIT_INVALIDATED', 'App initialization was invalidated');
            return;
        }

        const factory: unknown = appModule.default;
        if (!isTUIAppFactory(factory)) {
            throw new AOTUIError('APP_INVALID_EXPORT', { modulePath: msg.appModulePath });
        }
        if (!hasViewTypeToolAuthoringProtocol(factory)) {
            sendError(msg.requestId, 'APP_AUTHORING_PROTOCOL_UNSUPPORTED',
                'This Runtime requires a TUIAppFactory using ' + VIEW_TYPE_TOOL_PROTOCOL);
            return;
        }
        const kernelConfig = factory.kernelConfig;
        const metadata = captureAppMetadata({ app_name: kernelConfig.appName });
        if (msg.appName !== undefined && msg.appName !== metadata.app_name) {
            const error = new AOTUIError('APP_IDENTITY_MISMATCH', { expected: metadata.app_name, actual: msg.appName, path: 'INIT.appName' });
            sendError(msg.requestId, error.code, error.message);
            return;
        }
        const lifecycleOffer = Object.getOwnPropertyDescriptor(msg, 'appLifecycle');
        if (!lifecycleOffer || !('value' in lifecycleOffer) || !captureAppLifecycleAck(lifecycleOffer.value, msg.appInstanceId))
            throw new Error('APP_LIFECYCLE_UNSUPPORTED');

        let offer: ReturnType<typeof capturePersistenceOffer> = null;
        let appKey = String(msg.appId);
        if (Object.getOwnPropertyDescriptor(factory, 'persistenceSupport')?.value === STATE_SESSION_PROTOCOL) {
            const field = Object.getOwnPropertyDescriptor(msg, 'persistence');
            offer = field?.enumerable && 'value' in field ? capturePersistenceOffer(field.value, msg.appInstanceId) : null;
            if (!offer) {
                sendError(msg.requestId, 'PERSISTENCE_UNAVAILABLE', 'App requires a valid state-session-v1 persistence offer in INIT');
                return;
            }
            const configured = launchConfig?.AOTUI_APP_KEY;
            if (configured !== undefined && (typeof configured !== 'string' || !configured.length)) {
                sendError(msg.requestId, 'APP_STATE_KEY_INVALID', 'AOTUI_APP_KEY must be a non-empty string when provided');
                return;
            }
            appKey = configured ?? appKey;
        }

        if (offer) {
            const proxy = createStateStorageProxy(offer.instanceId, offer.transport, request => {
                if (!parentPort) return false;
                parentPort.postMessage(request);
            });
            try {
                const session = createAppStatePersistence({ instanceId: offer.instanceId, desktopId: msg.desktopId,
                    appKey, storage: proxy.storage, limits: offer.limits });
                persistence = { proxy, session };
            } catch (error) {
                proxy.disconnect();
                throw error;
            }
        }
        const kernel = new AppKernel({ ...kernelConfig, appName: metadata.app_name, factory, launchConfig,
            appId: msg.appId, desktopId: msg.desktopId, instanceId: msg.appInstanceId, projectionLimits,
            ...(persistence ? { persistence: persistence.session.port } : {}),
        });
        app = { kernel, appId: msg.appId, instanceId: msg.appInstanceId, toolsEnabled, generation,
            signalPolicy: kernelConfig.signalPolicy ?? 'auto', ...(persistence ? { persistence } : {}) };
        parentPort?.postMessage({ type: 'INIT_RESPONSE', requestId: msg.requestId, success: true,
            appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, version: APP_LIFECYCLE_VERSION, instanceId: msg.appInstanceId },
            ...(offer ? { persistence: { protocol: STATE_SESSION_PROTOCOL, version: STATE_SESSION_VERSION, instanceId: offer.instanceId } } : {}),
            protocol: WORKER_PROTOCOL, toolsEnabled,
            appInstanceId: msg.appInstanceId,
            projectionLimits,
        } satisfies WorkerToMainMessage);
    } catch (error) {
        const failure = initializationFailure('INIT', error);
        if (generation === lifecycleGeneration) lifecycleGeneration++;
        if (app) await closeApplication(app.kernel, persistence, true);
        else if (persistence) await persistence.session.close(() => {}, true);
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

    const { kernel, persistence } = openingApp;
    try { await kernel.onOpen(); }
    catch (error) {
        const failure = initializationFailure('OPEN', error);
        await closeApplication(kernel, persistence, true);
        sendLifecycleResponse(requestId, failure, persistence, kernel);
        return;
    }
    if (generation !== lifecycleGeneration) {
        sendError(requestId, 'E_OPEN_INVALIDATED', 'App opening was invalidated');
        return;
    }

    projectionUnsubscribe?.();
    projectionUnsubscribe = kernel.getProjectionCoordinator().subscribe(schedulePublication);
    pushSemanticSnapshot();

    sendLifecycleResponse(requestId);
}

async function handleAppClose(requestId: RequestID): Promise<void> {
    projectionUnsubscribe?.();
    projectionUnsubscribe = undefined;
    if (publicationTimer) {
        clearTimeout(publicationTimer);
        publicationTimer = null;
    }
    const closingApp = app;
    if (!closingApp) { sendError(requestId, 'E_NOT_INITIALIZED', 'App not initialized');return; }
    const { kernel, persistence } = closingApp;
    const failure = await closeApplication(kernel, persistence);
    sendLifecycleResponse(requestId, failure, persistence, kernel);
}

async function handleAppReinitialize(requestId: RequestID, _reason?: string): Promise<void> {
    await app?.kernel.onReinitialize(_reason);
    sendLifecycleResponse(requestId);
}

async function handleAppShutdown(requestId: RequestID): Promise<void> {
    const record = app?.persistence;
    const result = await record?.session.shutdown();
    sendLifecycleResponse(requestId, result?.ok === false ? persistenceCloseFailure : undefined, record);
}

async function handleAppDelete(requestId: RequestID): Promise<void> {
    try { await app?.kernel.onDelete(); }
    catch {
        parentPort?.postMessage({ type: 'LIFECYCLE_RESPONSE', requestId, success: false,
            error: { code: 'APP_DELETE_FAILED', message: 'APP_DELETE_FAILED' } } as WorkerToMainMessage);
        return;
    }
    sendLifecycleResponse(requestId);
}

// ============================================================================
// 辅助函数
// ============================================================================

function schedulePublication(): void {
    if (publicationTimer) return;
    publicationTimer = setTimeout(() => {
        publicationTimer = null;
        pushSemanticSnapshot();
    }, PUBLICATION_THROTTLE_MS);
}

/** Observation requests a full frame. A Tool terminal flushes queued publication work. */
function flushInteractionProjection(requestId?: RequestID): void {
    if (publicationTimer) {
        clearTimeout(publicationTimer);
        publicationTimer = null;
    }
    pushSemanticSnapshot(requestId);
}

function pushSemanticSnapshot(requestId?: RequestID): void {
    if (!app || !parentPort) return;
    const projection = app.kernel.getProjectionCoordinator();
    if (!projection.token().ready) return;
    const publication = projection.nextPublication();
    const delivery = { ...(requestId ? { requestId } : {}), suppressSignal: app.signalPolicy === 'never' };
    if ('draft' in publication) {
        parentPort.postMessage({ type: 'SNAPSHOT_PREPARED', draft: publication.draft, ...delivery } satisfies WorkerToMainMessage);
        return;
    }
    const { issue, ...source } = publication.failure;
    parentPort.postMessage({
        type: 'SNAPSHOT_PREPARE_FAILED', ...source, appId: createAppId(source.appId), ...delivery,
        error: captureSnapshotPrepareIssue(issue),
    } satisfies WorkerToMainMessage);
}

function sendLifecycleResponse(requestId: RequestID, failure?: WorkerError, record?: PersistenceRecord, kernel = app?.kernel): void {
    const appCleanup = kernel?.getAppCleanupReport();
    parentPort?.postMessage({
        type: 'LIFECYCLE_RESPONSE',
        requestId,
        success: !failure,
        ...(appCleanup ? { appCleanup } : {}),
        ...(record ? { persistence: record.session.getReport() } : {}),
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
