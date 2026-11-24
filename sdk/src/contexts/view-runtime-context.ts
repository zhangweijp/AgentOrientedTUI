import { useContext } from 'preact/hooks';
import { sharedPreactContext } from '../context/shared-preact-context.js';
import type { createRefCapture } from '@aotui/core';
import type { CapturedPublication } from '../app-factory/refs.js';

export interface RefRegistry {
    captureRef: ReturnType<typeof createRefCapture>;
    registerRef(data: CapturedPublication): {
        update(value: CapturedPublication): void;
        release(): void;
    };
}

export const ViewRuntimeContext = sharedPreactContext<RefRegistry & { readonly viewId: string }>('view');

export function useRefRegistry(hook: 'useDataRef' | 'useArrayRef', refId: string): RefRegistry {
    const context = useContext(ViewRuntimeContext);
    if (!context) {
        const location = typeof refId === 'string' && refId.length <= 80 && /^[\p{L}\p{N}\p{M}_-]+$/u.test(refId)
            ? ' for Ref ' + JSON.stringify(refId) : '';
        throw new Error('[AOTUI SDK] ' + hook + location + ' must run in a child component of ' +
            '<StaticView>, <DynamicView>, or a ViewType component returned by defineViewType.');
    }
    return context;
}
