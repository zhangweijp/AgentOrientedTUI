import { APP_LIFECYCLE_PROTOCOL, APP_LIFECYCLE_VERSION, STATE_SESSION_VERSION, captureAppMetadata } from '../spi/index.js';
import { SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY } from '../spi/worker-protocol/types.js';
import { initializationFailure } from '../adapters/initialization-error.js';
import { captureAppLifecycleAck } from '../adapters/app-lifecycle-protocol.js';
import { hasViewTypeToolAuthoringProtocol } from '../spi/app/app-factory.interface.js';
import { createStateStorageProxy } from './state-storage-proxy.js';
import { createAppStatePersistence } from './state-persistence.js';
import { capturePersistenceOffer, STATE_SESSION_PROTOCOL } from '../adapters/storage/state-storage-protocol.js';
/**
 * AOTUI Runtime - Worker Runtime
 * 
 * 运行在 Worker Thread 中的 App 运行环境。
 * 
 * [C1 修复] 此文件从 SDK 迁移到 Runtime，因为它执行的是 Runtime 职责：
 * - 动态加载 App 模块
 * - 处理 IPC 消息
 * - 管理 App 生命周期
 * 
 * SDK 只负责"构建" App，Runtime 负责"运行" App。
 * 
 * @module @aotui/runtime/worker-runtime
 */

import { parentPort } from 'worker_threads';

// Import from unified SPI protocol (Single Source of Truth)
import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    InitMessage,
    WorkerError,
    WorkerInitializationDiagnostic,
    RequestID,
    ViewID,
    AppID,
    DesktopID,
} from '../spi/worker-protocol/index.js';

// Runtime SPI types
import type { AppContext, SignalPolicy } from '../spi/index.js';
import { createAppId, createDesktopId, isTUIAppFactory } from '../spi/index.js';
import { AOTUIError } from '../spi/core/errors.js';
import { captureSnapshotPrepareIssue } from '../core/snapshot/snapshot-support.js';

// [方案 B] AppKernel from worker-runtime
import { AppKernel } from './app-kernel/AppKernel.js';
import { captureViewToolCapabilities } from '../adapters/worker-message-capture.js';
import { invokeTypeParameters } from './ordinary-invocation-v2.js';
import type { LLMOutputEventMeta } from '../spi/core/llm-output.js';

// [RFC-002] Global Ref Registry from SDK -> REMOVED
// Ref data is now exported via AppKernel (explicit dependency)

// ============================================================================
// Worker 状态
// ============================================================================

let app: AppKernel | null = null;
type PersistenceRecord = { app: AppKernel; proxy: ReturnType<typeof createStateStorageProxy>; session: ReturnType<typeof createAppStatePersistence> };
let persistenceRecord: PersistenceRecord | null = null;
let initAttempted = false;
function persistenceResponse(requestId: RequestID, record: PersistenceRecord, ok: boolean, failure?: WorkerError): void {
    const appCleanup = record.app.getAppCleanupReport();
    parentPort?.postMessage({ type: 'LIFECYCLE_RESPONSE', requestId, success: ok, persistence: record.session.getReport(),
        ...(appCleanup ? { appCleanup } : {}),
        ...(!ok ? { error: failure ?? { code: 'PERSISTENCE_CLOSE_FAILED', message: 'Managed persistence did not complete successfully' } } : {}) });
}

let appId: AppID = '' as AppID;  // Will be set by INIT message
let desktopId: DesktopID = '' as DesktopID;  // Will be set by INIT message
let appInstanceId = '';
let lifecycleGeneration = 0;
let parametersNegotiated = false;
function revokeToolProtocol(): number {
    parametersNegotiated = false;
    return ++lifecycleGeneration;
}
let projectionUnsubscribe: (() => void) | undefined;
let publicationTimer: ReturnType<typeof setTimeout> | null = null;
const PUBLICATION_THROTTLE_MS = 16;
let signalPolicy: SignalPolicy = 'auto';

// [RFC-001] Worker-Side Transformation is now enforced.


// ============================================================================
// IPC 消息处理
// ============================================================================

