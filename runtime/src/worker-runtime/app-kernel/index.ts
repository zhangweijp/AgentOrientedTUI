/**
 * AOTUI Runtime - App Kernel Module
 *
 * [方案 B] Worker 内的 App 执行引擎。
 *
 * 负责：
 * - App 生命周期管理
 * - 组件 View 注册
 * - 系统事件处理
 * - Operation 路由
 *
 * @module @aotui/runtime/worker-runtime/app-kernel
 */

export { AppKernel, type TypeToolDefinition, type TypeTool } from './AppKernel.js';

/**
 * [RFC-B2] ViewRegistry - Lightweight View Management
 * 
 * Replacement for ViewTree in component-mode apps.
 * Provides simple register/unregister/get API without tree management.
 */
export { ViewRegistry, createViewRegistry } from './view-registry.js';
