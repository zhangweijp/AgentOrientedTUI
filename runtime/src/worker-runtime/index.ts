import { captureAppLifecycleAck } from '../adapters/app-lifecycle-protocol.js';
import { createStateStorageProxy } from './state-storage-proxy.js';
import { createAppStatePersistence } from './state-persistence.js';
import { capturePersistenceOffer } from '../adapters/storage/state-storage-protocol.js';
import { copyJson, SnapshotDataError } from '../core/snapshot/json.js';
import { DEFAULT_SNAPSHOT_LIMITS } from '../core/snapshot/snapshot-support.js';
import { REF_V2_CAPABILITY } from '../adapters/ref-invocation-v2.js';
import { invokeRefInvocationV2 } from './ref-invocation-v2.js';
/**
 * AOTUI Runtime - Worker Runtime
 * 
 * 运行在 Worker Thread 中的 App 运行环境。
 * 
 * [C1 修复] 此文件从 SDK 迁移到 Runtime，因为它执行的是 Runtime 职责：
 * - 初始化 LinkedOM (globalThis.document)
 * - 动态加载 App 模块
 * - 处理 IPC 消息
 * - 管理 App 生命周期
 * 
 * SDK 只负责"构建" App，Runtime 负责"运行" App。
 * 
 * @module @aotui/runtime/worker-runtime
 */

import { parentPort } from 'worker_threads';
import { parseHTML } from 'linkedom';

// Import from unified SPI protocol (Single Source of Truth)
import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    InitMessage,
    RequestID,
    ViewID,
    AppID,
    DesktopID,
} from '../spi/worker-protocol/index.js';

// [RFC-001] Transformer for Worker-Side Transformation
import { extractViewFragments } from './view-fragment-extractor.js';
import { captureDOMSnapshot } from './dom-snapshot-producer.js';

// Runtime SPI types
import type { IAOTUIApp, AppContext, IProjectionPort, SignalPolicy } from '../spi/index.js';
import { createAppId, createDesktopId, isTUIAppFactory } from '../spi/index.js';
import { AOTUIError } from '../spi/core/errors.js';

// [方案 B] AppKernel from worker-runtime
import { AppKernel } from './app-kernel/index.js';
import { captureWorkerCapabilities } from '../adapters/worker-message-capture.js';
import { ORDINARY_V2_CAPABILITY } from '../adapters/ordinary-invocation-v2.js';
import { invokeOrdinaryInvocationV2 } from './ordinary-invocation-v2.js';
import type { LLMOutputEventMeta } from '../spi/core/llm-output.js';

// [RFC-002] Global Ref Registry from SDK -> REMOVED
// Ref data is now exported via AppKernel (explicit dependency)

// ============================================================================
// Worker 状态
// ============================================================================

let app: IAOTUIApp | null = null;
type PersistenceRecord = { app: IAOTUIApp; proxy: ReturnType<typeof createStateStorageProxy>; session: ReturnType<typeof createAppStatePersistence> };
let persistenceRecord: PersistenceRecord | null = null;
let lastInitInstanceId = '';
function persistenceResponse(requestId: RequestID, record: PersistenceRecord, ok: boolean): void {
    parentPort?.postMessage({ type: 'LIFECYCLE_RESPONSE', requestId, success: ok, persistence: record.session.getReport(),
        ...(record.app instanceof AppKernel && record.app.getAppCleanupReport() ? { appCleanup: record.app.getAppCleanupReport() } : {}),
        ...(!ok ? { error: { code: 'PERSISTENCE_CLOSE_FAILED', message: 'Managed persistence did not complete successfully' } } : {}) });
}

