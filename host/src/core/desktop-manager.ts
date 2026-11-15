/**
 * Desktop Manager
 * 
 * Manages Desktop lifecycle using SDK createRuntime().
 * 
 * [RFC-021] TUI-chat has been removed. Desktop now:
 * - Only hosts TUI tool applications (third-party apps via AppRegistry)
 * - Chat/conversation is handled by ConversationManager (not a TUI App)
 * 
 * [SDK 标准化] 只使用 Runtime 的公开 API:
 * - createRuntime() - SDK Facade
 * - Kernel (IKernel) - 通过 createRuntime 获得
 * - 类型从 SPI 层导入
 */
import {
    // SDK Facade
    createRuntime,
    // SPI Types
    type DesktopID,
    type IDesktop,
    type IKernel,
    type AppLaunchConfig,
    // Third-party Apps
    AppRegistry,
    installNpmPackage,
    parseInstallSource,
    resolveCatalog,
    resolveCatalogOptionsFromConfig,
    searchCatalog,
    type AppConfigEntry,
    type AppRegistryEntry,
    type AppRegistryFailure,
    type CatalogSearchResult,
    type ResolvedCatalog
} from '@aotui/runtime';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { readSemanticDesktopSnapshot } from './semantic-desktop-snapshot.js';

export type { DesktopID };

export interface DesktopInfo {
    desktopId: DesktopID;
    thirdPartyAppCount: number;
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

export interface CatalogSearchEntry extends CatalogSearchResult {
    installed: boolean;
    installedName: string | null;
}

export interface CatalogSearchResponse {
    source: ResolvedCatalog['source'];
    remoteUrl?: string;
    cachedAt?: string;
    signatureVerified: boolean;
    warnings: string[];
    apps: CatalogSearchEntry[];
}

export interface DesktopManagerOptions {
    kernel?: IKernel;
    appRegistry?: AppRegistry;
}

export interface DesktopManagerInitializeOptions {
    appEntries?: AppRegistryEntry[];
    loadFromConfig?: boolean;
}

export class DesktopManager {
    private kernel: IKernel;
    private appRegistry: AppRegistry;

    constructor(options?: DesktopManagerOptions) {
        // [SDK 标准化] 使用 createRuntime() 代替手动实例化 Engine 组件
        this.kernel = options?.kernel ?? createRuntime();

        // [Third-Party Apps] 初始化 AppRegistry
        this.appRegistry = options?.appRegistry ?? new AppRegistry();
    }

    /**
     * 异步初始化 (加载第三方 App)
     * 
     * 必须在使用 createDesktop 之前调用此方法
     */
    async initialize(options?: DesktopManagerInitializeOptions): Promise<void> {
        const hasExplicitEntries = Array.isArray(options?.appEntries);
        const shouldLoadFromConfig = options?.loadFromConfig ?? !hasExplicitEntries;

        const discovery = hasExplicitEntries ? await this.appRegistry.loadFromEntries(options?.appEntries ?? [])
            : shouldLoadFromConfig ? await this.appRegistry.loadFromConfig() : [];
        for (const result of discovery) if (result.status === 'failed') this.reportAppFailure(result);

        console.log(`[DesktopManager] Initialized with ${this.appRegistry.list().length} third-party apps`);
    }

    /**
     * Get the Kernel instance
     * 
     * [SDK 标准化] 返回 IKernel 接口而非具体实现
     */
    getKernel(): IKernel {
        return this.kernel;
    }

    /**
     * Create a new Desktop
     * 
     * [RFC-021] ChatApp has been removed. Desktop now only hosts third-party TUI apps.
     * Chat/conversation is handled by ConversationManager in the Product Layer.
     * 
     * [Option D] Third-party apps are installed via AppRegistry.installAll()
     * using the Runtime package Worker
     * 
     * @param desktopId - Optional: specify a custom Desktop ID (for historical topics)
     * @param config - Optional: runtime config to inject into apps (e.g. projectPath)
     */
    async createDesktop(desktopId?: DesktopID, config?: Record<string, any>): Promise<DesktopInfo> {
        const runtimeDataDir = process.env.AOTUI_DATA_DIR
            || path.join(os.homedir(), '.aotui', 'data');

        const runtimeContext = {
            env: {
                AOTUI_DATA_DIR: runtimeDataDir,
                AOTUI_TOPIC_ID: desktopId ?? '',
            }
        };

        const actualDesktopId = await this.kernel.createDesktop(desktopId, runtimeContext);
        try {
            const desktop = this.kernel.getDesktop(actualDesktopId);
            const results = await this.appRegistry.installAll(desktop, {
                dynamicConfig: config,
            });
            for (const result of results) {
                if (result.status === 'failed') this.reportAppFailure(result);
            }
            const thirdPartyAppCount = desktop.getInstalledApps().length;
            console.log(`[DesktopManager] Created Desktop ${actualDesktopId} with ${thirdPartyAppCount} third-party apps (Semantic)`);
            return { desktopId: actualDesktopId, thirdPartyAppCount };
        } catch (error) {
            console.error('[DesktopManager] Failed to install apps:', error);
            await this.kernel.destroyDesktop(actualDesktopId);
            throw error;
        }
    }

