/**
 * AOTUI SDK - View Runtime Context
 *
 * Runtime context for a mounted View.
 *
 * @module @aotui/sdk/contexts/view-runtime-context
 */
import { createContext } from "preact";
import type { IViewMeta, IRefRegistry } from "@aotui/runtime/spi";

// ═══════════════════════════════════════════════════════════════
//  统一 Context 值接口
// ═══════════════════════════════════════════════════════════════

/**
 * 统一的 View 运行时上下文值
 *
 * 设计原则:
 * 1. 所有字段使用 readonly 防止意外修改
 * 2. 公共 API (meta) 与内部 API 清晰分离
 * 3. Runtime-owned ports remain separate fields for internal SDK use
 */
interface ViewRuntimeContextValue {
  // ═══════════════════════════════════════════════════════════
  // 公共 API - 应用开发者可使用
  // ═══════════════════════════════════════════════════════════

  /** View 元数据 (viewId, appId, desktopId, markDirty) */
  readonly meta: Readonly<IViewMeta>;

  // ═══════════════════════════════════════════════════════════
  // 内部 API - 仅 SDK 组件/Hooks 使用
  // ═══════════════════════════════════════════════════════════

  /** Ref 注册表 - useArrayRef, useRef */
  readonly refs: Readonly<IRefRegistry>;

}

// ═══════════════════════════════════════════════════════════════
//  Context 实例
// ═══════════════════════════════════════════════════════════════

/**
 * 统一运行时 Context
 *
 * The single context used by SDK View hooks.
 */
export const ViewRuntimeContext = createContext<ViewRuntimeContextValue | null>(
  null,
);
ViewRuntimeContext.displayName = "AOTUI.ViewRuntime";
