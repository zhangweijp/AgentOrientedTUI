/**
 * App Registry
 * 
 * 管理第三方 TUI App 的注册和加载。
 * 
 * 职责:
 * - 从 ~/.agentina/config.json 加载配置
 * - 动态加载 App 模块
 * - 为 Desktop 提供 App 安装服务
 * 
 * @module @aotui/runtime/engine/app-registry
 */

import type { IDesktop, AppID } from '../../spi/index.js';
import { captureAppMetadata, APP_LIFECYCLE_PROTOCOL, STATE_SESSION_PROTOCOL } from '../../spi/index.js';
import type { AppMetadata } from '../../spi/index.js';
import { hasViewTypeToolAuthoringProtocol } from '../../spi/app/app-factory.interface.js';
import { AOTUIError } from '../../spi/core/errors.js';
import type { TUIConfig, AppConfigEntry } from './config.js';
import type { AppLaunchConfig } from '../../spi/app/app-config.interface.js';
import type { AppInteractionOptions } from '../../spi/runtime/app-interaction.interface.js';
import { captureInteractionModes } from './interaction-config.js';
import { createDefaultConfig, validateConfig } from './config.js';
// [Option C] ESM-compatible imports for file system access
import * as fs from 'fs';
import * as pathModule from 'path';
import * as os from 'os';

// Re-export
export type { TUIConfig, AppConfigEntry } from './config.js';

/**
 * 已加载的 App 信息
 */
export interface LoadedApp {
    /** Canonical name from the generated static manifest; never a registry alias. */
    readonly name: string;
    readonly metadata: AppMetadata;
    readonly modulePath: string;
    readonly source: string;
}

export interface AppRegistryEntry extends AppConfigEntry {
    /** Registry key used to reference the app */
    name: string;
}

/**
 * AppRegistry 配置
 */
export interface AppRegistryOptions {
    /** 配置文件路径 (默认 ~/.agentina/config.json) */
    configPath?: string;
    /** 是否自动加载 (默认 true) */
    autoLoad?: boolean;
}

/** Host-owned installation policy; business launch config cannot enable Runtime capabilities. */
export interface AppRegistryInstallOptions extends AppInteractionOptions {
    defaultWorkerScript?: string;
    dynamicConfig?: AppLaunchConfig;
}

export interface AppRegistryFailure {
    readonly name: string;
    readonly status: 'failed';
    readonly phase: 'discovery' | 'install' | 'register';
    readonly issue: { readonly code: string; readonly message: string; readonly path?: string };
}
export type AppDiscoveryResult = Readonly<{ name: string; status: 'loaded' | 'disabled' }> | AppRegistryFailure;
export type AppInstallResult = Readonly<{ name: string; status: 'installed' | 'registered'; appId: AppID }> | AppRegistryFailure;

