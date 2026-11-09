import { APP_LIFECYCLE_PROTOCOL } from './runtime/app-lifecycle.interface.js';
import { STATE_SESSION_PROTOCOL } from './runtime/state-persistence.interface.js';
/**
 * AOTUI Runtime - Component Factory Interface (SPI)
 * 
 * [RFC-027-C] Factory Injection Pattern
 * 
 * **设计原则**:
 * 1. 完全解耦: Runtime不依赖SDK实现细节
 * 2. 接口契约: 明确的类型定义
 * 3. 职责分离: SDK负责渲染,Runtime负责管理
 * 4. 可测试性: 易于Mock和单元测试
 * 
 * @packageDocumentation
 */

import type { IRefExporter } from './app/ref-exporter.interface.js';
import type { AppID, DesktopID } from './core/types.js';
import type { AppLaunchConfig } from './app/app-config.interface.js';
import type { IProjectionPort } from './runtime/projection.interface.js';
import type { IViewOwnedToolPort } from './runtime/view-owned-tools.interface.js';
import type { IAppTypeToolPort } from './runtime/app-type-tools.interface.js';
import type { AppLifecyclePort } from './runtime/app-lifecycle.interface.js';
import type { AppStatePersistence } from './runtime/state-persistence.interface.js';
export type { AppStatePersistence, StateValue, StateIssue, StateBinding, StateBindingStatus, StateFlushReport } from './runtime/state-persistence.interface.js';

// ═══════════════════════════════════════════════════════════════
//  Runtime Context
// ═══════════════════════════════════════════════════════════════

/**
 * Runtime Context
 * 
 * Runtime向SDK提供的运行时能力。
 * SDK通过这些接口与Runtime交互，无需知道Runtime内部实现。
 */
export interface RuntimeContext {
    persistence?: AppStatePersistence;
    appLifecycle?: AppLifecyclePort;
    /** 应用ID */
    appId: AppID;

    /** 桌面ID */
    desktopId: DesktopID;

    /** App 启动配置 */
    launchConfig?: AppLaunchConfig;

    /**
     * Ref导出器
     * 
     * SDK通过此接口导出语义引用(useRef, useArrayRef)
     */
    refExporter: IRefExporter;

    /**
     * 标记为脏
     * 
     * 当View内容变化时调用，触发Runtime重新推送
     */
    markDirty: () => void;

    /** Semantic projection transaction port (no DOM/Preact types). */
    projection: IProjectionPort;

    /** Per-View Tool port for current capability support, not Agent execution. */
    viewTools?: IViewOwnedToolPort;

    /** App-scoped ordinary Tools; does not include business/resource authorization. */
    appTypeTools?: IAppTypeToolPort;
}

// ═══════════════════════════════════════════════════════════════
//  Component Renderer
// ═══════════════════════════════════════════════════════════════

/**
 * Component Renderer
 * 
 * SDK返回给Runtime的渲染控制接口。
 * Runtime通过这些方法控制组件生命周期。
 */
export interface ComponentRenderer {
    /** Join already queued render commits, not background business work. Synchronous producers may omit this. */
    whenCommitted?: (signal: AbortSignal) => Promise<void>;
    /**
     * 渲染组件
     * 
     * 强制重新渲染组件树（通常用于状态恢复）
     */
    render: () => void;

    /**
     * 卸载组件
     * 
     * 清理所有组件、移除DOM、解绑事件
     */
    unmount: () => void | Promise<void>;

}

// ═══════════════════════════════════════════════════════════════
//  Component Factory
// ═══════════════════════════════════════════════════════════════

/**
 * Component Factory
 * 
 * SDK通过createTUIApp返回的工厂对象。
 * Runtime调用initializeComponent来初始化组件树。
 * 
 * **职责分离**:
 * - SDK: 创建Preact VNode、设置Context、处理渲染
 * - Runtime: 提供容器、注入运行时能力、管理生命周期
 */
export interface ComponentFactory {
    readonly persistenceSupport?: typeof STATE_SESSION_PROTOCOL;
    readonly appLifecycleSupport?: typeof APP_LIFECYCLE_PROTOCOL;
    /**
     * 初始化组件
     * 
     * @param container - DOM容器（由Runtime创建）
     * @param context - 运行时上下文（Runtime能力注入）
     * @returns 渲染控制器
     * 
     * @example
     * ```tsx
     * const renderer = await factory.initializeComponent(appContainer, {
     *     appId: 'app_0', desktopId: 'desktop_0',
     *     refExporter, markDirty, projection, viewTools,
     * });
     * ```
     */
    initializeComponent(
        container: HTMLElement,
        context: RuntimeContext
    ): Promise<ComponentRenderer>;

    // [未来扩展]
    // getMetadata?: () => AppMetadata;
    // validateContext?: (context: RuntimeContext) => boolean;
}
