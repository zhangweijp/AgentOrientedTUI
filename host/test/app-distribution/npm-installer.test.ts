import { AppRegistry } from '@aotui/runtime';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fssync from 'fs';
import os from 'os';
import path from 'path';
import { installNpmPackage, removeInstalledApp } from '../../src/app-distribution/npm-installer.js';

describe('installNpmPackage', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentina-npm-install-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it.each(['managed', 'external', 'cache-root'])('removes only an owned App package in the %s case', async ownership => {
        const cacheRoot = path.join(tmpDir, 'npm');
        const installRoot = ownership === 'managed' ? path.join(cacheRoot, 'demo-app', 'latest')
            : ownership === 'external' ? path.join(tmpDir, 'external', 'latest') : cacheRoot;
        const installedPath = path.join(installRoot, 'node_modules', 'demo-app');
        await fs.mkdir(installedPath, { recursive: true });
        const configPath = path.join(tmpDir, 'registry.json');
        await fs.writeFile(configPath, JSON.stringify({ version: 2, apps: { demo: {
            source: 'local:' + installedPath, enabled: false,
            distribution: { type: 'npm', installRoot, installedPath },
        } } }));
        const registry = new AppRegistry({ configPath });
        await registry.loadFromConfig();

        await removeInstalledApp(registry, 'demo', cacheRoot);

        expect(fssync.existsSync(installRoot)).toBe(ownership !== 'managed');
        expect(registry.getConfig().apps).toEqual({});
    });

    it('installs package into cache and returns local source', async () => {
        const runner = vi.fn(async (_command: string, args: string[], cwd: string) => {
            const spec = args[args.length - 1];
            const packageName = spec.split('@')[0] || spec;
            const packagePath = path.join(cwd, 'node_modules', packageName);
            await fs.mkdir(packagePath, { recursive: true });
            await fs.writeFile(
                path.join(packagePath, 'package.json'),
                JSON.stringify({ name: packageName, version: '1.0.1' }),
                'utf-8'
            );
        });

        const result = await installNpmPackage('demo-app@1.0.0', {
            cacheRoot: tmpDir,
            commandRunner: runner
        });

        expect(runner).toHaveBeenCalledTimes(1);
        expect(result.packageName).toBe('demo-app');
        expect(result.packageSpec).toBe('demo-app@1.0.0');
        expect(result.resolvedVersion).toBe('1.0.1');
        expect(result.localSource).toBe(`local:${result.installedPath}`);
        expect(fssync.existsSync(result.installedPath)).toBe(true);
    });

    it('skips reinstall if package is already cached', async () => {
        const runner = vi.fn(async (_command: string, args: string[], cwd: string) => {
            const spec = args[args.length - 1];
            const packageName = spec.split('@')[0] || spec;
            const packagePath = path.join(cwd, 'node_modules', packageName);
            await fs.mkdir(packagePath, { recursive: true });
            await fs.writeFile(
                path.join(packagePath, 'package.json'),
                JSON.stringify({ name: packageName, version: '2.0.0' }),
                'utf-8'
            );
        });

        await installNpmPackage('cached-app', {
            cacheRoot: tmpDir,
            commandRunner: runner
        });
        await installNpmPackage('cached-app', {
            cacheRoot: tmpDir,
            commandRunner: runner
        });

        expect(runner).toHaveBeenCalledTimes(1);
    });

    it('reinstalls when forceReinstall is true', async () => {
        const runner = vi.fn(async (_command: string, args: string[], cwd: string) => {
            const spec = args[args.length - 1];
            const packageName = spec.split('@')[0] || spec;
            const packagePath = path.join(cwd, 'node_modules', packageName);
            await fs.mkdir(packagePath, { recursive: true });
            await fs.writeFile(
                path.join(packagePath, 'package.json'),
                JSON.stringify({ name: packageName, version: '3.0.0' }),
                'utf-8'
            );
        });

        await installNpmPackage('forced-app', {
            cacheRoot: tmpDir,
            commandRunner: runner
        });
        await installNpmPackage('forced-app', {
            cacheRoot: tmpDir,
            commandRunner: runner,
            forceReinstall: true
        });

        expect(runner).toHaveBeenCalledTimes(2);
    });
});
