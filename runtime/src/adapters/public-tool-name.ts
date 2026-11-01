/** The native Tool adapter contract; Core identities remain unrestricted. */
export function buildPublicToolName(appName: string, viewType: string, toolName: string): string {
    const parts = [appName, viewType, toolName];
    const name = parts.join('-');
    if (parts.some(part => typeof part !== 'string' || !part.length) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        throw new Error(`AOTUI_TOOL_NAME_INVALID: ${JSON.stringify(name)} (${name.length} characters). ` +
            'Declare appName-ViewType-toolName using only letters, digits, underscores and hyphens, with at most 64 characters in total.');
    }
    return name;
}
