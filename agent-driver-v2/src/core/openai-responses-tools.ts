import { isDeepStrictEqual } from 'node:util';
import { openai } from '@ai-sdk/openai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { asSchema, jsonSchema, type AssistantModelMessage, type JSONSchema7, type JSONValue, type ModelMessage, type Tool } from 'ai';
import type { LLMConfig } from './interfaces.js';
import { ProviderToolSchemaError } from './provider-tool-schema.js';

type LoadedFunction = {
    type: 'function';
    name: string;
    parameters: Record<string, JSONValue>;
    description?: string;
    strict?: boolean;
    defer_loading?: true;
};

function isObject(value: unknown): value is Record<string, JSONValue> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoadedFunction(value: unknown): value is LoadedFunction {
    return isObject(value) && value.type === 'function' && typeof value.name === 'string' && isObject(value.parameters) &&
        (value.description === undefined || typeof value.description === 'string') &&
        (value.strict === undefined || typeof value.strict === 'boolean') && value.defer_loading === undefined;
}

async function functionDefinition(name: string, tool: Tool, deferred = false): Promise<LoadedFunction> {
    const schema = await asSchema(tool.inputSchema).jsonSchema;
    return {
        type: 'function', name, parameters: structuredClone(schema) as unknown as Record<string, JSONValue>,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        ...(deferred ? { defer_loading: true } : {}),
    };
}

function additionalTools(tools: LoadedFunction[]): ModelMessage {
    return { role: 'system', content: '', providerOptions: { openai: { additionalTools: tools } } };
}

function restoreAdditionalToolNames(encoded: string, names: ReadonlyMap<string, string>): string {
    let body: unknown;
    try { body = JSON.parse(encoded); }
    catch { throw new ProviderToolSchemaError('OpenAI Responses', 'request', '$', 'Expected a JSON model request.'); }
    const pending = new Set(names.keys());
    if (isObject(body) && Array.isArray(body.input)) {
        if (Array.isArray(body.tools) && body.tools.some(tool => isObject(tool) && typeof tool.name === 'string' && names.has(tool.name))) {
            throw new ProviderToolSchemaError('OpenAI Responses', 'tool_search', '$.tools', 'A historical registration appeared in the current tool list.');
        }
        for (const item of body.input) {
            if (!isObject(item) || item.type !== 'additional_tools' || item.role !== 'developer' || !Array.isArray(item.tools)) continue;
            for (const tool of item.tools) {
                if (!isObject(tool) || tool.type !== 'function' || typeof tool.name !== 'string') continue;
                const name = names.get(tool.name);
                if (name === undefined) continue;
                if (!pending.delete(tool.name)) throw new ProviderToolSchemaError('OpenAI Responses', 'tool_search', '$.input', 'The encoder duplicated a historical tool definition.');
                tool.name = name;
            }
        }
    }
    if (pending.size) throw new ProviderToolSchemaError('OpenAI Responses', 'tool_search', '$.input', 'The encoder omitted a historical tool definition.');
    return JSON.stringify(body);
}

function withoutOpenAISearchHistory(messages: ModelMessage[]): ModelMessage[] {
    const calls = new Set<string>();
    for (const message of messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type === 'tool-call' && part.providerOptions?.openai?.aotuiToolSearch === true) calls.add(part.toolCallId);
        }
    }
    return messages.flatMap(message => {
        if ((message.role !== 'assistant' && message.role !== 'tool') || !Array.isArray(message.content)) return [message];
        const content = message.content.filter(part => {
            if (part.type === 'text' && part.text === '' && Array.isArray(part.providerOptions?.openai?.aotuiToolsLoaded)) return false;
            return !((part.type === 'tool-call' || part.type === 'tool-result') && part.toolName === 'tool_search' && calls.has(part.toolCallId));
        });
        if (content.length === message.content.length) return [message];
        return content.length ? [{ ...message, content } as ModelMessage] : [];
    });
}

export function recordOpenAIResponsesToolLoad(assistant: AssistantModelMessage | undefined,
    loaded: LoadedFunction[] | undefined): AssistantModelMessage | undefined {
    if (loaded === undefined || (!assistant && !loaded.length)) return assistant;
    const output = assistant ?? { role: 'assistant', content: '' };
    if (typeof output.content === 'string' && !loaded.length) return assistant;
    const content = typeof output.content === 'string' ? (output.content ? [{ type: 'text' as const, text: output.content }] : []) :
        output.content.map(part => part.type === 'tool-call' && part.toolName === 'tool_search' ? { ...part, providerOptions: {
            ...part.providerOptions, openai: { ...part.providerOptions?.openai, aotuiToolSearch: true },
        } } : part);
    if (loaded.length) content.unshift({ type: 'text', text: '', providerOptions: { openai: { aotuiToolsLoaded: loaded } } });
    return { ...output, content };
}

