/**
 * @aotui/host - LLM Config Types
 * 
 * LLM 配置管理相关的类型定义
 */

/**
 * LLM 配置存储格式 (数据库)
 */
export interface LLMConfigRecord {
    /** 配置 ID */
    id: number;
    /** 配置名称 */
    name: string;
    /** Raw model ID sent to the selected Provider. */
    model: string;
    /** Provider ID (可选, e.g., "openai", "anthropic") */
    providerId?: string;
    /** 自定义 Base URL (可选) */
    baseUrl?: string;
    /** API Key (加密存储) */
    apiKey?: string;
    /** Temperature (0-1) */
    temperature: number;
    /** 是否为激活配置 */
    isActive: boolean;
    /** 创建时间 */
    createdAt: number;
    /** 更新时间 */
    updatedAt: number;
}

/**
 * LLM 配置输入 (用户创建配置时)
 */
export interface LLMConfigInput {
    name: string;
    model: string;
    providerId: string;
    baseUrl?: string;
    apiKey?: string;
    temperature?: number;
    skipValidation?: boolean;
}

/** Parse the Provider and model pair saved by the Topic and Agent selectors. */
export function parseModelSelection(value: string): { providerId: string; modelId: string } | undefined {
    const separator = value.indexOf(':', value.startsWith('custom:') ? 'custom:'.length : 0);
    const slash = value.indexOf('/');
    if (separator < 1 || (slash >= 0 && slash < separator) || !value.slice(separator + 1).trim()) return undefined;
    return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}
