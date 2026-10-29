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
    ViewToolInvokeMessage,
    ViewToolValidateMessage,
    InitMessage,
    RequestID,
    ViewID,
    AppID,
    DesktopID,
} from '../spi/worker-protocol/index.js';

// [RFC-001] Transformer for Worker-Side Transformation
import { transformElement } from '../engine/view/transformer/pure.js';
import { createViewFragmentExtractor } from './view-fragment-extractor.js';
import { DomSnapshotShadowProducer } from './dom-snapshot-producer.js';

// Runtime SPI types
import type { IAOTUIApp, AppContext, IProjectionPort, OperationContext, SignalPolicy } from '../spi/index.js';
import { createAppId, createDesktopId, type SnapshotID, type OperationID } from '../spi/index.js';
import { AOTUIError } from '../spi/core/errors.js';

// [方案 B] AppKernel from worker-runtime
import { AppKernel } from './app-kernel/index.js';

// [RFC-002] Global Ref Registry from SDK -> REMOVED
// Ref data is now exported via AppKernel (explicit dependency)

// ============================================================================
// Worker 状态
// ============================================================================

let app: IAOTUIApp | null = null;
let appId: AppID = '' as AppID;  // Will be set by INIT message
let desktopId: DesktopID = '' as DesktopID;  // Will be set by INIT message
let appContainer: HTMLElement | null = null;
// M2 shadow only: independent, versioned App instance transport.
let shadowInstanceId = '';
let shadowEnabled = false;
let experimentalReadOnlyViewTools = false;
let experimentalVersionedMutations = false;
let shadowProducerSeq = 0;
let shadowObservedEpoch = 0; // Fallback for non-component App implementations.
const shadowProducer = new DomSnapshotShadowProducer();
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

const extractViewFragments = createViewFragmentExtractor();

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
            case 'VIEW_DISMOUNT':
                await handleViewDismount(msg.requestId, msg.viewId);
                break;
            case 'VIEW_MOUNT_BY_LINK':
                await handleViewMountByLink(msg.requestId, msg.parentViewId, msg.linkId);
                break;
            case 'VIEW_TOOL_INVOKE':
                await handleViewToolInvoke(msg);
                break;
            case 'VIEW_TOOL_VALIDATE':
                await handleViewToolValidate(msg);
                break;
            case 'APP_OPERATION':
            case 'VIEW_OPERATION':
                await handleOperation(msg.requestId, msg.operation, msg.args, msg.snapshotId, msg.viewId);
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

async function handleReset(requestId: RequestID): Promise<void> {
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

    // 2. 调用 App 清理
    if (app) {
        try {
            await app.onClose();
        } catch (e) {
            console.error('[Worker] Error closing app during reset:', e);
        }
        app = null;
    }

    // 3. 重置 DOM 环境 (完全重建 LinkedOM 以清除 head/events)
    if (appContainer) {
        appContainer.remove();
        appContainer = null;
    }
    // Re-initialize LinkedOM to get a fresh document/window
    initLinkedOM();
    extractViewFragments.clear();

    // 4. 重置状态
    appId = createAppId('');
    desktopId = createDesktopId('');
    shadowInstanceId = '';
    shadowEnabled = false;
    experimentalReadOnlyViewTools = false;
    experimentalVersionedMutations = false;
    shadowProducerSeq = 0;
    shadowObservedEpoch = 0;
    shadowProducer.reset();

    // 发送响应
    parentPort?.postMessage({
        type: 'RESET_RESPONSE',
        requestId,
        success: true,
    } as WorkerToMainMessage);
}

