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

export function useRefRegistry(): RefRegistry {
    const context = useContext(ViewRuntimeContext);
    if (!context) throw new Error('[AOTUI SDK] Ref Hooks must be used inside a mounted <View>.');
    return context;
}
