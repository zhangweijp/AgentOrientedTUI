/**
 * @aotui/agent-driver-v2 - Main Entry Point
 */

export { AgentDriverV2 } from './core/agent-driver-v2.js';
export { ModelInputError } from './core/llm-client.js';
export { createLanguageModel, resolveProviderEndpoint } from './core/provider-factory.js';
export { createProviderToolSchemaPolicy, ProviderToolSchemaError, type ProviderToolSchemaPolicy, type ToolSchemaIssue } from './core/provider-tool-schema.js';
// Source adapters construct tools through the same AI SDK contract as Driver.
export { jsonSchema } from 'ai';
export type { LanguageModelUsage, Tool } from 'ai';
export type {
    ContextDrivenSource,
    DrivenSourceContext,
    MessageWithTimestamp,
    ToolResult,
    ToolOutcomeStatus,
    AgentDriverV2Config,
    LLMConfig,
    ModelInputLimits,
    ModelInputMeasurement,
    MeasureModelRequest,
    FittedModelRequest,
    ToolExecutionBudget,
} from './core/interfaces.js';
