import { useLayoutEffect, useRef } from './preact-hooks.js';
import { useAppRuntimeContext } from '../context/AppRuntimeContext.js';
import type { AppLifecycleCallbacks } from '@aotui/runtime/spi';
export type { AppLifecycleCallbacks } from '@aotui/runtime/spi';

export function experimental_useAppLifecycle(callbacks: AppLifecycleCallbacks): void {
    const port = useAppRuntimeContext().appLifecycle;
    if (port?.protocol !== 'app-lifecycle-v2') throw new Error('APP_LIFECYCLE_UNSUPPORTED');
    const current = useRef(callbacks), closing = useRef<AppLifecycleCallbacks>();
    useLayoutEffect(() => { if (!closing.current) current.current = callbacks; });
    useLayoutEffect(() => port.register({
        stop: () => { closing.current ??= current.current; return closing.current.stop?.(); },
        close: () => (closing.current ?? current.current).close?.(),
    }), [port]);
}
