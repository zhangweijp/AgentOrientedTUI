import type { ModelMessage } from 'ai';

export const COMPACTION_TOOL_NAME = 'context_compact';

export function isCompactionAnchor(message: ModelMessage): boolean {
    return message.role === 'tool' && message.content.some(part => {
        if (part.type !== 'tool-result' || part.toolName !== COMPACTION_TOOL_NAME || part.output?.type !== 'json') return false;
        const value = part.output.value;
        return value !== null && typeof value === 'object' && 'success' in value && value.success === true;
    });
}
