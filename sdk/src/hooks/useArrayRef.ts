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
import { useLayoutEffect } from 'preact/hooks';
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
   * 如果提供，生成的 Ref 链接和 Registry Key 将包含类型信息：
   * - List: `(Type[]:id)`
   * - Item: `(Type:id[index])`
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
  const { registerRef, unregisterRef } = useRefRegistry();
  const itemType = options?.itemType;

  // Lists are real Ref targets; capacity limits belong to Core.
  useLayoutEffect(() => {
    const registered: string[] = [];
    const add = (id: string, value: object) => {
      registerRef(id, value);
      registered.push(id);
    };

    try {
      add(itemType ? `${itemType}[]:${refId}` : refId, data);
      data.forEach((item, idx) => {
        const itemId = `${refId}[${idx}]`;
        add(itemType ? `${itemType}:${itemId}` : itemId, item);
      });
    } catch (error) {
      for (const id of registered.reverse()) unregisterRef(id);
      throw error;
    }
    return () => {
      for (const id of registered) unregisterRef(id);
    };
  }, [refId, data, itemType, registerRef, unregisterRef]);

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
