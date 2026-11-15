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
        const target = override
            ? await this.resolveModelSelection(override, active?.providerId)
            : active?.providerId
                ? { providerId: active.providerId, modelId: active.model }
                : active && await this.resolveModelSelection(active.model);
        if (!target) {
            throw new Error('No active LLM config found. Choose a Provider and model in Settings.');
        }
        const { providerId, modelId } = target;
        if (!providerId.trim() || providerId !== providerId.trim() || !modelId.trim()) {
            throw new Error('Choose a Provider and nonempty model in Settings.');
        }

        const custom = await this.resolveCustomProvider(providerId);
        if (providerId.startsWith('custom:') && !custom) {
            throw new Error(`Provider "${providerId}" is unavailable. Reselect the model in Settings.`);
        }
        const catalog = custom ? [] : await this.readCatalog(providerId);
        const rawModel = (value: string) => this.findCatalogModel(catalog, value)?.id ?? value;
        const model = rawModel(modelId);

        let record = active;
        if (override) {
            const records = this.getAllConfigs().filter(candidate => candidate.providerId === providerId);
            const sameProviderActive = active?.providerId === providerId ? active : undefined;
            record = sameProviderActive && rawModel(sameProviderActive.model) === model
                ? sameProviderActive
                : records.find(candidate => rawModel(candidate.model) === model) ?? sameProviderActive ?? records[0] ?? null;
        }

        const id = custom?.protocol ?? providerId;
        const configuredURL = custom?.baseUrl ?? (record?.baseUrl || await this.resolveBaseUrl(providerId));
        const { baseURL } = resolveProviderEndpoint(id, configuredURL);
        if (!baseURL) {
            throw new Error(`Provider "${providerId}" requires a baseURL. Set the endpoint or reselect the model in Settings.`);
        }
        if (custom && !custom.apiKey) {
            throw new Error(`API key not found for provider "${providerId}". Set its key in Settings.`);
        }
        return {
            model,
            provider: { id, baseURL },
            apiKey: custom ? custom.apiKey : record?.apiKey,
            temperature: record?.temperature,
            maxSteps: record?.maxSteps,
        };
    }

    private async resolveModelSelection(selection: string, activeProviderId?: string) {
        const explicit = parseModelSelection(selection);
        if (explicit) return explicit;

        if (!selection.startsWith('custom:')) {
            const slash = selection.indexOf('/');
            if (slash > 0) {
                const providerId = selection.slice(0, slash);
                const model = (await this.readCatalog(providerId)).find(candidate => candidate.catalogId === selection);
                if (model) return { providerId, modelId: model.id };
                if (activeProviderId && (await this.readCatalog(activeProviderId)).some(candidate => candidate.id === selection)) {
                    return { providerId: activeProviderId, modelId: selection };
                }
            } else if (activeProviderId && !selection.includes(':')) {
                return { providerId: activeProviderId, modelId: selection };
            }
        }
        throw new Error('Cannot resolve the Provider and model for this selection. Reselect the model in Settings.');
    }

    private async readCatalog(providerId: string) {
        try {
            return await this.modelRegistry.getModels({ providerId });
        } catch {
            return [];
        }
    }

    private findCatalogModel(models: Awaited<ReturnType<ModelRegistry['getModels']>>, value: string) {
        return models.find(model => model.id === value) ?? models.find(model => model.catalogId === value);
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
        maxSteps?: number;
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
            maxSteps: input.maxSteps ?? 10,
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
        if (skipValidation) {
            this.logger.debug('Model validation skipped', { providerId, modelId });
            return true;
        }

        try {
            const models = await this.modelRegistry.getModels({ providerId });

            const exists = this.findCatalogModel(models, modelId) !== undefined;
            
            if (exists) {
                this.logger.debug('Model validated successfully', { providerId, modelId });
            } else {
                this.logger.warn('Model not found in registry', { providerId, modelId });
            }
            
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
     * 获取模型的推荐配置
     * 
     * 根据模型能力（reasoning, tool_call）推荐合适的 temperature 和 maxSteps
     * 
     * @param providerId - Provider ID
     * @param modelId - 模型 ID
     * @returns 推荐的配置
     */
    async getModelRecommendedConfig(
        providerId: string,
        modelId: string
    ): Promise<{ temperature: number; maxSteps: number }> {
        try {
            const models = await this.modelRegistry.getModels({ providerId });

            // 查找模型（兼容 provider/model 与 vendor/model）
            const model = this.findCatalogModel(models, modelId);
            
            if (!model) {
                this.logger.debug('Model not found, using default config', { providerId, modelId });
                return { temperature: 0.7, maxSteps: 10 };
            }
            
            // 根据模型能力推荐配置
            let temperature = 0.7;
            let maxSteps = 10;
            
            // Reasoning 模型通常需要更低的 temperature 和更多的 steps
            if (model.reasoning) {
                temperature = 0.5;
                maxSteps = 20;
                this.logger.debug('Reasoning model detected, using lower temperature', {
                    modelId,
                    temperature,
                    maxSteps,
                });
            }
            
            // Tool-calling 模型可以使用标准配置
            if (model.tool_call && !model.reasoning) {
                temperature = 0.7;
                maxSteps = 10;
            }
            
            return { temperature, maxSteps };
        } catch (error) {
            this.logger.error('Failed to get model recommended config', { error, providerId, modelId });
            // 返回默认配置
            return { temperature: 0.7, maxSteps: 10 };
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