let appId: AppID = '' as AppID;  // Will be set by INIT message
let desktopId: DesktopID = '' as DesktopID;  // Will be set by INIT message
let appContainer: HTMLElement | null = null;
let appInstanceId = '';
let lifecycleGeneration = 0;
let refV2NegotiatedApp: IAOTUIApp | null = null;
let ordinaryParametersNegotiatedApp: IAOTUIApp | null = null;
function revokeRefProtocol(): number {
    refV2NegotiatedApp = null;
    ordinaryParametersNegotiatedApp = null;
    return ++lifecycleGeneration;
}
let producerSequence = 0;
let projectionUnsubscribe: (() => void) | undefined;
function currentProjection(): IProjectionPort | undefined {
    const candidate = app as IAOTUIApp & { getProjectionCoordinator?: () => IProjectionPort } | null;
    return candidate?.getProjectionCoordinator?.();
}

// ============================================================================
// DOM 观察与推送 (Worker-Only 架构)
// ============================================================================

let domObserver: MutationObserver | null = null;
let domUpdateTimer: ReturnType<typeof setTimeout> | null = null;
const DOM_UPDATE_THROTTLE_MS = 16;  // ~60fps 节流


// [RFC-012] Signal Policy - 控制何时触发 UpdateSignal
let signalPolicy: SignalPolicy = 'auto';

// [RFC-001] Worker-Side Transformation is now enforced.


// ============================================================================
// 初始化 LinkedOM (每个 Worker 独立)
// ============================================================================

let document!: Document;
let window!: Window;

function initLinkedOM() {
    const dom = parseHTML(
        '<!DOCTYPE html><html><head></head><body></body></html>'
    );
    document = dom.document;
    window = dom.window;

    // 设置 globalThis
    (globalThis as any).document = document;
    (globalThis as any).window = window;

    // 暴露 MutationObserver 到 globalThis
    (globalThis as any).MutationObserver = (window as any).MutationObserver;
}

// 首次初始化
initLinkedOM();

// ============================================================================
// IPC 消息处理
// ============================================================================

