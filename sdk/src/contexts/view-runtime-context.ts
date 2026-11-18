import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { createRefCapture, RefCapture } from '@aotui/runtime/spi';

export interface RefRegistry {
    captureRef: ReturnType<typeof createRefCapture>;
    registerRef(id: string, data: RefCapture, refType?: string): {
        update(value: RefCapture): void;
        release(): void;
    };
}

export const ViewRuntimeContext = createContext<(RefRegistry & { readonly viewId: string }) | null>(null);

export function useRefRegistry(hook: 'useDataRef' | 'useArrayRef', refId: string): RefRegistry {
    const context = useContext(ViewRuntimeContext);
    if (!context) {
        const location = typeof refId === 'string' && refId.length <= 80 && /^[\p{L}\p{N}\p{M}_-]+$/u.test(refId)
            ? ' for Ref ' + JSON.stringify(refId) : '';
        throw new Error('[AOTUI SDK] ' + hook + location + ' needs a parent <View>. ' +
            'Move the hook into a content component rendered as a child of <View>. ' +
            'A component that returns <View> cannot use the provider it returns.');
    }
    return context;
}
