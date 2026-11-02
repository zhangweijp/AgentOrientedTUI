/**
 * AOTUI SDK - useViewContext Hook
 *
 * Reads current View metadata and the internal Ref registration port.
 */
import { useContext } from 'preact/hooks';
import type { IViewMeta, IRefRegistry } from "@aotui/runtime/spi";
import { ViewRuntimeContext } from "../contexts/view-runtime-context.js";

// ═══════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════

/**
 * 获取当前 View 的元数据 (公共 API)
 *
 * Reads the current View's metadata from the mounted View context.
 *
 * @throws Error 如果在 View 外部使用
 * @returns IViewMeta (viewId, appId, desktopId, markDirty)
 *
 * @example
 * function MyComponent() {
 *     const { viewId, markDirty } = useViewContext();
 *     // Use markDirty() to trigger UI updates after state changes
 * }
 */
export function useViewContext(): IViewMeta {
  const context = useContext(ViewRuntimeContext);
  if (!context) throw new Error('[AOTUI SDK] useViewContext must be used inside a mounted <View>.');
  return context.meta;
}

// ═══════════════════════════════════════════════════════════════
//  Internal Ref Hook
// ═══════════════════════════════════════════════════════════════

/**
 * 获取 Ref 注册表 (内部 API)
 *
 * Reads the Ref registry used by SDK hooks from the mounted View context.
 *
 * @internal 仅供 `useArrayRef` 等 Hooks 使用
 */
export function useRefRegistry(): IRefRegistry {
  const context = useContext(ViewRuntimeContext);
  if (!context) throw new Error('[AOTUI SDK] Ref Hooks must be used inside a mounted <View>.');
  return context.refs;
}