export async function prepareOpenAIResponsesInput(config: LLMConfig, messages: ModelMessage[], tools: Record<string, Tool>): Promise<{
    messages: ModelMessage[];
    tools: Record<string, Tool>;
    providerOptions?: ProviderOptions;
    openaiToolLoad?: LoadedFunction[];
    rewriteRequestBody?: (body: string) => string;
    /** Only registrations and positioned definitions actually created by this adapter may bypass the top-level list. */
    responsesForms?: {
        readonly registrationOnly: ReadonlySet<string>;
        readonly positioned: readonly (readonly LoadedFunction[])[];
        readonly clientCatalog: readonly LoadedFunction[];
    };
}> {
    const selection = config.provider.openaiResponsesTools;
    if (!selection) return { messages: withoutOpenAISearchHistory(messages), tools };
    if (Object.hasOwn(tools, 'tool_search')) throw new ProviderToolSchemaError('OpenAI Responses', 'tool_search', '$.tools', 'Tool search reserves this name.');

    const additional = new Set(selection.additionalTools);
    const deferred = new Set(selection.deferredTools);
    const registered = new Map(Object.entries(tools));
    const latest = new Map<string, LoadedFunction>();
    const history = messages.map(message => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return { message };
        const [first, ...content] = message.content;
        const aotuiToolsLoaded = first?.type === 'text' && first.text === '' ? first.providerOptions?.openai?.aotuiToolsLoaded : undefined;
        if (!Array.isArray(aotuiToolsLoaded)) return { message };
        const loaded = aotuiToolsLoaded.filter(isLoadedFunction).filter(tool => additional.has(tool.name));
        for (const tool of loaded) latest.set(tool.name, tool);
        return { message: { ...message, content }, loaded };
    });

    const clientCatalog: LoadedFunction[] = [];
    const registrationOnly = new Set<string>();
    const positioned: LoadedFunction[][] = [];
    const openaiToolLoad: LoadedFunction[] = [];
    for (const [name, tool] of Object.entries(tools)) {
        if (tool.type === 'provider') continue;
        if (additional.has(name) || deferred.has(name)) {
            const options = tool.providerOptions?.openai;
            if (options?.namespace !== undefined || options?.allowedCallers !== undefined || options?.async === true ||
                additional.has(name) && options?.deferLoading === true)
                throw new ProviderToolSchemaError('OpenAI Responses', name.slice(0,160), '$.tools',
                    'This function calling form cannot be preserved by positioned or deferred registration.');
        }
        if (additional.has(name)) {
            const current = await functionDefinition(name, tool);
            if (isDeepStrictEqual(current, latest.get(name))) continue;
            openaiToolLoad.push(current);
            latest.set(name, current);
        } else if (deferred.has(name)) {
            const openaiOptions = selection.search === 'hosted' ? { deferLoading: true } : { omitFromRequestTools: true };
            registered.set(name, { ...tool, providerOptions: { ...tool.providerOptions,
                openai: { ...tool.providerOptions?.openai, ...openaiOptions },
            } });
            if (selection.search === 'client') {
                clientCatalog.push(await functionDefinition(name, tool, true));
                registrationOnly.add(name);
            }
        }
    }

    // Encoder registrations have no execution routes. The Source separately owns all current bindings.
    const register = (name: string, { description, parameters, strict }: LoadedFunction) => {
        registrationOnly.add(name);
        registered.set(name, {
            inputSchema: jsonSchema(parameters as JSONSchema7), description, strict,
            providerOptions: { openai: { omitFromRequestTools: true } },
        });
    };
    for (const tool of latest.values()) register(tool.name, tool);
    const search = selection.search === 'hosted' ? openai.tools.toolSearch({ execution: 'server' }) :
        openai.tools.toolSearch({ execution: 'client', description: 'Load available tool definitions by their exact names.',
            parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } },
                required: ['names'], additionalProperties: false },
            execute: async ({ arguments: input }) => {
                const names = isObject(input) && Array.isArray(input.names) ? input.names : [];
                return { tools: clientCatalog.filter(tool => names.includes(tool.name)) };
            },
        });
    // Provider-utils patch releases use the same runtime schema symbol and distinct declaration symbols.
    registered.set('tool_search', search as unknown as Tool);

    const replay: ModelMessage[] = [], names = new Map<string, string>();
    let aliasNumber = 0;
    for (const { message, loaded } of history) {
        if (loaded?.length) {
            positioned.push(loaded);
            replay.push(additionalTools(loaded.map(tool => {
                if (isDeepStrictEqual(tool, latest.get(tool.name))) return tool;
                // AI SDK resolves positioned definitions by registered name. Give each older shape its own registration.
                let alias: string;
                do alias = 'aotui_previous_' + ++aliasNumber; while (registered.has(alias));
                names.set(alias, tool.name);
                register(alias, tool);
                return { ...tool, name: alias };
            })));
        }
        if (message.role !== 'assistant' || typeof message.content === 'string' || message.content.length > 0) replay.push(message);
    }
    if (openaiToolLoad.length) {
        positioned.push(openaiToolLoad);
        replay.push(additionalTools(openaiToolLoad));
    }
    return { messages: replay, tools: Object.fromEntries(registered),
        responsesForms: { registrationOnly, positioned, clientCatalog },
        providerOptions: { openai: { store: false, include: ['reasoning.encrypted_content'], parallelToolCalls: false } }, openaiToolLoad,
        ...(names.size ? { rewriteRequestBody: (encoded: string) => restoreAdditionalToolNames(encoded, names) } : {}),
    };
}
