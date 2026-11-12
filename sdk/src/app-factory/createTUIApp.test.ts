import { describe, expect, it, vi } from 'vitest';
import { createTUIApp } from './createTUIApp.js';

describe('createTUIApp', () => {
    it('forwards canonical app_name into kernelConfig.appName', () => {
        function RootComponent() {
            return null;
        }

        const onReinitialize = vi.fn();
        const factory = createTUIApp({
            app_name: 'test_app',
            component: RootComponent,
            onReinitialize,
        } as any);

        expect(factory.kernelConfig.appName).toBe('test_app');
        expect(factory.kernelConfig.onReinitialize).toBe(onReinitialize);
    });

    it('captures metadata once without executing accessors or retaining mutable author metadata', () => {
        let reads = 0;
        expect(() => createTUIApp({ get app_name() { reads++; return 'test_app'; }, component: () => null }))
            .toThrow(expect.objectContaining({ code: 'APP_METADATA_INVALID', path: 'app_name' }));
        expect(reads).toBe(0);
        const input = { app_name: 'test_app', whatItIs: 'Before', component: () => null };
        const factory = createTUIApp(input);input.app_name = 'other';input.whatItIs = 'After';
        expect(factory.displayName).toBe('test_app');
        expect(factory.kernelConfig).toMatchObject({ appName: 'test_app', name: 'test_app', whatItIs: 'Before' });
    });

    it('does not require a separate display name', () => {
        function RootComponent() {
            return null;
        }

        expect(() =>
            createTUIApp({
                app_name: 'system_ide',
                component: RootComponent,
            } as any)
        ).not.toThrow();
    });

    it('advertises the managed lifecycle contract without requiring app cleanup callbacks', () => {
        const factory = createTUIApp({ app_name: 'test_app', component: () => null });
        expect(factory.appLifecycleSupport).toBe('app-lifecycle-v2');
        expect(Object.getOwnPropertyDescriptor(factory, 'toolAuthoringProtocol')?.value).toBe('view-type-tools-v4');
        expect(factory.kernelConfig.onDelete).toBeUndefined();
        expect(factory.kernelConfig.onReinitialize).toBeUndefined();
    });

    it.each([undefined, { protocol: 'app-lifecycle-v1' }])('refuses an unsupported cleanup port before rendering the Root', async appLifecycle => {
        const component = vi.fn(() => null);
        const factory = createTUIApp({ app_name: 'test_app', component });
        await expect(factory.initialize({ appId: 'app', desktopId: 'desktop', appLifecycle } as any))
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
        expect(() => createTUIApp({ ...value, component: () => null } as any)).toThrow(/app_name.*string/);
    });
    it('does not coerce an object name and returns only the component factory contract', () => {
        const coercion = vi.fn(() => 'valid');
        expect(() => createTUIApp({ app_name: { toString: coercion }, component: () => null } as any)).toThrow(/app_name.*string/);
        expect(coercion).not.toHaveBeenCalled();
        const factory = createTUIApp({ app_name: 'valid_123', whatItIs: 'What', whenToUse: 'When', component: () => null });
        expect(factory.displayName).toBe('valid_123');expect(factory.kernelConfig).toMatchObject({ appName: 'valid_123', name: 'valid_123', whatItIs: 'What', whenToUse: 'When' });
        expect(typeof factory.initialize).toBe('function');
        expect(Object.hasOwn(factory, 'create')).toBe(false);
        expect(Object.hasOwn(factory, 'TUI_FACTORY')).toBe(false);
        expect(typeof factory).toBe('object');
    });
});
