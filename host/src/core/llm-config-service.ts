/**
 * @aotui/host - LLM Config Service
 * 
 * LLM 配置管理服务
 * 
 * 职责:
 * - 管理 LLM Provider 配置
 * - 提供配置 CRUD 接口
 * - 管理激活配置
 * - (未来) API Key 加密存储
 */

import { resolveProviderEndpoint, type LLMConfig } from '@aotui/agent-driver-v2';
import type { LLMConfigRecord, LLMConfigInput } from '../types/llm-config.js';
import { parseModelSelection } from '../types/llm-config.js';
import * as llmConfigDb from '../db/llm-config-db.js';
import { getDb, persistDatabase } from '../db/index.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../config/config.js';
import type { ModelRegistry } from '../services/model-registry.js';
import {
    CustomProviderStore,
    type CustomProviderRecord,
    type CustomProviderProtocol,
} from '../services/custom-provider-store.js';

/**
 * LLM Config Service
 */
export class LLMConfigService {
    private logger: Logger;
    private modelRegistry: ModelRegistry;
    private customProviderStore: CustomProviderStore;

    constructor(modelRegistry: ModelRegistry) {
        this.logger = new Logger('LLMConfigService');
        this.modelRegistry = modelRegistry;
        this.customProviderStore = new CustomProviderStore();
    }

    async resolveLLMConfig(selection?: string): Promise<LLMConfig> {
        const active = this.getActiveLLMConfigRecord();
        const override = selection?.trim() ? selection : undefined;
        const target = override ? parseModelSelection(override)
            : active && { providerId: active.providerId, modelId: active.model };
        if (!override && !target) {
            throw new Error('No active LLM config found. Choose a Provider and model in Settings.');
        }
        if (!target?.providerId?.trim() || target.providerId !== target.providerId.trim() || !target.modelId.trim()) {
            throw new Error('Choose a Provider and nonempty model. Reselect the model in Settings.');
        }
        const { providerId, modelId: model } = target;

        const custom = await this.resolveCustomProvider(providerId);
        if (providerId.startsWith('custom:') && !custom) {
            throw new Error(`Provider "${providerId}" is unavailable. Reselect the model in Settings.`);
        }
        let record = active;
        if (override) {
            const records = this.getAllConfigs().filter(candidate => candidate.providerId === providerId);
            const sameProviderActive = active?.providerId === providerId ? active : undefined;
            record = sameProviderActive?.model === model
                ? sameProviderActive
                : records.find(candidate => candidate.model === model) ?? sameProviderActive ?? records[0] ?? null;
        }

        const id = custom?.protocol ?? providerId;
        const configuredURL = custom?.baseUrl ?? (record?.baseUrl || await this.resolveBaseUrl(providerId));
        const { baseURL, defaultBaseURL } = resolveProviderEndpoint(id, configuredURL);
        if (!baseURL) {
            throw new Error(`Provider "${providerId}" requires a baseURL. Set the endpoint or reselect the model in Settings.`);
        }
        if (custom && !custom.apiKey) {
            throw new Error(`API key not found for provider "${providerId}". Set its key in Settings.`);
        }
        const modes = (await Config.getTuiConfig()).toolSchemaModes;
        const key = `${id}:${model}`;
        const endpoint = baseURL.replace(/\/$/, '');
        const endpointKey = `${key}@${endpoint}`;
        const toolSchemaMode = modes && Object.hasOwn(modes, endpointKey) ? modes[endpointKey]
            : modes && endpoint === defaultBaseURL && Object.hasOwn(modes, key) ? modes[key] : undefined;
        return {
            model,
            provider: { id, baseURL, ...(toolSchemaMode === undefined ? {} : { toolSchemaMode }) },
            apiKey: custom ? custom.apiKey : record?.apiKey,
            temperature: record?.temperature,
        };
    }

    /** Resolve the budget after the Desktop or IM model override has been applied. */
    withModelInputBudget(config: LLMConfig): LLMConfig {
        if (config.inputBudget) return config;
        return { ...config, inputBudget: async ({ providerId, modelId }) => {
            if (providerId !== config.provider.id || modelId !== config.model) return;
            const endpoint = resolveProviderEndpoint(providerId, config.provider.baseURL);
            const baseURL = endpoint.baseURL?.replace(/\/$/, '');
            const isDefault = baseURL === endpoint.defaultBaseURL;
            const key = providerId + ':' + modelId;
            const configured = (await Config.getTuiConfig()).modelInputLimits;
            const endpointKey = key + '@' + baseURL;
            if (baseURL && configured && Object.hasOwn(configured, endpointKey)) return configured[endpointKey];
            if (isDefault && configured && Object.hasOwn(configured, key)) return configured[key];
            const models = await this.modelRegistry.getModels({ providerId });
            const model = models.find(candidate => candidate.id === modelId);
            const limits = model?.limit;
            if (!model || !limits?.context || !limits.output) return;
            if (!isDefault) {
                const catalogURL = (await this.modelRegistry.getProviderConfig(providerId)).baseURL?.replace(/\/$/, '');
                if (!catalogURL || catalogURL !== baseURL) return;
            }
            const modalities = model.modalities?.input;
            return { contextWindow: limits.context, maxInputTokens: limits.input,
                maxOutputTokens: Math.min(limits.output, 4_096),
                capabilities: { toolCall: model.tool_call,
                    ...(modalities ? { input: { image: modalities.includes('image'), pdf: modalities.includes('pdf') } } : {}) } };
        } };
    }

