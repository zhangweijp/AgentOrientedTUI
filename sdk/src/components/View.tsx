/**
 * AOTUI SDK - View Component (RFC-027 Enhanced + View Type Mechanism)
 *
 * 组件模式: 在createTUIApp的AppRuntimeContext中使用
 *
 * View Type机制改造:
 * - id prop改为必填，由开发者手动指定
 * - 新增type prop，用于同类View的Tool聚合
 * - 移除uniqueId（breaking change，不向后兼容）
 * 
 * 渲染为: <div data-view-id="fd_0" data-view-type="FileDetail" data-view-kind="state">...</div>
 * Snapshot stores the body separately; the Agent message boundary adds the View envelope.
 */
import { type ComponentChildren, type JSX, h } from "preact";
import { useContext, useMemo, useRef as usePreactRef } from 'preact/hooks';
import { AppRuntimeContext } from "../context/AppRuntimeContext.js";
import { ViewRuntimeContext } from "../contexts/view-runtime-context.js";
import { createViewId } from "@aotui/runtime/spi";
import type { ViewSnapshotV2 } from '@aotui/runtime/core';

export interface ViewProps {
  /** 
   * View ID (required, manually specified by developer)
   * 
   * Naming rules:
   * - Only alphanumeric characters and underscore (_)
   * - 2-15 characters long
   * - Must be unique within the app
   * 
   * Examples:
   * - Single instance: "workspace", "chat", "settings"
   * - Multiple instances: "fd_0", "fd_1", "user_123"
   */
  id: string;

  /**
   * Explicit page type, shared by instances with the same Tools.
   * 
   * Used for grouping Views of the same type and Tools aggregation.
   * Multiple views can share the same type.
   * 
   * Examples:
   * - type="FileDetail" for all file detail views
   * - type="UserProfile" for all user profile views
   */
  type: string;

  /** Page purpose; independent of the body and the instance ID. */
  kind: ViewSnapshotV2['kind'];

  /**
   * Display name (optional, defaults to id)
   * 
   * Human-readable name shown in Snapshot
   */
  name?: string;

  /** Child elements */
  children?: ComponentChildren;

}

/**
 * View组件
 */
export function View({ id, type, kind, name, children }: ViewProps): JSX.Element {
  // Validate ID format
  if (!id) {
    throw new Error(
      '[AOTUI SDK] View "id" prop is required.\n' +
      'Example: <View kind="state" id="workspace" type="Workspace">\n' +
      'Naming rules: alphanumeric and underscore (_) only, 2-15 characters'
    );
  }

  if (!/^[a-zA-Z0-9_]{2,15}$/.test(id)) {
    throw new Error(
      `[AOTUI SDK] Invalid View ID "${id}".\n` +
      'ID must be 2-15 characters, alphanumeric and underscore (_) only.\n' +
      'Examples: "workspace", "fd_0", "user_123"'
    );
  }

  if (typeof type !== 'string' || type.trim().length === 0 || (kind !== 'instruction' && kind !== 'state')) {
    throw new TypeError('[AOTUI SDK] VIEW_METADATA_INVALID: View requires an explicit non-empty type and kind="instruction" or kind="state".');
  }

  // 尝试获取AppRuntimeContext (组件模式)
  const parentViewContext = useContext(ViewRuntimeContext);
  if (parentViewContext) {
    const parentViewId = parentViewContext.meta.viewId;
    const childViewId = createViewId(id);
    throw Object.assign(
      new Error(
        `[AOTUI SDK] NESTED_VIEW_UNSUPPORTED: View "${childViewId}" cannot be declared inside View "${parentViewId}". ` +
        'Declare both Views as independent siblings under a non-View layout component.'
      ),
      {
        code: 'NESTED_VIEW_UNSUPPORTED' as const,
        parentViewId,
        childViewId,
      }
    );
  }

  const appContext = useContext(AppRuntimeContext);

  // 如果在组件模式下
  if (!appContext) {
    throw new Error(`[AOTUI SDK] Empty AppRuntimeContext`);
  }

  // Derive type and display name
  const viewType = type;
  const displayName = name || id;

  // Use developer-specified ID directly (with type branding)
  const viewId = createViewId(id);  // ✅ 确保类型安全

  // The semantic View identity is allocated only when Preact attaches its DOM node.
  // Runtime assigns this identity only after Preact commits the DOM ref.
  // Ref callbacks run before child layout effects, so Refs can register in the
  // same commit without allocating a View identity from render().
  const instanceRef = usePreactRef<string | null>(null);
  const viewToolsPort = appContext.viewTools;
  const attachContainer = useMemo(() => (node: HTMLDivElement | null) => {
    if (node && viewToolsPort && !instanceRef.current) {
      instanceRef.current = viewToolsPort.mount(viewId, viewType);
      // The projection uses the identity allocated at actual mount.
      node.setAttribute('data-view-instance-id', instanceRef.current);
    } else if (!node && viewToolsPort && instanceRef.current) {
      viewToolsPort.unmount(instanceRef.current);
      instanceRef.current = null;
    }
  }, [viewId, viewType, viewToolsPort]);

  // 构建ViewRuntimeContext (供子组件使用)
  const viewRuntimeContext = useMemo(() => ({
    meta: {
      viewId: viewId,
      viewType: viewType,  // ✅ 传递type信息
      appId: appContext.appId,
      desktopId: appContext.desktopId,
      markDirty: appContext.markDirty,
    },
    refs: {
      registerRef: (refId: string, data: object, refType?: string) => {
        return appContext.refExporter.registerRef(viewId, refId, data, refType);
      },
    },
  }), [viewId, viewType, appContext.launchConfig, viewToolsPort]);

  // 渲染
  return h(
    ViewRuntimeContext.Provider,
    { value: viewRuntimeContext },
    h(
      'div',
      {
        ref: attachContainer,
        id: viewId,
        'data-view-id': viewId,
        'data-view-type': viewType,  // ✅ 添加type属性
        'data-view-kind': kind,
        'data-view-name': displayName,
      },
      children
    )
  );
}
