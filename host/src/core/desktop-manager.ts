import {
    createRuntime,
    AOTUIError,
    type AppLaunchConfig,
    type DesktopID,
    type IDesktop,
    type IKernel,
} from '@aotui/runtime';
import { AppCatalog, type AppCatalogEntry, type AppCatalogFailure, type AppConfigEntry,
    type InstallAppOptions, type InstallAppResult } from '../app-distribution/app-catalog.js';
import { resolveCatalog, resolveCatalogOptionsFromConfig, type ResolvedCatalog } from '../app-distribution/catalog-resolver.js';
import { searchCatalog, type CatalogSearchResult } from '../app-distribution/catalog.js';
import path from 'path';
import os from 'os';
import { rethrowAfterDesktopClose } from './desktop-close.js';

export type { DesktopID, InstallAppOptions, InstallAppResult };

export interface DesktopInfo {
    desktop: IDesktop;
    thirdPartyAppCount: number;
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
    appCatalog?: AppCatalog;
}

export interface DesktopManagerInitializeOptions {
    appEntries?: AppCatalogEntry[];
}

export class DesktopManager {
    private readonly kernel: IKernel;
    private readonly appCatalog: AppCatalog;
    private appEntries?: readonly AppCatalogEntry[];

    constructor(options?: DesktopManagerOptions) {
        this.kernel = options?.kernel ?? createRuntime();
        this.appCatalog = options?.appCatalog ?? new AppCatalog();
    }

    async initialize(options?: DesktopManagerInitializeOptions): Promise<void> {
        this.appEntries = options?.appEntries;
        const discovery = await this.appCatalog.discover(this.appEntries);
        for (const result of discovery) if (result.status === 'failed') this.reportAppFailure(result);
        console.log(`[DesktopManager] Discovered ${discovery.filter(result => result.status === 'loaded').length} enabled apps`);
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
     * @param desktopId - Optional: specify a custom Desktop ID (for historical topics)
     * @param config - Optional: runtime config to inject into apps (e.g. projectPath)
     */
    async createDesktop(desktopId?: DesktopID, config?: AppLaunchConfig): Promise<DesktopInfo> {
        const runtimeDataDir = process.env.AOTUI_DATA_DIR
            || path.join(os.homedir(), '.aotui', 'data');

        const actualDesktopId = await this.kernel.createDesktop(desktopId);
        const desktop = this.kernel.getDesktop(actualDesktopId);
        try {
            if (desktop.isClosing) throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: desktop.id });
            const { AOTUI_DATA_DIR = runtimeDataDir, ...launchConfig } = { ...config };
            const results = await this.appCatalog.installAll(desktop, {
                entries: this.appEntries,
                dynamicConfig: { ...launchConfig, AOTUI_DATA_DIR },
            });
            for (const result of results) {
                if (result.status === 'failed') this.reportAppFailure(result);
            }
            if (desktop.isClosing || this.getDesktop(desktop.id) !== desktop) {
                throw new AOTUIError('DESKTOP_DISPOSED', { desktopId: desktop.id });
            }
            const thirdPartyAppCount = desktop.getInstalledApps().length;
            console.log(`[DesktopManager] Created Desktop ${actualDesktopId} with ${thirdPartyAppCount} third-party apps (Semantic)`);
            return { desktop, thirdPartyAppCount };
        } catch (error) {
            console.error('[DesktopManager] Failed to install apps:', error);
            return rethrowAfterDesktopClose(desktop, error);
        }
    }

    private reportAppFailure(result: AppCatalogFailure): void {
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

    async getAppsConfig(): Promise<Record<string, AppConfigEntry>> {
        return this.appCatalog.getEntries(this.appEntries);
    }

    async getAppDetail(name: string): Promise<AppConfigEntry> {
        if (this.appEntries) {
            const entries = await this.getAppsConfig();
            if (!Object.hasOwn(entries, name)) throw new AOTUIError('APP_NOT_FOUND', { appId: name });
            return entries[name];
        }
        return this.appCatalog.getEntry(name);
    }

    async searchAppsCatalog(query?: string): Promise<CatalogSearchResponse> {
        const installedApps = await this.getAppsConfig();
        const installedEntries = Object.entries(installedApps);
        const resolvedCatalog = await resolveCatalog(resolveCatalogOptionsFromConfig((await this.appCatalog.getConfig()).catalog));

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

    installApp(source: string, options?: InstallAppOptions): Promise<InstallAppResult> {
        return this.appCatalog.install(source, options);
    }

    updateApp(name: string): Promise<InstallAppResult> {
        return this.appCatalog.update(name);
    }

    removeApp(name: string): Promise<void> {
        return this.appCatalog.remove(name);
    }

    setAppEnabled(name: string, enabled: boolean): Promise<void> {
        return this.appCatalog.setEnabled(name, enabled);
    }
}

export const desktopManager = new DesktopManager();
