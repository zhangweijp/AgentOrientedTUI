export const responsesUsage = {
    input_tokens: 11, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 18,
    vendor: { values: [0, null, false] },
};

export const googleUsage = {
    promptTokenCount: 11, candidatesTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 18, cachedContentTokenCount: 3,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }, { modality: 'IMAGE', tokenCount: 3 }],
    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 3 }, { modality: 'TEXT', tokenCount: 1 }],
    vendor: { values: [0, null, false] },
};

export function responsesFrames(terminal, text) {
    const item = { type: 'message', id: 'message-1' };
    return [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_text.delta', item_id: item.id, delta: text },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: terminal, response: { usage: responsesUsage,
            ...(terminal === 'response.incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } },
    ];
}

export function googleFrames(usage, text) {
    return [
        ...(usage ? [{ usageMetadata: { promptTokenCount: 1 } }, { usageMetadata: usage }] : []),
        { usageMetadata: null },
        { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] },
    ];
}