async function handleInit(msg: InitMessage): Promise<void> {
    // 如果已经初始化过 (从池中获取但未重置? 理论上不应发生)，先重置
    if (appId && appId !== msg.appId) {
        console.warn(`[Worker] Re-initializing worker (prev: ${appId}, new: ${msg.appId})`);
        await handleReset('internal_reset');
    }

    appId = msg.appId;
    desktopId = msg.desktopId;
    // Identity is supplied by the bound Runtime WorkerHost, never inferred from
    // appId or Date.now. Reused physical Workers receive a fresh INIT token.
    shadowEnabled = msg.snapshotShadow === true && typeof msg.appInstanceId === 'string' && msg.appInstanceId.length > 0;
    experimentalReadOnlyViewTools = shadowEnabled && msg.experimentalReadOnlyViewTools === true;
    experimentalVersionedMutations = shadowEnabled && msg.experimentalVersionedMutations === true;
    shadowInstanceId = typeof msg.appInstanceId === 'string' ? msg.appInstanceId : '';
    shadowProducerSeq = 0;
    shadowObservedEpoch = 0;
    shadowProducer.reset();

    // [重构] 不再使用 globalThis，config 将通过 AppKernel 构造函数传递
    const launchConfig = msg.config;

    // 动态加载 App 模块
    try {
        // [RFC-005] Configuration Injection
        // Runtime Config is handled via AppWorkerHost passing it to Worker, 
        // but here we focus on App Config.

        const appModule = await import(msg.appModulePath);

        // [方案 B] 支持多种导出方式，优先使用 kernelConfig
        const factory = appModule.default;

        if (factory?.kernelConfig) {
            // 新模式: 使用 kernelConfig 在 Worker Runtime 中实例化 AppKernel
            // [重构] 将 launchConfig 注入到 kernelConfig 中
            const configWithLaunch = {
                ...factory.kernelConfig,
                launchConfig,  // 注入运行时配置
            };

            // [RFC-012] 读取 signalPolicy
            if (factory.kernelConfig.signalPolicy) {
                signalPolicy = factory.kernelConfig.signalPolicy;
            }

            app = new AppKernel(configWithLaunch);
        } else if (factory) {
            // 向后兼容: TUIAppFactory { create: () => ... }
            // 注意：旧模式无法注入 launchConfig，需要保留 globalThis 作为 fallback
            if (launchConfig) {
                console.warn('[Worker] Legacy factory mode - using globalThis fallback for config');
                (globalThis as any).__AOTUI_APP_CONFIG__ = launchConfig;
            }
            if (typeof factory.create === 'function') {
                app = factory.create();
            } else if (typeof factory === 'function') {
                app = factory();
            } else {
                app = factory;
            }
        } else if (appModule.app) {
            app = appModule.app;
        } else {
            throw new AOTUIError('APP_INVALID_EXPORT', { modulePath: msg.appModulePath });
        }

        // Keep the SDK/AppKernel App identity equal to the authenticated
        // Worker INIT appId. Otherwise Tool IDs and SDK AppRuntimeContext use ''.
        if (app instanceof AppKernel) {
            app.setId(appId);
            if (msg.appInstanceId) app.setAppExecutionInstanceId(msg.appInstanceId);
        }

        // 创建 App 容器
        appContainer = document.createElement('div') as unknown as HTMLElement;
        appContainer.id = `app-root-${appId}`;
        document.body.appendChild(appContainer as unknown as Node);

        sendResponse(msg.requestId, 'INIT_RESPONSE', true);
    } catch (error) {
        sendError(msg.requestId, 'E_INIT_FAILED', String(error));
    }
}

