/**
 * @aotui/agent-driver-v2 - Main Entry Point
 */

export { AgentDriverV2 } from './core/agent-driver-v2.js';
export { ModelInputError } from './core/llm-client.js';
export { createLanguageModel, resolveProviderEndpoint } from './core/provider-factory.js';
// Source adapters construct tools through the same AI SDK contract as Driver.
export { jsonSchema } from 'ai';
export type { Tool } from 'ai';
export type {
    ContextDrivenSource,
    DrivenSource,
    DrivenSourceContext,
    MessageWithTimestamp,
    ToolResult,
    ToolOutcomeStatus,
    AgentDriverV2Config,
    LLMConfig,
    ModelInputLimits,
} from './core/interfaces.js';
