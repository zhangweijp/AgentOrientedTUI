/**
 * AOTUI Runtime - App Kernel
 *
 * [方案 B] 从 @aotui/sdk 迁移到 @aotui/runtime/worker-runtime。
 *
 * Worker 内的 App 执行引擎，负责：
 * - App 生命周期管理 (onOpen, onClose...)
 * - ViewTree 状态管理 (SSOT)
 * - 系统事件处理 (Runtime Bridge)
 * - Operation 路由
 * - Type-level Tools 管理
 *
 * @module @aotui/runtime/worker-runtime/app-kernel
 */

import type {
    AppID,
    ViewID,
    OperationID,
    OperationResult,
    OperationContext,
    AppContext,
    IAOTUIApp,
    IView,
    AppKernelConfig,
    IRefExporter, // [RFC-002]
} from '../../spi/index.js';
import { createViewId } from '../../spi/index.js';
import { AOTUIError, failedResult } from '../../spi/core/errors.js';
import type { DataPayload, IndexMap, RefV1Terminal } from '../../spi/worker-protocol/index.js';
import {createIfAbsentSchema,type CreateIfAbsentTerminal} from '../../core/tool/create-if-absent-contract.js';
import type { SafeRefInvoker, SafeCreateIfAbsentInvoker } from '../../spi/runtime/view-owned-tools.interface.js';
import { compileOrdinaryParams, type OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import { compileSnapshotValueParams, type SnapshotValueParameterContract } from '../../core/tool/snapshot-value-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';

import { ViewRegistry, createViewRegistry } from './view-registry.js';
import { SemanticProjectionCoordinator } from '../../core/projection/coordinator.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import { canonicalJson, copyJson, SnapshotDataError } from '../../core/snapshot/json.js';
import { hasRefParamDeclaration, validateRefParams } from '../../core/tool/ref-declarations.js';
import type { AggregatedViewTool } from '../../core/tool/view-owned-tools.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../../core/snapshot/types.js';
import { paramsToJsonSchema } from '../dom-snapshot-producer.js';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
import { randomUUID } from 'node:crypto';
import { closeError } from '../../engine/core/close-operation.js';

// ─────────────────────────────────────────────────────────────
// Type Definitions for Type-level Tools
// ─────────────────────────────────────────────────────────────

/** Type Tool Definition (for registration) */
export interface TypeToolDefinition {
    description: string;
    params: Record<string, unknown>;
    declaredByViewId?: string;
    declaredByViewGeneration?: string;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/** Type Tool (stored in registry) */
export interface TypeTool {
    id: string;  // `${appId}-${viewType}-${toolName}`
    name: string;
    viewType: string;
    description: string;
    params: Record<string, unknown>;
    declaredByViewId?: string;
    declaredByViewGeneration?: string;
    handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface TypeToolParamDef {
    type?: string;
    itemType?: string;
}

/**
 * App Kernel Implementation
 *
 * 运行在 Worker 内的 App 执行引擎。
 * 实现 IAOTUIApp 接口，供 Worker Runtime 调用。
 */
export class AppKernel implements IAOTUIApp, IRefExporter {
    private _id: AppID = '' as AppID;
    readonly name: string;
    private readonly toolAppName: string;

    private config: AppKernelConfig;
    private context!: AppContext;
    private container!: HTMLElement;

    /**
     * [RFC-B2] ViewRegistry - 轻量级View管理
     * 替代ViewTree,只管理组件模式View
     */
    private viewRegistry: ViewRegistry;
    private viewIdCounter = 0;

    /** [RFC-002] Ref Registry Storage */
    private refRegistry = new Map<string, object>();

    /** [RFC-027] View Registry for component mode (viewKey -> viewId) */
    private viewKeyToId = new Map<string, ViewID>();

    /** Type-level Tools Registry */
    private typeTools = new Map<string, Map<string, TypeTool>>();

    /** A pure TypeScript semantic mutation clock, not a DOM observation. */
    private readonly projection = new SemanticProjectionCoordinator();
    private appExecutionInstanceId: string = randomUUID();
    private viewOwnedTools?: ReturnType<typeof createViewOwnedTools>;

    private persistence?: AppStatePersistence;
    private appLifecycle?: ReturnType<typeof createAppLifecycle>;
    enableAppLifecycle(): void {
        this.assertActive();
        if (this.appLifecycle) throw new Error('APP_LIFECYCLE_ALREADY_ENABLED');
        this.appLifecycle = createAppLifecycle(this.appExecutionInstanceId);
    }
    getAppCleanupReport() { return this.appLifecycle?.getReport(); }
    beginShutdown(): void { this.closing = true; this.appLifecycle?.stop(); }
    stopApplication(): void { this.appLifecycle?.stop(); }

    private closing = false;
    private openPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private deletePromise?: Promise<void>;
    private assertActive(): void { if (this.closing) throw closeError('APP_KERNEL_CLOSED'); }
    private closedToolResult(): OperationResult { return { success: false, error: { code: 'TOOL_UNAVAILABLE', message: 'App lifecycle is closing' } }; }

    setPersistence(port: AppStatePersistence): void {
        this.assertActive();
        if (this.componentRenderer || port.instanceId !== this.appExecutionInstanceId || this.persistence) throw new Error('Invalid persistence instance');
        this.persistence = port;
    }

    getProjectionCoordinator(): SemanticProjectionCoordinator {
        return this.projection;
    }

    setAppExecutionInstanceId(instanceId: string): void {
        this.assertActive();
        if (!instanceId.trim() || this.viewOwnedTools) {
            throw new Error('App execution identity must be assigned before View initialization');
        }
        this.appExecutionInstanceId = instanceId;
    }

    /** M4 Stage 1 diagnostics only: never a Tool execution authorization. */
    getViewOwnedToolDefinitions(): readonly AggregatedViewTool[] {
        return this.viewOwnedTools?.listTools() ?? Object.freeze([]);
    }

    /**
     * Stage 6 preflight: checks LIVE Runtime-owned Tool binding without invoking
     * a Handler. A trusted Host must still independently authorize any I/O.
     */
    validateBoundViewTool(
        source: ToolDescriptorV2,
        target: ToolTargetV2,
    ): OperationResult {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) {
            return { success: false, error: {
                code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized',
            } };
        }
        return this.viewOwnedTools.validate({
            ...source,
            appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId,
        }, target);
    }

    /** Current binding qualification; never invokes the ordinary Wrapper. */
    validateBoundRefViewTool(source: ToolDescriptorV2, target: ToolTargetV2): OperationResult {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateRefBinding({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target);
    }

    invokeBoundRefViewTool(source: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeRef({ ...source, appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId }, target, args);
    }

    validateBoundOrdinaryViewTool(source: ToolDescriptorV2, target: ToolTargetV2): OperationResult {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateOrdinaryBinding({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target);
    }

    validateBoundOrdinaryParametersViewTool(source: ToolDescriptorV2, target: ToolTargetV2): OperationResult {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateOrdinaryParametersBinding({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target);
    }

    validateBoundSnapshotValueParametersViewTool(source: ToolDescriptorV2, target: ToolTargetV2): OperationResult {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) return { success: false, error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } };
        return this.viewOwnedTools.validateSnapshotValueParametersBinding({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target);
    }

    invokeBoundSnapshotValueParametersViewTool(source: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeSnapshotValueParameters({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target, args);
    }

    invokeBoundOrdinaryParametersViewTool(source: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeOrdinaryParameters({ ...source, appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId }, target, args);
    }

    invokeBoundOrdinaryViewTool(source: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>): RefV1Terminal | Promise<RefV1Terminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeOrdinary({ ...source, appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId }, target, args);
    }

    validateBoundCreateIfAbsentViewTool(source: ToolDescriptorV2, target: ToolTargetV2): OperationResult {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateCreateIfAbsentBinding({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target);
    }

    invokeBoundCreateIfAbsentViewTool(source: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>): CreateIfAbsentTerminal | Promise<CreateIfAbsentTerminal> {
        if (this.closing) return { phase: 'not-entered', outcome: { status: 'rejected', code: 'TOOL_UNAVAILABLE', message: 'App lifecycle is closing' } };
        if (!this.viewOwnedTools) return {phase:'not-entered',outcome:{status:'rejected',code:'TOOL_UNAVAILABLE',message:'View-owned Tool registry not initialized'}};
        return this.viewOwnedTools.invokeCreateIfAbsent({ ...source, appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId }, target, args);
    }

    /**
     * Stage 3: read-only, explicitly source-bound Tool execution.
     * This is called only by trusted Worker IPC, never by legacy onOperation.
     */
    async invokeBoundReadOnlyTool(
        source: ToolDescriptorV2,
        target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>,
    ): Promise<OperationResult> {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools || source.isMutating) {
            return { success: false, error: {
                code: 'TOOL_PERMISSION_DENIED',
                message: 'Only registered read-only View Tools may run',
            } };
        }
        const live = this.viewOwnedTools.listTools().find(tool => tool.id === source.id);
        if (!live || live.isMutating) {
            return { success: false, error: {
                code: 'TOOL_UNAVAILABLE',
                message: 'Read-only Tool is no longer offered by this View',
            } };
        }
        return this.viewOwnedTools.invoke({
            ...source,
            appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId,
        }, target, args);
    }

    /** Stage 2 source inventory, captured alongside Tool bindings in Worker. */
    getViewOwnedViewInstances() {
        return this.viewOwnedTools?.listViews() ?? Object.freeze([]);
    }

    constructor(config: AppKernelConfig) {
        // [RFC-B2] Only support component mode
        if (!config.component) {
            throw new AOTUIError(
                'CONFIG_INVALID',
                { reason: 'AppKernelConfig.component is required. Traditional mode (config.root) is no longer supported.' }
            );
        }
        if (!config.appName) {
            throw new AOTUIError('CONFIG_INVALID', {
                reason: 'AppKernelConfig.appName is required.'
            });
        }

        this.config = config;
        this.name = config.name;
        this.toolAppName = this.resolveToolAppName(config.appName);

        // Initialize ViewRegistry
        this.viewRegistry = createViewRegistry();
    }

    private resolveToolAppName(appName: string): string {
        if (!/^[a-z0-9_]+$/.test(appName)) {
            throw new AOTUIError('CONFIG_INVALID', {
                reason: `Invalid appName "${appName}". appName must match /^[a-z0-9_]+$/`
            });
        }
        return appName;
    }

    /**
     * Tool 前缀语义名（供 Worker 侧导出 Tool Key）
     */
    getToolAppName(): string {
        return this.toolAppName;
    }

    get id(): AppID {
        return this._id;
    }

    setId(id: AppID): void {
        this.assertActive();
        this._id = id;
    }

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    onOpen(context: AppContext, container: HTMLElement): Promise<void> {
        if (this.closing) return Promise.reject(closeError('APP_KERNEL_CLOSED'));
        if (this.openPromise) return this.openPromise;
        this.openPromise = Promise.resolve().then(async () => {
            this.assertActive();this.context = context;this.container = container;
            this.initializeDOMStructure();
            context.onRender(() => { if (!this.closing) this.renderAllViews(); });
            await this.initializeFromComponent();
            this.assertActive();
            for (const [name, listener] of this.eventListeners()) container.addEventListener(name, listener);
            this.renderAllViews();
        });
        void this.openPromise.catch(() => {});return this.openPromise;
    }

    private eventListeners(): Array<[string, EventListener]> {
        return [['aotui:ref-register', this.handleRefRegister], ['aotui:ref-unregister', this.handleRefUnregister],
            ['aotui:type-tool-register', this.handleTypeToolRegister], ['aotui:type-tool-unregister', this.handleTypeToolUnregister],
            ['aotui:system', this.handleSystemEvent]];
    }

    onClose(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.beginShutdown();
        let failed = false;
        const revokeViews = () => {
            for (const view of this.viewOwnedTools?.listViews() ?? []) {
                try { this.viewOwnedTools!.unmount(view.viewInstanceId); } catch { failed = true; }
            }
        };
        revokeViews();
        this.closePromise = Promise.resolve().then(async () => {
            await Promise.allSettled([this.openPromise, this.deletePromise]);
            try { await this.componentRenderer?.unmount(); } catch { failed = true; }
            this.componentRenderer = undefined;
            try { await this.appLifecycle?.close(); } catch { failed = true; }
            for (const [name, listener] of this.eventListeners()) {
                try { this.container?.removeEventListener(name, listener); } catch { failed = true; }
            }
            revokeViews();
            for (const clear of [() => this.viewOwnedTools?.dispose(), () => this.viewRegistry.clear(), () => this.refRegistry.clear(),
                () => this.typeTools.clear(), () => this.viewKeyToId.clear()]) {
                try { clear(); } catch { failed = true; }
            }
            if (failed) throw closeError('APP_UNMOUNT_FAILED');
        });
        void this.closePromise.catch(() => {});return this.closePromise;
    }

    async onReinitialize(context?: import('../../spi/index.js').AppReinitializeContext): Promise<void> {
        this.assertActive();
        if (this.config.onReinitialize) {
            await this.config.onReinitialize({
                ...this.context,
                reason: context?.reason ?? (this.config.launchConfig as { __aotuiLifecycle?: { reason?: string } } | undefined)
                    ?.__aotuiLifecycle?.reason,
            });
        }
    }

    /**
     * [RFC-015] App Delete Lifecycle
     */
    onDelete(): Promise<void> {
        if (this.deletePromise) return this.deletePromise;
        if (this.closing) return Promise.reject(closeError('LIFECYCLE_CONFLICT'));
        this.beginShutdown();
        this.deletePromise = Promise.resolve().then(async () => {
            if (this.openPromise) await this.openPromise.catch(() => {});
            try { await this.config.onDelete?.(this.context); } catch { throw closeError('APP_DELETE_FAILED'); }
        });
        void this.deletePromise.catch(() => {});return this.deletePromise;
    }

    async onPause(): Promise<void> {
        this.assertActive();
        // Default: no-op
    }

    async onResume(): Promise<void> {
        this.assertActive();
        // Default: no-op
    }

    // ─────────────────────────────────────────────────────────────
    //  System Events (Runtime Bridge)
    // ─────────────────────────────────────────────────────────────

    /**
     * Handle system events from Desktop
     * 
     * [RFC-B2] Removed mount/dismount/ViewLink system events
     * View lifecycle is now managed via Operations
     */
    async onSystemEvent(event: string, payload: DataPayload): Promise<void> {
        this.assertActive();
        console.log(`[AppKernel] System event: ${event}`, payload);
        console.warn(`[AppKernel] System event '${event}' is not supported in component mode.`);
    }

    /**
     * Handle DOM-based system events from worker runtime.
     * Used to request view close in component mode.
     */
    private handleSystemEvent = (event: Event) => {
        if (this.closing) return;
        const detail = (event as CustomEvent).detail as { type?: string; viewId?: ViewID } | undefined;
        if (!detail || detail.type !== 'dismount_view' || !detail.viewId) {
            return;
        }

        const viewId = detail.viewId;
        const viewNode = this.container.querySelector(`[data-view-id="${viewId}"]`) as HTMLElement | null
            ?? this.container.querySelector(`#${viewId}`) as HTMLElement | null;

        if (!viewNode) {
            console.warn(`[AppKernel] dismount_view target not found: ${viewId}`);
            return;
        }

        const CustomEventCtor = this.container.ownerDocument.defaultView?.CustomEvent as typeof CustomEvent | undefined;
        if (!CustomEventCtor) {
            console.warn('[AppKernel] CustomEvent not available for view close dispatch');
            return;
        }

        const closeEvent = new CustomEventCtor('aotui:view-close', {
            bubbles: true,
            detail: { viewId, reason: 'system_dismount' }
        });

        viewNode.dispatchEvent(closeEvent);
    };

    // ─────────────────────────────────────────────────────────────
    //  Operations
    // ─────────────────────────────────────────────────────────────

    /**
     * Execute Operation
     *
     * Routes the operation to the appropriate view or app-level handler.
     */
    async onOperation(
        context: OperationContext,
        operation: OperationID,
        args: Record<string, unknown>
    ): Promise<OperationResult> {
        this.assertActive();
        // Route to view if viewId is specified
        if (context.viewId) {
            // [RFC-B2] Unified query: only ViewRegistry
            const view = this.viewRegistry.get(context.viewId);
            if (!view) {
                // [RFC-020] Type Tool Routing Fallback
                // If view not found, check if viewId is actually a ViewType targeting a Type Tool
                // AgentParser: app-FileDetail-op -> viewId="FileDetail"
                if (this.typeTools.has(context.viewId)) {
                    return this.callTypeTool(context.viewId, operation, args);
                }

                return failedResult('VIEW_NOT_FOUND', { viewId: context.viewId });
            }

            const result = await view.onOperation(operation, args);
            if (result.success) {
                this.renderAllViews();
            }
            return result;
        }

        // App-level operation
        if (this.config.onOperation) {
            return this.config.onOperation(operation, args, {
                appId: this._id,
                desktopId: this.context.desktopId,
            });
        }

        return failedResult('OPERATION_NO_HANDLER', { operationName: operation });
    }

    // ─────────────────────────────────────────────────────────────
    //  Ref Registry (RFC-002)
    // ─────────────────────────────────────────────────────────────
    //  [RFC-002] RefExporter Implementation
    // ─────────────────────────────────────────────────────────────

    /**
     * Handle ref-register event from DOM
     */
    private handleRefRegister = (event: Event) => {
        const { viewId, key, data } = (event as CustomEvent).detail;
        this.registerRef(viewId, key, data);
    };

    /**
     * Handle ref-unregister event from DOM
     */
    private handleRefUnregister = (event: Event) => {
        const { viewId, key } = (event as CustomEvent).detail;
        this.unregisterRef(viewId, key);
    };

    /**
     * Export ref from view
     */
    exportRef<T extends object>(viewId: ViewID, key: string, data: T): void {
        this.assertActive();
        const fullKey = `${viewId}:${key}`;
        this.refRegistry.set(fullKey, data);
        this.projection.recordMutation('ref');
    }

    /**
     * Unexport ref from view
     */
    unexportRef(viewId: ViewID, key: string): void {
        const fullKey = `${viewId}:${key}`;
        if (this.refRegistry.delete(fullKey)) this.projection.recordMutation('ref');
    }

    /**
     * [IRefExporter] Alias for exportRef
     */
    public registerRef(viewId: string, refId: string, data: object): void {
        this.exportRef(viewId as ViewID, refId, data);
    }

    /**
     * [IRefExporter] Alias for unexportRef
     */
    public unregisterRef(viewId: string, refId: string): void {
        this.unexportRef(viewId as ViewID, refId);
    }

    /**
     * Export all registered refs to IndexMap
     * Called by Worker Runtime during snapshot generation
     */
    exportRefsToIndexMap(): IndexMap {
        const result: IndexMap = {};
        for (const [fullKey, data] of this.refRegistry) {
            // 保留完整 key: "viewId:refId"
            // SnapshotFormatter 会添加 appId 前缀
            result[fullKey] = data as DataPayload;
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────
    //  Type Tool Management (RFC-020)
    // ─────────────────────────────────────────────────────────────

    /**
     * Unregister Type Tool
     */
    unregisterTypeTool(viewType: string, toolName: string): void {
        const tools = this.typeTools.get(viewType);
        if (tools?.delete(toolName)) {
            if (tools.size === 0) this.typeTools.delete(viewType);
            this.projection.recordMutation('tool');
            // Preserve the legacy Tool refresh signal.
            if (!this.closing) this.context?.markDirty?.();
        }
    }

    /**
     * Handle type-tool-register event from DOM
     */
    private handleTypeToolRegister = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        this.registerTypeTool(detail.viewType, detail.toolName, {
            description: detail.description,
            params: detail.params,
            handler: detail.handler
        });
    };

    /**
     * Handle type-tool-unregister event from DOM
     */
    private handleTypeToolUnregister = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        this.unregisterTypeTool(detail.viewType, detail.toolName);
    };

    // ─────────────────────────────────────────────────────────────
    //  [RFC-007] View Tree Export
    // ──────────────────────────────────────────────────────────── 

    /**
     * [RFC-B2] Render View Tree to Markdown
     * 
     * Component mode: Parse from DOM instead of ViewTree
     */
    renderViewTree(): string {
        // [RFC-B2] TODO: Implement DOM parsing for component mode
        // For now, return registered views list
        const allViews = this.viewRegistry.getAll();
        return allViews.map(v => `- ${v.name} (${v.id})`).join('\n');
    }

    // ─────────────────────────────────────────────────────────────
    //  Private: View Initialization
    // ─────────────────────────────────────────────────────────────

    private initializeDOMStructure(): void {
        // View Tree Container (Markdown)
        let treeContainer = this.container.querySelector('[data-view-tree]');
        if (!treeContainer) {
            treeContainer = this.container.ownerDocument.createElement('div');
            treeContainer.setAttribute('data-view-tree', '');
            this.container.appendChild(treeContainer);
        }

        // Views Container (Preact mounts)
        let viewsContainer = this.container.querySelector('[data-views]');
        if (!viewsContainer) {
            viewsContainer = this.container.ownerDocument.createElement('div');
            viewsContainer.setAttribute('data-views', '');
            this.container.appendChild(viewsContainer);
        }
    }



    /**
     * [RFC-027-C] Component初始化 (Factory Injection Pattern)
     */
    private componentRenderer?: any; // ComponentRenderer from SDK

    private async initializeFromComponent(): Promise<void> {
        // 1. 创建App容器 (在data-views容器中)
        const viewsContainer = this.container.querySelector('[data-views]');
        if (!viewsContainer) {
            throw new Error(
                '[AppKernel] Cannot find data-views container. ' +
                'This is required for component mode.'
            );
        }

        const appContainer = this.container.ownerDocument.createElement('div');
        appContainer.setAttribute('data-app-root', '');
        viewsContainer.appendChild(appContainer);

        // 2. 获取Factory (config.component现在是Factory对象)
        const factory = this.config.component as any;

        if (!factory || typeof factory.initializeComponent !== 'function') {
            throw new Error(
                '[AppKernel] Invalid component factory: initializeComponent method not found. ' +
                'Make sure you are using createTUIApp() from SDK.'
            );
        }

        // M4 Stage 1: the Core registry is scoped to the trusted App execution.
        const owned = this.viewOwnedTools ??= createViewOwnedTools(
            String(this._id || this.toolAppName), this.appExecutionInstanceId,
        );

        // 3. 构建RuntimeContext
        const runtimeContext = {
            appId: this._id,
            desktopId: this.context.desktopId,
            launchConfig: this.config.launchConfig,
            allocateViewId: (key: string) => this.allocateViewId(key),
            registerView: (view: IView) => this.registerView(view),
            unregisterView: (viewId: ViewID) => this.unregisterView(viewId),
            refExporter: this,
            markDirty: () => { if (!this.closing) this.context.markDirty(); },
            projection: this.projection,
            persistence: this.persistence,
            appLifecycle: this.appLifecycle?.port,
            typeTools: this, // Legacy ViewTypeTool API unchanged.
            viewTools: {
                refDeclarationSupport: 'snapshot-value-v1' as const,
                safeRefInvocationSupport: 'snapshot-value-v1' as const,
                safeOrdinaryInvocationSupport: 'ordinary-v1' as const,
                safeOrdinaryParametersInvocationSupport: 'ordinary-v2' as const,
                safeSnapshotValueParametersInvocationSupport: 'snapshot-value-v2' as const,
                fingerprintReadOnlyParams: (params: unknown, additionalProperties: boolean) => {
                    const kind = hasRefParamDeclaration(params) ? 'snapshot-value' as const : 'ordinary' as const;
                    const compiled = kind === 'snapshot-value' ? compileSnapshotValueParams(params, { additionalProperties })
                        : compileOrdinaryParams(params, { additionalProperties });
                    if (!compiled.ok) throw new Error(compiled.issue.code + ': ' + compiled.issue.message);
                    return Object.freeze({ kind, fingerprint: compiled.contract.fingerprint });
                },
                fingerprintOrdinaryParams: (params: unknown, additionalProperties: boolean) => {
                    const compiled = compileOrdinaryParams(params, { additionalProperties });
                    if (!compiled.ok) throw new Error(compiled.issue.code + ': ' + compiled.issue.message);
                    return compiled.contract.fingerprint;
                },
                safeCreateIfAbsentInvocationSupport: 'create-if-absent-v1' as const,
                fingerprintParams: (params: unknown) => {
                    const data = copyJson(params, { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 });
                    validateRefParams(data);
                    return canonicalJson(data);
                },
                mount: (viewId: string, viewType: string) => {
                    this.assertActive();
                    const identity = owned.mount(viewId, viewType);
                    this.projection.recordMutation('view');
                    return identity.viewInstanceId;
                },
                unmount: (viewInstanceId: string) => {
                    owned.unmount(viewInstanceId);
                    this.projection.recordMutation('view');
                },
                registerTool: (viewInstanceId: string, toolName: string, definition: import('../../spi/app/public-types.js').TypeToolDefinition,
                    options?: import('../../spi/runtime/view-owned-tools.interface.js').ViewToolRegistrationOptions) => {
                    this.assertActive();
                    const fields = Object.getOwnPropertyDescriptors(definition);
                    for (const key of ['description', 'params', 'isMutating', 'handler']) {
                        const field = fields[key];
                        if (field && (!field.enumerable || !('value' in field))) {
                            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$.' + key,
                                'Accessors/hidden properties are forbidden');
                        }
                    }
                    let params: unknown = fields.params?.value ?? {};
                    const handler = fields.handler?.value;
                    if (typeof handler !== 'function') throw new Error('View-local Tool handler must be a function');
                    if (!params || typeof params !== 'object' || Array.isArray(params)) {
                        throw new Error('View-local Tool params must be a parameter object');
                    }
                    let safeInvoker: SafeRefInvoker | SafeCreateIfAbsentInvoker | undefined;
                    let registrationMode: Parameters<typeof owned.registerTool>[4];
                    let parameters: OrdinaryParameterContract | undefined;
                    let snapshotParameters: SnapshotValueParameterContract | undefined;
                    let ordinary = false, creation = false;
                    if (options !== undefined) {
                        if (options === null || typeof options !== 'object' || Array.isArray(options)) {
                            throw new Error('Invalid Ref registration metadata');
                        }
                        const metadata = Object.getOwnPropertyDescriptors(options);
                        if (metadata.safeSnapshotValueParametersInvocationMode?.value === 'snapshot-value-v2') {
                            const allowed = ['safeSnapshotValueParametersInvocationMode', 'additionalProperties', 'createSafeSnapshotValueParametersInvoker'];
                            if (Reflect.ownKeys(metadata).length !== 3 || Reflect.ownKeys(metadata).some(key =>
                                typeof key !== 'string' || !allowed.includes(key) || !metadata[key]!.enumerable || !('value' in metadata[key]!)) ||
                                typeof metadata.additionalProperties?.value !== 'boolean' ||
                                typeof metadata.createSafeSnapshotValueParametersInvoker?.value !== 'function' ||
                                fields.isMutating?.value !== false || !fields.params) throw new Error('Invalid Ref V2 registration metadata');
                            const compiled = compileSnapshotValueParams(fields.params.value, { additionalProperties: metadata.additionalProperties.value });
                            if (!compiled.ok) throw new Error(compiled.issue.code + ': ' + compiled.issue.message);
                            snapshotParameters = compiled.contract;
                            try { safeInvoker = metadata.createSafeSnapshotValueParametersInvoker.value(snapshotParameters); }
                            catch { throw new Error('Ref parameter factory failed'); }
                            if (typeof safeInvoker !== 'function') throw new Error('Invalid Ref V2 callable');
                            registrationMode = { safeSnapshotValueParametersInvocationMode: 'snapshot-value-v2' };
                        } else if (metadata.safeOrdinaryParametersInvocationMode?.value === 'ordinary-v2') {
                            const allowed = ['safeOrdinaryParametersInvocationMode', 'additionalProperties', 'createSafeOrdinaryParametersInvoker'];
                            if (Reflect.ownKeys(metadata).length !== 3 || Reflect.ownKeys(metadata).some(key =>
                                typeof key !== 'string' || !allowed.includes(key) || !metadata[key]!.enumerable || !('value' in metadata[key]!)) ||
                                typeof metadata.additionalProperties?.value !== 'boolean' ||
                                typeof metadata.createSafeOrdinaryParametersInvoker?.value !== 'function' ||
                                typeof fields.isMutating?.value !== 'boolean' || !fields.params) throw new Error('Invalid ordinary-v2 registration metadata');
                            const compiled = compileOrdinaryParams(fields.params.value, { additionalProperties: metadata.additionalProperties.value });
                            if (!compiled.ok) throw new Error(compiled.issue.code + ': ' + compiled.issue.message);
                            parameters = compiled.contract;
                            try { safeInvoker = metadata.createSafeOrdinaryParametersInvoker.value(parameters); }
                            catch { throw new Error('Ordinary parameter factory failed'); }
                            if (typeof safeInvoker !== 'function') throw new Error('Invalid ordinary-v2 callable');
                            registrationMode = { safeOrdinaryParametersInvocationMode: 'ordinary-v2' };
                        } else {
                        ordinary = metadata.safeOrdinaryInvocationMode?.value === 'ordinary-v1';
                        creation = metadata.safeCreateIfAbsentInvocationMode?.value === 'create-if-absent-v1';
                        const keys = creation ? ['safeCreateIfAbsentInvocationMode','createSafeCreateIfAbsentInvoker'] : ordinary ? ['safeOrdinaryInvocationMode','createSafeOrdinaryInvoker'] : ['safeRefInvocationMode','createSafeRefInvoker'];
                        if (Reflect.ownKeys(metadata).some(key => typeof key !== 'string' || !keys.includes(key) ||
                            !metadata[key]!.enumerable || !('value' in metadata[key]!)) ||
                            metadata[keys[0]!]?.value !== (creation ? 'create-if-absent-v1' : ordinary ? 'ordinary-v1' : 'snapshot-value-v1')) throw new Error('Invalid safe registration metadata');
                        registrationMode = creation ? {safeCreateIfAbsentInvocationMode:'create-if-absent-v1'} : ordinary ? {safeOrdinaryInvocationMode:'ordinary-v1'} : {safeRefInvocationMode:'snapshot-value-v1'};
                        const committedParams = copyJson(params, { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 });
                        validateRefParams(committedParams);
                        if (ordinary && (fields.isMutating?.value !== false || !committedParams || typeof committedParams !== 'object' ||
                            Array.isArray(committedParams) || Object.keys(committedParams).length !== 0)) throw new Error('Ordinary Tool requires empty parameters and explicit read-only');
                        if(creation) {if(fields.isMutating?.value!==true)throw new Error('Creation Tool must be explicitly mutating');createIfAbsentSchema(committedParams);}
                        params = committedParams;
                        const factoryField = metadata[creation ? 'createSafeCreateIfAbsentInvoker' : ordinary ? 'createSafeOrdinaryInvoker' : 'createSafeRefInvoker'];
                        if(creation && !factoryField)throw new Error('Creation factory is required');
                        if (factoryField) {
                            const factory = factoryField.value;
                            if (typeof factory !== 'function') throw new Error('Invalid safe Ref factory');
                            try { safeInvoker = factory(committedParams as Readonly<Record<string, unknown>>); }
                            catch { throw new Error('Safe Ref factory failed'); }
                            if (typeof safeInvoker !== 'function') throw new Error('Invalid safe Ref callable');
                        }
                        }
                    }
                    const release = owned.registerTool(viewInstanceId, {
                        name: toolName,
                        description: fields.description?.value as string,
                        inputSchema: snapshotParameters ? snapshotParameters.schema : parameters ? ordinaryParameterProfile(parameters) : creation ? createIfAbsentSchema(params) : ordinary ? {type:'object',properties:{},required:[],additionalProperties:false} : paramsToJsonSchema(params as Record<string, unknown>),
                        isMutating: fields.isMutating?.value ?? true,
                    }, async args => await handler(args) as OperationResult, true,
                    registrationMode, safeInvoker);
                    this.projection.recordMutation('tool');
                    return () => {
                        release();
                        this.projection.recordMutation('tool');
                    };
                },
            },
        };

        // 4. 调用SDK factory初始化组件
        this.componentRenderer = await factory.initializeComponent(appContainer, runtimeContext);
    }

    // ─────────────────────────────────────────────────────────────
    //  Private: Rendering
    // ─────────────────────────────────────────────────────────────

    private renderAllViews(): void {
        if (this.closing) return;
        // [RFC-B2] Component mode: Views auto-render via Preact
        // Just update the tree description
        const treeOutput = this.renderViewTree();
        const treeContainer = this.container.querySelector('[data-view-tree]');
        if (treeContainer) {
            treeContainer.innerHTML = treeOutput;
        }

        // Component-mode Views self-render, no manual triggering needed
    }

    // [RFC-B2] Removed createViewContainer() and removeViewContainer()
    // Component mode: Views manage their own containers

    private generateViewId(): ViewID {
        return createViewId(this.viewIdCounter++);
    }

    // ─────────────────────────────────────────────────────────────
    //  [RFC-027] Component Mode Methods
    // ─────────────────────────────────────────────────────────────

    /**
     * Allocate viewId for component mode
     * Uses view key (name or name_uniqueId) to ensure consistent ID assignment
     */
    private allocateViewId(key: string): ViewID {
        this.assertActive();
        const existing = this.viewKeyToId.get(key);
        if (existing) {
            return existing;
        }

        const viewId = this.generateViewId();
        this.viewKeyToId.set(key, viewId);

        return viewId;
    }

    /**
     * [RFC-B2] Register IView instance from component mode
     */
    private registerView(view: IView): void {
        this.assertActive();
        this.viewRegistry.register(view);
        this.projection.recordMutation('view');
    }

    /**
     * [RFC-B2] Unregister IView instance
     */
    private unregisterView(viewId: ViewID): void {
        if (this.viewRegistry.has(viewId)) {
            this.viewRegistry.unregister(viewId);
            this.projection.recordMutation('view');
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Type-level Tools (View Type Aggregation)
    // ─────────────────────────────────────────────────────────────

    /**
     * Register a Type-level Tool
     * Tool ID format: `${appId}-${viewType}-${toolName}`
     */
    registerTypeTool(viewType: string, toolName: string, tool: TypeToolDefinition): void {
        this.assertActive();
        const paramsField = Object.getOwnPropertyDescriptor(tool, 'params');
        if (paramsField && (!paramsField.enumerable || !('value' in paramsField))) {
            throw new SnapshotDataError('SNAPSHOT_SERIALIZATION_ERROR', '$.params',
                'Accessors/hidden properties are forbidden');
        }
        if (hasRefParamDeclaration(tool.params)) {
            validateRefParams(copyJson(tool.params, { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 }));
            throw new SnapshotDataError('REF_CONTRACT_UNSUPPORTED', '$.params',
                'REF_CONTRACT_UNSUPPORTED: Ref declarations require a View-local Tool');
        }
        if (!this.typeTools.has(viewType)) {
            this.typeTools.set(viewType, new Map());
        }

        const toolId = `${this._id}-${viewType}-${toolName}`;

        this.typeTools.get(viewType)!.set(toolName, {
            id: toolId,
            name: toolName,
            viewType,
            description: tool.description,
            params: tool.params,
            ...(tool.declaredByViewId && tool.declaredByViewGeneration ? {
                declaredByViewId: tool.declaredByViewId,
                declaredByViewGeneration: tool.declaredByViewGeneration,
            } : {}),
            handler: tool.handler
        });

        this.projection.recordMutation('tool');
        // Retain the legacy refresh behavior until Strict takes over.
        this.context?.markDirty?.();
    }

    /**
     * Call a Type-level Tool - LLM must provide view_id in params
     */
    async callTypeTool(
        viewType: string,
        toolName: string,
        params: Record<string, unknown>
    ): Promise<OperationResult> {
        this.assertActive();
        const tool = this.typeTools.get(viewType)?.get(toolName);
        if (!tool) {
            return {
                success: false,
                error: {
                    code: 'OPERATION_FAILED' as const,
                    message: `Type tool ${viewType}.${toolName} not found`,
                    context: { viewType, toolName }
                }
            };
        }

        try {
            const resolvedArgsResult = this.resolveTypeToolArgs(viewType, toolName, tool.params, params);
            if (!resolvedArgsResult.success) {
                return resolvedArgsResult;
            }

            const result = await tool.handler(resolvedArgsResult.data as Record<string, unknown>);
            // SDK TypeTools return OperationResult. Preserve the business status:
            // transport success is not permission to recast { success:false }.
            if (result && typeof result === 'object' && 'success' in result) {
                // A malformed business status must never be treated as an
                // ordinary raw object and therefore wrapped as success.
                if (typeof (result as OperationResult).success !== 'boolean') {
                    return { success: false, error: {
                        code: 'TOOL_RESULT_INVALID', message: 'Tool returned an invalid success flag',
                    } };
                }
                const outcome = result as OperationResult;
                if (outcome.success) {
                    if (!this.closing) this.componentRenderer?.render();
                    this.renderAllViews();
                }
                return outcome;
            }
            // Legacy raw-value handler compatibility.
            if (!this.closing) this.componentRenderer?.render();
            this.renderAllViews();
            return { success: true, data: result as Record<string, unknown> };
        } catch (error) {
            return {
                success: false,
                error: {
                    code: 'OPERATION_FAILED' as const,
                    message: `Type tool execution failed: ${(error as Error).message}`,
                    context: { viewType, toolName }
                }
            };
        }
    }

    /**
     * Get all Type Tools for a specific view type
     */
    getTypeTools(viewType: string): TypeTool[] {
        const tools = this.typeTools.get(viewType);
        return tools ? Array.from(tools.values()) : [];
    }

    /**
     * Get all registered Type Tools (all types)
     */
    getAllTypeTools(): Map<string, TypeTool[]> {
        const result = new Map<string, TypeTool[]>();
        for (const [viewType, toolsMap] of this.typeTools) {
            result.set(viewType, Array.from(toolsMap.values()));
        }
        return result;
    }

    private resolveTypeToolArgs(
        viewType: string,
        toolName: string,
        paramSchema: Record<string, unknown>,
        rawArgs: Record<string, unknown>
    ): OperationResult {
        const resolvedArgs: Record<string, unknown> = { ...rawArgs };
        const viewIdsForType = this.viewRegistry.getByType(viewType).map(view => view.id);

        for (const [paramName, value] of Object.entries(rawArgs)) {
            const def = (paramSchema[paramName] ?? null) as TypeToolParamDef | null;
            if (!def) {
                continue;
            }

            if (def.type === 'reference') {
                if (typeof value === 'object' && value !== null) {
                    continue;
                }
                if (typeof value !== 'string') {
                    return failedResult('OPERATION_INVALID_ARGS', {
                        param: paramName,
                        operationName: `${viewType}.${paramName}`,
                        reason: 'reference parameter must be string or object',
                        expected: 'reference string or object',
                        received: typeof value,
                        viewType,
                    });
                }

                const resolved = this.resolveRefId(value, viewIdsForType);
                if (!resolved) {
                    return failedResult('OPERATION_INVALID_ARGS', {
                        operationName: toolName,
                        param: paramName,
                        refId: value,
                        reason: `reference '${value}' not found in current snapshot indexMap`,
                        viewType,
                    });
                }
                resolvedArgs[paramName] = resolved;
                continue;
            }

            if (def.type === 'array' && def.itemType === 'reference' && Array.isArray(value)) {
                const resolvedItems: unknown[] = [];
                for (const item of value) {
                    if (typeof item === 'object' && item !== null) {
                        resolvedItems.push(item);
                        continue;
                    }
                    if (typeof item !== 'string') {
                        return failedResult('OPERATION_INVALID_ARGS', {
                            param: paramName,
                            operationName: `${viewType}.${paramName}`,
                            reason: 'reference array contains non-string/non-object item',
                            expected: 'reference[] as string[] or object[]',
                            received: typeof item,
                            viewType,
                        });
                    }
                    const resolvedItem = this.resolveRefId(item, viewIdsForType);
                    if (!resolvedItem) {
                        return failedResult('OPERATION_INVALID_ARGS', {
                            operationName: toolName,
                            param: paramName,
                            refId: item,
                            reason: `reference '${item}' not found in current snapshot indexMap`,
                            viewType,
                        });
                    }
                    resolvedItems.push(resolvedItem);
                }
                resolvedArgs[paramName] = resolvedItems;
            }
        }

        return {
            success: true,
            data: resolvedArgs,
        };
    }

    private resolveRefId(refId: string, scopedViewIds: ViewID[]): object | null {
        // Legacy TypeTool refs may only resolve within their declared ViewType.
        // Ambiguity must fail closed; no global suffix search across unrelated Views.
        let found: object | null = null;
        for (const viewId of scopedViewIds) {
            const value = this.refRegistry.get(`${viewId}:${refId}`);
            if (!value) continue;
            if (found !== null) return null;
            found = value;
        }
        return found;
    }
}
