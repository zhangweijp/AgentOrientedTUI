export type ToolTarget = Readonly<{ param: string; value: string }>;

export function captureToolTarget(value: unknown, support?: string): ToolTarget | undefined {
    if (value === undefined) return undefined;
    if (support !== 'argument-v1') throw new Error('TOOL_TARGET_UNSUPPORTED: Runtime must support View-local argument targets');
    if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error('TOOL_TARGET_INVALID: Expected { param, value }');
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).length !== 2 || !['param', 'value'].every(key => {
        const field = fields[key];
        return field?.enumerable && 'value' in field && typeof field.value === 'string' && field.value.length > 0;
    })) throw new Error('TOOL_TARGET_INVALID: param and value must be non-empty strings');
    return Object.freeze({ param: fields.param!.value, value: fields.value!.value });
}
