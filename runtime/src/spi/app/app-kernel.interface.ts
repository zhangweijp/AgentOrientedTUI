/**
 * SPI Layer - AppKernel Configuration Interface
 *
 * App Kernel 的配置接口，由 SDK 生成，
 * 传递给 Runtime 的 AppKernel 实例化。
 *
 * [方案 B] 定义在 SPI 层以解耦 SDK 和 Runtime。
 * SDK 生成配置，Runtime 消费配置。
 *
 * @module @aotui/runtime/spi/app
 */
import type { AppLaunchConfig } from './app-config.interface.js';
import type { AppContext } from './store.interface.js';

export interface AppReinitializeContext extends AppContext {
    reason?: string;
}

/**
 * [RFC-012] App 信号策略
 * 
 * 控制 App 何时触发 UpdateSignal。
 * 
 * - 'auto' (默认): DOM 变化自动触发 UpdateSignal
 * - 'manual': 仅显式调用 emitSignal() 时触发
 * - 'never': 永不触发信号 (被动 App，如 Thought Recorder)
 */
export type SignalPolicy = 'auto' | 'manual' | 'never';

/**
 * App Kernel Configuration
 *
 * 由 SDK 生成的配置对象，传递给 AppKernel。
 *
 * @example
 * SDK 生成的组件配置由 Runtime AppKernel 消费。
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
     * 派生的日志／调试标签；不用于注册、Ref 解析或调用定位
     */
    name: string;

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

    /**
     * 运行时启动配置
     * 
     * 由 Worker Runtime 在实例化 AppKernel 时注入。
     * 包含环境变量、初始状态等运行时信息。
     * 
     * 注意：这不是由 SDK 设置的，而是由 Runtime 注入。
     */
    launchConfig?: AppLaunchConfig;

    /**
     * [RFC-012] 信号策略
     * 
     * 控制此 App 何时触发 UpdateSignal 通知 Agent。
     * 
     * - 'auto' (默认): DOM 变化自动触发，适合交互式 App
     * - 'manual': 仅显式调用时触发，适合批量更新场景
     * - 'never': 永不触发，适合被动 App（如 Thought Recorder）
     * 
     * @default 'auto'
     */
    signalPolicy?: SignalPolicy;

    /**
     * [RFC-015] App 删除回调
     * 
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
