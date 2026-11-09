/**
 * @aotui/host - SystemPromptDrivenSource
 * 
 * 系统提示词驱动源
 * 
 * 职责:
 * - 注入系统提示词，告诉 LLM 角色定位
 * - timestamp = 0，确保在所有消息之前
 * - 不提供 tools，不执行 toolCall
 * - setSystemPrompt 更新后通知，已捕获正文保持
 * 
 * 设计特点:
 * - **最高优先级**: timestamp=0，确保系统提示词排在第一位
 * - **单一职责**: 只负责系统提示词注入
 * - **捕获**: 每轮返回独立消息对象
 * - **执行**: 不提供工具执行器
 */

import type { ContextDrivenSource, DrivenSourceContext } from '@aotui/agent-driver-v2';

/**
 * SystemPromptDrivenSource 配置
 */
export interface SystemPromptConfig {
    /** 系统提示词内容 */
    systemPrompt: string;
    /** 可选的元数据 */
    metadata?: Record<string, unknown>;
}

/**
 * SystemPromptDrivenSource
 * 
 * 通过 DrivenSource 模式注入系统提示词
 * 
 * @example
 * ```typescript
 * const source = new SystemPromptDrivenSource({
 *   systemPrompt: `You are an AI assistant with access to a TUI desktop.
 * 
 * Your capabilities:
 * - Access and interact with applications
 * - Execute tools to manage files
 * - Use AOTUI IDE for code editing
 * 
 * Guidelines:
 * - Always confirm before destructive actions
 * - Provide clear explanations
 * - Respect user privacy`,
 *   metadata: {
 *     version: '1.0',
 *     locale: 'en-US',
 *   },
 * });
 * 
 * const { messages } = await source.getContext();
 * // [{ role: 'system', content: '...', timestamp: 0 }]
 * ```
 */
export class SystemPromptDrivenSource implements ContextDrivenSource {
    readonly name = 'SystemPrompt';
    
    private config: SystemPromptConfig;
    private listeners = new Set<() => void>();
    
    /**
     * 创建系统提示词驱动源
     * 
     * @param config - 配置对象
     */
    constructor(config: SystemPromptConfig) {
        this.config = config;
        
        // 验证系统提示词不为空
        if (!config.systemPrompt || config.systemPrompt.trim().length === 0) {
            throw new Error('SystemPromptDrivenSource: systemPrompt cannot be empty');
        }
    }
    
    /**
     * 获取消息
     * 
     * 返回单条系统消息，timestamp = 0
     * 
     * @returns 本轮 Context，包含单条系统消息和空工具
     */
    async getContext(): Promise<DrivenSourceContext> {
        try {
            return { messages: [{
                role: 'system',
                content: this.config.systemPrompt,
                timestamp: 0, // ✅ 确保第一位
                region: 'static',
            }], tools: {} };
        } catch (error) {
            console.error('Failed to capture context from SystemPrompt:', error);
            return { messages: [], tools: {} };
        }
    }

    /**
     * 动态更新系统提示词
     */
    setSystemPrompt(systemPrompt: string): void {
        const nextPrompt = systemPrompt?.trim();
        if (!nextPrompt) {
            throw new Error('SystemPromptDrivenSource: systemPrompt cannot be empty');
        }
        if (nextPrompt === this.config.systemPrompt) {
            return;
        }
        this.config = {
            ...this.config,
            systemPrompt: nextPrompt,
        };
        this.listeners.forEach((listener) => listener());
    }

    getSystemPrompt(): string {
        return this.config.systemPrompt;
    }
    
    /**
     * 订阅更新
     * 
     * 订阅 setSystemPrompt 的变化
     * 
     * @returns 空的取消订阅函数
     */
    onUpdate(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => {
            this.listeners.delete(callback);
        };
    }
    
    /**
     * 获取配置元数据
     * 
     * @returns 元数据对象
     */
    getMetadata(): Record<string, unknown> {
        return this.config.metadata || {};
    }
}
