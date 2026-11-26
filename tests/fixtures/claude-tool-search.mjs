export const CLAUDE = 'claude-sonnet-4-5';
export const REGEX_SEARCH = 'tool_search_tool_regex';

export function foundTool(id, name) {
    return [
        { type: 'server_tool_use', id, name: REGEX_SEARCH, input: { pattern: name } },
        { type: 'tool_search_tool_result', tool_use_id: id, content: {
            type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: name }],
        } },
    ];
}

export function failedToolSearch(id, errorCode, errorMessage) {
    return [
        { type: 'server_tool_use', id, name: REGEX_SEARCH, input: { pattern: '(' } },
        { type: 'tool_search_tool_result', tool_use_id: id, content: {
            type: 'tool_search_tool_result_error', error_code: errorCode, error_message: errorMessage,
        } },
    ];
}

export function useTool(id, name, input) {
    return { type: 'tool_use', id, name, input };
}

export function claudeTurn(label, parts, beforeReply) {
    const calls = parts.some(part => part.type === 'tool_use');
    const frames = [
        { type: 'message_start', message: {
            type: 'message', role: 'assistant', id: 'msg_' + label.replaceAll(' ', '_'), model: CLAUDE,
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 },
        } },
    ];
    for (const [index, part] of parts.entries()) {
        const field = part.type === 'text' ? 'text' : part.type === 'tool_use' || part.type === 'server_tool_use' ? 'input' : undefined;
        const start = field === 'text' ? { ...part, text: '' } : field === 'input' ? { ...part, input: {} } : part;
        frames.push({ type: 'content_block_start', index, content_block: start });
        if (field === 'text') frames.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: part.text } });
        if (field === 'input') frames.push({ type: 'content_block_delta', index, delta: {
            type: 'input_json_delta', partial_json: JSON.stringify(part.input),
        } });
        frames.push({ type: 'content_block_stop', index });
    }
    frames.push({ type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 } }, { type: 'message_stop' });
    return { label, path: '/v1/messages', frames, beforeReply };
}

export function wireBlocks(body) {
    return body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
}
