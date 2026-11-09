import type { ToolResultData } from '../../spi/core/tool-result.js';
import { APP_LIFECYCLE_PROTOCOL, VIEW_TYPE_TOOL_PROTOCOL, captureAppMetadata } from '../../spi/index.js';
/**
 * AOTUI Runtime - App Kernel
 *
 * [方案 B] 从 @aotui/sdk 迁移到 @aotui/runtime/worker-runtime。
 *
 * Worker 内的 App 执行引擎，负责：
 * - App 生命周期管理 (onOpen, onClose...)
 * - Component View mount and owned Tool lifecycle
 * - source-bound View Tool lifecycle and invocation
 * - Semantic projection and Ref export
 *
 * @module @aotui/runtime/worker-runtime/app-kernel
 */

import type {
    AppID,
    AppContext,
    IAOTUIApp,
    AppKernelConfig,
    IRefExporter, // [RFC-002]
} from '../../spi/index.js';
import type { IRefBinding } from '../../spi/app/ref-exporter.interface.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';

import { SemanticProjectionCoordinator } from '../../core/projection/coordinator.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import type { OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import type { ToolDescriptorV3, ObservedToolExecutionV3 } from '../../core/snapshot/types.js';
import type { AppTypeToolDefinition, AppTypeToolRegistrationOptions } from '../../spi/runtime/app-type-tools.interface.js';
import { hasViewTypeToolAuthoringProtocol } from '../../spi/app/app-factory.interface.js';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
import { randomUUID } from 'node:crypto';
import { closeError } from '../../engine/core/close-handle.js';
import { isTUIAppFactory } from '../../spi/app/app-factory.interface.js';

/**
 * App Kernel Implementation
 *
 * 运行在 Worker 内的 App 执行引擎。
 * 实现 IAOTUIApp 接口，供 Worker Runtime 调用。
 */
export class AppKernel implements IAOTUIApp, IRefExporter {
    private _id: AppID = '' as AppID;
    readonly name: string;

    private config: AppKernelConfig;
    private context!: AppContext;
    private container!: HTMLElement;

    /** Ref entries carry their own identity so stale cleanup cannot affect a later owner. */
    private refRegistry = new Map<string, { value: object; refType?: string }>();

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
    private readonly projectionOwner = new AbortController();
    beginShutdown(): void { this.closing = true; this.projectionOwner.abort(); this.appLifecycle?.stop(); }
    stopApplication(): void { this.projectionOwner.abort(); this.appLifecycle?.stop(); }

    async whenProjectionCommitted(): Promise<void> {
        this.assertActive();
        await this.componentRenderer?.whenCommitted?.(this.projectionOwner.signal);
        await this.projection.whenCommitted(this.projectionOwner.signal);
        this.assertActive();
    }

    private closing = false;
    private openPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private deletePromise?: Promise<void>;
    private assertActive(): void { if (this.closing) throw closeError('APP_KERNEL_CLOSED'); }
    private closedToolResult(): ToolResultData { return { success: false, error: { code: 'TOOL_UNAVAILABLE', message: 'App lifecycle is closing' } }; }

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

    /** Detached V3 Tool metadata for the configured producers. */
    getToolDefinitions(): readonly ToolDescriptorV3[] {
        return this.viewOwnedTools?.listTools() ?? Object.freeze([]);
    }

    /**
     * Stage 6 preflight: checks LIVE Runtime-owned Tool binding without invoking
     * a Handler. A trusted Host must still independently authorize any I/O.
     */
    validateBoundTypeTool(source: ToolDescriptorV3, execution: ObservedToolExecutionV3): ToolResultData {
        if (this.closing) return this.closedToolResult();
        if (!this.viewOwnedTools) return { success: false, error: {
            code: 'TOOL_UNAVAILABLE', message: 'ViewType Tool registry not initialized',
        } };
        return this.viewOwnedTools.validateTypeToolBinding(source, execution);
    }

    getBoundTypeToolContract(source: ToolDescriptorV3, execution: ObservedToolExecutionV3): OrdinaryParameterContract | undefined {
        return this.closing ? undefined : this.viewOwnedTools?.getTypeToolContract(source, execution);
    }

    invokeBoundTypeTool(source: ToolDescriptorV3, execution: ObservedToolExecutionV3,
        args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'ViewType Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeTypeTool(source, execution, args);
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
        captureAppMetadata({ app_name: config.appName });

    }

    get id(): AppID {
        return this._id;
    }

    setId(id: AppID): void {
        this.assertActive();
        if (!id || this._id && this._id !== id) throw new AOTUIError('APP_IDENTITY_MISMATCH', { expected: this._id || 'Runtime-assigned App ID', actual: id, path: 'AppKernel.id' });
        this._id = id;
    }

    // ─────────────────────────────────────────────────────────────
    //  Lifecycle
    // ─────────────────────────────────────────────────────────────

