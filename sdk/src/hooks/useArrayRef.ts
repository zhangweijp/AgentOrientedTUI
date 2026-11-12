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
import { arrayRef, captureRefEntries, formatRef, type ArrayRefOptions } from '../app-factory/refs.js';
import { useRefRegistry } from '../contexts/view-runtime-context.js';

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
export function useArrayRef(
  refId: string,
  data: readonly unknown[],
  options?: ArrayRefOptions,
): ArrayRefHandle {
  const { captureRef, registerRef } = useRefRegistry();
  const itemType = options?.itemType;
  const desired = captureRefEntries(captureRef, arrayRef(refId, data, options));
  type Binding = ReturnType<typeof registerRef>;
  const owner = useRef<{ bindings: Map<string, Binding>; refId: string; itemType: string | undefined; registerRef: typeof registerRef }>();
  const release = () => {
    for (const binding of owner.current?.bindings.values() ?? []) binding.release();
    owner.current = undefined;
  };
  useLayoutEffect(() => release, []);

  useLayoutEffect(() => {
    let current = owner.current;
    if (!current || current.refId !== refId || current.itemType !== itemType || current.registerRef !== registerRef) {
      release();
      current = { bindings: new Map(), refId, itemType, registerRef };
      owner.current = current;
    }
    const bindings = current.bindings;
    const added: string[] = [];
    try {
      for (const [id, value] of desired) {
        const binding = bindings.get(id);
        if (binding) binding.update(value);
        else {
          bindings.set(id, registerRef(id, value, itemType));
          added.push(id);
        }
      }
    } catch (error) {
      for (const id of added.reverse()) {
        bindings.get(id)!.release();
        bindings.delete(id);
      }
      throw error;
    }
    for (const [id, binding] of bindings) {
      if (!desired.has(id)) {
        binding.release();
        bindings.delete(id);
      }
    }
  });

  return [
    content => formatRef(content, refId, itemType === undefined ? undefined : `${itemType}[]`),
    (index, content) => formatRef(content, `${refId}[${index}]`, itemType),
  ];
}
