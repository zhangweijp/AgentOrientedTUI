/**
 * SPI App Layer - Public Types for App Developers
 *
 * [P4/P5 FIX] 类型定义碎片化修复
 *
 * 这些接口是 App 开发者可见的公共 API。
 * SDK 应该 re-export 这些类型，而不是定义自己的版本。
 *
 * 设计原则:
 * 1. 使用 string 替代 Branded Types (AppID, ViewID 等) - 降低开发者心智负担
 * 2. 只暴露 App 开发者需要的最小接口 - 接口隔离原则 (ISP)
 * 3. 作为 SSOT (Single Source of Truth) - SDK 和应用层都从这里导入
 *
 * @module @aotui/runtime/spi/app/public-types
 */


// ============================================================================
// IViewMeta - View 元数据 (App 开发者可见)
// ============================================================================

/**
 * View 元数据接口 - App 开发者的公共 API
 *
 * 这是 App 开发者通过 `useViewContext()` 获取的上下文类型。
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *     const ctx = useViewContext();
 *     console.log('Current view:', ctx.viewId);
 *     console.log('Desktop:', ctx.desktopId);
 *
 *     // 标记 View 需要更新
 *     ctx.markDirty();
 * }
 * ```
 */
export interface IViewMeta {
    /** 当前 View 的唯一标识符 */
    readonly viewId: string;

    /**
     * 当前View的类型 (用于Tool聚合)
     * 
     * @optional
     */
    readonly viewType?: string;

    /** SDK View mount identity; distinct from the stable viewId. */
    readonly viewGeneration?: string;

    /** Runtime-owned current mount identity; never a developer-assigned viewId. */
    readonly viewInstanceId?: string;

    /** 父 App 的唯一标识符 */
    readonly appId: string;

    /** Desktop 的唯一标识符 (用于加载相关数据，如历史记录) */
    readonly desktopId: string;

    /**
     * 标记 View 为 dirty，触发 UpdateSignal
     *
     * 数据链路: markDirty() → Preact render → MutationObserver → UpdateSignal
     */
    markDirty(): void;
}

// ============================================================================
// IRefRegistry - Ref 注册表 (App 开发者可见)
// ============================================================================

/**
 * Ref 注册表接口 - App 开发者的公共 API
 *
 * 用于 `useArrayRef` 等 Hooks 内部注册数据引用。
 * App 开发者通常不直接使用此接口，而是通过 Hooks。
 *
 * @internal 主要供 SDK Hooks 使用
 */
export interface IRefRegistry {
    /**
     * 注册数据引用
     *
     * @param refId - 引用 ID (View 内唯一)
     * @param data - 绑定的数据对象
     */
    registerRef(refId: string, data: object): void;

    /**
     * 注销数据引用
     *
     * @param refId - 要注销的引用 ID
     */
    unregisterRef(refId: string): void;
}
