const MCP_SERVER_ITEM_PREFIX = 'server:';
const MCP_TOOL_ITEM_PREFIX = 'mcp-';

// Application references always use registry keys, never display or package names.
export function appSourceControls(enabledApps: readonly string[], registeredApps: readonly string[]) {
    const selected = new Set(enabledApps);
    return {
        enabled: selected.size > 0,
        disabledItems: registeredApps.filter(name => !selected.has(name)),
    };
}

export function sanitizeMcpKeySegment(input: string): string {
    return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function buildMcpServerItemKey(serverName: string): string {
    return `${MCP_SERVER_ITEM_PREFIX}${serverName}`;
}

export function isMcpServerItemKey(itemKey: string): boolean {
    return itemKey.startsWith(MCP_SERVER_ITEM_PREFIX);
}

export function parseMcpServerItemKey(itemKey: string): string | null {
    if (!isMcpServerItemKey(itemKey)) {
        return null;
    }

    const serverName = itemKey.slice(MCP_SERVER_ITEM_PREFIX.length);
    return serverName.length > 0 ? serverName : null;
}

export function buildMcpToolItemKey(serverName: string, toolName: string): string {
    const sanitizedServer = sanitizeMcpKeySegment(serverName);
    const sanitizedTool = sanitizeMcpKeySegment(toolName);
    return `${MCP_TOOL_ITEM_PREFIX}${sanitizedServer}-${sanitizedTool}`;
}

export function buildMcpToolKeyPrefix(serverName: string): string {
    const sanitizedServer = sanitizeMcpKeySegment(serverName);
    return `${MCP_TOOL_ITEM_PREFIX}${sanitizedServer}-`;
}
