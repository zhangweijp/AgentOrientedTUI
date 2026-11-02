/**
 * AppRegistry Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppRegistry } from './index.js';
import { isTUIAppFactory } from '../../spi/app/app-factory.interface.js';
import { SEMANTIC_INTERACTION_MODES } from '../../spi/runtime/app-interaction.interface.js';
import type { TUIAppFactory } from '../../spi/app/app-factory.interface.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock factory
function createMockFactory(name: string): TUIAppFactory {
    return {
        persistenceSupport: 'state-session-v1',
        appLifecycleSupport: 'app-lifecycle-v2',
        displayName: `${name} App`,
        kernelConfig: {
            appName: name,
            name,
            description: `${name} App`,
            component: {},
        },
        initializeComponent: vi.fn(async () => ({ render: vi.fn(), unmount: vi.fn() })),
    };
}

describe('AppRegistry', () => {
    let tempDir: string;
    let configPath: string;

    beforeEach(async () => {
        // 创建临时目录
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-test-'));
        configPath = path.join(tempDir, 'config.json');
    });

    afterEach(async () => {
        // 清理临时目录
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe('Configuration', () => {
        it('should create default config if not exists', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            const config = registry.getConfig();
            // [Option D] Default config version is now 2
            expect(config.version).toBe(2);
            expect(config.apps).toEqual({});
        });

        it('should load existing config', async () => {
            // 写入测试配置
            const testConfig = {
                version: 1,
                apps: {
                    'test-app': {
                        source: 'npm:@test/app',
                        enabled: false
                    }
                }
            };
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, JSON.stringify(testConfig));

            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            const config = registry.getConfig();
            expect(config.apps['test-app']).toBeDefined();
            expect(config.apps['test-app'].enabled).toBe(false);
        });
    });

    describe('App Management', () => {
        it('should list installed apps', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            expect(registry.list()).toHaveLength(0);
        });

        it('should check if app exists', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            expect(registry.has('non-existent')).toBe(false);
        });

        it('uses the non-empty appName from component Kernel metadata without format checks', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();
            const canonicalName = 'a'.repeat(51);

            const factoryWithoutManifestName = {
                persistenceSupport: 'state-session-v1',
                appLifecycleSupport: 'app-lifecycle-v2',
                kernelConfig: {
                    appName: canonicalName,
                    name: canonicalName,
                    component: {},
                },
                displayName: canonicalName,
                initializeComponent: vi.fn(async () => ({ render: vi.fn(), unmount: vi.fn() })),
            } as unknown as TUIAppFactory;

            // @ts-ignore
            registry.loadFactory = vi.fn().mockResolvedValue(factoryWithoutManifestName);

            const name = await registry.add('local:/tmp/cache/node_modules/@agentina/aotui-ide');
            expect(name).toBe(canonicalName);
            expect(registry.getConfig().apps[canonicalName]).toBeDefined();
        });

        it('rejects an empty appName from component Kernel metadata', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();
            registry.loadFactory = vi.fn().mockResolvedValue(createMockFactory(''));

            await expect(registry.add('local:/tmp/unnamed-app')).rejects.toMatchObject({
                code: 'CONFIG_INVALID',
            });
        });

        it('should delete managed npm install artifacts on remove', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            const installRoot = path.join(tempDir, '.agentina', 'apps', 'npm', 'scope-agentina__aotui-ide', 'latest');
            const installedPath = path.join(installRoot, 'node_modules', '@agentina', 'aotui-ide');
            await fs.mkdir(installedPath, { recursive: true });
            await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'agentina-app-cache', private: true }));

            // @ts-ignore
            registry['config'].apps['aotui-ide'] = {
                source: `local:${installedPath}`,
                enabled: true,
                originalSource: 'npm:@agentina/aotui-ide',
                distribution: {
                    type: 'npm',
                    packageName: '@agentina/aotui-ide',
                    installedPath,
                }
            };
            // @ts-ignore
            registry['apps'].set('aotui-ide', {
                name: 'aotui-ide',
                source: `local:${installedPath}`,
                factory: createMockFactory('aotui-ide'),
            });
            // @ts-ignore
            registry.getDefaultNpmCacheRoot = vi.fn().mockReturnValue(path.join(tempDir, '.agentina', 'apps', 'npm'));

            await registry.remove('aotui-ide');

            await expect(fs.stat(installRoot)).rejects.toThrow();
            expect(registry.getConfig().apps['aotui-ide']).toBeUndefined();
        });

        it('should not delete npm artifacts outside managed root on remove', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            const installRoot = path.join(tempDir, 'external-cache', 'latest');
            const installedPath = path.join(installRoot, 'node_modules', '@agentina', 'aotui-ide');
            await fs.mkdir(installedPath, { recursive: true });

            // @ts-ignore
            registry['config'].apps['aotui-ide'] = {
                source: `local:${installedPath}`,
                enabled: true,
                originalSource: 'npm:@agentina/aotui-ide',
                distribution: {
                    type: 'npm',
                    packageName: '@agentina/aotui-ide',
                    installRoot,
                    installedPath,
                }
            };
            // @ts-ignore
            registry['apps'].set('aotui-ide', {
                name: 'aotui-ide',
                source: `local:${installedPath}`,
                factory: createMockFactory('aotui-ide'),
            });
            // @ts-ignore
            registry.getDefaultNpmCacheRoot = vi.fn().mockReturnValue(path.join(tempDir, '.agentina', 'apps', 'npm'));

            await registry.remove('aotui-ide');

            expect(await fs.stat(installRoot)).toBeDefined();
        });
    });

    it('resolves aoapp.json entry.main relative to its app directory', async () => {
        const appDir = path.join(tempDir, 'manifest-app');
        await fs.mkdir(appDir);
        await fs.writeFile(path.join(appDir, 'aoapp.json'), JSON.stringify({ entry: { main: './dist/entry.mjs' } }));

        const registry = new AppRegistry({ configPath });
        expect(registry.resolveModulePath(`local:${appDir}`)).toBe(path.join(appDir, 'dist/entry.mjs'));
    });

    it('falls back to package.json main for local directories without aoapp.json', async () => {
        const appDir = path.join(tempDir, 'package-app');
        await fs.mkdir(appDir);
        await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ main: './lib/index.mjs' }));

        const registry = new AppRegistry({ configPath });
        expect(registry.resolveModulePath(`local:${appDir}`)).toBe(path.join(appDir, 'lib/index.mjs'));
    });

    it('prefers aoapp.json entry.main to package.json main', async () => {
        const appDir = path.join(tempDir, 'manifest-package-app');
        await fs.mkdir(appDir);
        await fs.writeFile(path.join(appDir, 'aoapp.json'), JSON.stringify({ entry: { main: './semantic/main.mjs' } }));
        await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ main: './package/main.mjs' }));

        const registry = new AppRegistry({ configPath });
        expect(registry.resolveModulePath(`local:${appDir}`)).toBe(path.join(appDir, 'semantic/main.mjs'));
    });

    describe('Component factory detection', () => {
        it('accepts only the component-factory contract, not retired manifest/create or callable factories', () => {
            const factory = createMockFactory('test');
            expect(isTUIAppFactory(factory)).toBe(true);
            expect(isTUIAppFactory({ manifest: { app_name: 'test' }, create: () => ({}) })).toBe(false);
            expect(isTUIAppFactory(() => ({}))).toBe(false);
            expect(isTUIAppFactory({ displayName: 'test', kernelConfig: { appName: 'test' } })).toBe(false);
            expect(isTUIAppFactory({ displayName: 'test', kernelConfig: {}, initializeComponent() {} })).toBe(false);
            expect(isTUIAppFactory({ displayName: '', kernelConfig: { appName: 'test' }, initializeComponent() {} })).toBe(false);
            const { persistenceSupport: _persistence, ...withoutPersistence } = factory;
            const { appLifecycleSupport: _lifecycle, ...withoutLifecycle } = factory;
            expect(isTUIAppFactory(withoutPersistence)).toBe(false);
            expect(isTUIAppFactory(withoutLifecycle)).toBe(false);
            expect(isTUIAppFactory({ ...factory, persistenceSupport: 'legacy' })).toBe(false);
            expect(isTUIAppFactory({ ...factory, appLifecycleSupport: 'legacy' })).toBe(false);
            const accessorMarker = { ...factory };
            Object.defineProperty(accessorMarker, 'appLifecycleSupport', { get: () => 'app-lifecycle-v2' });
            expect(isTUIAppFactory(accessorMarker)).toBe(false);
        });

        it('loads only the module default as the managed component factory', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();
            const defaultPath = path.join(tempDir, 'default-factory.mjs');
            await fs.writeFile(defaultPath, `export default { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'default_app', kernelConfig: { appName: 'default_app' }, initializeComponent() {} };`);
            await expect((registry as any).loadFactory(`local:${defaultPath}`)).resolves.toMatchObject({ displayName: 'default_app' });
        });

        it.each([
            ['named factory', `const f = { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'named_app', kernelConfig: { appName: 'named_app' }, initializeComponent() {} }; export const factory = f;`],
            ['other named factory', `const f = { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'named_app', kernelConfig: { appName: 'named_app' }, initializeComponent() {} }; export const componentFactory = f;`],
            ['factory nested under default', `export default { factory: { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'nested_app', kernelConfig: { appName: 'nested_app' }, initializeComponent() {} } };`],
            ['missing appName', `export default { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'nameless_app', kernelConfig: {}, initializeComponent() {} };`],
            ['missing persistence marker', `export default { appLifecycleSupport: 'app-lifecycle-v2', displayName: 'missing_persistence', kernelConfig: { appName: 'missing_persistence' }, initializeComponent() {} };`],
            ['wrong persistence marker', `export default { persistenceSupport: 'state-session-v0', appLifecycleSupport: 'app-lifecycle-v2', displayName: 'wrong_persistence', kernelConfig: { appName: 'wrong_persistence' }, initializeComponent() {} };`],
            ['missing lifecycle marker', `export default { persistenceSupport: 'state-session-v1', displayName: 'missing_lifecycle', kernelConfig: { appName: 'missing_lifecycle' }, initializeComponent() {} };`],
            ['wrong lifecycle marker', `export default { persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v1', displayName: 'wrong_lifecycle', kernelConfig: { appName: 'wrong_lifecycle' }, initializeComponent() {} };`],
        ])('rejects %s as a module default factory', async (_kind, source) => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();
            const modulePath = path.join(tempDir, 'invalid-factory.mjs');
            await fs.writeFile(modulePath, source);
            await expect((registry as any).loadFactory(`local:${modulePath}`)).rejects.toMatchObject({ code: 'APP_INVALID_EXPORT' });
        });
    });

    describe('Installation (AppRegistry)', () => {
        let registry: AppRegistry;
        let mockDesktop: any;

        beforeEach(async () => {
            // Create mock desktop
            mockDesktop = {
                id: 'dt_test',
                installDynamicWorkerApp: vi.fn().mockResolvedValue('app_worker'),
                registerPendingApp: vi.fn().mockResolvedValue('app_pending'),
                logSystem: vi.fn()
            };

            registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            // Mock resolveModulePath to avoid file system dependency
            // @ts-ignore
            registry.resolveModulePath = vi.fn().mockReturnValue('/mock/module/path');
        });

        it.each([true, false])('negotiates Semantic capabilities and preserves launch config for autoStart=%s', async autoStart => {
            registry['apps'].set('semantic-app', {
                name: 'semantic-app', source: 'local:/semantic', factory: createMockFactory('semantic-app'),
            });
            registry['config'].apps['semantic-app'] = { source: 'local:/semantic', enabled: true, autoStart };
            await registry.installAll(mockDesktop, {
                dynamicConfig: { projectPath: '/test/workspace', AOTUI_DATA_DIR: '/test/data' },
                interactionModes: SEMANTIC_INTERACTION_MODES,
            });
            const options = autoStart ? mockDesktop.installDynamicWorkerApp.mock.calls[0][1]
                : mockDesktop.registerPendingApp.mock.calls[0][0];
            expect(options.interactionModes).toEqual(SEMANTIC_INTERACTION_MODES);
            expect(options.config).toMatchObject({
                projectPath: '/test/workspace', AOTUI_DATA_DIR: '/test/data', AOTUI_APP_NAME: 'semantic-app',
            });
        });

        it('does not accept capability negotiation from app launch data and rejects invalid Host modes before installation', async () => {
            registry['apps'].set('semantic-app', {
                name: 'semantic-app', source: 'local:/semantic', factory: createMockFactory('semantic-app'),
            });
            await registry.installAll(mockDesktop, { dynamicConfig: { interactionModes: ['ordinary-v2'] } });
            expect(mockDesktop.installDynamicWorkerApp.mock.calls[0][1].interactionModes).toBeUndefined();
            mockDesktop.installDynamicWorkerApp.mockClear();
            await expect(registry.installAll(mockDesktop, { interactionModes: ['unsupported'] as any }))
                .rejects.toMatchObject({ code: 'INTERACTION_MODES_INVALID' });
            expect(mockDesktop.installDynamicWorkerApp).not.toHaveBeenCalled();
        });

        it('should install autoStart=true apps immediately', async () => {
            // Setup: Add app with autoStart=true
            // @ts-ignore
            registry['apps'].set('worker-app', {
                name: 'worker-app',
                source: 'local:/mock',
                factory: createMockFactory('worker-app'),
            });
            // config defaults to autoStart=true if not present, or we can explicit set it
            registry['config'].apps['worker-app'] = {
                source: 'local:/mock',
                enabled: true,
                autoStart: true,
                description: 'Worker App',
            };

            await registry.installAll(mockDesktop);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith('/mock/module/path', expect.objectContaining({
                name: 'worker-app',
                description: 'Worker App'
            }));
            expect(mockDesktop.registerPendingApp).not.toHaveBeenCalled();
        });

        it('should inject only canonical AOTUI_APP_NAME into launch config', async () => {
            registry['apps'].set('worker-app', {
                name: 'worker-app',
                source: 'local:/mock',
                factory: createMockFactory('worker-app'),
            });
            registry['config'].apps['worker-app'] = {
                source: 'local:/mock',
                enabled: true,
                autoStart: true
            };

            await registry.installAll(mockDesktop);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith(
                '/mock/module/path',
                expect.objectContaining({
                    config: expect.objectContaining({
                        AOTUI_APP_NAME: 'worker-app',
                    }),
                })
            );

            const installOptions = mockDesktop.installDynamicWorkerApp.mock.calls[0]?.[1];
            expect(installOptions?.config?.AOTUI_APP_KEY).toBeUndefined();
        });

        it('should register autoStart=false apps as pending', async () => {
            // Setup: Add app with autoStart=false
            // @ts-ignore
            registry['apps'].set('pending-app', {
                name: 'pending-app',
                source: 'local:/mock',
                factory: createMockFactory('pending-app'),
            });
            registry['config'].apps['pending-app'] = {
                source: 'local:/mock',
                enabled: true,
                autoStart: false,
                description: 'Pending App',
            };

            await registry.installAll(mockDesktop);

            expect(mockDesktop.registerPendingApp).toHaveBeenCalledWith(expect.objectContaining({
                name: 'pending-app',
                description: 'Pending App',
                modulePath: '/mock/module/path'
            }));
            expect(mockDesktop.installDynamicWorkerApp).not.toHaveBeenCalled();
        });

        it('should install only selected explicit entries without consulting config apps', async () => {
            const configDrivenFactory = createMockFactory('config-app');
            const explicitFactory = createMockFactory('explicit-app');

            registry['config'].apps['config-app'] = {
                source: 'local:/config-app',
                enabled: true,
                autoStart: true,
            };
            registry['entryConfigs'].set('config-app', { ...registry['config'].apps['config-app'] });
            registry['apps'].set('config-app', {
                name: 'config-app',
                source: 'local:/config-app',
                factory: configDrivenFactory,
            });

            registry['apps'].clear();
            registry['entryConfigs'].clear();
            registry['loadFactory'] = vi.fn().mockResolvedValue(explicitFactory);

            await registry.loadFromEntries([
                {
                    name: 'explicit-app',
                    source: 'local:/explicit-app',
                    enabled: true,
                    autoStart: true,
                }
            ]);

            expect(registry.has('config-app')).toBe(false);
            expect(registry.has('explicit-app')).toBe(true);

            await registry.installSelected(mockDesktop, ['explicit-app']);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledTimes(1);
            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith(
                '/mock/module/path',
                expect.objectContaining({
                    name: 'explicit-app'
                })
            );
        });

        it('should keep non-selected explicit entries out of installation', async () => {
            const alphaFactory = createMockFactory('alpha-app');
            const betaFactory = createMockFactory('beta-app');

            registry['loadFactory'] = vi.fn()
                .mockResolvedValueOnce(alphaFactory)
                .mockResolvedValueOnce(betaFactory);

            await registry.loadFromEntries([
                {
                    name: 'alpha-app',
                    source: 'local:/alpha-app',
                    enabled: true,
                    autoStart: true,
                },
                {
                    name: 'beta-app',
                    source: 'local:/beta-app',
                    enabled: true,
                    autoStart: true,
                }
            ]);

            await registry.installSelected(mockDesktop, ['beta-app']);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledTimes(1);
            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith(
                '/mock/module/path',
                expect.objectContaining({
                    name: 'beta-app'
                })
            );
        });
    });
});
