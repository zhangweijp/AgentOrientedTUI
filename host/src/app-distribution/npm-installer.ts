import path from 'path';
import os from 'os';
import fs from 'fs';
import fsp from 'fs/promises';
import { execFile as nodeExecFile } from 'child_process';
import { promisify } from 'util';
import { parseNpmSpecifier } from './sources.js';

const execFile = promisify(nodeExecFile);

export interface NpmInstallOptions {
    cacheRoot?: string;
    npmBinary?: string;
    commandRunner?: (command: string, args: string[], cwd: string) => Promise<void>;
}

export interface NpmInstallResult {
    packageName: string;
    packageSpec: string;
    requestedVersion: string | null;
    resolvedVersion: string | null;
    installRoot: string;
    installedPath: string;
    localSource: string;
}

export async function installNpmPackage(packageInput: string, options?: NpmInstallOptions): Promise<NpmInstallResult> {
    const parsed = parseNpmSpecifier(packageInput);
    const cacheRoot = options?.cacheRoot ?? getDefaultAppCacheRoot();
    const npmBinary = options?.npmBinary ?? 'npm';
    const requestedVersion = parsed.version;
    await fsp.mkdir(cacheRoot, { recursive: true });
    // npm may replace packages in its working directory. Only this attempt owns this workspace.
    const installRoot = await fsp.mkdtemp(path.join(cacheRoot, 'install-'));
    try {
        await fsp.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'agentina-app-cache', private: true }));
        await runInstallCommand(
            npmBinary,
            ['install', '--no-save', '--omit=dev', '--ignore-scripts', parsed.packageSpec],
            installRoot,
            options?.commandRunner
        );
        const installedPath = path.join(installRoot, 'node_modules', parsed.packageName);
        if (!fs.existsSync(installedPath)) {
            throw new Error(`Package install succeeded but app path was not found: ${installedPath}`);
        }
        return {
            packageName: parsed.packageName, packageSpec: parsed.packageSpec, requestedVersion,
            resolvedVersion: await readPackageVersion(installedPath), installRoot, installedPath,
            localSource: `local:${installedPath}`,
        };
    } catch (error) {
        await removeNpmCache(installRoot, cacheRoot).catch(cause => console.warn(`Could not remove failed npm workspace ${installRoot}`, cause));
        throw error;
    }
}

function getDefaultAppCacheRoot(): string {
    return path.join(os.homedir(), '.agentina', 'apps', 'npm');
}

/** Remove only a cache workspace owned by this product. */
export async function removeNpmCache(installRoot: string, cacheRoot = getDefaultAppCacheRoot()): Promise<void> {
    if (typeof installRoot !== 'string' || !installRoot.trim()) return;
    const managed = await fsp.realpath(cacheRoot).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    });
    const relative = path.relative(path.resolve(cacheRoot), path.resolve(installRoot));
    if (!managed || !relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    const installed = await fsp.realpath(installRoot).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
    });
    if (!installed || installed !== path.join(managed, relative)) return;
    await fsp.rm(installed, { recursive: true, force: true });
    for (let parent = path.dirname(installed); parent.startsWith(managed + path.sep); parent = path.dirname(parent)) {
        try { await fsp.rmdir(parent); }
        catch { break; }
    }
}

async function runInstallCommand(
    command: string,
    args: string[],
    cwd: string,
    commandRunner?: (command: string, args: string[], cwd: string) => Promise<void>
): Promise<void> {
    if (commandRunner) {
        await commandRunner(command, args, cwd);
        return;
    }

    try {
        await execFile(command, args, { cwd });
    } catch (error: any) {
        const stderr = error?.stderr ? String(error.stderr).trim() : '';
        const reason = stderr ? `: ${stderr}` : '';
        throw new Error(`Failed to install npm package with "${command} ${args.join(' ')}"${reason}`);
    }
}

async function readPackageVersion(installedPath: string): Promise<string | null> {
    const packageJsonPath = path.join(installedPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
        return null;
    }
    try {
        const raw = await fsp.readFile(packageJsonPath, 'utf-8');
        const json = JSON.parse(raw) as { version?: unknown };
        return typeof json.version === 'string' ? json.version : null;
    } catch {
        return null;
    }
}