    /**
     * 获取当前激活的配置记录
     */
    getActiveLLMConfigRecord(): LLMConfigRecord | null {
        const db = getDb();
        return llmConfigDb.getActiveLLMConfig(db);
    }

    /**
     * 获取所有 LLM 配置
     */
    getAllConfigs(): LLMConfigRecord[] {
        const db = getDb();
        return llmConfigDb.getAllLLMConfigs(db);
    }

    /**
     * 获取单个配置
     */
    getConfig(id: number): LLMConfigRecord | null {
        const db = getDb();
        return llmConfigDb.getLLMConfig(db, id);
    }

    /**
     * 创建新的 LLM 配置
     */
    async createConfig(input: LLMConfigInput): Promise<LLMConfigRecord> {
        if (!input.providerId?.trim() || !input.model.trim()) {
            throw new Error('Choose a Provider and nonempty model in Settings.');
        }
        const customProvider = await this.resolveCustomProvider(input.providerId);

        if (input.providerId?.startsWith('custom:') && !customProvider) {
            throw new Error(`Custom provider not found: ${input.providerId}`);
        }

        if (!customProvider) {
            const isValid = await this.validateModel(
                input.providerId,
                input.model,
                input.skipValidation || false
            );
            
            if (!isValid && !input.skipValidation) {
                throw new Error(
                    `Model "${input.model}" not found in provider "${input.providerId}". ` +
                    `Please select a valid model or enable "Custom Model" option.`
                );
            }
        }
        
        const db = getDb();
        const record = llmConfigDb.createLLMConfig(db, {
            ...input,
            baseUrl: customProvider ? undefined : input.baseUrl || await this.resolveBaseUrl(input.providerId),
            apiKey: customProvider ? undefined : input.apiKey,
        });
        persistDatabase();

        this.logger.info('LLM config created', { 
            id: record.id, 
            name: record.name,
            providerId: record.providerId,
            baseUrl: record.baseUrl,
        });
        return record;
    }

    /**
     * 为自定义 Provider 创建模型配置（独立链路，不依赖 models.dev）
     */
    async createCustomModelConfig(input: {
        customProviderId: string;
        modelId: string;
        name?: string;
        temperature?: number;
        setActive?: boolean;
    }): Promise<LLMConfigRecord> {
        const customProvider = await this.resolveCustomProvider(input.customProviderId);
        if (!customProvider) {
            throw new Error(`Custom provider not found: ${input.customProviderId}`);
        }

        const modelId = input.modelId.trim();
        if (!modelId) {
            throw new Error('modelId is required for custom provider config creation.');
        }

        const record = await this.createConfig({
            name: input.name?.trim() || `${customProvider.name} / ${modelId}`,
            model: modelId,
            providerId: customProvider.id,
            temperature: input.temperature ?? 0.7,
            skipValidation: true,
        });

        if (input.setActive) {
            this.setActiveConfig(record.id);
        }

        this.logger.info('Custom provider model config created', {
            id: record.id,
            customProviderId: customProvider.id,
            modelId,
            setActive: input.setActive ?? false,
        });

        return record;
    }

    /**
     * 验证模型是否存在于 ModelRegistry
     * 
     * @param providerId - Provider ID (如 'anthropic')
     * @param modelId - 模型 ID (如 'claude-3-5-sonnet-20241022')
     * @param skipValidation - 是否跳过验证（用于自定义模型）
     * @returns 验证结果
     */
    async validateModel(
        providerId: string,
        modelId: string,
        skipValidation: boolean = false
    ): Promise<boolean> {
        if (skipValidation) return true;

        try {
            const models = await this.modelRegistry.getModels({ providerId });

            const exists = models.some(model => model.id === modelId);
            
            if (!exists) this.logger.warn('Model not found in registry', { providerId, modelId });
            
            return exists;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isRegistryUnavailable =
                errorMessage.includes('models.dev') ||
                errorMessage.includes('Network error') ||
                errorMessage.includes('no cache available') ||
                errorMessage.includes('internet connection');

            if (isRegistryUnavailable) {
                this.logger.warn('Model registry unavailable, skipping model validation', {
                    providerId,
                    modelId,
                    error: errorMessage,
                });
                return true;
            }

            this.logger.error('Model validation failed', { error, providerId, modelId });
            // 验证失败时返回 false，但不抛出异常
            return false;
        }
    }

