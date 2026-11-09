/**
 * AOTUI SDK - useArrayRef Hook
 *
 * 创建一个指向数据数组的引用。
 *
 * @module @aotui/sdk/useArrayRef
 *
 * @example
 * ```tsx
 * function ChatView({ messages }) {
 *   const [listRef, itemRef] = useArrayRef('messages', messages, { itemType: 'Message' });
 *
 *   return <ul>{messages.map((msg, idx) => (
 *     <li key={msg.id}>{itemRef(idx, `${msg.role}: ${msg.content}`)}</li>
 *   ))}</ul>;
 * }
 * ```
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useRefRegistry } from './useViewContext.js';

/**
 * ListRefFormatter - 列表标题格式化函数
 */
export type ListRefFormatter = (content: string) => string;

/**
 * ItemRefFormatter - 列表项格式化函数
 *
 * @param index - 列表项索引
 * @param content - 显示内容
 * @returns 格式化后的 TUI 标记字符串
 */
export type ItemRefFormatter = (index: number, content: string) => string;

/**
 * ArrayRefHandle - 列表引用句柄元组
 *
 * [0]: listRef - 格式化列表标题
 * [1]: itemRef - 格式化列表项
 */
export type ArrayRefHandle = [ListRefFormatter, ItemRefFormatter];

export interface UseArrayRefOptions {
  /**
   * 列表项类型名称 (如 "Message")
   *
   * 如果提供，生成的 Ref 展示链接包含类型信息，注册名仍为 View 内的局部 ID：
   * - List: `(Type[]:id)`
   * - Item: `(Type:id[index])`
   * 同一业务种类也传入列表和元素的 Ref 注册记录。
   */
  itemType?: string;
}

/**
 * 创建一个指向数据数组的引用。
 *
 * @param refId - 列表引用 ID (在当前 View 内唯一)
 * @param data - 数据数组
 * @param options - 配置选项
 * @returns [listRef, itemRef] - 列表标题和列表项的格式化函数
 */
export function useArrayRef(
  refId: string,
  data: object[],
  options?: UseArrayRefOptions,
): ArrayRefHandle {
  const { registerRef } = useRefRegistry();
  const itemType = options?.itemType;
  type Binding = ReturnType<typeof registerRef>;
  type BoundValue = { binding: Binding; value: object };
  const bindings = useRef<Map<string, BoundValue> | null>(null);
  const entriesFor = (values: object[]) => [
    { id: refId, value: values },
    ...values.map((value, index) => ({
      id: `${refId}[${index}]`,
      value,
    })),
  ];

  // A publisher keeps its handles while updating values; cleanup only releases
  // the handles it acquired.
  useLayoutEffect(() => {
    const current = new Map<string, BoundValue>();
    try {
      for (const { id, value } of entriesFor(data)) {
        const binding = registerRef(id, value, itemType);
        current.set(id, { binding, value });
      }
    } catch (error) {
      for (const { binding } of [...current.values()].reverse()) binding.release();
      throw error;
    }
    bindings.current = current;
    return () => {
      for (const { binding } of [...current.values()].reverse()) binding.release();
      if (bindings.current === current) bindings.current = null;
    };
  }, [refId, itemType, registerRef]);

  useLayoutEffect(() => {
    const current = bindings.current;
    if (!current) return;
    const desired = entriesFor(data);
    const added: Array<{ id: string; binding: Binding }> = [];
    try {
      for (const { id, value } of desired) {
        if (current.has(id)) continue;
        const binding = registerRef(id, value, itemType);
        added.push({ id, binding });
        current.set(id, { binding, value });
      }
    } catch (error) {
      for (const { id, binding } of added.reverse()) {
        binding.release();
        current.delete(id);
      }
      throw error;
    }

    const desiredIds = new Set(desired.map(entry => entry.id));
    for (const { id, value } of desired) {
      const existing = current.get(id)!;
      if (existing.value !== value) {
        existing.binding.update(value);
        existing.value = value;
      }
    }
    for (const [id, existing] of current) {
      if (!desiredIds.has(id)) {
        existing.binding.release();
        current.delete(id);
      }
    }
  }, [data]);

  // 列表标题格式化函数
  const listRef: ListRefFormatter = (content: string): string => {
    const prefix = itemType ? `${itemType}[]:` : "";
    return `[${content}](${prefix}${refId})`;
  };

  // 列表项格式化函数
  const itemRef: ItemRefFormatter = (
    index: number,
    content: string,
  ): string => {
    const prefix = itemType ? `${itemType}:` : "";
    return `[${content}](${prefix}${refId}[${index}])`;
  };

  return [listRef, itemRef];
}
