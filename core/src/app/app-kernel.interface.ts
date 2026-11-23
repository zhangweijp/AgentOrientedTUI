import type { AppID, DesktopID } from './identity.js';

/** Identity of an App instance during lifecycle callbacks. */
export interface AppContext {
    readonly desktopId: DesktopID;
    readonly appId: AppID;
}

export interface AppReinitializeContext extends AppContext {
    reason?: string;
}

/** Whether committed App projections request an Agent update. */
export type SignalPolicy = 'auto' | 'never';

/**
 * App Kernel Configuration
 *
 * Lifecycle methods run with a per-instance shallow copy of this configuration as `this`.
 */
export interface AppKernelConfig {
    /**
     * App 语义名称（用于对外暴露给 LLM 的 Tool 名称前缀）
     *
     * 约束: 仅允许 [a-zA-Z0-9_]
     * 示例: system_ide, planning_app, terminal_app
     *
     * 必须与 SDK 的 `app_name` 一致；缺少该值的工厂无效。
     */
    appName: string;

    /**
     * [RFC-013] App 描述
     * 
     * 告诉 Agent 这个 App 是什么、什么时候该使用它。
     * 会在 Desktop Snapshot 的 Installed Applications 中展示给 Agent。
     * 
     * @example
     * description: 'Agent 与 User 之间的实时对话应用。当需要与 User 对话、询问问题、报告进度时使用此 App。'
     */
    description?: string;

    /** App 是什么 (用于 Desktop State 展示) */
    whatItIs?: string;

    /** 什么时候用 (用于 Desktop State 展示) */
    whenToUse?: string;

    /** Auto requests an update after a changed projection. Never leaves refresh to the Host. */
    signalPolicy?: SignalPolicy;

    /**
     * 当 App 被永久删除时调用。
     * 用于清理持久化数据（如 DB、LocalStorage）。
     */
    onDelete?(context: AppContext): Promise<void> | void;

    /**
     * App 重新初始化回调
     *
     * 在 Runtime 触发冷重启前调用，用于最佳努力清理瞬时状态。
     */
    onReinitialize?(context: AppReinitializeContext): Promise<void> | void;

}
