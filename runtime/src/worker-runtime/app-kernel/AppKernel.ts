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
    OperationResult,
    AppContext,
    IAOTUIApp,
    AppKernelConfig,
    IRefExporter, // [RFC-002]
} from '../../spi/index.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { ViewToolInvocationTerminal } from '../../spi/worker-protocol/index.js';
import type { SafeRefInvoker } from '../../spi/runtime/view-owned-tools.interface.js';
import { compileOrdinaryParams, type OrdinaryParameterContract } from '../../core/tool/ordinary-parameter-contract.js';
import { compileSnapshotValueParams, type SnapshotValueParameterContract } from '../../core/tool/snapshot-value-parameter-contract.js';
import { ordinaryParameterProfile } from '../../core/tool/ordinary-parameter-profile.js';

import { SemanticProjectionCoordinator } from '../../core/projection/coordinator.js';
import { createViewOwnedTools } from '../../core/tool/view-owned-tools.js';
import { SnapshotDataError } from '../../core/snapshot/json.js';
import { hasRefParamDeclaration } from '../../core/tool/ref-declarations.js';
import type { AggregatedViewTool } from '../../core/tool/view-owned-tools.js';
import type { ToolDescriptorV2, ToolTargetV2 } from '../../core/snapshot/types.js';
import { buildPublicToolName } from '../../adapters/public-tool-name.js';
import { createAppLifecycle } from '../app-lifecycle.js';
import type { AppStatePersistence } from '../../spi/runtime/state-persistence.interface.js';
import { randomUUID } from 'node:crypto';
import { closeError } from '../../engine/core/close-operation.js';

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

    /** [RFC-002] Ref Registry Storage */
    private refRegistry = new Map<string, object>();

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
        args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeSnapshotValueParameters({ ...source,
            appId: String(this._id), appInstanceId: this.appExecutionInstanceId }, target, args);
    }

    invokeBoundOrdinaryParametersViewTool(source: ToolDescriptorV2, target: ToolTargetV2,
        args: Readonly<Record<string, unknown>>): ViewToolInvocationTerminal | Promise<ViewToolInvocationTerminal> {
        if (this.closing) return { phase: 'not-entered', result: this.closedToolResult() };
        if (!this.viewOwnedTools) return { phase: 'not-entered', result: { success: false,
            error: { code: 'TOOL_UNAVAILABLE', message: 'View-owned Tool registry not initialized' } } };
        return this.viewOwnedTools.invokeOrdinaryParameters({ ...source, appId: String(this._id),
            appInstanceId: this.appExecutionInstanceId }, target, args);
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

    }

    private resolveToolAppName(appName: string): string {
        if (!/^[a-z0-9_]+$/.test(appName)) {
            throw new AOTUIError('CONFIG_INVALID', {
                reason: `Invalid appName "${appName}". appName must match /^[a-z0-9_]+$/`
            });
        }
        return appName;
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

    public registerRef(viewId: string, refId: string, data: object): void {
        this.assertActive();
        const fullKey = `${viewId}:${refId}`;
        this.refRegistry.set(fullKey, data);
        this.projection.recordMutation('ref');
    }

    public unregisterRef(viewId: string, refId: string): void {
        const fullKey = `${viewId}:${refId}`;
        if (this.refRegistry.delete(fullKey)) this.projection.recordMutation('ref');
    }

    getViewRefs(): readonly { viewId: string; refId: string; value: object }[] {
        return [...this.refRegistry].map(([key, value]) => {
            const separator = key.indexOf(':');
            return { viewId: key.slice(0, separator), refId: key.slice(separator + 1), value };
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
        const lifecycleMarker = Object.getOwnPropertyDescriptor(factory, 'appLifecycleSupport');
        if (lifecycleMarker) {
            if (!('value' in lifecycleMarker) || lifecycleMarker.value !== 'app-lifecycle-v2')
                throw new Error('APP_LIFECYCLE_UNSUPPORTED');
            if (!this.appLifecycle) this.enableAppLifecycle();
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
            refExporter: this,
            markDirty: () => {
                if (this.closing) return;
                this.projection.recordMutation('view');
                this.context.markDirty();
            },
            projection: this.projection,
            persistence: this.persistence,
            appLifecycle: this.appLifecycle?.port,
            viewTools: {
                targetSelectorSupport: 'argument-v1' as const,
                refDeclarationSupport: 'snapshot-value-v1' as const,
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
                registerTool: (viewInstanceId: string, toolName: string, definition: import('../../spi/runtime/view-owned-tools.interface.js').ViewToolDefinition,
                    options: import('../../spi/runtime/view-owned-tools.interface.js').ViewToolRegistrationOptions) => {
                    this.assertActive();
                    const view = owned.listViews().find(view => view.viewInstanceId === viewInstanceId);
                    if (view) buildPublicToolName(this.toolAppName, view.viewType, toolName);
                    const fields = Object.getOwnPropertyDescriptors(definition);
                    for (const key of ['description', 'params', 'isMutating', 'handler', 'target']) {
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
                    if (options === undefined) throw new Error('View Tools require a canonical V2 parameter contract');
                    let safeInvoker: SafeRefInvoker | undefined;
                    let registrationMode: Parameters<typeof owned.registerTool>[3];
                    let parameters: OrdinaryParameterContract | undefined;
                    let snapshotParameters: SnapshotValueParameterContract | undefined;
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
                        } else throw new Error('Invalid View Tool registration metadata');
                    }
                    const release = owned.registerTool(viewInstanceId, {
                        ...(fields.target ? { target: fields.target.value } : {}),
                        name: toolName,
                        description: fields.description?.value as string,
                        inputSchema: snapshotParameters ? snapshotParameters.schema : ordinaryParameterProfile(parameters!),
                        isMutating: fields.isMutating?.value ?? true,
                    }, async args => await handler(args) as OperationResult,
                    registrationMode!, safeInvoker!);
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

    // Component Views and their owned Tools render directly through Preact.
    // Runtime only observes the committed View/Ref/Tool projection.
}