parentPort?.on('message', async (msg: MainToWorkerMessage) => {
    if (msg.type === 'STATE_STORAGE_RESPONSE') { persistenceRecord?.proxy.receive(msg);return; }
    if (msg.type === 'VIEW_TOOL_INVOKE_ORDINARY_V2') {
        try {
            const kernel = app instanceof AppKernel ? app : null;
            const response = await invokeOrdinaryInvocationV2(msg,{appId,instanceId:appInstanceId,
                negotiated:ordinaryParametersNegotiatedApp!==null && ordinaryParametersNegotiatedApp===app,
                ...(kernel ? {validateBinding:(tool,target)=>kernel.validateBoundViewTool(tool,target),
                    validateWrapper:(tool,target)=>kernel.validateBoundOrdinaryParametersViewTool(tool,target),
                    invokeBinding:(tool,target,args)=>kernel.invokeBoundOrdinaryParametersViewTool(tool,target,args)} : {}),
            });
            if (response) { await flushInteractionProjection(); parentPort?.postMessage(response); }
        } catch { /* No trusted terminal: Host records unknown. */ }
        return;
    }
    if (msg.type === 'VIEW_TOOL_INVOKE_REF_V2') {
        try {
            const kernel = app instanceof AppKernel ? app : null;
            const response = await invokeRefInvocationV2(msg, { appId, instanceId: appInstanceId,
                negotiated: refV2NegotiatedApp !== null && refV2NegotiatedApp === app,
                ...(kernel ? { validateBinding: (tool, target) => kernel.validateBoundViewTool(tool, target),
                    validateWrapper: (tool, target) => kernel.validateBoundSnapshotValueParametersViewTool(tool, target),
                    invokeBinding: (tool, target, args) => kernel.invokeBoundSnapshotValueParametersViewTool(tool, target, args) } : {}),
            });
            if (response) { await flushInteractionProjection(); parentPort?.postMessage(response); }
        } catch { /* No trusted terminal: Host records unknown. */ }
        return;
    }
    if (['APP_STOP', 'APP_SHUTDOWN', 'APP_CLOSE', 'APP_DELETE', 'APP_REINITIALIZE', 'TERMINATE'].includes(msg.type)) revokeRefProtocol();
    // STOP revokes business admission while allowing an already-started render
    // to commit its sole resource owner. Final close joins that initialization.
    if (msg.type === 'APP_STOP' && app instanceof AppKernel) app.stopApplication();
    if (['APP_SHUTDOWN', 'APP_CLOSE', 'TERMINATE', 'RESET'].includes(msg.type) && app instanceof AppKernel) app.beginShutdown();
    try {
        switch (msg.type) {
            case 'INIT':
                await handleInit(msg);
                break;
            case 'APP_OPEN':
                await handleAppOpen(msg.requestId);
                break;
            case 'APP_PAUSE':
                await handleAppPause(msg.requestId);
                break;
            case 'APP_RESUME':
                await handleAppResume(msg.requestId);
                break;
            case 'APP_STOP':
                sendResponse(msg.requestId, 'LIFECYCLE_RESPONSE', true);
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
            case 'TERMINATE':
                process.exit(0);
                break;
            case 'RESET':
                await handleReset(msg.requestId);
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

async function handleReset(requestId: RequestID, initGeneration?: number): Promise<void> {
    const resetGeneration = initGeneration ?? revokeRefProtocol();
    const closingApp = app, closingPersistence = persistenceRecord;
    if (closingApp instanceof AppKernel) closingApp.beginShutdown();
    if (closingPersistence) {
        const result = await closingPersistence.session.close(() => closingPersistence.app.onClose());
        if (!result.ok) { persistenceResponse(requestId, closingPersistence, false);return; }
        if (resetGeneration !== lifecycleGeneration || app !== closingApp || persistenceRecord !== closingPersistence) {
            sendError(requestId, 'E_RESET_INVALIDATED', 'Worker reset was invalidated');return;
        }
        if (persistenceRecord === closingPersistence) persistenceRecord = null;
    }
    app = null;
    projectionUnsubscribe?.();
    projectionUnsubscribe = undefined;
    // 1. 停止 DOM 观察
    if (domObserver) {
        domObserver.disconnect();
        domObserver = null;
    }
    if (domUpdateTimer) {
        clearTimeout(domUpdateTimer);
        domUpdateTimer = null;
    }

    // 3. 重置 DOM 环境 (完全重建 LinkedOM 以清除 head/events)
    if (appContainer) {
        appContainer.remove();
        appContainer = null;
    }
    // Re-initialize LinkedOM to get a fresh document/window
    initLinkedOM();
    // 4. 重置状态
    appId = createAppId('');
    desktopId = createDesktopId('');
    appInstanceId = '';
    producerSequence = 0;
    signalPolicy = 'auto';

    // Detach/reset synchronously. A late old close must not erase a newer INIT.
    if (closingApp && !closingPersistence) {
        try { await closingApp.onClose(); }
        catch { console.error('[Worker] App cleanup failed during reset'); }
    }

    // 发送响应
    parentPort?.postMessage({
        type: 'RESET_RESPONSE',
        requestId,
        success: true,
    } as WorkerToMainMessage);
}

async function handleInit(msg: InitMessage): Promise<void> {
    if (msg.appInstanceId && msg.appInstanceId === lastInitInstanceId) {
        sendError(msg.requestId, 'APP_INSTANCE_REUSE_UNSUPPORTED', 'A logical App instance can initialize only once');return;
    }
    if (typeof msg.appInstanceId !== 'string' || !msg.appInstanceId.trim()) {
        sendError(msg.requestId, 'APP_INSTANCE_MISMATCH', 'Runtime App instance identity is required');return;
    }
    lastInitInstanceId = msg.appInstanceId;
    const generation = revokeRefProtocol();
    const field = Object.getOwnPropertyDescriptor(msg, 'requestedCapabilities');
    const requested = field && !('value' in field) ? null : captureWorkerCapabilities(field?.value);
    if (appId) {
        await handleReset('internal_reset', generation);
        if (persistenceRecord) { sendError(msg.requestId, 'PERSISTENCE_CLOSE_FAILED', 'Previous instance did not close successfully');return; }
    }
    if (generation !== lifecycleGeneration) {
        sendError(msg.requestId, 'E_INIT_INVALIDATED', 'App initialization was invalidated');
        return;
    }
    app = null;
    appId = msg.appId;
    desktopId = msg.desktopId;
    // Identity is supplied by the bound Runtime WorkerHost, never inferred from
    // appId or Date.now. Reused physical Workers receive a fresh INIT token.
    appInstanceId = typeof msg.appInstanceId === 'string' ? msg.appInstanceId : '';
    producerSequence = 0;

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

        // Only the managed SDK component factory is a supported App entry.
        // Do not run callable factories, legacy .create() objects, App instances,
        // or global config fallbacks in a Worker.
        const factory: unknown = appModule.default;
        if (!isTUIAppFactory(factory)) {
            throw new AOTUIError('APP_INVALID_EXPORT', { modulePath: msg.appModulePath });
        }
        const managedFactory = factory;
        const offerField = Object.getOwnPropertyDescriptor(msg, 'persistence');
        const offer = offerField && 'value' in offerField ? capturePersistenceOffer(offerField.value, msg.appInstanceId ?? '') : null;
        if (!offerField || !('value' in offerField) || !offer) throw new Error('Invalid persistence offer');

        const lifecycleOffer = Object.getOwnPropertyDescriptor(msg, 'appLifecycle');
        if (!lifecycleOffer || !('value' in lifecycleOffer) || !captureAppLifecycleAck(lifecycleOffer.value, msg.appInstanceId ?? ''))
            throw new Error('APP_LIFECYCLE_UNSUPPORTED');

        // The factory object itself supplies the only ComponentFactory; the
        // Worker injects launchConfig into AppKernel's managed config.
        const configWithLaunch = {
            ...managedFactory.kernelConfig,
            component: managedFactory,
            launchConfig,
        };

        if (managedFactory.kernelConfig.signalPolicy) {
            signalPolicy = managedFactory.kernelConfig.signalPolicy as SignalPolicy;
        }

        app = new AppKernel(configWithLaunch);

        // Keep the SDK/AppKernel App identity equal to the authenticated
        // Worker INIT appId. Otherwise Tool IDs and SDK AppRuntimeContext use ''.
        if (app instanceof AppKernel) {
            app.setId(appId);
            if (msg.appInstanceId) app.setAppExecutionInstanceId(msg.appInstanceId);
            app.enableAppLifecycle();
            const proxy = createStateStorageProxy(offer.instanceId, offer.transport, request => {
                if (!parentPort) return false;parentPort.postMessage(request);
            });
            const configured = launchConfig?.AOTUI_APP_NAME;
            const session = createAppStatePersistence({ instanceId: offer.instanceId, desktopId: String(msg.desktopId),
                appKey: typeof configured === 'string' && configured.length ? configured : String(msg.appId),
                storage: proxy.storage, limits: offer.limits });
            app.setPersistence(session.port);
            persistenceRecord = { app, proxy, session };
        }

        // 创建 App 容器
        appContainer = document.createElement('div') as unknown as HTMLElement;
        appContainer.id = `app-root-${appId}`;
        document.body.appendChild(appContainer as unknown as Node);

        const refV2Accepted = requested?.includes(REF_V2_CAPABILITY) === true && app instanceof AppKernel;
        refV2NegotiatedApp = refV2Accepted ? app : null;
        const parametersAccepted = requested?.includes(ORDINARY_V2_CAPABILITY) === true && app instanceof AppKernel;
        ordinaryParametersNegotiatedApp = parametersAccepted ? app : null;
        const capabilities = [...(refV2Accepted ? [REF_V2_CAPABILITY] : []), ...(parametersAccepted ? [ORDINARY_V2_CAPABILITY] : [])];
        const initializedPersistence = persistenceRecord;
        if (!initializedPersistence) throw new Error('PERSISTENCE_INIT_FAILED');
        parentPort?.postMessage({ type: 'INIT_RESPONSE', requestId: msg.requestId, success: true,
            appLifecycle: { protocol: 'app-lifecycle-v2', version: 2, instanceId: msg.appInstanceId! },
            persistence: { protocol: 'state-session-v1', version: 1, instanceId: initializedPersistence.session.port.instanceId },
            acceptedCapabilities: capabilities,
            appInstanceId,
        } as WorkerToMainMessage);
    } catch (error) {
        if (generation === lifecycleGeneration) { refV2NegotiatedApp = null; ordinaryParametersNegotiatedApp = null; }
        const failed = persistenceRecord;
        if (failed) { if (failed.app instanceof AppKernel) failed.app.beginShutdown(); await failed.session.close(() => failed.app.onClose(), true); }
        sendError(msg.requestId, 'E_INIT_FAILED', 'App initialization failed');
    }
}

async function handleAppOpen(requestId: RequestID): Promise<void> {
    const openingApp = app;
    const generation = lifecycleGeneration;
    if (!openingApp || !appContainer) {
        sendError(requestId, 'E_NOT_INITIALIZED', 'App not initialized');
        return;
    }

    // 渲染回调 - ViewBasedApp 注册，markDirty 调用
    let renderCallback: (() => void) | null = null;

    // Render Phase Flag + Deferred Scheduling
    // 防止无限渲染循环。如果在渲染期间调用 markDirty，不会立即触发新渲染，
    // 而是设置 needsRerender 标志，等当前渲染结束后通过 queueMicrotask 调度。
    let isRendering = false;
    let needsRerender = false;

    function scheduleRender(): void {
        if (!renderCallback || app !== openingApp || generation !== lifecycleGeneration) return;

        isRendering = true;
        try {
            renderCallback();
        } finally {
            isRendering = false;
            // Check if a deferred render was requested during the render phase
            if (needsRerender) {
                needsRerender = false;
                // Use queueMicrotask to break the synchronous call chain
                queueMicrotask(() => scheduleRender());
            }
        }
    }

    const context: AppContext = {
        appId,
        desktopId,

        markDirty: () => {
            if (app !== openingApp || generation !== lifecycleGeneration) return;
            // If currently rendering, defer the re-render
            if (isRendering) {
                needsRerender = true;
                return;
            }

            // Not in render phase - schedule render normally
            if (renderCallback) {
                scheduleRender();
            }
        },
        onRender: (callback: () => void) => {
            renderCallback = callback;
        },
    };

    const openingPersistence = persistenceRecord;
    try { await openingApp.onOpen(context, appContainer); }
    catch {
        if (openingPersistence) {
            if (openingPersistence.app instanceof AppKernel) openingPersistence.app.beginShutdown();
            await openingPersistence.session.close(() => openingPersistence.app.onClose(), true);
            persistenceResponse(requestId, openingPersistence, false);
        } else sendError(requestId, 'E_OPEN_FAILED', 'App initial commit failed');
        return;
    }
    if (app !== openingApp || generation !== lifecycleGeneration) {
        sendError(requestId, 'E_OPEN_INVALIDATED', 'App opening was invalidated');
        return;
    }

    // M3: semantic-only Ref / ViewTypeTool changes can leave DOM unchanged.
    // This is a Worker Adapter subscription, not a Core dependency on DOM.
    // Preserve signalPolicy: manual apps do not auto-publish observations.
    projectionUnsubscribe?.();
    const projection = currentProjection();
    if (projection) {
        // Do not replay the initial render's already-observed notifications.
        const subscribedAtEpoch = projection.token().epoch;
        projectionUnsubscribe = projection.subscribe(token => {
            // Ref-only and Tool-only commits publish without requiring a DOM change.
            if (token.epoch > subscribedAtEpoch && signalPolicy !== 'manual') {
                scheduleDomUpdate();
            }
        });
    }

    // [Worker-Only] 启动 DOM 观察并推送初始状态
    startDomObserver();
    // [RFC-001] Enforce Worker-Side Transformation
    pushSemanticSnapshot();

    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleAppPause(requestId: RequestID): Promise<void> {
    if (app?.onPause) {
        await app.onPause();
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleAppResume(requestId: RequestID): Promise<void> {
    if (app?.onResume) {
        await app.onResume();
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleAppClose(requestId: RequestID): Promise<void> {
    const record = persistenceRecord;
    if (!record) { sendError(requestId, 'PERSISTENCE_UNAVAILABLE', 'Managed persistence session is unavailable');return; }
    const result = await record.session.close(() => record.app.onClose());
    persistenceResponse(requestId, record, result.ok);
}

async function handleAppReinitialize(requestId: RequestID, _reason?: string): Promise<void> {
    if (app?.onReinitialize) {
        await app.onReinitialize({
            appId,
            desktopId,
            markDirty: () => {},
            onRender: () => {},
            reason: _reason,
        });
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
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
    try { await app?.onDelete?.(); }
    catch {
        parentPort?.postMessage({ type: 'LIFECYCLE_RESPONSE', requestId, success: false,
            error: { code: 'APP_DELETE_FAILED', message: 'APP_DELETE_FAILED' } } as WorkerToMainMessage);
        return;
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleExternalEvent(
    requestId: RequestID,
    viewId: ViewID,
    eventType: string,
    data: Record<string, unknown>
): Promise<void> {
    if (!appContainer) {
        sendError(requestId, 'E_NOT_INITIALIZED', 'App container not initialized');
        return;
    }

    // [Milestone 1] Dispatch external event to appContainer
    // This allows SDK hooks (useExternalEvent) to listen for system events
    const event = new (window as any).CustomEvent('aotui:external-event', {
        bubbles: true,
        detail: {
            type: eventType,
            viewId,
            data,
            timestamp: Date.now()
        }
    });
    appContainer.dispatchEvent(event);

    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
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
    if (!appContainer) {
        console.warn('[Worker] Cannot dispatch LLM text: appContainer not initialized');
        return;
    }

    // Dispatch custom event for SDK hooks to listen
    // [RFC-020] Include reasoning in event detail
    const event = new (window as any).CustomEvent('aotui:llm-text', {
        bubbles: true,
        detail: {
            type: msg.eventType,
            content: msg.content,
            reasoning: msg.reasoning,
            timestamp: msg.timestamp,
            id: `llm_${msg.timestamp}`,
            meta: msg.meta
        }
    });
    appContainer.dispatchEvent(event);
}


// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 启动 DOM 观察器
 * 
 * 监听 appContainer 的 DOM 变化，节流后推送到主线程
 * 
 * [RFC-012] 根据 signalPolicy 决定行为:
 * - 'auto': 正常触发
 * - 'never': 仍然推送 snapshot (保持数据鲜度) 但带 suppressSignal 标志
 * - 'manual': 不自动推送 snapshot
 */
function startDomObserver(): void {
    if (!appContainer || domObserver) return;

    // [RFC-012] 'never' 策略仍然需要 observer 来推送数据
    // Notification policy travels with each Semantic publication.

    // LinkedOM 支持 MutationObserver
    domObserver = new MutationObserver(() => {
        // M3: DOM changes are semantic projection changes even when no Ref/Tool
        // registration changed. This epoch is a version, not Date.now().
        currentProjection()?.recordMutation('content');
        // [RFC-012] manual 模式下不自动推送
        if (signalPolicy === 'manual') {
            return;
        }
        scheduleDomUpdate();
    });

    domObserver.observe(appContainer as unknown as Node, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
    });

}

/**
 * 节流调度 DOM 更新
 */
function scheduleDomUpdate(): void {
    if (domUpdateTimer) return;  // 已有计划中的更新

    domUpdateTimer = setTimeout(() => {
        domUpdateTimer = null;
        // [RFC-001] Enforce Worker-Side Transformation
        pushSemanticSnapshot();
    }, DOM_UPDATE_THROTTLE_MS);
}

/**
 * Publish the handler's committed render before its terminal response. MessagePort
 * ordering lets the Host accept that projection before resolving the invocation.
 * Background business work still publishes when the application completes it.
 */
async function flushInteractionProjection(): Promise<void> {
    // Drain the already queued component/MutationObserver microtask, not a wall-clock delay.
    await Promise.resolve();
    if (!appContainer) return;
    if (domUpdateTimer) {
        clearTimeout(domUpdateTimer);
        domUpdateTimer = null;
    }
    pushSemanticSnapshot();
}

// [RFC-001 Phase 3] Removed legacy pushDomUpdate


function pushSemanticSnapshot(): void {
    if (!appContainer) return;
    const producerSeq = ++producerSequence;
    const before = currentProjection()?.token();
    const sourceEpoch = before?.epoch ?? 0;
    try {
        if (!parentPort) throw new Error('Semantic transport unavailable');
        if (!before?.ready || !(app instanceof AppKernel)) throw new Error('Semantic projection is not ready');
        const now = Date.now();
        const draft = copyJson(captureDOMSnapshot({ appId, instanceId: appInstanceId,
            producerSeq, sourceEpoch, capturedAt: now, container: appContainer,
            fragments: extractViewFragments(appContainer), kernel: app }), {
                maxDepth: DEFAULT_SNAPSHOT_LIMITS.maxDepth,
                maxNodes: DEFAULT_SNAPSHOT_LIMITS.maxNodes,
                maxApproxBytes: DEFAULT_SNAPSHOT_LIMITS.maxSnapshotBytes * 2,
            });
        const after = currentProjection()?.token();
        if (!after?.ready || after.epoch !== sourceEpoch) throw new Error('Projection changed during capture');
        parentPort.postMessage({ type: 'SNAPSHOT_PREPARED', draft,
            suppressSignal: signalPolicy === 'never' } as WorkerToMainMessage);
    } catch (error) {
        if (!parentPort) throw new Error('Semantic snapshot transport unavailable');
        const serializationFailure = (error instanceof SnapshotDataError && error.code === 'SNAPSHOT_SERIALIZATION_ERROR') ||
            (error instanceof Error && error.name === 'DataCloneError');
        const nestedViewMessage = error instanceof Error && error.message.startsWith('NESTED_VIEW_UNSUPPORTED:')
            ? error.message.slice(0, 160) : undefined;
        const message = error instanceof SnapshotDataError
            ? `${error.message} at …${error.path.slice(-112)}`.slice(0, 160)
            : nestedViewMessage ?? 'Semantic snapshot preparation or transport failed';
        parentPort.postMessage({ type: 'SNAPSHOT_PREPARE_FAILED', appId,
            instanceId: appInstanceId, producerSeq, sourceEpoch,
            suppressSignal: signalPolicy === 'never',
            error: { code: serializationFailure ? 'SNAPSHOT_SERIALIZATION_ERROR' : 'SNAPSHOT_INVALID', message },
        } as WorkerToMainMessage);
    }
}

function sendResponse(
    requestId: RequestID,
    type: 'INIT_RESPONSE' | 'LIFECYCLE_RESPONSE',
    success: boolean
): void {
    parentPort?.postMessage({
        type,
        requestId,
        success,
        ...(type === 'LIFECYCLE_RESPONSE' && app instanceof AppKernel && app.getAppCleanupReport() ? { appCleanup: app.getAppCleanupReport() } : {}),
    } as WorkerToMainMessage);
}

function sendError(requestID: RequestID, code: string, message: string): void {
    parentPort?.postMessage({
        type: 'ERROR_RESPONSE',
        requestId: requestID,
        success: false,
        error: { code, message },
    } as WorkerToMainMessage);
}
