import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { IRefRegistry } from '@aotui/runtime/spi';

export const ViewRuntimeContext = createContext<(IRefRegistry & { readonly viewId: string }) | null>(null);

export function useRefRegistry(): IRefRegistry {
    const context = useContext(ViewRuntimeContext);
    if (!context) throw new Error('[AOTUI SDK] Ref Hooks must be used inside a mounted <View>.');
    return context;
}
