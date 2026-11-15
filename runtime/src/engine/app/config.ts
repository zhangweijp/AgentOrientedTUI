/**
 * TUI App Configuration Types
 * 
 * 定义 ~/.agentina/config.json 的结构
 * 
 * @module @aotui/runtime/engine/app-registry
 */

/**
 * 单个 App 的配置
 */
export interface AppConfigEntry {
    /** 
     * 来源
     * - npm:@scope/name -- npm 包
     * - local:/path/to/app -- 本地目录
     * - git:github:user/repo -- Git 仓库
     */
    source: string;

    /** 是否启用 */
    enabled: boolean;

    /** 安装时间 */
    installedAt?: string;

    /**
     * [RFC-014] Desktop 创建时是否自动启动此 App
     * - true: Desktop 创建时自动安装并启动 (默认行为)
     * - false: App 已安装但不自动启动，需按需启动
     * @default true
     */
    autoStart?: boolean;

    /**
     * 原始安装来源（用于分发场景），例如：
     * - npm:@scope/my-app@1.2.3
     */
    originalSource?: string;

    /**
     * 分发元数据（用于展示与排障）
     */
    distribution?: {
        type: 'local' | 'npm' | 'git' | 'catalog';
        packageName?: string;
        requested?: string;
        resolvedVersion?: string;
        installRoot?: string;
        installedPath?: string;
        installedAt?: string;
        catalogId?: string;
        [key: string]: unknown;
    };
}

export interface CatalogTrustKeyConfig {
    keyId: string;
    algorithm?: 'ed25519';
    publicKey: string;
}

export interface CatalogConfig {
    /**
     * 远端应用目录地址（静态 JSON / API）
     */
    url?: string;

    /**
     * 目录缓存文件路径
     * 为空时使用 ~/.agentina/cache/app-catalog.json
     */
    cachePath?: string;

    /**
     * 是否强制要求远端目录签名有效
     */
    requireSignature?: boolean;

    /**
     * 受信任的签名公钥集合
     */
    trustedKeys?: CatalogTrustKeyConfig[];
}

/** Registry file shared with product configuration. */
export interface TUIConfig {
    /** 配置版本 */
    version: number;

    /** 远端目录配置 */
    catalog?: CatalogConfig;

    /** 已安装的 App */
    apps: Record<string, AppConfigEntry>;
}

/**
 * 创建默认配置 (Version 2)
 */
export function createDefaultConfig(): TUIConfig {
    return {
        version: 2,
        apps: {}
    };
}

export function validateConfig(config: unknown): config is TUIConfig {
    if (typeof config !== 'object' || config === null) return false;

    const c = config as Record<string, unknown>;
    if (typeof c.version !== 'number') return false;
    if (typeof c.apps !== 'object' || c.apps === null) return false;

    return true;
}
