/** Capture only the trusted host field, before allocating or transferring ownership. */
export function captureToolsEnabled(options?: object): boolean | undefined {
    let retired = false;
    try {
        if (options === undefined) return undefined;
        retired = 'interactionModes' in options;
        if (!retired) {
            const field = Object.getOwnPropertyDescriptor(options, 'toolsEnabled');
            if (!field && !('toolsEnabled' in options)) return undefined;
            if (field?.enumerable && 'value' in field && (field.value === undefined || typeof field.value === 'boolean')) return field.value;
        }
    } catch { /* Invalid options or descriptors. */ }
    const message = retired ? 'interactionModes has been retired. Use toolsEnabled.'
        : 'toolsEnabled must be an own enumerable boolean data property.';
    throw Object.assign(new Error(message), { code: 'TOOLS_ENABLED_INVALID' });
}
