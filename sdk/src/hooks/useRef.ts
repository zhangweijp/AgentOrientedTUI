/**
 * AOTUI SDK - useDataRef Hook
 *
 * 创建一个指向单个数据对象的引用。
 *
 * @module @aotui/sdk/hooks/useRef
 *
 * @example
 * ```tsx
 * function TopicDetailView({ topic }) {
 *   const topicRef = useDataRef('current_topic', topic);
 *
 *   return (
 *     <View name="TopicDetail">
 *       <p>{topicRef(`话题: ${topic.name}`)}</p>
 *       {/* Agent 看到: [话题: General](current_topic) *\/}
 *     </View>
 *   );
 * }
 * ```
 */
import { useLayoutEffect, useMemo, useRef as usePreactRef } from "./preact-hooks.js";
// [P1 ISP] Use specialized hook instead of useInternalViewContext
import { useRefRegistry } from "./useViewContext.js";

/**
 * RefHandle - 单资源引用句柄
 *
 * 作为渲染函数使用: `ref(content)` 返回格式化后的 TUI 标记字符串。
 */
export interface RefHandle<T> {
  /** 格式化为 TUI 标记: [content](refId) */
  (content: string): string;
  /** 当前绑定的数据 */
  data: T;
  /** 引用 ID */
  id: string;
}

/**
 * 创建一个指向单个数据对象的引用。
 *
 * @param refId - 引用 ID (在当前 View 内唯一)
 * @param data - 绑定的数据对象
 * @returns RefHandle - 可作为渲染函数调用的引用句柄
 */
export function useDataRef<T extends object>(refId: string, data: T): RefHandle<T> {
  // [P1 ISP] Use specialized hook
  const { registerRef, unregisterRef } = useRefRegistry();

  // 使用 Preact ref 存储 registry 引用，避免每次渲染重新注册
  const registeredRef = usePreactRef(false);

  // 注册到 RefRegistry
  // Align Ref registration with View's synchronous commit phase.
  // A passive useEffect leaves DOM-visible Ref markers without registry entries.
  useLayoutEffect(() => {
    registerRef(refId, data);
    registeredRef.current = true;

    return () => {
      if (registeredRef.current) {
        unregisterRef(refId);
        registeredRef.current = false;
      }
    };
  }, [refId, data, registerRef, unregisterRef]);

  // 创建渲染函数
  const format = (content: string): string => {
    return `[${content}](${refId})`;
  };

  // 附加属性
  (format as RefHandle<T>).data = data;
  (format as RefHandle<T>).id = refId;

  return format as RefHandle<T>;
}

/**
 * V2-only versioned entity Ref. The marker is JSON-compatible so legacy
 * Snapshot V1 can retain it as data; V2 Producer converts it to an entity
 * target. It does NOT authorize a mutation and doesn't read disk versions.
 */
export function useEntityRef(
  refId: string,
  target: { entityType: string; entityId: string; entityVersion: string },
): RefHandle<{ $aotuiEntityRefV1: {
    entityType: string; entityId: string; entityVersion: string;
  } }> {
  const { entityType, entityId, entityVersion } = target;
  const payload = useMemo(() => {
    if (![entityType, entityId, entityVersion].every(
      value => typeof value === 'string' && value.trim().length > 0
    )) {
      throw new Error('[AOTUI SDK] useEntityRef requires a nonempty entity identity and version');
    }
    return Object.freeze({
      $aotuiEntityRefV1: Object.freeze({ entityType, entityId, entityVersion }),
    });
  }, [entityType, entityId, entityVersion]);
  return useDataRef(refId, payload);
}
