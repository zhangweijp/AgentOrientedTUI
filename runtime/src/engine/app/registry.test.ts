/**
 * AppRegistry Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppRegistry } from './registry.js';
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
        displayName: name,
        toolAuthoringProtocol: 'view-type-tools-v4',
        kernelConfig: {
            appName: name,
            name,
            description: `${name} App`,
            component: {},
        },
        initialize: vi.fn(async () => ({ close: vi.fn() })),
    };
}

describe('AppRegistry', () => {
    let tempDir: string;
    let configPath: string;

    async function writeApp(name: string, directory = name, patch: Record<string, unknown> = {}) {
        const appDir = path.join(tempDir, directory);
        await fs.mkdir(path.join(appDir, 'dist'), { recursive: true });
        await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ type: 'module' }));
        await fs.writeFile(path.join(appDir, 'dist/index.mjs'), 'throw new Error("REGISTRY_MUST_NOT_IMPORT_APP");');
        await fs.writeFile(path.join(appDir, 'aoapp.json'), JSON.stringify({ app_name: name, version: '1.0.0',
            description: `${name} App`, whatItIs: 'Static metadata', whenToUse: 'Unit fixture',
            toolAuthoringProtocol: 'view-type-tools-v4', persistenceSupport: 'state-session-v1', appLifecycleSupport: 'app-lifecycle-v2',
            entry: { main: './dist/index.mjs' }, ...patch }));
        return appDir;
    }
    const loaded = (name: string, description = `${name} App`) => ({
        name, source: 'local:/mock', modulePath: '/mock/module/path', metadata: { app_name: name, description },
    });

    beforeEach(async () => {
        // 创建临时目录
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-test-'));
        configPath = path.join(tempDir, 'config.json');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
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

        it('rejects an invalid shared Worker script before changing discovery', async () => {
            const registry = new AppRegistry({ configPath });
            const directory = await writeApp('healthy');
            await registry.registerTransient('local:' + directory);
            await fs.writeFile(configPath, JSON.stringify({ version: 2, runtime: { workerScript: 42 },
                apps: { healthy: { source: 'local:' + directory, enabled: true } } }));
            await expect(registry.loadFromConfig()).rejects.toMatchObject({ code: 'CONFIG_INVALID',
                context: { path: 'runtime.workerScript' } });
            expect(registry.get('healthy')?.modulePath).toBe(path.join(directory, 'dist/index.mjs'));
        });

        it('should load existing config', async () => {
            // 写入测试配置
            const testConfig = {
                version: 1,
                apps: {
                    'test_app': {
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
            expect(config.apps['test_app']).toBeDefined();
            expect(config.apps['test_app'].enabled).toBe(false);
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

            expect(registry.get('non-existent')).toBeUndefined();
        });

        it('reads generated metadata without executing the App or imposing an arbitrary name-length allocation', async () => {
            const registry = new AppRegistry({ configPath });
            const canonicalName = 'a'.repeat(51), appDir = await writeApp(canonicalName);
            expect(await registry.add(`local:${appDir}`)).toBe(canonicalName);
            expect(registry.get(canonicalName)).toMatchObject({ metadata: { app_name: canonicalName } });
            expect(registry.get(canonicalName)).not.toHaveProperty('factory');
        });

        it('rejects empty metadata names before changing registration', async () => {
            const registry = new AppRegistry({ configPath }), appDir = await writeApp('', 'unnamed');
            await expect(registry.add(`local:${appDir}`)).rejects.toMatchObject({ code: 'APP_MANIFEST_INVALID' });
            expect(registry.list()).toEqual([]);
        });

        it('reports duplicate canonical names instead of inventing a registration alias', async () => {
            const registry = new AppRegistry({ configPath });
            const first = await writeApp('duplicate', 'first'), second = await writeApp('duplicate', 'second');
            await registry.add(`local:${first}`);
            await expect(registry.add(`local:${second}`)).rejects.toMatchObject({ code: 'APP_ALREADY_REGISTERED', context: { appName: 'duplicate' } });
            await expect(registry.registerTransient(`local:${second}`)).rejects.toMatchObject({ code: 'APP_ALREADY_REGISTERED' });
            expect(registry.get('duplicate')?.modulePath).toBe(path.join(first, 'dist/index.mjs'));
        });

        it('reports duplicate and missing batch entries without discarding a loaded App', async () => {
            const registry = new AppRegistry({ configPath }), appDir = await writeApp('canonical');
            const healthy = { name: 'canonical', source: 'local:' + appDir, enabled: true };
            const entries = [healthy, { ...healthy, source: 'local:' + path.join(tempDir, 'missing') }];
            entries.length = 3;
            const results = await registry.loadFromEntries(entries);
            expect(Object.keys(results)).toEqual(['0', '1', '2']);
            expect(results).toMatchObject([
                { name: 'canonical', status: 'loaded' },
                { name: 'canonical', status: 'failed', issue: { code: 'APP_ALREADY_REGISTERED', path: 'apps[1].name' } },
                { name: 'apps[2]', status: 'failed', issue: { code: 'CONFIG_INVALID', path: 'apps[2].name' } },
            ]);
            expect(registry.get('canonical')?.modulePath).toBe(path.join(appDir, 'dist/index.mjs'));
        });

        it('rejects registry identity and metadata overrides per App while loading healthy entries', async () => {
            const registry = new AppRegistry({ configPath }), appDir = await writeApp('canonical'), healthy = await writeApp('healthy');
            const missing = path.join(tempDir, 'missing');
            expect(await registry.loadFromEntries([
                { name: 'wrong', source: `local:${appDir}`, enabled: true },
                { name: 'healthy', source: `local:${healthy}`, enabled: true },
                { name: 'missing', source: `local:${missing}`, enabled: true },
            ])).toMatchObject([
                { name: 'wrong', status: 'failed', phase: 'discovery', issue: { code: 'APP_IDENTITY_MISMATCH' } },
                { name: 'healthy', status: 'loaded' },
                { name: 'missing', status: 'failed', phase: 'discovery', issue: { code: 'APP_MANIFEST_INVALID', path: missing } },
            ]);
            expect(registry.get('wrong')).toBeUndefined();expect(registry.get('healthy')).toBeDefined();
            expect(await registry.loadFromEntries([{ name: 'canonical', source: `local:${appDir}`, enabled: true, description: 'second source' } as never]))
                .toMatchObject([{ name: 'canonical', status: 'failed', issue: { code: 'CONFIG_INVALID' } }]);
            expect(registry.get('canonical')).toBeUndefined();
        });

        it('should delete managed npm install artifacts on remove', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            const installRoot = path.join(tempDir, '.agentina', 'apps', 'npm', 'scope-agentina__aotui-ide', 'latest');
            const installedPath = path.join(installRoot, 'node_modules', '@agentina', 'aotui_ide');
            await fs.mkdir(installedPath, { recursive: true });
            await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'agentina-app-cache', private: true }));

            // @ts-ignore
            registry['config'].apps['aotui_ide'] = {
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
            registry['apps'].set('aotui_ide', {
                name: 'aotui_ide',
                source: `local:${installedPath}`,
                modulePath: '/mock/module/path', metadata: { app_name: 'aotui_ide', description: 'aotui_ide App' },
            });
            // @ts-ignore
            registry.getDefaultNpmCacheRoot = vi.fn().mockReturnValue(path.join(tempDir, '.agentina', 'apps', 'npm'));

            await registry.remove('aotui_ide');

            await expect(fs.stat(installRoot)).rejects.toThrow();
            expect(registry.getConfig().apps['aotui_ide']).toBeUndefined();
        });

        it('should not delete npm artifacts outside managed root on remove', async () => {
            const registry = new AppRegistry({ configPath });
            await registry.loadFromConfig();

            const installRoot = path.join(tempDir, 'external-cache', 'latest');
            const installedPath = path.join(installRoot, 'node_modules', '@agentina', 'aotui_ide');
            await fs.mkdir(installedPath, { recursive: true });

            // @ts-ignore
            registry['config'].apps['aotui_ide'] = {
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
            registry['apps'].set('aotui_ide', {
                name: 'aotui_ide',
                source: `local:${installedPath}`,
                modulePath: '/mock/module/path', metadata: { app_name: 'aotui_ide', description: 'aotui_ide App' },
            });
            // @ts-ignore
            registry.getDefaultNpmCacheRoot = vi.fn().mockReturnValue(path.join(tempDir, '.agentina', 'apps', 'npm'));

            await registry.remove('aotui_ide');

            expect(await fs.stat(installRoot)).toBeDefined();
        });
    });

    it('resolves the generated entry relative to its package, for both directory and explicit entry sources', async () => {
        const appDir = await writeApp('manifest_app'), registry = new AppRegistry({ configPath });
        const entry = path.join(appDir, 'dist/index.mjs');
        expect(registry.resolveModulePath(`local:${appDir}`)).toBe(entry);
        expect(registry.resolveModulePath(`local:${entry}`)).toBe(entry);
    });

    it('rejects a missing explicit local source without substituting the package entry or registering an App', async () => {
        const appDir = await writeApp('manifest_app'), registry = new AppRegistry({ configPath });
        const missing = path.join(appDir, 'missing.mjs');
        expect(() => registry.resolveModulePath(`local:${missing}`)).toThrow(expect.objectContaining({
            code: 'APP_MANIFEST_INVALID', context: expect.objectContaining({ path: missing }),
        }));
        await expect(registry.add(`local:${missing}`)).rejects.toMatchObject({ code: 'APP_MANIFEST_INVALID' });
        expect(registry.list()).toEqual([]);
        expect(registry.getConfig().apps).toEqual({});
    });

    it('requires generated metadata instead of importing a package.json fallback to discover names', async () => {
        const appDir = path.join(tempDir, 'package-app');await fs.mkdir(appDir);
        await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ main: './index.mjs' }));
        const registry = new AppRegistry({ configPath });
        expect(() => registry.resolveModulePath(`local:${appDir}`)).toThrow(expect.objectContaining({ code: 'APP_MANIFEST_INVALID' }));
    });

    it('uses the generated entry and rejects a different explicit module under the same manifest', async () => {
        const appDir = await writeApp('manifest_app'), other = path.join(appDir, 'other.mjs');
        await fs.writeFile(other, 'throw Error("must not import")');
        const registry = new AppRegistry({ configPath });
        expect(() => registry.resolveModulePath(`local:${other}`)).toThrow(expect.objectContaining({ code: 'APP_IDENTITY_MISMATCH' }));
    });

    describe('Component factory detection', () => {
        it('accepts only the component-factory contract, not retired manifest/create or callable factories', () => {
            const factory = createMockFactory('test');
            expect(isTUIAppFactory(factory)).toBe(true);
            expect(isTUIAppFactory({ manifest: { app_name: 'test' }, create: () => ({}) })).toBe(false);
            expect(isTUIAppFactory(() => ({}))).toBe(false);
            expect(isTUIAppFactory({ displayName: 'test', kernelConfig: { appName: 'test' } })).toBe(false);
            expect(isTUIAppFactory({ displayName: 'test', kernelConfig: {}, initialize() {} })).toBe(false);
            expect(isTUIAppFactory({ displayName: '', kernelConfig: { appName: 'test' }, initialize() {} })).toBe(false);
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
            registry['apps'].set('semantic_app', {
                name: 'semantic_app', source: 'local:/semantic', modulePath: '/mock/module/path', metadata: { app_name: 'semantic_app', description: 'semantic_app App' },
            });
            registry['config'].apps['semantic_app'] = { source: 'local:/semantic', enabled: true, autoStart };
            await registry.installAll(mockDesktop, {
                dynamicConfig: { projectPath: '/test/workspace', AOTUI_DATA_DIR: '/test/data' },
                interactionModes: SEMANTIC_INTERACTION_MODES,
            });
            const options = autoStart ? mockDesktop.installDynamicWorkerApp.mock.calls[0][1]
                : mockDesktop.registerPendingApp.mock.calls[0][0];
            expect(options.interactionModes).toEqual(SEMANTIC_INTERACTION_MODES);
            expect(options.config).toMatchObject({
                projectPath: '/test/workspace', AOTUI_DATA_DIR: '/test/data', AOTUI_APP_KEY: 'semantic_app',
            });
        });

        it('does not accept capability negotiation from app launch data and rejects invalid Host modes before installation', async () => {
            registry['apps'].set('semantic_app', {
                name: 'semantic_app', source: 'local:/semantic', modulePath: '/mock/module/path', metadata: { app_name: 'semantic_app', description: 'semantic_app App' },
            });
            await registry.installAll(mockDesktop, { dynamicConfig: { interactionModes: ['view-type-parameters-v1'] } });
            expect(mockDesktop.installDynamicWorkerApp.mock.calls[0][1].interactionModes).toBeUndefined();
            mockDesktop.installDynamicWorkerApp.mockClear();
            await expect(registry.installAll(mockDesktop, { interactionModes: ['unsupported'] as any }))
                .rejects.toMatchObject({ code: 'INTERACTION_MODES_INVALID' });
            expect(mockDesktop.installDynamicWorkerApp).not.toHaveBeenCalled();
        });

        it('rejects the retired state namespace key before installing an App', async () => {
            registry['apps'].set('worker_app', loaded('worker_app'));
            await expect(registry.installAll(mockDesktop, { dynamicConfig: { AOTUI_APP_NAME: 'old_key' } }))
                .rejects.toMatchObject({ code: 'CONFIG_INVALID' });
            expect(mockDesktop.installDynamicWorkerApp).not.toHaveBeenCalled();
            await registry.installAll(mockDesktop, { dynamicConfig: { AOTUI_APP_KEY: 'separate_state' } });
            expect(mockDesktop.installDynamicWorkerApp.mock.calls[0][1].config.AOTUI_APP_KEY).toBe('separate_state');
        });

        it('should install autoStart=true apps immediately', async () => {
            // Setup: Add app with autoStart=true
            // @ts-ignore
            registry['apps'].set('worker_app', {
                name: 'worker_app',
                source: 'local:/mock',
                modulePath: '/mock/module/path', metadata: { app_name: 'worker_app', description: 'Worker App' },
            });
            // config defaults to autoStart=true if not present, or we can explicit set it
            registry['config'].apps['worker_app'] = {
                source: 'local:/mock',
                enabled: true,
                autoStart: true,
            };

            await registry.installAll(mockDesktop);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith('/mock/module/path', expect.objectContaining({
                name: 'worker_app',
                description: 'Worker App'
            }));
            expect(mockDesktop.registerPendingApp).not.toHaveBeenCalled();
        });

        it('should inject only canonical AOTUI_APP_KEY into launch config', async () => {
            registry['apps'].set('worker_app', {
                name: 'worker_app',
                source: 'local:/mock',
                modulePath: '/mock/module/path', metadata: { app_name: 'worker_app', description: 'Worker App' },
            });
            registry['config'].apps['worker_app'] = {
                source: 'local:/mock',
                enabled: true,
                autoStart: true
            };

            await registry.installAll(mockDesktop);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith(
                '/mock/module/path',
                expect.objectContaining({
                    config: expect.objectContaining({
                        AOTUI_APP_KEY: 'worker_app',
                    }),
                })
            );

            const installOptions = mockDesktop.installDynamicWorkerApp.mock.calls[0]?.[1];
            expect(installOptions?.config?.AOTUI_APP_NAME).toBeUndefined();
        });

        it('should register autoStart=false apps as pending', async () => {
            // Setup: Add app with autoStart=false
            // @ts-ignore
            registry['apps'].set('pending_app', {
                name: 'pending_app',
                source: 'local:/mock',
                modulePath: '/mock/module/path', metadata: { app_name: 'pending_app', description: 'Pending App' },
            });
            registry['config'].apps['pending_app'] = {
                source: 'local:/mock',
                enabled: true,
                autoStart: false,
            };

            await registry.installAll(mockDesktop);

            expect(mockDesktop.registerPendingApp).toHaveBeenCalledWith(expect.objectContaining({
                name: 'pending_app',
                modulePath: '/mock/module/path'
            }));
            expect(mockDesktop.installDynamicWorkerApp).not.toHaveBeenCalled();
        });

        it('should install only selected explicit entries without consulting config apps', async () => {
            const explicit = await writeApp('explicit_app');

            registry['config'].apps['config_app'] = {
                source: 'local:/config-app',
                enabled: true,
                autoStart: true,
            };
            registry['entryConfigs'].set('config_app', { ...registry['config'].apps['config_app'] });
            registry['apps'].set('config_app', {
                name: 'config_app',
                source: 'local:/config-app',
                modulePath: '/mock/module/path', metadata: { app_name: 'config_app' },
            });

            registry['apps'].clear();
            registry['entryConfigs'].clear();

            await registry.loadFromEntries([
                {
                    name: 'explicit_app',
                    source: `local:${explicit}`,
                    enabled: true,
                    autoStart: true,
                }
            ]);

            expect(registry.get('config_app')).toBeUndefined();
            expect(registry.get('explicit_app')).toBeDefined();

            await registry.installSelected(mockDesktop, ['explicit_app']);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledTimes(1);
            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith(
                path.join(explicit, 'dist/index.mjs'),
                expect.objectContaining({
                    name: 'explicit_app'
                })
            );
        });

        it('should keep non-selected explicit entries out of installation', async () => {
            const alpha = await writeApp('alpha_app'), beta = await writeApp('beta_app');

            await registry.loadFromEntries([
                {
                    name: 'alpha_app',
                    source: `local:${alpha}`,
                    enabled: true,
                    autoStart: true,
                },
                {
                    name: 'beta_app',
                    source: `local:${beta}`,
                    enabled: true,
                    autoStart: true,
                }
            ]);

            await registry.installSelected(mockDesktop, ['beta_app']);

            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledTimes(1);
            expect(mockDesktop.installDynamicWorkerApp).toHaveBeenCalledWith(
                path.join(beta, 'dist/index.mjs'),
                expect.objectContaining({
                    name: 'beta_app'
                })
            );
        });
    });
});
