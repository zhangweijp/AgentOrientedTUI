/**
 * AOTUI Runtime - App Kernel Module
 *
 * [方案 B] Worker 内的 App 执行引擎。
 *
 * 负责：
 * - App 生命周期管理
 * - 组件 View 注册
 * - View lifecycle and source-bound Tool handling
 * - Semantic projection and Ref export
 *
 * @module @aotui/runtime/worker-runtime/app-kernel
 */

export { AppKernel } from './AppKernel.js';
