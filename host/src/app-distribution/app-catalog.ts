import os from 'node:os';
import path from 'node:path';
import { AOTUIError, readAppManifest, type AppID, type AppLaunchConfig, type IDesktop } from '@aotui/runtime';
import { Config } from '../config/config.js';
import { installNpmPackage, removeNpmCache } from './npm-installer.js';
import { parseInstallSource } from './sources.js';

export interface AppConfigEntry {
    source: string;
    enabled: boolean;
    autoStart?: boolean;
    installedAt?: string;
    originalSource?: string;
    distribution?: {
        type: 'local' | 'npm';
        packageName?: string;
        requested?: string;
        resolvedVersion?: string;
        installRoot?: string;
        installedPath?: string;
        installedAt?: string;
        [key: string]: unknown;
    };
}

export interface AppCatalogEntry extends AppConfigEntry {
    name: string;
}

export interface InstallAppOptions {
    force?: boolean;
    autoStart?: boolean;
    enabled?: boolean;
}

export interface InstallAppResult {
    name: string;
    source: string;
    originalSource: string;
    distributionType: 'local' | 'npm';
}

type AppSelection = {
    entries?: readonly AppCatalogEntry[];
    name?: string;
};

type AppInstallOptions = Pick<Parameters<IDesktop['registerPendingApp']>[0], 'toolsEnabled' | 'projectionLimits'> & AppSelection & {
    dynamicConfig?: AppLaunchConfig;
    startAll?: boolean;
};

export interface AppCatalogFailure {
    readonly name: string;
    readonly status: 'failed';
    readonly phase: 'discovery' | 'install' | 'register';
    readonly issue: { readonly code: string; readonly message: string; readonly path?: string };
    readonly installationId?: string;
    readonly appId?: AppID;
}

export type AppDiscoveryResult =
    | Readonly<{ name: string; entry: AppConfigEntry; status: 'loaded' | 'disabled' }>
    | AppCatalogFailure;
export type AppInstallResult = Readonly<{ name: string; installationId: string } & (
    { status: 'installed'; appId: AppID } | { status: 'registered' }
)> | AppCatalogFailure;

const distributionFields = ['packageName', 'requested', 'resolvedVersion', 'installRoot', 'installedPath', 'installedAt'];

function readEntry(name: string, value: unknown): AppConfigEntry {
    const invalid = (field: string, reason: string) =>
        new AOTUIError('CONFIG_INVALID', { path: 'apps.' + name + field, reason });
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalid('', 'Provide an App configuration object');
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.source !== 'string' || !entry.source.trim() || typeof entry.enabled !== 'boolean') {
        throw invalid('', 'Provide a nonempty source and a boolean enabled for this App');
    }
    if (entry.autoStart !== undefined && typeof entry.autoStart !== 'boolean') {
        throw invalid('.autoStart', 'Expected a boolean');
    }
    for (const field of ['installedAt', 'originalSource']) {
        if (entry[field] !== undefined && typeof entry[field] !== 'string') {
            throw invalid('.' + field, 'Expected a string');
        }
    }
    if (entry.distribution !== undefined) {
        const dist = entry.distribution as Record<string, unknown> | null;
        if (!dist || typeof dist !== 'object' || Array.isArray(dist)
            || (dist.type !== 'local' && dist.type !== 'npm')) {
            throw invalid('.distribution', 'Provide a local or npm distribution object');
        }
        for (const field of distributionFields) {
            if (dist[field] !== undefined && typeof dist[field] !== 'string') {
                throw invalid('.distribution.' + field, 'Expected a string');
            }
        }
    }
    return value as AppConfigEntry;
}

function localAppPath(source: string): string {
    if (!source.startsWith('local:') || !source.slice(6).trim()) {
        throw new AOTUIError('CONFIG_NOT_SUPPORTED', { feature: 'Configured sources must resolve to a local installed package' });
    }
    return path.resolve(source.slice(6));
}

