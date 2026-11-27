/**
 * @aotui/agent-driver-v2 - Debounce Utility
 * 
 * 信号防抖工具，避免短时间内多次触发 LLM 调用
 */

/**
 * 创建防抖函数
 * 
 * @param fn - 要防抖的函数
 * @param delayMs - 延迟时间 (ms)
 * @returns 防抖后的函数
 */
export function debounce<T extends (...args: any[]) => void>(
    fn: T,
    delayMs: number
): T & { cancel(): void } {
    let timeoutId: NodeJS.Timeout | null = null;
    const cancel = () => {
        if (timeoutId !== null) clearTimeout(timeoutId);
        timeoutId = null;
    };
    return Object.assign((...args: Parameters<T>) => {
        cancel();
        timeoutId = setTimeout(() => {
            timeoutId = null;
            fn(...args);
        }, delayMs);
    }, { cancel }) as T & { cancel(): void };
}