    onOpen(context: AppContext, container: HTMLElement): Promise<void> {
        if (this.closing) return Promise.reject(closeError('APP_KERNEL_CLOSED'));
        if (this.openPromise) return this.openPromise;
        this.openPromise = Promise.resolve().then(async () => {
            this.assertActive();this.setId(context.appId);this.context = context;this.container = container;
            this.initializeDOMStructure();
            await this.initializeFromComponent();
            this.assertActive();
        });
        void this.openPromise.catch(() => {});return this.openPromise;
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
            revokeViews();
            for (const clear of [() => this.viewOwnedTools?.dispose(), () => this.refRegistry.clear()]) {
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

    public registerRef(viewId: string, refId: string, data: object, refType?: string): IRefBinding {
        this.assertActive();
        const fullKey = `${viewId}:${refId}`;
        if (this.refRegistry.has(fullKey)) {
            const error = new Error(`Ref '${refId}' is already registered in View '${viewId}'`) as Error & { code: string };
            error.name = 'RefRegistrationError';
            error.code = 'REF_ALREADY_REGISTERED';
            throw error;
        }
        const entry = { value: data, refType };
        this.refRegistry.set(fullKey, entry);
        this.projection.recordMutation('ref');
        let released = false;
        return {
            update: (next: object) => {
                this.assertActive();
                if (released || this.refRegistry.get(fullKey) !== entry) {
                    throw new Error(`Ref binding '${refId}' in View '${viewId}' is no longer active`);
                }
                if (entry.value !== next) {
                    entry.value = next;
                    this.projection.recordMutation('ref');
                }
            },
            release: () => {
                if (released) return;
                released = true;
                if (this.refRegistry.get(fullKey) === entry) {
                    this.refRegistry.delete(fullKey);
                    this.projection.recordMutation('ref');
                }
            },
        };
    }

    getViewRefs(): readonly { viewId: string; refId: string; value: object; refType?: string }[] {
        return [...this.refRegistry].map(([key, entry]) => {
            const separator = key.indexOf(':');
            return { viewId: key.slice(0, separator), refId: key.slice(separator + 1), value: entry.value,
                ...(entry.refType === undefined ? {} : { refType: entry.refType }) };
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  Private: View Initialization
    // ─────────────────────────────────────────────────────────────

    private initializeDOMStructure(): void {
        // Keep one container for the Preact app root. Views themselves are
        // projected from their actual mounted DOM identities.
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
    private componentRenderer?: import('../../spi/component-factory.interface.js').ComponentRenderer;

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
        if (isTUIAppFactory(factory) && !hasViewTypeToolAuthoringProtocol(factory)) {
            throw new Error('APP_AUTHORING_PROTOCOL_UNSUPPORTED');
        }
        const lifecycleMarker = Object.getOwnPropertyDescriptor(factory, 'appLifecycleSupport');
        if (lifecycleMarker) {
            if (!('value' in lifecycleMarker) || lifecycleMarker.value !== APP_LIFECYCLE_PROTOCOL)
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');
            if (!this.appLifecycle) this.enableAppLifecycle();
        }

        // M4 Stage 1: the Core registry is scoped to the trusted App execution.
        const owned = this.viewOwnedTools ??= createViewOwnedTools(
            String(this._id), this.appExecutionInstanceId,
        );

        // 3. 构建RuntimeContext
        const runtimeContext = {
            appId: this._id,
            desktopId: this.context.desktopId,
            launchConfig: this.config.launchConfig,
            refExporter: this,
            markDirty: () => {
                if (this.closing) return;
                this.projection.recordMutation('view');
            },
            projection: this.projection,
            persistence: this.persistence,
            appLifecycle: this.appLifecycle?.port,
            viewTools: {
                mount: (viewId: string, viewType: string) => {
                    this.assertActive();
                    const identity = owned.mount(viewId, viewType);
                    this.projection.recordMutation('view');
                    return identity.viewInstanceId;
                },
                unmount: (viewInstanceId: string) => {
                    if (this.closing) return;
                    owned.unmount(viewInstanceId);
                    this.projection.recordMutation('view');
                },
            },
            appTypeTools: {
                protocol: VIEW_TYPE_TOOL_PROTOCOL,
                registerTypeTool: (definition: AppTypeToolDefinition, options: AppTypeToolRegistrationOptions) => {
                    this.assertActive();
                    // Core owns strict capture, compilation, callable qualification, and reentry checks.
                    // Pass the original values so custom prototypes/accessors cannot be laundered here.
                    const release = owned.registerTypeTool(definition, options);
                    if (this.closing) {
                        release();
                        throw closeError('APP_KERNEL_CLOSED');
                    }
                    this.projection.recordMutation('tool');
                    let released = false;
                    return () => {
                        if (released) return;
                        released = true;
                        release();
                        if (!this.closing) this.projection.recordMutation('tool');
                    };
                },
            },
        };

        // 4. 调用SDK factory初始化组件
        this.componentRenderer = await factory.initializeComponent(appContainer, runtimeContext);
    }

    // Component Views and their owned Tools render directly through Preact.
    // Runtime only observes the committed View/Ref/Tool projection.
}
