import { tool, dynamicTool, jsonSchema, type ModelMessage, type ToolSet, type InferToolInput, type InferToolOutput } from 'ai';
import { z } from 'zod';
import { AgentDriverV2, createLanguageModel, type Tool, type DrivenSourceContext, type ContextDrivenSource, type AgentDriverV2Config } from '@aotui/agent-driver-v2';
import { SemanticAOTUIDrivenSource } from '@aotui/agent-driver-adapter';

type Expect<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Same<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const inputSchema = z.object({ mode: z.enum(['append','replace']), title: z.string(), count: z.number().optional() });
export const outputSchema = z.object({ done: z.boolean(), summary: z.string() });
export type Input = z.infer<typeof inputSchema>;
export type Output = z.infer<typeof outputSchema>;
export const apply = tool({
  inputSchema, outputSchema,
  description: 'Typed public tool', metadata: { source: 'SRT-06', revision: 1 },
  execute: async (input, options) => {
    const mode: 'append' | 'replace' = input.mode;
    const title: string = input.title;
    const callId: string = options.toolCallId;
    return { done: mode === 'append', summary: title + callId };
  },
  needsApproval: (input, options) => input.mode === 'replace' && options.toolCallId.length > 0,
  onInputAvailable: ({ input, toolCallId }) => { const value: string = input.title + toolCallId; void value; },
  toModelOutput: ({ input, output, toolCallId }) => ({ type: 'json', value: { summary: output.summary, title: input.title, callId: toolCallId } }),
});
export type AccurateInput = Expect<Same<InferToolInput<typeof apply>, Input>>;
export type AccurateOutput = Expect<Same<InferToolOutput<typeof apply>, Output>>;
export type InputNotAny = Expect<Same<IsAny<InferToolInput<typeof apply>>, false>>;
export type OutputNotAny = Expect<Same<IsAny<InferToolOutput<typeof apply>>, false>>;
export const noOutput: Tool<Input, never> = { inputSchema, execute: undefined, outputSchema: undefined, needsApproval: false };
export const schemaOnly: Tool<Input,Output> = { inputSchema, outputSchema };
export const dynamic = dynamicTool({ inputSchema: jsonSchema<unknown>({ type: 'object' }), execute: input => input, metadata: { source: 'dynamic' } });
export const provider: Tool<unknown, never> = { type: 'provider', id: 'test.server_tool', args: { version: 1 }, inputSchema: jsonSchema<unknown>({ type: 'object' }), supportsDeferredResults: true };
export const tools: ToolSet = { apply, noOutput, schemaOnly, dynamic, provider };
export const completeMessages: ModelMessage[] = [
  { role: 'system', content: 'System' },
  { role: 'user', content: [{ type: 'text', text: 'Message' }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'apply', input: { mode: 'append', title: 'A' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'apply', output: { type: 'json', value: { done: true } } }] },
];
export const context: DrivenSourceContext = {
  messages: [{ role: 'user', content: 'App', timestamp: 1 }], tools,
  adopt: async () => {}, release: async () => {},
  executeTool: async (toolName, args, toolCallId) => ({ toolName, toolCallId, outcomeStatus: 'succeeded', result: args }),
};
export const source: ContextDrivenSource = { name: 'public', getContext: async () => context, onUpdate: callback => { void callback; return () => {}; } };
export const config: AgentDriverV2Config = {
  sources: [source], llm: { model: 'openai:test', apiKey: 'LOCAL_TEST_ONLY' },
  onAssistantMessage: (message: ModelMessage) => { void message; },
  onToolResult: (message: ModelMessage) => { void message; },
};
export const createPublicDriver = () => new AgentDriverV2(config);
export const createPublicModel = () => createLanguageModel({ config: config.llm, target: { providerId: 'openai', modelName: 'test', registryModelId: 'openai:test' }, warn: () => {} });
export type AdapterMatchesSource = Expect<SemanticAOTUIDrivenSource extends ContextDrivenSource ? true : false>;

export type PortableModelV3 = Expect<Same<ReturnType<typeof createLanguageModel>['specificationVersion'], 'v3'>>;
