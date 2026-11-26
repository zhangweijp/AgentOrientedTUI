import { jsonSchema, type AssistantModelMessage, type LanguageModel, type ModelMessage, type Tool, type ToolResultPart } from 'ai';

type ModelStream = Extract<LanguageModel, { specificationVersion: 'v3' }>['doStream'];
type RequestTool = NonNullable<Parameters<ModelStream>[0]['tools']>[number];
export type AnthropicSearchError = { type: 'tool_search_tool_result_error'; error_code: string; error_message?: string };

export function isAnthropicSearchTool(tool: RequestTool | Tool): boolean {
    return tool.type === 'provider' && (tool.id === 'anthropic.tool_search_regex_20251119' ||
        tool.id === 'anthropic.tool_search_bm25_20251119');
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSearchError(value: unknown): value is AnthropicSearchError {
    return record(value) && value.type === 'tool_search_tool_result_error' && typeof value.error_code === 'string';
}

export function captureAnthropicSearchError(frame: unknown, errors: Map<string, AnthropicSearchError>): void {
    if (!record(frame) || frame.type !== 'content_block_start') return;
    const block = frame.content_block;
    if (record(block) && block.type === 'tool_search_tool_result' && typeof block.tool_use_id === 'string' && isSearchError(block.content))
        errors.set(block.tool_use_id, block.content);
}

function searchError(part: ToolResultPart): AnthropicSearchError | undefined {
    const captured = part.providerOptions?.aotui?.anthropicSearchError;
    if (isSearchError(captured)) return captured;
    // Older saved messages contain the error in the SDK's normalized form.
    const { output } = part;
    if (output.type === 'error-json' && record(output.value) &&
        output.value.type === 'tool_search_tool_result_error' && typeof output.value.errorCode === 'string') {
        return { type: output.value.type, error_code: output.value.errorCode,
            ...(typeof output.value.errorMessage === 'string' ? { error_message: output.value.errorMessage } : {}) };
    }
}

/** A tool reference needs the definition even after the original Source stops offering it. */
export function recordAnthropicSearchTools(message: AssistantModelMessage, tools: readonly RequestTool[],
    rawErrors: ReadonlyMap<string, AnthropicSearchError>): AssistantModelMessage {
    if (!Array.isArray(message.content) || !tools.some(isAnthropicSearchTool)) return message;

    const definitions = new Map(tools.map(tool => [tool.name, tool]));
    const searches = new Map<string, RequestTool>();
    return { ...message, content: message.content.map(part => {
        if (part.type === 'tool-call' && part.providerExecuted) {
            const tool = definitions.get(part.toolName);
            if (tool && isAnthropicSearchTool(tool)) searches.set(part.toolCallId, tool);
        }
        if (part.type !== 'tool-result') return part;

        const search = searches.get(part.toolCallId);
        if (!search || search.name !== part.toolName) return part;
        const failure = rawErrors.get(part.toolCallId) ?? searchError(part);

        const referenced = new Set<RequestTool>([search]);
        const results = part.output.type === 'json' && Array.isArray(part.output.value) ? part.output.value : [];
        for (const reference of results) {
            if (record(reference) &&
                reference.type === 'tool_reference' && typeof reference.toolName === 'string') {
                const tool = definitions.get(reference.toolName);
                if (tool?.type === 'function') referenced.add(tool);
            }
        }
        // This JSON lives inside the saved result part. No handle, callback, or current Source is needed to replay it.
        const history = JSON.parse(JSON.stringify([...referenced]));
        return { ...part, providerOptions: {
            ...part.providerOptions, aotui: { ...part.providerOptions?.aotui, anthropicSearchTools: history,
                ...(failure ? { anthropicSearchError: failure } : {}) },
        } };
    }) };
}

/** Restore Provider declarations only. The Driver builds execution routes from live Contexts. */
export function includeAnthropicHistoryTools(messages: ModelMessage[], tools: Record<string, Tool>): Record<string, Tool> {
    const historical = new Map<string, Tool>();
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
        const message = messages[messageIndex];
        if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
        for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex--) {
            const part = message.content[partIndex];
            if (part.type !== 'tool-result') continue;
            const history = part.providerOptions?.aotui?.anthropicSearchTools;
            if (!Array.isArray(history)) continue;
            for (const entry of history) {
                if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
                    typeof entry.name !== 'string' || Object.hasOwn(tools, entry.name) || historical.has(entry.name)) continue;

                // Only the request tool data recorded by this Driver is required by the SDK encoder.
                const tool = entry as RequestTool;
                if (tool.type === 'provider' && isAnthropicSearchTool(tool)) {
                    historical.set(tool.name, { type: 'provider', id: tool.id, args: tool.args, inputSchema: jsonSchema({}) });
                } else if (tool.type === 'function' && tool.inputSchema && typeof tool.inputSchema === 'object') {
                    const { name, inputSchema, ...definition } = tool;
                    historical.set(name, { ...definition, inputSchema: jsonSchema(inputSchema) });
                }
            }
        }
    }
    return historical.size ? { ...tools, ...Object.fromEntries(historical) } : tools;
}