function failedApp(name: string, phase: AppCatalogFailure['phase'], error: unknown, fallbackPath?: string): AppCatalogFailure {
    const own = (value: unknown, key: string): unknown => {
        if (typeof value !== 'object' || value === null) return;
        try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return; }
    };
    const text = (value: unknown, max: number) => typeof value === 'string' && value.length
        ? value.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, ' ') : undefined;
    let code = 'APP_INSTALL_FAILED', message = 'Check the App package and rebuild with the matching SDK.';
    let path = text(fallbackPath, 512);
    for (let depth = 0; error && depth < 8; depth++, error = own(error, 'cause')) {
        const context = own(error, 'context');
        code = text(own(error, 'code'), 128) ?? code;
        message = text(own(context, 'reason'), 2048) ?? text(own(error, 'message'), 2048) ?? message;
        path = text(own(error, 'path'), 512) ?? text(own(context, 'path'), 512) ?? path;
    }
    return { name, phase, status: 'failed', issue: { code, message, ...(path === undefined ? {} : { path }) } };
}

/** Agentina's installed applications and their launch policy. Reads always use the product file. */
export class AppCatalog {
    constructor(private readonly options?: { configPath?: string }) {}

    getConfig() {
        return Config.getTuiConfig(this.options?.configPath);
    }

    async getEntries(configured?: readonly AppCatalogEntry[]): Promise<Record<string, AppConfigEntry>> {
        const entries: [string, AppConfigEntry][] = [];
        for await (const item of this.entries({ entries: configured })) {
            if ('status' in item) console.warn(`[AppCatalog] Invalid entry ${item.name}`, item.issue);
            else entries.push([item.name, item.entry]);
        }
        return Object.fromEntries(entries);
    }

    async getEntry(name: string): Promise<AppConfigEntry> {
        const { apps = {} } = await this.getConfig();
        if (!Object.hasOwn(apps, name)) throw new AOTUIError('APP_NOT_FOUND', { appId: name });
        return readEntry(name, apps[name]);
    }

    private async *entries(selection?: AppSelection): AsyncGenerator<
        { name: string; entry: AppConfigEntry } | AppCatalogFailure
    > {
        const explicit = selection?.entries;
        const entries = explicit ? Array.from(explicit, (entry, index) => ({
            name: entry && Object.getOwnPropertyDescriptor(entry, 'name')?.value,
            path: `apps[${index}].name`, value: entry,
        })) : Object.entries((await this.getConfig()).apps ?? {}).map(([name, value]) => ({ name, path: 'apps.' + name, value }));
        const seen = new Set<string>();
        for (const item of entries) {
            const { name, path: entryPath, value } = item;
            if (selection?.name !== undefined && selection.name !== name) continue;
            try {
                if (typeof name !== 'string' || !name.trim() || name !== name.trim()) {
                    throw new AOTUIError('CONFIG_INVALID', { path: entryPath, reason: 'Provide a nonempty installation ID without surrounding whitespace' });
                }
                if (seen.has(name)) throw new AOTUIError('APP_ALREADY_REGISTERED', { appName: name, path: entryPath });
                seen.add(name);
                yield { name, entry: readEntry(name, value) };
            } catch (error) {
                yield failedApp(typeof name === 'string' ? name : entryPath, 'discovery', error, entryPath);
            }
        }
        if (selection?.name !== undefined && !seen.has(selection.name)) {
            const name = selection.name;
            yield failedApp(name, 'discovery', new AOTUIError('APP_NOT_FOUND', { appId: name }), 'apps.' + name);
        }
    }

    async discover(entries?: readonly AppCatalogEntry[]): Promise<AppDiscoveryResult[]> {
        const results: AppDiscoveryResult[] = [];
        for await (const item of this.entries({ entries })) {
            if ('status' in item) {
                results.push(item);
                continue;
            }
            const { name, entry } = item;
            if (!entry.enabled) {
                results.push({ name, entry, status: 'disabled' });
                continue;
            }
            try {
                await readAppManifest(localAppPath(entry.source));
                results.push({ name, entry, status: 'loaded' });
            } catch (error) {
                results.push(failedApp(name, 'discovery', error, 'apps.' + name + '.source'));
            }
        }
        return results;
    }

