import { describe, expect, it, vi } from 'vitest';
import { createTUIApp } from './createTUIApp.js';

describe('createTUIApp', () => {
    it('exposes the canonical app_name on the factory', () => {
        function RootComponent() {
            return null;
        }

        const factory = createTUIApp({
            viewTypes: [],
            app_name: 'test_app',
            component: RootComponent,
        });

        expect(factory.app_name).toBe('test_app');
    });

    it('captures the App name without executing accessors or retaining catalog metadata', () => {
        let reads = 0;
        expect(() => createTUIApp({viewTypes: [], get app_name() { reads++; return 'test_app'; }, component: () => null }))
            .toThrow(expect.objectContaining({ code: 'APP_METADATA_INVALID', path: 'app_name' }));
        expect(reads).toBe(0);
        const input = { viewTypes: [], app_name: 'test_app', whatItIs: 'Before', component: () => null };
        const factory = createTUIApp(input);input.app_name = 'other';
        expect(factory.app_name).toBe('test_app');
        expect(factory).not.toHaveProperty('whatItIs');
    });

    it('advertises the managed lifecycle contract without requiring app cleanup callbacks', () => {
        const factory = createTUIApp({viewTypes: [], app_name: 'test_app', component: () => null });
        expect(factory.appLifecycleSupport).toBe('app-lifecycle-v2');
        expect(Object.getOwnPropertyDescriptor(factory, 'toolAuthoringProtocol')?.value).toBe('view-type-tools-v7');
    });

    it.each([undefined, { protocol: 'app-lifecycle-v1' }])('refuses an unsupported cleanup port before rendering the Root', async appLifecycle => {
        const component = vi.fn(() => null);
        const factory = createTUIApp({viewTypes: [], app_name: 'test_app', component });
        await expect(async () => factory.initialize({ appId: 'app', desktopId: 'desktop', appLifecycle } as any))
            .rejects.toThrow('APP_LIFECYCLE_UNSUPPORTED');
        expect(component).not.toHaveBeenCalled();
    });

    it('rejects invalid app_name values', () => {
        function RootComponent() {
            return null;
        }

        expect(() =>
            createTUIApp({
                app_name: 'System-Ide',
                component: RootComponent,
            } as any)
        ).toThrow(/app_name/);
    });
    it.each([{}, { name: 'only_name' }, { app_name: undefined }, { app_name: null }, { app_name: 123 }, { app_name: {} }, { app_name: ['valid'] }])('rejects non-string JS configuration %j without regexp coercion', value => {
        expect(() => createTUIApp({ ...value, component: () => null } as any)).toThrow(/APP_METADATA_INVALID.*app_name/);
    });
    it('does not coerce an object name and returns only the component factory contract', () => {
        const coercion = vi.fn(() => 'valid');
        expect(() => createTUIApp({ app_name: { toString: coercion }, component: () => null } as any)).toThrow(/APP_METADATA_INVALID.*app_name/);
        expect(coercion).not.toHaveBeenCalled();
        const factory = createTUIApp({viewTypes: [], app_name: 'valid_123', component: () => null });
        expect(factory).toEqual({ app_name: 'valid_123', initialize: expect.any(Function),
            appLifecycleSupport: 'app-lifecycle-v2', toolAuthoringProtocol: 'view-type-tools-v7' });
    });
});