function failedApp(name: string, phase: AppRegistryFailure['phase'], error: unknown, fallbackPath?: string): AppRegistryFailure {
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

/**
 * App Registry
 * 
 * 管理第三方 TUI App 的生命周期
 * 
 * @example
 * ```typescript
 * const registry = new AppRegistry();
 * await registry.loadFromConfig();
 * 
 * // 为 Desktop 安装所有已注册的 App
 * await registry.installAll(desktop);
 * ```
 */
export class AppRegistry {
    private apps = new Map<string, LoadedApp>();
    private entryConfigs = new Map<string, AppConfigEntry>();
    private config: TUIConfig = createDefaultConfig();
    private configPath: string;

    constructor(options?: AppRegistryOptions) {
        this.configPath = options?.configPath ?? this.getDefaultConfigPath();
    }

    // ════════════════════════════════════════════════════════════════
    //  Public API
    // ════════════════════════════════════════════════════════════════

    /**
     * 从配置文件加载所有 App
     */
    async loadFromConfig(): Promise<AppDiscoveryResult[]> {
        this.config = await this.readConfig();
        return this.loadFromEntries(Object.entries(this.config.apps).map(([name, entry]) => ({ ...entry, name })));
    }

    /** Discover static App manifests from explicit Host configuration. */
    async loadFromEntries(entries: AppRegistryEntry[], options?: { replace?: boolean }): Promise<AppDiscoveryResult[]> {
        if (!Array.isArray(entries)) throw new AOTUIError('CONFIG_INVALID', { reason: 'Expected an array of App entries' });
        if (options?.replace !== false) {
            this.apps.clear();
            this.entryConfigs.clear();
        }
        const seen = new Set<string>();
        return Array.from(entries, (entry, index) => {
            const path = `apps[${index}].name`;
            if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) return failedApp(
                `apps[${index}]`, 'discovery', new AOTUIError('CONFIG_INVALID', { path, reason: 'Provide the App name' }));
            const { name, ...appEntry } = entry;
            if (seen.has(name)) return failedApp(name, 'discovery', new AOTUIError('APP_ALREADY_REGISTERED', { appName: name, path }));
            seen.add(name);
            return this.loadEntry(name, appEntry);
        });
    }

    /**
     * 添加 App 到配置
     * 
     * @param source 来源 (npm:xxx, local:xxx, git:xxx)
     * @param options 选项
     */
    async add(
        source: string,
        options?: {
            force?: boolean;
            enabled?: boolean;
            autoStart?: boolean;
            originalSource?: string;
            distribution?: AppConfigEntry['distribution'];
        }
    ): Promise<string> {
        if (options && Object.hasOwn(options, 'alias')) throw new AOTUIError('CONFIG_INVALID', { reason: 'Registry aliases are not supported; use the generated canonical app_name' });
        const loaded = this.readManifest(source);
        const name = loaded.name;

        // 检查名称冲突
        if (this.config.apps[name] && !options?.force) {
            throw new AOTUIError('APP_ALREADY_REGISTERED', {
                appName: name,
                reason: `App already exists from ${this.config.apps[name].source}. Use --force to replace it.`
            });
        }

        // 注册到配置
        this.config.apps[name] = {
            source,
            enabled: options?.enabled ?? true,
            autoStart: options?.autoStart,
            installedAt: new Date().toISOString(),
            originalSource: options?.originalSource,
            distribution: options?.distribution
        };
        this.entryConfigs.set(name, { ...this.config.apps[name] });

        // 添加到内存
        this.apps.set(name, loaded);

        // 保存配置
        await this.saveConfig();

        console.log(`[AppRegistry] Added app: ${name} from ${source}`);
        return name;
    }

    /**
     * 注册临时 App (不保存到配置文件)
     * 用于开发环境自动发现或运行时动态添加
     */
    async registerTransient(source: string): Promise<string> {
        const loaded = this.readManifest(source);
        const name = loaded.name;

        // 检查名称冲突 (仅检查内存中)
        if (this.apps.has(name)) {
            if (this.apps.get(name)!.modulePath !== loaded.modulePath) throw new AOTUIError('APP_ALREADY_REGISTERED', { appName: name });
            console.log(`[AppRegistry] Transient app "${name}" already loaded from ${this.apps.get(name)?.source}`);
            return name;
        }

        // 添加到内存
        this.apps.set(name, loaded);
        this.entryConfigs.set(name, {
            source,
            enabled: true,
            autoStart: true,
        });

        console.log(`[AppRegistry] Registered transient app: ${name} from ${source}`);
        return name;
    }

    /**
     * 移除 App
     */
    async remove(name: string): Promise<void> {
        const entry = this.entryConfigs.get(name) ?? this.config.apps[name];
        if (!entry) {
            throw new AOTUIError('APP_NOT_FOUND', { appId: name });
        }

        await this.cleanupInstalledArtifacts(entry);
        const shouldPersistRemoval = this.config.apps[name] !== undefined;
        delete this.config.apps[name];
        this.apps.delete(name);
        this.entryConfigs.delete(name);

        if (shouldPersistRemoval) {
            await this.saveConfig();
        }
        console.log(`[AppRegistry] Removed app: ${name}`);
    }

    /**
     * 列出所有已安装的 App
     */
    list(): LoadedApp[] {
        return Array.from(this.apps.values());
    }

    /**
     * 获取已安装的 App
     */
    get(name: string): LoadedApp | undefined {
        return this.apps.get(name);
    }

    getEntry(name: string): AppConfigEntry | undefined {
        const entry = this.entryConfigs.get(name) ?? this.config.apps[name];
        return entry ? { ...entry } : undefined;
    }

    getEntries(): Record<string, AppConfigEntry> {
        return Object.fromEntries(
            Array.from(this.entryConfigs.entries()).map(([name, entry]) => [name, { ...entry }])
        );
    }

    /**
     * 启用/禁用 App
     */
    async setEnabled(name: string, enabled: boolean): Promise<void> {
        const entry = this.entryConfigs.get(name) ?? this.config.apps[name];
        if (!entry) {
            throw new AOTUIError('APP_NOT_FOUND', { appId: name });
        }

        this.entryConfigs.set(name, { ...entry, enabled });
        if (this.config.apps[name]) {
            this.config.apps[name].enabled = enabled;
            await this.saveConfig();
        }

        console.log(`[AppRegistry] ${enabled ? 'Enabled' : 'Disabled'} app: ${name}`);
    }

    /**
     * [RFC-014] 设置 App 自动启动状态
     * 
     * @param name - App 名称
     * @param autoStart - 是否在 Desktop 创建时自动启动
     */
    async setAutoStart(name: string, autoStart: boolean): Promise<void> {
        const entry = this.entryConfigs.get(name);
        if (!entry) {
            throw new AOTUIError('APP_NOT_FOUND', { appId: name });
        }

        this.entryConfigs.set(name, { ...entry, autoStart });
        if (this.config.apps[name]) {
            this.config.apps[name].autoStart = autoStart;
            await this.saveConfig();
        }

        console.log(`[AppRegistry] Set autoStart=${autoStart} for: ${name}`);
    }


    /**
     * [Option D] 为 Desktop 安装所有已注册的 App (配置驱动)
     * 
     * 使用 config.json 中的 runtime.workerScript 作为默认 Worker 脚本，
     * 各 App 可以通过 workerScript 字段覆盖。
     * 
     * @param desktop - 目标 Desktop
     * @param options - 可选配置
     * @returns 每个 App 的安装或登记结果
     */
    async installAll(
        desktop: IDesktop,
        options?: AppRegistryInstallOptions
    ): Promise<AppInstallResult[]> {
        // 获取默认 Worker 脚本路径
        const defaultWorkerScript = options?.defaultWorkerScript
            ?? this.config.runtime?.workerScript;

        // [C1 Fix] defaultWorkerScript is now optional
        // If not provided, Runtime will use its built-in worker-runtime

        return this.installEntries(desktop, Array.from(this.apps.keys()), {
            defaultWorkerScript,
            dynamicConfig: options?.dynamicConfig,
            interactionModes: captureInteractionModes(options),
        });
    }

    async installSelected(
        desktop: IDesktop,
        names: string[],
        options?: AppRegistryInstallOptions
    ): Promise<AppInstallResult[]> {
        const defaultWorkerScript = options?.defaultWorkerScript
            ?? this.config.runtime?.workerScript;

        return this.installEntries(desktop, names, {
            defaultWorkerScript,
            dynamicConfig: options?.dynamicConfig,
            interactionModes: captureInteractionModes(options),
        });
    }



    /** Resolve the generated entry without importing any App code. */
    public resolveModulePath(source: string): string {
        return this.readManifest(source).modulePath;
    }

    private readManifest(source: string): LoadedApp {
        if (!source.startsWith('local:')) throw new AOTUIError('CONFIG_NOT_SUPPORTED', { feature: 'Registry sources must resolve to a local installed package directory' });
        const target = pathModule.resolve(source.slice(6));
        if (!fs.existsSync(target)) throw new AOTUIError('APP_MANIFEST_INVALID', {
            path: target, reason: 'Local source does not exist; check the path or build the App before registering it',
        });
        const targetInfo = fs.statSync(target);
        let directory = targetInfo.isDirectory() ? target : pathModule.dirname(target);
        while (!fs.existsSync(pathModule.join(directory, 'aoapp.json')) &&
            !fs.existsSync(pathModule.join(directory, 'package.json')) && pathModule.dirname(directory) !== directory) {
            directory = pathModule.dirname(directory);
        }
        const manifestPath = pathModule.join(directory, 'aoapp.json');
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const metadata = captureAppMetadata(manifest);
            if (typeof manifest.version !== 'string' || !manifest.version || typeof manifest.entry?.main !== 'string' || !manifest.entry.main)
                throw new TypeError('version and entry.main are required; build the App to regenerate aoapp.json');
            if (!hasViewTypeToolAuthoringProtocol(manifest)) throw Object.assign(new Error('The generated manifest declares an unsupported authoring protocol; rebuild with the matching SDK'), { code: 'APP_AUTHORING_PROTOCOL_UNSUPPORTED', path: manifestPath + '#toolAuthoringProtocol' });
            if (manifest.persistenceSupport !== STATE_SESSION_PROTOCOL || manifest.appLifecycleSupport !== APP_LIFECYCLE_PROTOCOL)
                throw new TypeError('The generated manifest requires the current persistence and lifecycle contracts');
            const modulePath = pathModule.resolve(directory, manifest.entry.main);
            if (targetInfo.isFile() && target !== modulePath)
                throw new AOTUIError('APP_IDENTITY_MISMATCH', { expected: modulePath, actual: target, path: 'manifest.entry.main' });
            if (!fs.existsSync(modulePath) || !fs.statSync(modulePath).isFile()) throw new TypeError('The generated entry.main file does not exist; build the App first');
            return Object.freeze({ name: metadata.app_name, metadata, modulePath, source });
        } catch (error) {
            if (error instanceof AOTUIError || Object.getOwnPropertyDescriptor(error ?? {}, 'code')?.value === 'APP_AUTHORING_PROTOCOL_UNSUPPORTED') throw error;
            throw new AOTUIError('APP_MANIFEST_INVALID', { path: manifestPath,
                reason: error instanceof Error ? error.message : 'Build the App to generate aoapp.json' });
        }
    }

    /**
     * 获取配置（用于调试）
     */
    getConfig(): TUIConfig {
        return { ...this.config };
    }

    // ════════════════════════════════════════════════════════════════
    //  Internal Methods
    // ════════════════════════════════════════════════════════════════

    private getDefaultConfigPath(): string {
        const home = process.env.HOME || process.env.USERPROFILE || '~';
        return `${home}/.agentina/config.json`;
    }

    private async readConfig(): Promise<TUIConfig> {
        try {
            const fs = await import('fs/promises');
            const content = await fs.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(content);

            if (!validateConfig(config) || Array.isArray(config.apps)) {
                throw new AOTUIError('CONFIG_INVALID', { path: this.configPath, reason: 'Expected a registry version and App entries' });
            }
            if (config.runtime !== undefined && (!config.runtime || typeof config.runtime !== 'object' || Array.isArray(config.runtime))) {
                throw new AOTUIError('CONFIG_INVALID', { path: 'runtime', reason: 'Expected a Runtime configuration object' });
            }
            if (config.runtime?.workerScript !== undefined && typeof config.runtime.workerScript !== 'string') {
                throw new AOTUIError('CONFIG_INVALID', { path: 'runtime.workerScript', reason: 'Expected a Worker script path' });
            }

            return config;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // 配置文件不存在，使用默认值
                return createDefaultConfig();
            }
            throw error;
        }
    }

    private async saveConfig(): Promise<void> {
        const fs = await import('fs/promises');
        const path = await import('path');

        // 确保目录存在
        const dir = path.dirname(this.configPath);
        await fs.mkdir(dir, { recursive: true });

        // 写入配置
        const content = JSON.stringify(this.config, null, 2);
        await fs.writeFile(this.configPath, content, 'utf-8');
    }

    private loadEntry(name: string, entry: AppConfigEntry): AppDiscoveryResult {
        this.apps.delete(name);
        this.entryConfigs.set(name, { ...entry });
        try {
            if (typeof entry.source !== 'string' || typeof entry.enabled !== 'boolean') {
                throw new AOTUIError('CONFIG_INVALID', { path: 'apps.' + name, reason: 'Provide source and enabled for this App' });
            }
            if (!entry.enabled) return { name, status: 'disabled' };
            const loaded = this.readManifest(entry.source);
            if (name !== loaded.name) throw new AOTUIError('APP_IDENTITY_MISMATCH', { expected: loaded.name, actual: name, path: 'registry.key' });
            const override = ['alias', 'description', 'whatItIs', 'whenToUse'].find(key => Object.hasOwn(entry, key));
            if (override) throw new AOTUIError('CONFIG_INVALID', { path: 'apps.' + name + '.' + override,
                reason: `${override} is App metadata; remove the override and rebuild the App manifest` });
            this.apps.set(name, loaded);
            return { name, status: 'loaded' };
        } catch (error) {
            return failedApp(name, 'discovery', error);
        }
    }

    private async installEntries(desktop: IDesktop, names: string[], options: AppRegistryInstallOptions): Promise<AppInstallResult[]> {
        if (Object.hasOwn(options.dynamicConfig ?? {}, 'AOTUI_APP_NAME')) throw new AOTUIError('CONFIG_INVALID', {
            reason: 'Use AOTUI_APP_KEY for a Host-owned state namespace; registration uses the generated app_name',
        });
        const results: AppInstallResult[] = [];
        for (const name of names) {
            const app = this.apps.get(name);
            if (!app) {
                results.push(failedApp(name, 'install', new AOTUIError('APP_NOT_FOUND', { appId: name })));
                continue;
            }
            const configEntry = this.entryConfigs.get(name) ?? this.config.apps[name];
            const dynamicConfig: AppLaunchConfig = { ...options.dynamicConfig, AOTUI_APP_KEY: options.dynamicConfig?.AOTUI_APP_KEY ?? name };
            const autoStart = configEntry?.autoStart ?? true;
            const modulePath = app.modulePath;
            const workerScript = configEntry?.workerScript ?? options.defaultWorkerScript;

            try {
                const { description, whatItIs, whenToUse } = app.metadata;

                if (autoStart) {
                    const appId = await desktop.installDynamicWorkerApp(
                        modulePath,
                        {
                            workerScriptPath: workerScript,
                            name,
                            description,
                            whatItIs,
                            whenToUse,
                            config: dynamicConfig,
                            interactionModes: options.interactionModes,
                        }
                    );
                    results.push({ name, status: 'installed', appId: appId as AppID });
                    console.log(`[AppRegistry] Installed "${name}" to Desktop ${desktop.id} (Worker mode)`);
                } else {
                    const appId = await desktop.registerPendingApp({
                        name,
                        description,
                        whatItIs,
                        whenToUse,
                        modulePath,
                        workerScriptPath: workerScript,
                        config: dynamicConfig,
                        interactionModes: options.interactionModes,
                    });
                    results.push({ name, status: 'registered', appId: appId as AppID });
                    console.log(`[AppRegistry] Registered "${name}" to Desktop ${desktop.id} (Pending mode)`);
                }
            } catch (error) {
                results.push(failedApp(name, autoStart ? 'install' : 'register', error, modulePath));
            }
        }

        return results;
    }

    private async cleanupInstalledArtifacts(entry: AppConfigEntry): Promise<void> {
        if (entry.distribution?.type !== 'npm') {
            return;
        }

        const installRoot = this.resolveNpmInstallRoot(entry);
        if (!installRoot) {
            return;
        }

        const allowedRoot = this.getDefaultNpmCacheRoot();
        const normalizedAllowedRoot = pathModule.resolve(allowedRoot);
        const normalizedInstallRoot = pathModule.resolve(installRoot);

        if (
            normalizedInstallRoot !== normalizedAllowedRoot &&
            !normalizedInstallRoot.startsWith(`${normalizedAllowedRoot}${pathModule.sep}`)
        ) {
            console.warn(`[AppRegistry] Skip deleting npm cache outside managed root: ${normalizedInstallRoot}`);
            return;
        }

        const fsPromises = await import('fs/promises');
        await fsPromises.rm(normalizedInstallRoot, { recursive: true, force: true });
        await this.pruneEmptyParentDirs(pathModule.dirname(normalizedInstallRoot), normalizedAllowedRoot);
    }

    private resolveNpmInstallRoot(entry: AppConfigEntry): string | null {
        const explicitInstallRoot = entry.distribution?.installRoot;
        if (typeof explicitInstallRoot === 'string' && explicitInstallRoot.trim()) {
            return explicitInstallRoot;
        }

        const installedPath = entry.distribution?.installedPath;
        if (typeof installedPath !== 'string' || !installedPath.trim()) {
            return null;
        }

        const packageName = entry.distribution?.packageName;
        if (typeof packageName === 'string' && packageName.trim()) {
            const nodeModulesSuffix = pathModule.join('node_modules', ...packageName.split('/'));
            const normalizedInstalledPath = pathModule.normalize(installedPath);
            if (normalizedInstalledPath.endsWith(nodeModulesSuffix)) {
                return normalizedInstalledPath.slice(0, normalizedInstalledPath.length - nodeModulesSuffix.length - 1);
            }
        }

        const segments = pathModule.normalize(installedPath).split(pathModule.sep);
        const nodeModulesIndex = segments.lastIndexOf('node_modules');
        if (nodeModulesIndex > 0) {
            return segments.slice(0, nodeModulesIndex).join(pathModule.sep) || pathModule.sep;
        }

        return null;
    }

    private getDefaultNpmCacheRoot(): string {
        return pathModule.join(os.homedir(), '.agentina', 'apps', 'npm');
    }

    private async pruneEmptyParentDirs(startDir: string, stopDir: string): Promise<void> {
        const fsPromises = await import('fs/promises');
        let current = pathModule.resolve(startDir);
        const normalizedStop = pathModule.resolve(stopDir);

        while (current.startsWith(`${normalizedStop}${pathModule.sep}`)) {
            try {
                const entries = await fsPromises.readdir(current);
                if (entries.length > 0) {
                    break;
                }
                await fsPromises.rmdir(current);
                current = pathModule.dirname(current);
            } catch {
                break;
            }
        }
    }


}

export type { TUIAppFactory } from '../../spi/index.js';
