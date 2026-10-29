/**
 * useLLMOutputChannel - 订阅 LLM 文本输出
 * 
 * [RFC-011] LLM Output Output Channel
 * 
 * 提供 TUI App 订阅 LLM 文本输出的能力。
 * 
 * @module @aotui/sdk/hooks/useLLMOutputChannel
 * 
 * @example
 * ```tsx
 * function ChatView() {
 *     const [thoughts, setThoughts] = useState<string[]>([]);
 *     
 *     useLLMOutputChannel((event) => {
 *         setThoughts(prev => [...prev, event.content]);
 *     });
 *     
 *     return (
 *         <View id="chat" type="Chat" name="Chat">
 *             {thoughts.map((t, i) => <p key={i}>💭 {t}</p>)}
 *         </View>
 *     );
 * }
 * ```
 */

import { useEffect, useRef } from './preact-hooks.js';
import { useContext } from './preact-hooks.js';
import { ViewRuntimeContext } from '../contexts/view-runtime-context.js';
import type { LLMOutputEvent, LLMOutputListener } from '@aotui/runtime/spi';

// ============================================================================
// Types
// ============================================================================

/**
 * useLLMOutputChannel 配置选项
 */
export interface LLMOutputChannelOptions {
    /** @deprecated Unsupported option: omit it. DOM delivers future events; a Provider owns its replay policy. */
    includeHistory?: boolean;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * 订阅 LLM 文本输出通道
 * 
 * 当 LLM 产生非 Tool Call 的文本输出时触发回调。
 * 
 * @param onText - 接收文本事件的回调函数
 * @param options - 可选配置
 * 
 * @example
 * ```tsx
 * // 基础用法
 * useLLMOutputChannel((event) => {
 *     console.log('LLM said:', event.content);
 * });
 * 
 * // 显示 Agent 思考过程
 * const [thinking, setThinking] = useState('');
 * useLLMOutputChannel((event) => {
 *     setThinking(event.content);
 * });
 * ```
 */
export function useLLMOutputChannel(
    onText: LLMOutputListener,
    options?: LLMOutputChannelOptions
): void {
    // 从 ViewRuntimeContext 获取 llmOutput 通道 (null-safe: 允许在 View 外调用)
    const viewCtx = useContext(ViewRuntimeContext);
    const llmOutput = viewCtx?.llmOutput;
    if (options?.includeHistory !== undefined) {
        throw new Error('SDK_LLM_HISTORY_OPTION_UNSUPPORTED: useLLMOutputChannel does not implement includeHistory; omit it and follow the source Provider replay contract.');
    }
    if (llmOutput != null && typeof llmOutput.subscribe !== 'function') {
        throw new Error('SDK_LLM_OUTPUT_UNAVAILABLE: useLLMOutputChannel requires a callable Provider.subscribe; an invalid Provider cannot fall back to DOM events.');
    }
    const dom = typeof document === 'undefined' ? undefined : document;
    if (llmOutput == null && !dom) {
        throw new Error('SDK_LLM_OUTPUT_UNAVAILABLE: useLLMOutputChannel requires an actual Provider or a document event bridge.');
    }

    // 使用 ref 保持回调引用最新
    const callbackRef = useRef(onText);
    callbackRef.current = onText;

    useEffect(() => {
        // 包装 listener 以使用最新的回调
        const handler: LLMOutputListener = (event) => {
            callbackRef.current(event);
        };

        // Select one actual source; Provider failures propagate without DOM fallback.
        if (llmOutput != null) return llmOutput.subscribe(handler);

        // [RFC-011] 方案2: Worker 模式通过 DOM 事件接收
        // 兼容两种事件名：
        // - 'aotui:llm-output' (旧)
        // - 'aotui:llm-text'   (当前 worker-runtime)
        // [RFC-020] 支持 reasoning 字段
        const domHandler = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail && (detail.content || detail.reasoning || detail.meta?.usage)) {
                const preview = detail.reasoning
                    ? `reasoning: ${detail.reasoning.slice(0, 30)}...`
                    : `content: ${detail.content?.slice(0, 30)}...`;
                console.log('[useLLMOutputChannel] Received DOM event:', (e as CustomEvent).type, preview);
                const event: LLMOutputEvent = {
                    desktopId: detail.desktopId || '' as any,
                    type: detail.type || 'complete',
                    content: detail.content,
                    reasoning: detail.reasoning,  // [RFC-020]
                    timestamp: detail.timestamp || Date.now(),
                    meta: detail.meta
                };
                handler(event);
            }
        };

        // 监听 document 级别的自定义事件 (bubbles: true)
        dom!.addEventListener('aotui:llm-output', domHandler);
        dom!.addEventListener('aotui:llm-text', domHandler);

        return () => {
            dom!.removeEventListener('aotui:llm-output', domHandler);
            dom!.removeEventListener('aotui:llm-text', domHandler);
        };
    }, [llmOutput, dom]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ============================================================================
// History Hook
// ============================================================================

/**
 * 获取 LLM 文本历史
 * 
 * 查询实际 Provider 的历史；组件 DOM 桥不提供历史查询。
 * 
 * @returns 历史事件数组
 * 
 * @example
 * ```tsx
 * function HistoryView() {
 *     const history = useLLMOutputHistory();
 *     
 *     return (
 *         <ul>
 *             {history.map((e, i) => <li key={i}>{e.content}</li>)}
 *         </ul>
 *     );
 * }
 * ```
 */
export function useLLMOutputHistory(): LLMOutputEvent[] {
    const viewCtx = useContext(ViewRuntimeContext);
    const llmOutput = viewCtx?.llmOutput;
    if (llmOutput == null || typeof llmOutput.getHistory !== 'function') {
        throw new Error('SDK_LLM_HISTORY_UNAVAILABLE: useLLMOutputHistory requires a callable Provider.getHistory; the component DOM bridge does not provide history.');
    }
    return llmOutput.getHistory();
}