    /**
     * 设置激活配置
     */
    setActiveConfig(id: number): void {
        const db = getDb();
        llmConfigDb.setActiveLLMConfig(db, id);
        persistDatabase();

        const record = llmConfigDb.getLLMConfig(db, id);
        this.logger.info('Active LLM config changed', { id, name: record?.name });
    }

    /**
     * 更新配置
     */
    async updateConfig(id: number, updates: Partial<LLMConfigInput>): Promise<void> {
        const db = getDb();
        const existing = llmConfigDb.getLLMConfig(db, id);
        if (!existing) {
            throw new Error(`LLM config not found: ${id}`);
        }

        const nextProviderId = updates.providerId ?? existing.providerId;
        const nextModel = updates.model ?? existing.model;
        if (!nextProviderId?.trim() || !nextModel.trim()) {
            throw new Error('Choose a Provider and nonempty model in Settings.');
        }
        const customProvider = await this.resolveCustomProvider(nextProviderId);

        if (nextProviderId?.startsWith('custom:') && !customProvider) {
            throw new Error(`Custom provider not found: ${nextProviderId}`);
        }

        if (customProvider && (updates.baseUrl !== undefined || updates.apiKey !== undefined)) {
            throw new Error('Set the endpoint and API key in the custom Provider settings.');
        }

        // 当 provider 或 model 发生变化时，重新校验模型
        if (!customProvider && (updates.providerId !== undefined || updates.model !== undefined)) {
            const isValid = await this.validateModel(nextProviderId, nextModel, false);
            if (!isValid) {
                throw new Error(
                    `Model "${nextModel}" not found in provider "${nextProviderId}". ` +
                    `Please select a valid model or use a supported custom model value.`
                );
            }
        }

        const mergedUpdates = { ...updates };
        if (nextProviderId !== existing.providerId) {
            mergedUpdates.baseUrl = customProvider ? '' : updates.baseUrl || await this.resolveBaseUrl(nextProviderId) || '';
            mergedUpdates.apiKey = updates.apiKey ?? '';
        }
        llmConfigDb.updateLLMConfig(db, id, mergedUpdates);
        persistDatabase();

        this.logger.info('LLM config updated', { id });
    }

    private async resolveBaseUrl(providerId: string): Promise<string | undefined> {
        try {
            const providerConfig = await this.modelRegistry.getProviderConfig(providerId);
            if (providerConfig.baseURL) {
                this.logger.info('Auto-filled baseUrl from ModelRegistry', {
                    providerId,
                    baseUrl: providerConfig.baseURL,
                });
                return providerConfig.baseURL;
            }
        } catch (error) {
            this.logger.warn('Failed to get baseUrl from ModelRegistry', {
                providerId,
                error,
            });
        }
    }

    /**
     * 删除配置
     */
    deleteConfig(id: number): void {
        const db = getDb();

        // 检查是否是激活配置
        const record = llmConfigDb.getLLMConfig(db, id);
        if (record?.isActive) {
            // 允许删除 active 配置，但先清除 active 状态
            // 这样用户就不需要先切换到另一个配置再删除
            this.logger.info('Deleting active config, clearing active state first', { id });
            
            // 清除所有配置的 active 状态
            const allConfigs = llmConfigDb.getAllLLMConfigs(db);
            allConfigs.forEach(config => {
                if (config.isActive) {
                    llmConfigDb.updateLLMConfig(db, config.id, { isActive: false });
                }
            });
        }

        llmConfigDb.deleteLLMConfig(db, id);
        persistDatabase();
        this.logger.info('LLM config deleted', { id });
    }

    async listCustomProviders(): Promise<CustomProviderRecord[]> {
        return this.customProviderStore.list();
    }

    async createCustomProvider(input: {
        name: string;
        baseUrl: string;
        protocol: CustomProviderProtocol;
        apiKey?: string;
        id?: string;
    }): Promise<CustomProviderRecord> {
        return this.customProviderStore.create(input);
    }

    async updateCustomProvider(
        id: string,
        updates: Partial<{
            name: string;
            baseUrl: string;
            protocol: CustomProviderProtocol;
            apiKey?: string;
        }>
    ): Promise<CustomProviderRecord> {
        return this.customProviderStore.update(id, updates);
    }

    async deleteCustomProvider(id: string): Promise<void> {
        return this.customProviderStore.delete(id);
    }

    private async resolveCustomProvider(providerId: string): Promise<CustomProviderRecord | null> {
        return providerId.startsWith('custom:') ? this.customProviderStore.getById(providerId) : null;
    }
}