function replayError(id: string, failure: AnthropicSearchError): Error {
    return new Error(`Claude Messages could not encode the saved search result ${id} (${failure.error_code}).`);
}

export function prepareAnthropicSearchErrorReplay(messages: ModelMessage[]):
    { messages: ModelMessage[]; rewriteRequestBody: (body: string) => string } | undefined {
    const errors = new Map<string, AnthropicSearchError>();
    const prepared = messages.map((message): ModelMessage => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return message;
        const before = errors.size;
        const calls = new Map<string, string>();
        const content = message.content.map(part => {
            if (part.type === 'tool-call' && part.providerExecuted) calls.set(part.toolCallId, part.toolName);
            if (part.type !== 'tool-result' || calls.get(part.toolCallId) !== part.toolName) return part;
            const failure = searchError(part);
            if (!failure) return part;
            if (errors.has(part.toolCallId)) throw replayError(part.toolCallId, failure);
            errors.set(part.toolCallId, failure);

            // Let the SDK produce the native block at this exact position. The fetch hook restores its error content.
            return { ...part, output: { type: 'json' as const, value: [] } };
        });
        return errors.size === before ? message : { ...message, content };
    });
    if (!errors.size) return;

    return { messages: prepared, rewriteRequestBody(body) {
        const request: unknown = JSON.parse(body);
        const remaining = new Map(errors);
        for (const message of record(request) && Array.isArray(request.messages) ? request.messages : []) {
            if (!record(message) || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
            const calls = new Set<string>();
            for (const block of message.content) {
                if (!record(block)) continue;
                if (block.type === 'server_tool_use' && typeof block.id === 'string') calls.add(block.id);
                if (block.type !== 'tool_search_tool_result' || typeof block.tool_use_id !== 'string') continue;
                const id = block.tool_use_id;
                const failure = errors.get(id);
                if (!failure) continue;
                if (!calls.has(id) || !remaining.delete(id) || !record(block.content) ||
                    block.content.type !== 'tool_search_tool_search_result' ||
                    !Array.isArray(block.content.tool_references) || block.content.tool_references.length)
                    throw replayError(id, failure);
                block.content = failure;
            }
        }
        const [missing] = remaining;
        if (missing) throw replayError(...missing);
        return JSON.stringify(request);
    } };
}

/** The saved Claude blocks have no matching local result on a different Provider's wire format. */
export function withoutAnthropicSearchHistory(messages: ModelMessage[]): ModelMessage[] {
    return messages.flatMap((message): ModelMessage[] => {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) return [message];
        const searches = new Set(message.content.flatMap(part => part.type === 'tool-result' &&
            (Array.isArray(part.providerOptions?.aotui?.anthropicSearchTools) || searchError(part)) ? [part.toolCallId] : []));
        if (!searches.size) return [message];
        const content = message.content.filter(part => !(
            (part.type === 'tool-result' || (part.type === 'tool-call' && part.providerExecuted)) && searches.has(part.toolCallId)
        ));
        return content.length ? [{ ...message, content }] : [];
    });
}