    async installAll(desktop: IDesktop, options?: AppInstallOptions): Promise<AppInstallResult[]> {
        const suppliedConfig = options?.dynamicConfig;
        if (Object.hasOwn(suppliedConfig ?? {}, 'AOTUI_APP_NAME')) {
            throw new AOTUIError('CONFIG_INVALID', {
                reason: 'AOTUI_APP_NAME is reserved for Host-assigned App identities and cannot be overridden in launchConfig.',
            });
        }
        const config = { ...suppliedConfig };
        if (config.AOTUI_DATA_DIR === undefined) {
            config.AOTUI_DATA_DIR = process.env.AOTUI_DATA_DIR || path.join(os.homedir(), '.aotui', 'data');
        }
        const results: AppInstallResult[] = [];
        for await (const item of this.entries(options)) {
            if ('status' in item) {
                results.push(item);
                continue;
            }
            const { name, entry } = item;
            if (!entry.enabled) continue;
            let installationId: string | undefined;
            let localPath: string | undefined;
            try {
                localPath = localAppPath(entry.source);
                installationId = await desktop.registerPendingApp({ installationId: name, localPath, config,
                    toolsEnabled: options?.toolsEnabled, projectionLimits: options?.projectionLimits });
                if (options?.startAll || (entry.autoStart ?? true)) {
                    const { appId } = await desktop.openApp(installationId);
                    results.push({ name, installationId, status: 'installed', appId });
                } else {
                    results.push({ name, installationId, status: 'registered' });
                }
            } catch (error) {
                const result = failedApp(name, installationId ? 'install' : 'register', error, localPath ?? 'apps.' + name + '.source');
                const manifestFailure = !installationId && ['APP_MANIFEST_INVALID', 'APP_IDENTITY_MISMATCH',
                    'APP_AUTHORING_PROTOCOL_UNSUPPORTED', 'PERSISTENCE_UNAVAILABLE'].includes(result.issue.code);
                const phase = manifestFailure || !localPath ? 'discovery' : result.phase;
                const appId = installationId
                    ? desktop.listApps().find(app => app.installationId === installationId)?.appId
                    : undefined;
                results.push({ ...result, phase, ...(installationId ? { installationId } : {}), ...(appId ? { appId } : {}) });
            }
        }
        return results;
    }

    install(source: string, options?: InstallAppOptions): Promise<InstallAppResult> {
        return this.installSource(source, options);
    }

    async update(name: string): Promise<InstallAppResult> {
        const entry = await this.getEntry(name);
        if (!entry.originalSource?.startsWith('npm:')) {
            throw new Error(`App "${name}" is not installed from npm and cannot be updated yet`);
        }
        return this.installSource(entry.originalSource, { force: true }, { name, entry });
    }

