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

export function parseMcpServerItemKey(itemKey: unknown): string | null {
    if (typeof itemKey !== 'string' || !itemKey.startsWith(MCP_SERVER_ITEM_PREFIX)) {
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

export function isMcpToolItemKey(itemKey: unknown): itemKey is string {
    return typeof itemKey === 'string' && /^mcp-[a-zA-Z0-9_-]+-[a-zA-Z0-9_-]+$/.test(itemKey);
}

export function isMcpItemKey(itemKey: unknown): itemKey is string {
    return isMcpToolItemKey(itemKey) || parseMcpServerItemKey(itemKey) !== null;
}

export const MCP_PERMISSION_RECONFIGURE = 'MCP permissions need to be reconfigured. Select servers and tools again and save.';

export function hasInvalidMcpToolKeys(keys: unknown): boolean {
    return keys !== undefined && (!Array.isArray(keys) || keys.some(key => !isMcpToolItemKey(key)));
}