parentPort?.on('message', async (msg: MainToWorkerMessage) => {
    if (msg.type === 'STATE_STORAGE_RESPONSE') { persistenceRecord?.proxy.receive(msg);return; }
    if (msg.type === 'FLUSH_PROJECTION') {
        const kernel = app;
        try {
            if (!kernel) throw new Error('Projection source unavailable');
            await kernel.whenProjectionCommitted();
            if (kernel !== app) throw new Error('Projection source replaced');
            flushInteractionProjection(msg.requestId);
        } catch { sendError(msg.requestId, 'PROJECTION_CLOSED', 'Projection source unavailable'); }
        return;
    }
    if (msg.type === 'VIEW_TOOL_INVOKE_V4') {
        try {
            const kernel = app;
            const response = await invokeTypeParameters(msg, { appId, instanceId: appInstanceId,
                negotiated: kernel !== null && parametersNegotiated,
                ...(kernel ? { validateBinding: (tool, execution) => kernel.validateBoundTypeTool(tool, execution),
                    getParameterContract: (tool, execution) => kernel.getBoundTypeToolContract(tool, execution),
                    isRefViewLive: (id, instanceId) => kernel.isRefViewLive(id, instanceId),
                    invokeBinding: (tool, execution, args) => kernel.invokeBoundTypeTool(tool, execution, args) } : {}),
            });
            if (response) {
                // Projection is a separate fact. It cannot erase a trusted business terminal.
                try { flushInteractionProjection(); }
                finally { parentPort?.postMessage(response); }
            }
        } catch { /* No trusted terminal: Host records unknown. */ }
        return;
    }
    if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE', 'APP_REINITIALIZE'].includes(msg.type)) revokeToolProtocol();
    // STOP revokes business admission while allowing an already-started render
    // to commit its sole resource owner. Final close joins that initialization.
    if (msg.type === 'APP_STOP') app?.stopApplication();
    if (msg.type === 'APP_SHUTDOWN' || msg.type === 'APP_CLOSE') app?.beginShutdown();
    try {
        switch (msg.type) {
            case 'INIT':
                await handleInit(msg);
                break;
            case 'APP_OPEN':
                await handleAppOpen(msg.requestId);
                break;
            case 'APP_PAUSE':
            case 'APP_RESUME':
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
            case 'EXTERNAL_EVENT':
                await handleExternalEvent(msg.requestId, msg.viewId, msg.eventType, msg.data);
                break;
            case 'LLM_OUTPUT_PUSH':
                // [RFC-011] Handle LLM text push from main thread
                handleLLMTextPush(msg as any);
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
    if (typeof msg.appInstanceId !== 'string' || !msg.appInstanceId.trim()) {
        sendError(msg.requestId, 'APP_INSTANCE_MISMATCH', 'Runtime App instance identity is required');return;
    }
    const requestedField = Object.getOwnPropertyDescriptor(msg, 'requestedCapabilities');
    const requested = !requestedField
        ? captureViewToolCapabilities([])
        : !('value' in requestedField) || requestedField.value === undefined
            ? { ok: false as const, code: 'WORKER_CAPABILITY_INVALID' as const }
            : captureViewToolCapabilities(requestedField.value);
    if (!requested.ok) {
        sendError(msg.requestId, requested.code, 'The requested Worker capability list is invalid or unsupported');
        return;
    }
    if (!requested.capabilities.includes(SNAPSHOT_CAPABILITY)) {
        sendError(msg.requestId, 'WORKER_SNAPSHOT_UNSUPPORTED', `This Worker requires ${SNAPSHOT_CAPABILITY} during INIT`);return;
    }
    if (msg.config && Object.hasOwn(msg.config, 'AOTUI_APP_NAME')) {
        sendError(msg.requestId, 'APP_CONFIG_UNSUPPORTED', 'Use AOTUI_APP_KEY for the Host-owned state namespace; App identity comes from the generated manifest');return;
    }
    if (msg.config?.AOTUI_APP_KEY !== undefined && (typeof msg.config.AOTUI_APP_KEY !== 'string' || !msg.config.AOTUI_APP_KEY.length)) {
        sendError(msg.requestId, 'APP_STATE_KEY_INVALID', 'AOTUI_APP_KEY must be a non-empty string when provided');return;
    }
    const generation = revokeToolProtocol();
    appId = msg.appId;
    desktopId = msg.desktopId;
    appInstanceId = msg.appInstanceId;

    // [重构] 不再使用 globalThis，config 将通过 AppKernel 构造函数传递
    const launchConfig = msg.config;

    // 动态加载 App 模块
    try {
        // [RFC-005] Configuration Injection
        // Runtime Config is handled via AppWorkerHost passing it to Worker, 
        // but here we focus on App Config.

        const appModule = await import(msg.appModulePath);
        if (generation !== lifecycleGeneration) {
            sendError(msg.requestId, 'E_INIT_INVALIDATED', 'App initialization was invalidated');
            return;
        }

        // Only the managed SDK App factory is a supported App entry.
        // Do not run callable factories, legacy .create() objects, App instances,
        // or global config fallbacks in a Worker.
        const factory: unknown = appModule.default;
        if (!isTUIAppFactory(factory)) {
            throw new AOTUIError('APP_INVALID_EXPORT', { modulePath: msg.appModulePath });
        }
        if (!hasViewTypeToolAuthoringProtocol(factory)) {
            sendError(msg.requestId, 'APP_AUTHORING_PROTOCOL_UNSUPPORTED',
                'This Runtime requires a TUIAppFactory using view-type-tools-v4');
            return;
        }
        const managedFactory = factory;
        const metadata = captureAppMetadata({ app_name: managedFactory.kernelConfig.appName });
        for (const [path, actual] of [
            ['INIT.appName', msg.appName],
        ] as const) {
            if (actual !== undefined && actual !== metadata.app_name) {
                const error = new AOTUIError('APP_IDENTITY_MISMATCH', { expected: metadata.app_name, actual, path });
                sendError(msg.requestId, error.code, error.message);return;
            }
        }
        const offerField = Object.getOwnPropertyDescriptor(msg, 'persistence');
        const offer = offerField && 'value' in offerField ? capturePersistenceOffer(offerField.value, msg.appInstanceId ?? '') : null;
        if (!offerField || !('value' in offerField) || !offer) throw new Error('Invalid persistence offer');

        const lifecycleOffer = Object.getOwnPropertyDescriptor(msg, 'appLifecycle');
        if (!lifecycleOffer || !('value' in lifecycleOffer) || !captureAppLifecycleAck(lifecycleOffer.value, msg.appInstanceId ?? ''))
            throw new Error('APP_LIFECYCLE_UNSUPPORTED');

        if (managedFactory.kernelConfig.signalPolicy) {
            signalPolicy = managedFactory.kernelConfig.signalPolicy as SignalPolicy;
        }

        app = new AppKernel({ ...managedFactory.kernelConfig, factory: managedFactory, launchConfig });

        // Keep the SDK/AppKernel App identity equal to the authenticated
        // Worker INIT appId. Otherwise Tool IDs and SDK AppRuntimeContext use ''.
        app.setId(appId);
        app.setAppExecutionInstanceId(msg.appInstanceId);
        app.enableAppLifecycle();
        const proxy = createStateStorageProxy(offer.instanceId, offer.transport, request => {
            if (!parentPort) return false;parentPort.postMessage(request);
        });
        const configured = launchConfig?.AOTUI_APP_KEY;
        const session = createAppStatePersistence({ instanceId: offer.instanceId, desktopId: String(msg.desktopId),
            appKey: typeof configured === 'string' && configured.length ? configured : String(msg.appId),
            storage: proxy.storage, limits: offer.limits });
        app.setPersistence(session.port);
        persistenceRecord = { app, proxy, session };

        parametersNegotiated = requested.capabilities.includes(PARAMETERS_V4_CAPABILITY);
        const capabilities = parametersNegotiated ? [SNAPSHOT_CAPABILITY, PARAMETERS_V4_CAPABILITY] : [SNAPSHOT_CAPABILITY];
        parentPort?.postMessage({ type: 'INIT_RESPONSE', requestId: msg.requestId, success: true,
            appLifecycle: { protocol: APP_LIFECYCLE_PROTOCOL, version: APP_LIFECYCLE_VERSION, instanceId: msg.appInstanceId! },
            persistence: { protocol: STATE_SESSION_PROTOCOL, version: STATE_SESSION_VERSION, instanceId: session.port.instanceId },
            acceptedCapabilities: capabilities,
            appInstanceId,
        } as WorkerToMainMessage);
    } catch (error) {
        const failure = initializationFailure('INIT', error);
        if (generation === lifecycleGeneration) parametersNegotiated = false;
        const failed = persistenceRecord;
        if (failed) { failed.app.beginShutdown(); await failed.session.close(() => failed.app.onClose(), true); }
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

    const context: AppContext = { appId, desktopId };

    const openingPersistence = persistenceRecord;
    try { await openingApp.onOpen(context); }
    catch (error) {
        const failure = initializationFailure('OPEN', error);
        if (openingPersistence) {
            openingPersistence.app.beginShutdown();
            await openingPersistence.session.close(() => openingPersistence.app.onClose(), true);
            persistenceResponse(requestId, openingPersistence, false, failure);
        } else sendError(requestId, failure.code, failure.message, failure.diagnostic);
        return;
    }
    if (app !== openingApp || generation !== lifecycleGeneration) {
        sendError(requestId, 'E_OPEN_INVALIDATED', 'App opening was invalidated');
        return;
    }

    projectionUnsubscribe?.();
    if (signalPolicy !== 'manual') {
        projectionUnsubscribe = openingApp.getProjectionCoordinator().subscribe(schedulePublication);
    }
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
    const record = persistenceRecord;
    if (!record) { sendError(requestId, 'PERSISTENCE_UNAVAILABLE', 'Managed persistence session is unavailable');return; }
    const result = await record.session.close(() => record.app.onClose());
    persistenceResponse(requestId, record, result.ok);
}

async function handleAppReinitialize(requestId: RequestID, _reason?: string): Promise<void> {
    await app?.onReinitialize({ appId, desktopId, reason: _reason });
    sendLifecycleResponse(requestId);
}

/**
 * 处理 APP_SHUTDOWN 消息
 * 触发SDK的持久化flush操作
 */
async function handleAppShutdown(requestId: RequestID): Promise<void> {
    const record = persistenceRecord;
    if (!record) { sendError(requestId, 'PERSISTENCE_UNAVAILABLE', 'Managed persistence session is unavailable');return; }
    const result = await record.session.shutdown();
    persistenceResponse(requestId, record, result.ok);
}

async function handleAppDelete(requestId: RequestID): Promise<void> {
    try { await app?.onDelete(); }
    catch {
        parentPort?.postMessage({ type: 'LIFECYCLE_RESPONSE', requestId, success: false,
            error: { code: 'APP_DELETE_FAILED', message: 'APP_DELETE_FAILED' } } as WorkerToMainMessage);
        return;
    }
    sendLifecycleResponse(requestId);
}

async function handleExternalEvent(
    requestId: RequestID,
    viewId: ViewID,
    eventType: string,
    data: Record<string, unknown>
): Promise<void> {
    if (!app?.dispatchExternalEvent({ viewId, type: eventType, data, timestamp: Date.now() })) {
        sendError(requestId, 'E_NOT_INITIALIZED', 'App instance not initialized');
        return;
    }

    sendLifecycleResponse(requestId);
}

/**
 * [RFC-011] Handle LLM text push from main thread
 * [RFC-020] Now supports structured payload { reasoning?, content? }
 * 
 * Dispatches a custom event to appContainer for SDK's useLLMTextChannel hook.
 */
function handleLLMTextPush(msg: {
    reasoning?: string;
    content?: string;
    eventType: 'complete';
    timestamp: number;
    meta?: Pick<LLMOutputEventMeta, 'model' | 'providerId' | 'modelId' | 'usage'>
}): void {
    app?.dispatchLLMOutput({
        desktopId, type: msg.eventType, timestamp: msg.timestamp,
        content: msg.content, reasoning: msg.reasoning, meta: msg.meta,
    });
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

/** Observation joins the renderer queue; invocation receipts can send the cached result immediately. */
function flushInteractionProjection(requestId?: RequestID): void {
    if (publicationTimer) {
        clearTimeout(publicationTimer);
        publicationTimer = null;
    }
    pushSemanticSnapshot(requestId);
}

function pushSemanticSnapshot(requestId?: RequestID): void {
    if (!app || !parentPort) return;
    const projection = app.getProjectionCoordinator();
    if (!projection.token().ready) return;
    const publication = projection.nextPublication();
    const delivery = { ...(requestId ? { requestId } : {}), suppressSignal: signalPolicy === 'never' };
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

function sendLifecycleResponse(requestId: RequestID): void {
    const appCleanup = app?.getAppCleanupReport();
    parentPort?.postMessage({
        type: 'LIFECYCLE_RESPONSE',
        requestId,
        success: true,
        ...(appCleanup ? { appCleanup } : {}),
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