async function handleAppOpen(requestId: RequestID): Promise<void> {
    if (!app || !appContainer) {
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
        if (!renderCallback) return;

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

    await app.onOpen(context, appContainer);

    // M3: semantic-only Ref / ViewTypeTool changes can leave DOM unchanged.
    // This is a Worker Adapter subscription, not a Core dependency on DOM.
    // Preserve signalPolicy: manual apps do not auto-publish observations.
    projectionUnsubscribe?.();
    const projection = currentProjection();
    if (projection) {
        // Do not replay the initial render's already-observed notifications.
        const subscribedAtEpoch = projection.token().epoch;
        projectionUnsubscribe = projection.subscribe(token => {
            // Even without Shadow, Ref-only changes must refresh legacy Snapshot.
            if (token.epoch > subscribedAtEpoch && signalPolicy !== 'manual') {
                scheduleDomUpdate();
            }
        });
    }

    // [Worker-Only] 启动 DOM 观察并推送初始状态
    startDomObserver();
    // [RFC-001] Enforce Worker-Side Transformation
    pushSnapshotFragment();

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
    if (app) {
        await app.onClose();
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
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
    try {
        // 触发 window 上的 'aotui:shutdown' 事件，让 SDK 层执行 persistence flush
        const shutdownPromise = new Promise<void>((resolve, reject) => {
            const win = globalThis.window as (Window & typeof globalThis) | undefined;
            if (!win || typeof win.dispatchEvent !== 'function') {
                resolve();
                return;
            }

            let settled = false;
            const settleResolve = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const settleReject = (error: unknown) => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            // 防止无监听器时卡住 shutdown（best effort）
            const fallbackTimer = setTimeout(() => {
                console.warn('[Worker] APP_SHUTDOWN flush timeout fallback');
                settleResolve();
            }, 1000);

            try {
                const CustomEventCtor = (win as any).CustomEvent ?? CustomEvent;
                const event = new CustomEventCtor('aotui:shutdown', {
                    detail: {
                        resolve: () => {
                            clearTimeout(fallbackTimer);
                            settleResolve();
                        },
                        reject: (error: unknown) => {
                            clearTimeout(fallbackTimer);
                            settleReject(error);
                        },
                    }
                });
                win.dispatchEvent(event);
            } catch (error) {
                clearTimeout(fallbackTimer);
                settleReject(error);
            }
        });

        // 等待持久化完成
        await shutdownPromise;
    } catch (error) {
        console.error('[Worker] Error during shutdown persistence:', error);
        // 持久化失败不应该阻塞shutdown流程，best effort
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleAppDelete(requestId: RequestID): Promise<void> {
    if (app && app.onDelete) {
        try {
            await app.onDelete();
        } catch (error) {
            console.error('[Worker] Error in app.onDelete:', error);
            // Delete should try best effort, but ensure we return execution
        }
    }
    // Delete implies Close (Runtime will call Close separately, but App might rely on onDelete -> Close flow)
    // Actually, AppManager calls delete() then close(). 
    // Here we just handle the delete hook.
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleViewDismount(requestId: RequestID, viewId: ViewID): Promise<void> {
    // Dispatch aotui:system event to appContainer for AppRuntime to handle
    if (appContainer) {
        const event = new (window as any).CustomEvent('aotui:system', {
            bubbles: true,
            detail: { type: 'dismount_view', viewId }
        });
        appContainer.dispatchEvent(event);
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}



/**
 * [RFC-006] Handle VIEW_MOUNT_BY_LINK message
 * 
 * Mount a view via ViewLink (V2 API)
 */
async function handleViewMountByLink(requestId: RequestID, parentViewId: ViewID, linkId: string): Promise<void> {
    // Dispatch aotui:system event with new V2 payload
    if (appContainer) {
        const event = new (window as any).CustomEvent('aotui:system', {
            bubbles: true,
            detail: { type: 'mount_view_by_link', parentViewId, linkId }
        });
        appContainer.dispatchEvent(event);
    }
    sendResponse(requestId, 'LIFECYCLE_RESPONSE', true);
}

async function handleViewToolValidate(message: ViewToolValidateMessage): Promise<void> {
    const denied = (code: string, message: string) => ({
        success: false, error: { code, message },
    });
    let result;
    if (!experimentalVersionedMutations || !shadowEnabled) {
        result = denied('TOOL_UNAVAILABLE', 'Versioned mutation preflight is disabled');
    } else if (message.appId !== appId || message.instanceId !== shadowInstanceId ||
        !(app instanceof AppKernel)) {
        result = denied('APP_INSTANCE_MISMATCH', 'Tool preflight App instance is no longer active');
    } else if (!message.tool.isMutating) {
        result = denied('TOOL_PERMISSION_DENIED', 'Mutation preflight requires a mutating Tool');
    } else {
        result = app.validateBoundViewTool(message.tool, message.target);
    }
    // Validation NEVER calls a business Tool Handler.
    parentPort?.postMessage({
        type: 'OPERATION_RESPONSE', requestId: message.requestId,
        success: true, result,
    } as WorkerToMainMessage);
}

async function handleViewToolInvoke(message: ViewToolInvokeMessage): Promise<void> {
    const denied = (code: string, text: string) => ({
        success: false, error: { code, message: text },
    });
    const result = !experimentalReadOnlyViewTools ||
        !shadowEnabled || message.instanceId !== shadowInstanceId ||
        message.appId !== appId || !(app instanceof AppKernel)
        ? denied('APP_INSTANCE_MISMATCH', 'View Tool source is not the current trusted Worker')
        : await app.invokeBoundReadOnlyTool(message.tool, message.target, message.args);
    // Transport delivery success and business Tool success remain distinct.
    parentPort?.postMessage({
        type: 'OPERATION_RESPONSE',
        requestId: message.requestId,
        success: true,
        result,
    } as WorkerToMainMessage);
}

async function handleOperation(
    requestId: RequestID,
    operation: string,
    args: Record<string, unknown>,
    snapshotId: string,
    viewId?: ViewID
): Promise<void> {
    if (!app) {
        sendError(requestId, 'E_NOT_INITIALIZED', 'App not initialized');
        return;
    }

    const context: OperationContext = {
        appId,
        viewId,
        snapshotId: snapshotId as SnapshotID,
    };

    const result = await app.onOperation(context, operation as OperationID, args);

    parentPort?.postMessage({
        type: 'OPERATION_RESPONSE',
        requestId,
        success: true,
        result,
    } as WorkerToMainMessage);
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
    meta?: {
        model?: string;
        usage?: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
        };
    }
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
    // suppressSignal 标志会在 pushSnapshotFragment 中设置

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
        pushSnapshotFragment();
    }, DOM_UPDATE_THROTTLE_MS);
}

// [RFC-001 Phase 3] Removed legacy pushDomUpdate


/**
 * [RFC-001] 推送 Snapshot Fragment 到主线程 (新协议)
 * 
 * 在 Worker 内直接执行 Transform，推送 Markdown + IndexMap，
 * 避免主线程 HTML 解析开销。
 * 
 * [RFC-002] Phase 2: 合并两个数据源的 IndexMap:
 * 1. Transformer 解析的 indexMap (来自 data-value，向后兼容)
 * 2. GlobalRefRegistry 导出的 indexMap (新 Ref 系统，无序列化)
 */
function pushSnapshotFragment(): void {
    if (!appContainer) return;

    const now = Date.now();
    const projectionBefore = shadowEnabled ? currentProjection()?.token() : undefined;

    // 在 Worker 内执行 Transform (传入 appId 以支持 operation 路径生成)
    const { markup, indexMap: transformerIndexMap } = transformElement(appContainer, appId);

    // [RFC-002] Ref Registry: Use AppKernel Explicit Export
    let finalIndexMap = transformerIndexMap;

    const kernel = app as unknown as {
        exportRefsToIndexMap?: () => Record<string, unknown>;
        getAllTypeTools?: () => Map<string, Array<{
            id: string;
            name: string;
            viewType: string;
            description: string;
            params: Record<string, unknown>;
        }>>;
        getToolAppName?: () => string;
    };

    if (kernel?.exportRefsToIndexMap) {
        const refIndexMap = kernel.exportRefsToIndexMap();
        const refCount = Object.keys(refIndexMap).length;
        if (refCount > 0) {
            finalIndexMap = { ...transformerIndexMap, ...refIndexMap } as typeof transformerIndexMap;
        }
    }

    const viewFragments = extractViewFragments(appContainer, appId, now);

    // [RFC-007] Get App View Tree if available
    let viewTree: string | undefined;
    if (app && typeof app.renderViewTree === 'function') {
        viewTree = app.renderViewTree();
    }

    // [View Type Aggregation] Get Type Tools from AppKernel
    if (kernel?.getAllTypeTools) {
        const allTypeTools = kernel.getAllTypeTools();

        // [RFC-020] Export Type Tools to IndexMap for AgentDriver discovery
        // AgentDriver uses generateToolsFromIndexMap to find tools
        // Format: tool:{app_name}-{viewType}-{toolName} (使用连字符以符合 API 工具名规范)
        const semanticAppName = kernel?.getToolAppName?.() ?? appId;
        for (const [viewType, tools] of allTypeTools) {
            for (const tool of tools) {
            // Construct App-scoped ID: appName-viewType-toolName
                // Note: IndexMap key must start with "tool:"
                // 使用连字符 '-' 而非点 '.' 以符合 LLM API 工具名要求 ^[a-zA-Z0-9_-]+$
            const toolKey = `tool:${semanticAppName}-${viewType}-${tool.name}`;

                // AgentDriver expects: description, params
                const transformedParams = Object.entries(tool.params || {}).map(([name, def]) => {
                    // SDK uses 'desc', Runtime/AgentDriver uses 'description'
                    const d = def as any;

                    return {
                        name,
                        type: d.type || 'string',  // 提供默认值防止 undefined
                        required: d.required,
                        description: d.desc || d.description || '',
                        itemType: d.itemType, // 保留 itemType 用于 array 类型
                        options: d.options    // 保留 options 用于 enum 类型
                    };
                });

                finalIndexMap[toolKey] = {
                    description: tool.description,
                    params: transformedParams,
                    appId,
                    appName: semanticAppName,
                    viewType,
                    toolName: tool.name,
                };
            }
        }
    }

    const shadowCaptureSeq = shadowEnabled && shadowInstanceId ? ++shadowProducerSeq : undefined;
    const shadowCaptureEpoch = shadowCaptureSeq !== undefined
        ? (projectionBefore?.epoch ?? ++shadowObservedEpoch) : undefined;
    parentPort?.postMessage({
        type: 'SNAPSHOT_FRAGMENT',
        appId,
        timestamp: now,
        ...(shadowInstanceId ? { appInstanceId: shadowInstanceId } : {}),
        ...(shadowCaptureSeq !== undefined ? {
            shadowCaptureSeq,
            shadowInstanceId,
        } : {}),
        markup,
        indexMap: finalIndexMap,
        views: viewFragments,
        viewTree, // [RFC-007] Push View Tree
        // [RFC-012] 根据 signalPolicy 决定是否抑制信号
        suppressSignal: signalPolicy === 'never',
    } as WorkerToMainMessage);

    // M2: only when explicitly enabled, derive a structured Draft from the
    // SAME best-effort capture. The legacy Fragment above remains authoritative.
    // SDK component Apps now use semantic+DOM mutation epochs; legacy Apps
    // retain the M2 capture-counter fallback until they adopt the same contract.
    if (shadowCaptureSeq !== undefined && shadowCaptureEpoch !== undefined) {
        const producerSeq = shadowCaptureSeq;
        const sourceEpoch = shadowCaptureEpoch;
        const projectionAfter = projectionBefore ? currentProjection()?.token() : undefined;
        if (projectionBefore && (!projectionBefore.ready || !projectionAfter?.ready ||
            projectionAfter.epoch !== projectionBefore.epoch)) {
            // Legacy Fragment is untouched, but the semantic Draft did not have
            // a stable capture epoch. A subsequent mutation event triggers retry.
            parentPort?.postMessage({
                type: 'SNAPSHOT_PREPARE_FAILED',
                appId, instanceId: shadowInstanceId, producerSeq, sourceEpoch,
                error: { code: 'SNAPSHOT_INVALID', message: 'Projection changed while capturing' },
            } as WorkerToMainMessage);
            return;
        }
        try {
            // M4 Stage 2 read-only V2 is selected only for fully View-owned
            // Tool Apps. Mixed/legacy TypeTools retain their exact V1 contract.
            // Do not downgrade an inconsistent V2 Draft to V1 on failure.
            const v2Only = app instanceof AppKernel &&
                app.getViewOwnedViewInstances().length > 0 &&
                [...app.getAllTypeTools().values()].every(tools => tools.length === 0);
            const captureInput = {
                appId, instanceId: shadowInstanceId,
                producerSeq, sourceEpoch, capturedAt: now,
                container: appContainer,
                fragments: viewFragments,
                kernel,
            };
            const draft = v2Only
                ? shadowProducer.captureV2(captureInput)
                : shadowProducer.capture(captureInput);
            if (projectionBefore) {
                const finalToken = currentProjection()?.token();
                if (!finalToken?.ready || finalToken.epoch !== sourceEpoch) {
                    throw new Error('Projection epoch changed while preparing Draft');
                }
            }
            parentPort?.postMessage({
                type: 'SNAPSHOT_PREPARED',
                draft,
            } as WorkerToMainMessage);
        } catch (error) {
            // No live Ref values, SDK data or stack traces in diagnostics.
            try {
                parentPort?.postMessage({
                    type: 'SNAPSHOT_PREPARE_FAILED',
                    appId, instanceId: shadowInstanceId,
                    producerSeq, sourceEpoch,
                    error: {
                        code: error instanceof Error && error.name === 'DataCloneError'
                            ? 'SNAPSHOT_SERIALIZATION_ERROR' : 'SNAPSHOT_INVALID',
                        message: 'Shadow snapshot preparation or transport failed',
                    },
                } as WorkerToMainMessage);
            } catch {
                // Shadow path is never allowed to crash the primary app.
            }
        }
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
