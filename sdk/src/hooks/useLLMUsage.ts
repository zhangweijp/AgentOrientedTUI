import { useLayoutEffect, useRef } from 'preact/hooks';
import type { LLMUsageEvent } from '@aotui/runtime/spi';

/** Subscribe to model usage delivered by the current Desktop. */
export function useLLMUsage(listener: (event: LLMUsageEvent) => void): void {
    const dom = typeof document === 'undefined' ? undefined : document;
    if (!dom) throw new Error('SDK_LLM_USAGE_UNAVAILABLE: useLLMUsage requires a document event bridge.');

    const callback = useRef(listener);
    callback.current = listener;

    // Subscribe before the initial snapshot can notify the Host.
    useLayoutEffect(() => {
        const receive = (event: Event) => callback.current((event as CustomEvent<LLMUsageEvent>).detail);
        dom.addEventListener('aotui:llm-usage', receive);
        return () => dom.removeEventListener('aotui:llm-usage', receive);
    }, [dom]);
}
