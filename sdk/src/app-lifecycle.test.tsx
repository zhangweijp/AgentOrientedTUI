import { h } from 'preact';
import { render } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLifecycleCallbacks } from '@aotui/runtime/spi';
import { AppRuntimeContext } from './context/AppRuntimeContext.js';
import { useAppLifecycle } from './hooks/useAppLifecycle.js';
import { useState } from 'preact/hooks';

const mounted: Array<() => void> = [];
afterEach(() => { for (const unmount of mounted.splice(0)) unmount(); vi.restoreAllMocks(); });

function mountLifecycle(component: () => unknown, lifecycle?: unknown) {
    const view = render(h(AppRuntimeContext.Provider, {
        value: { appId: 'app', desktopId: 'desktop', refExporter: {}, markDirty() {}, appLifecycle: lifecycle } as any,
    }, h(component, {})));
    mounted.push(view.unmount);
    return view;
}

describe('useAppLifecycle', () => {
    it('registers the latest pre-stop callbacks and keeps that callback pair through close', async () => {
        let callbacks: AppLifecycleCallbacks | undefined;
        let update!: (revision: number) => void;
        const stopA = vi.fn(), closeA = vi.fn(), stopB = vi.fn(), closeB = vi.fn();
        const stopC = vi.fn(), closeC = vi.fn(), unregister = vi.fn();
        const port = {
            protocol: 'app-lifecycle-v2' as const,
            register: vi.fn((value: AppLifecycleCallbacks) => { callbacks = value; return unregister; }),
        };
        function Root() {
            const [revision, setRevision] = useState(0);
            update = setRevision;
            useAppLifecycle(revision === 0 ? { stop: stopA, close: closeA }
                : revision === 1 ? { stop: stopB, close: closeB } : { stop: stopC, close: closeC });
            return null;
        }

        mountLifecycle(Root, port);
        expect(port.register).toHaveBeenCalledOnce();
        await act(async () => { update(1); });
        callbacks!.stop!();
        await act(async () => { update(2); });
        await callbacks!.close!();

        expect(stopA).not.toHaveBeenCalled();
        expect(closeA).not.toHaveBeenCalled();
        expect(stopB).toHaveBeenCalledOnce();
        expect(closeB).toHaveBeenCalledOnce();
        expect(stopC).not.toHaveBeenCalled();
        expect(closeC).not.toHaveBeenCalled();
    });

    it('accepts an empty callback set and unregisters on unmount', () => {
        let callbacks: AppLifecycleCallbacks | undefined;
        const unregister = vi.fn();
        const port = {
            protocol: 'app-lifecycle-v2' as const,
            register: vi.fn((value: AppLifecycleCallbacks) => { callbacks = value; return unregister; }),
        };
        function Root() { useAppLifecycle({}); return null; }

        const view = mountLifecycle(Root, port);
        expect(port.register).toHaveBeenCalledOnce();
        expect(() => callbacks!.stop!()).not.toThrow();
        expect(() => callbacks!.close!()).not.toThrow();
        view.unmount();
        expect(unregister).toHaveBeenCalledOnce();
    });

    it('rejects a missing Runtime lifecycle port before registering', () => {
        function Root() { useAppLifecycle({}); return null; }
        expect(() => mountLifecycle(Root)).toThrow('APP_LIFECYCLE_UNSUPPORTED');
    });
});
