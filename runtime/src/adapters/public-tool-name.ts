/** Native adapter aliases use three safe fields and two unambiguous separators. */
export function buildPublicToolName(appName: string, viewType: string, toolName: string): string {
    const invalid = (path: string, message: string): never => {
        throw Object.assign(new TypeError(`AOTUI_TOOL_NAME_INVALID: ${message}`), { code: 'AOTUI_TOOL_NAME_INVALID', path });
    };
    const parts: Array<[field: string, value: string]> = [
        ['appName', appName], ['viewType', viewType], ['toolName', toolName],
    ];
    for (const [field, part] of parts) {
        if (typeof part !== 'string' || !part.length) {
            invalid(field, `${field} must be a non-empty string. Use ASCII letters, digits, and underscores.`);
        }
        if (!/^[A-Za-z0-9_]+$/.test(part)) {
            invalid(field, `${field} must use only ASCII letters, digits, and underscores. Replace hyphens or other separators with underscores.`);
        }
    }
    const name = parts.map(([, value]) => value).join('-');
    if (name.length > 64) invalid('publicToolName', `the combined native Tool name has ${name.length} characters; shorten one or more fields to stay within 64.`);
    return name;
}
