/** Validate and join the fields used in a native Tool alias. */
export function buildPublicToolName(appName: string, ...parts: [toolName: string] | [viewType: string, toolName: string]): string {
    const invalid = (path: string, message: string): never => {
        throw Object.assign(new TypeError(`AOTUI_TOOL_NAME_INVALID: ${message}`), { code: 'AOTUI_TOOL_NAME_INVALID', path });
    };
    const fields: Array<[field: string, value: string]> = [['appName', appName]];
    if (parts.length === 2) fields.push(['viewType', parts[0]]);
    fields.push(['toolName', parts.length === 2 ? parts[1] : parts[0]]);
    for (const [field, part] of fields) {
        if (typeof part !== 'string' || !part.length) {
            invalid(field, `${field} must be a non-empty string. Use ASCII letters, digits, and underscores.`);
        }
        if (!/^[A-Za-z0-9_]+$/.test(part)) {
            invalid(field, `${field} must use only ASCII letters, digits, and underscores. Replace hyphens or other separators with underscores.`);
        }
    }
    const name = fields.map(([, value]) => value).join('-');
    if (name.length > 64) invalid('publicToolName', `the combined native Tool name has ${name.length} characters; shorten one or more fields to stay within 64.`);
    return name;
}