    private async installSource(input: string, options?: InstallAppOptions, update?: { name: string; entry: AppConfigEntry }): Promise<InstallAppResult> {
        const source = parseInstallSource(input);
        const startingApps = update ? {} : (await this.getConfig()).apps ?? {};
        const npm = source.kind === 'npm' ? await installNpmPackage(source.packageSpec) : undefined;
        try {
            const localSource = npm?.localSource ?? source.source;
            const localPath = localAppPath(localSource);
            const manifest = await readAppManifest(localPath);
            const name = update?.name ?? manifest.metadata.app_name;
            const existed = update !== undefined || Object.hasOwn(startingApps, name);
            const expected = update?.entry ?? (existed ? startingApps[name] as Partial<AppConfigEntry> | null : undefined);
            return await Config.updateTuiConfig((config, filename) => {
                const apps = config.apps ?? {};
                const exists = Object.hasOwn(apps, name);
                const previous = exists ? apps[name] as Partial<AppConfigEntry> | null : undefined;
                if (exists && !options?.force) {
                    throw new AOTUIError('APP_ALREADY_REGISTERED', { appName: name, reason: 'Use --force to replace the installation' });
                }
                if (options?.force && (existed !== exists || previous?.source !== expected?.source
                    || previous?.originalSource !== expected?.originalSource || previous?.installedAt !== expected?.installedAt)) {
                    throw Object.assign(new Error(`CONFIG_CONFLICT ${filename}: Installation "${name}" changed. Refresh the catalog and retry.`),
                        { code: 'CONFIG_CONFLICT', path: filename });
                }
                const installedAt = new Date().toISOString();
                const distribution: AppConfigEntry['distribution'] = npm ? {
                    ...previous?.distribution, type: 'npm', packageName: npm.packageName, requested: npm.packageSpec,
                    resolvedVersion: npm.resolvedVersion ?? undefined, installRoot: npm.installRoot,
                    installedPath: npm.installedPath, installedAt,
                } : { type: 'local', installedPath: localPath, installedAt };
                config.apps = { ...apps, [name]: {
                    ...previous, source: localSource, originalSource: source.source, distribution, installedAt,
                    enabled: options?.enabled ?? (typeof previous?.enabled === 'boolean' ? previous.enabled : true),
                    autoStart: options?.autoStart ?? (typeof previous?.autoStart === 'boolean' ? previous.autoStart : true),
                } };
                // A Desktop may still have an older confirmed path registered, including a pending App.
                return { name, source: localSource, originalSource: source.source, distributionType: source.kind };
            }, this.options?.configPath);
        } catch (error) {
            if (npm) await removeNpmCache(npm.installRoot).catch(cause => console.warn(`Could not remove unpublished npm workspace ${npm.installRoot}`, cause));
            throw error;
        }
    }

    setEnabled(name: string, enabled: boolean): Promise<void> {
        return this.setFlag(name, 'enabled', enabled);
    }

    setAutoStart(name: string, autoStart: boolean): Promise<void> {
        return this.setFlag(name, 'autoStart', autoStart);
    }

    private setFlag(name: string, flag: 'enabled' | 'autoStart', value: boolean): Promise<void> {
        return Config.updateTuiConfig(config => {
            const apps = config.apps ?? {};
            if (!Object.hasOwn(apps, name)) throw new AOTUIError('APP_NOT_FOUND', { appId: name });
            config.apps = { ...apps, [name]: { ...readEntry(name, apps[name]), [flag]: value } };
        }, this.options?.configPath);
    }

    async remove(name: string): Promise<void> {
        await Config.updateTuiConfig(config => {
            const apps = config.apps ?? {};
            if (!Object.hasOwn(apps, name)) throw new AOTUIError('APP_NOT_FOUND', { appId: name });
            const removed = apps[name] as Partial<AppConfigEntry> | null;
            delete apps[name];
            const root = removed?.distribution?.type === 'npm' ? removed.distribution.installRoot : undefined;
            if (typeof root === 'string' && root && !Object.values(apps).some(value => {
                const entry = value as Partial<AppConfigEntry> | null;
                const current = entry?.distribution?.installRoot;
                if (typeof current === 'string' && path.resolve(current) === path.resolve(root)) return true;
                const source = entry?.source;
                if (typeof source !== 'string' || !source.startsWith('local:') || !source.slice(6).trim()) return false;
                const relative = path.relative(root, localAppPath(source));
                return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
            })) return root;
        }, this.options?.configPath, async root => {
            if (!root) return;
            try { await removeNpmCache(root); }
            catch (cause) {
                throw Object.assign(new Error(`Removed ${name} from the catalog. Could not remove the npm cache at ${root}.`, { cause }),
                    { code: 'APP_CACHE_REMOVE_FAILED', path: root });
            }
        });
    }
}
