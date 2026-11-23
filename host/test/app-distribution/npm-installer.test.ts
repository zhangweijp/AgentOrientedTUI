import { AppCatalog } from '../../src/app-distribution/app-catalog.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import fssync from 'fs';
import os from 'os';
import path from 'path';
import { installNpmPackage } from '../../src/app-distribution/npm-installer.js';

describe('installNpmPackage', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentina-npm-install-'));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it.each(['managed', 'external', 'cache-root', 'redirected'])('removes only an owned App package in the %s case', async ownership => {
        vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
        const cacheRoot = path.join(tmpDir, '.agentina', 'apps', 'npm');
        const installRoot = ownership === 'managed' || ownership === 'redirected' ? path.join(cacheRoot, 'demo-app', 'latest')
            : ownership === 'external' ? path.join(tmpDir, 'external', 'latest') : cacheRoot;
        const installedPath = path.join(installRoot, 'node_modules', 'demo-app');
        if (ownership === 'redirected') {
            const external = path.join(tmpDir, 'redirected');
            await fs.mkdir(external);
            await fs.mkdir(path.dirname(installRoot), { recursive: true });
            await fs.symlink(external, installRoot, 'dir');
        }
        await fs.mkdir(installedPath, { recursive: true });
        const configPath = path.join(tmpDir, 'registry.json');
        await fs.writeFile(configPath, JSON.stringify({ version: 2, apps: { demo: {
            source: 'local:' + installedPath, enabled: false,
            distribution: { type: 'npm', installRoot, installedPath },
        } } }));
        const catalog = new AppCatalog({ configPath });
        await catalog.remove('demo');

        expect(fssync.existsSync(installRoot)).toBe(ownership !== 'managed');
        expect((await catalog.getConfig()).apps).toEqual({});
    });

    it('waits for the catalog commit and retains an npm workspace still referenced by another installation', async () => {
        vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
        const installRoot = path.join(tmpDir, '.agentina/apps/npm/demo/1.0.0');
        const installedPath = path.join(installRoot, 'node_modules', 'demo');
        await fs.mkdir(installedPath, { recursive: true });
        const configPath = path.join(tmpDir, 'config.json');
        const entry = { source: 'local:' + installedPath, enabled: true, distribution: { type: 'npm', installRoot } };
        const original = JSON.stringify({ version: 2, apps: { demo: entry, alias: entry } });
        await fs.writeFile(configPath, original);
        const catalog = new AppCatalog({ configPath });

        const failWrite = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(Error('disk write refused'), { code: 'EACCES' }));
        await expect(catalog.remove('demo')).rejects.toMatchObject({ code: 'CONFIG_WRITE_FAILED', path: await fs.realpath(configPath) });
        failWrite.mockRestore();
        expect(await fs.readFile(configPath, 'utf8')).toBe(original);
        expect(fssync.existsSync(installRoot)).toBe(true);

        await catalog.remove('demo');
        expect(fssync.existsSync(installRoot)).toBe(true);
        expect((await catalog.getConfig()).apps).toEqual({ alias: entry });
        await catalog.remove('alias');
        await expect(fs.stat(installRoot)).rejects.toHaveProperty('code', 'ENOENT');
    });

    it('also retains a workspace used as another installation\'s local path', async () => {
        vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
        const installRoot = path.join(tmpDir, '.agentina/apps/npm/install-first');
        const directory = path.join(installRoot, 'node_modules', 'demo');
        await fs.mkdir(directory, { recursive: true });
        const configPath = path.join(tmpDir, 'config.json');
        const local = { source: 'local:' + directory, enabled: true };
        await fs.writeFile(configPath, JSON.stringify({ apps: {
            demo: { ...local, distribution: { type: 'npm', installRoot } }, alias: local,
        } }));

        await new AppCatalog({ configPath }).remove('demo');

        expect(fssync.existsSync(directory)).toBe(true);
        expect((await new AppCatalog({ configPath }).getConfig()).apps).toEqual({ alias: local });
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

    it('downloads the same spec into separate workspaces and leaves the first edition intact', async () => {
        let version = '1.0.0';
        const runner = vi.fn(async (_command: string, _args: string[], cwd: string) => {
            const packagePath = path.join(cwd, 'node_modules', 'cached-app');
            await fs.mkdir(packagePath, { recursive: true });
            await fs.writeFile(path.join(packagePath, 'package.json'), JSON.stringify({ name: 'cached-app', version }));
        });
        const options = { cacheRoot: tmpDir, commandRunner: runner };
        const first = await installNpmPackage('cached-app@latest', options);
        version = '1.2.0';
        const next = await installNpmPackage('cached-app@latest', options);
        expect(runner).toHaveBeenCalledTimes(2);
        expect(next.installRoot).not.toBe(first.installRoot);
        expect(next.resolvedVersion).toBe('1.2.0');
        expect(JSON.parse(await fs.readFile(path.join(first.installedPath, 'package.json'), 'utf8')).version).toBe('1.0.0');
    });

    it('removes the new workspace if npm fails after writing files', async () => {
        const failure = Error('registry unavailable');
        await expect(installNpmPackage('failed-app', { cacheRoot: tmpDir, async commandRunner(_command, _args, cwd) {
            await fs.writeFile(path.join(cwd, 'partial'), 'incomplete');
            throw failure;
        } })).rejects.toBe(failure);
        expect(await fs.readdir(tmpDir)).toEqual([]);
    });
});