    private reportAppFailure(result: AppRegistryFailure): void {
        console.warn(`[DesktopManager] App ${result.name} failed during ${result.phase}`, result.issue);
    }

    /**
     * Get Desktop by ID
     */
    getDesktop(desktopId: DesktopID): IDesktop | null {
        try {
            return this.kernel.getDesktop(desktopId);
        } catch {
            return null;
        }
    }

    /**
     * Delete Desktop
     */
    async deleteDesktop(desktopId: DesktopID): Promise<boolean> {
        try {
            await this.kernel.destroyDesktop(desktopId);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get snapshot for a Desktop
     * 
     * Uses the same Semantic projection as the Agent with an independent observation.
     */
    async getSnapshot(desktopId: DesktopID): Promise<string | null> {
        try {
            const snapshot = await readSemanticDesktopSnapshot(this.kernel.getDesktop(desktopId), this.kernel);
            return snapshot.markup;
        } catch {
            return null;
        }
    }

    async getAppsConfig(): Promise<Record<string, AppConfigEntry>> {
        return this.appRegistry.getEntries();
    }

    async getAppDetail(name: string): Promise<AppConfigEntry> {
        const app = (await this.getAppsConfig())[name];
        if (!app) {
            throw new Error(`App "${name}" not found`);
        }
        return app;
    }

    async searchAppsCatalog(query?: string): Promise<CatalogSearchResponse> {
        const installedApps = await this.getAppsConfig();
        const installedEntries = Object.entries(installedApps);
        const resolvedCatalog = await resolveCatalog(resolveCatalogOptionsFromConfig(this.appRegistry.getConfig().catalog));

        const apps = searchCatalog(query, resolvedCatalog.catalog).map((entry) => {
            const installedMatch = installedEntries.find(([, app]) => (
                app.distribution?.packageName === entry.packageName
                || app.originalSource === `npm:${entry.packageName}`
                || app.originalSource?.startsWith(`npm:${entry.packageName}@`)
            ));

            return {
                ...entry,
                installed: Boolean(installedMatch),
                installedName: installedMatch?.[0] ?? null
            };
        });

        return {
            source: resolvedCatalog.source,
            remoteUrl: resolvedCatalog.remoteUrl,
            cachedAt: resolvedCatalog.cachedAt,
            signatureVerified: resolvedCatalog.signatureVerified,
            warnings: resolvedCatalog.warnings,
            apps
        };
    }

    async installApp(sourceInput: string, options?: InstallAppOptions): Promise<InstallAppResult> {
        const resolved = parseInstallSource(sourceInput);

        if (resolved.kind === 'local') {
            if (!fs.existsSync(resolved.absolutePath)) {
                throw new Error(`Local path does not exist: ${resolved.absolutePath}`);
            }

            const name = await this.appRegistry.add(resolved.source, {
                force: options?.force,
                autoStart: options?.autoStart,
                enabled: options?.enabled,
                originalSource: resolved.source,
                distribution: {
                    type: 'local',
                    installedPath: resolved.absolutePath,
                    installedAt: new Date().toISOString()
                }
            });

            return {
                name,
                source: resolved.source,
                originalSource: resolved.source,
                distributionType: 'local'
            };
        }

        const installResult = await installNpmPackage(resolved.packageSpec, {
            forceReinstall: options?.force
        });

        const name = await this.appRegistry.add(installResult.localSource, {
            force: options?.force,
            autoStart: options?.autoStart,
            enabled: options?.enabled,
            originalSource: resolved.source,
            distribution: {
                type: 'npm',
                packageName: installResult.packageName,
                requested: installResult.packageSpec,
                resolvedVersion: installResult.resolvedVersion ?? undefined,
                installedPath: installResult.installedPath,
                installedAt: new Date().toISOString()
            }
        });

        return {
            name,
            source: installResult.localSource,
            originalSource: resolved.source,
            distributionType: 'npm'
        };
    }

    async updateApp(name: string): Promise<InstallAppResult> {
        const current = await this.getAppDetail(name);
        const originalSource = current.originalSource;
        if (!originalSource || !originalSource.startsWith('npm:')) {
            throw new Error(`App "${name}" is not installed from npm and cannot be updated yet`);
        }

        return this.installApp(originalSource, {
            force: true,
            autoStart: current.autoStart,
            enabled: current.enabled
        });
    }

    async removeApp(name: string): Promise<void> {
        await this.appRegistry.remove(name);
    }

    async setAppEnabled(name: string, enabled: boolean): Promise<void> {
        await this.appRegistry.setEnabled(name, enabled);
    }
}

// Singleton instance
export const desktopManager = new DesktopManager();

// Initialize immediately (fire-and-forget for backward compatibility)
// Server should await this before processing requests
export const desktopManagerReady = desktopManager.initialize();
