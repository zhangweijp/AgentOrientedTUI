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
 *   const [listRef, itemRef] = useArrayRef('messages', messages, { scope: 'private', itemType: 'Message' });
 *
 *   return <ul>{messages.map((msg, idx) => (
 *     <li key={msg.id}>{itemRef(idx, `${msg.role}: ${msg.content}`)}</li>
 *   ))}</ul>;
 * }
 * ```
 */
import type Type from 'typebox';
import { arrayRef, formatRef, type ArrayRefOptions, type RefSourceValue } from '../app-factory/refs.js';
import { usePublishedRef } from './useRef.js';

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

/**
 * 创建一个指向数据数组的引用。
 *
 * @param refId - 列表引用 ID (在当前 View 内唯一)
 * @param data - 数据数组
 * @param options - 配置选项
 * @returns [listRef, itemRef] - 列表标题和列表项的格式化函数
 */
export function useArrayRef<Schema extends Type.TSchema>(
  refId: string,
  data: readonly unknown[] & RefSourceValue<Schema>,
  options: ArrayRefOptions<Schema>,
): ArrayRefHandle {
  const descriptor = arrayRef(refId, data, options);
  usePublishedRef('useArrayRef', descriptor);

  return [
    content => formatRef(content, descriptor),
    (index, content) => formatRef(content, descriptor, index),
  ];
}
