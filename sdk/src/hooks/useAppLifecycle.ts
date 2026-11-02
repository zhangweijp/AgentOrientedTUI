import { useLayoutEffect, useRef } from 'preact/hooks';
import { useInternalAppRuntimeContext } from '../context/AppRuntimeContext.js';
import type { AppLifecycleCallbacks } from '@aotui/runtime/spi';
export type { AppLifecycleCallbacks } from '@aotui/runtime/spi';

export function useAppLifecycle(callbacks: AppLifecycleCallbacks): void {
    const port = useInternalAppRuntimeContext().appLifecycle;
    if (port?.protocol !== 'app-lifecycle-v2') throw new Error('APP_LIFECYCLE_UNSUPPORTED');
    const current = useRef(callbacks), closing = useRef<AppLifecycleCallbacks>();
    useLayoutEffect(() => { if (!closing.current) current.current = callbacks; });
    useLayoutEffect(() => port.register({
        stop: () => { closing.current ??= current.current; return closing.current.stop?.(); },
        close: () => (closing.current ?? current.current).close?.(),
    }), [port]);
}
