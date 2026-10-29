/**
 * View Domain
 * 
 * 包含视图状态管理及 DOM 转换类型。
 * 
 * @module @aotui/runtime/engine/view
 */

// Export local ViewContext type for backward compatibility
export type { ViewContext } from './types.js';

// Re-export IView from local types for backward compatibility
export type { IView, IViewContext } from './types.js';

// ============================================================================
// ViewManager - 视图状态管理
// ============================================================================
export { ViewManager } from './manager.js';

// ============================================================================
// Transformer - DOM → TUI Markdown
// ============================================================================
export type { TransformResult } from './transformer/types.js';
