import type { JsonValue, ToolTargetSelector } from '../snapshot/types.js';

/** Inputs have already passed the bounded JSON copier. Never infer business fields. */
export function validTargetSelector(value: unknown, schema: JsonValue): value is ToolTargetSelector {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const selector = value as ToolTargetSelector;
    if (Object.keys(value).length !== 2 || typeof selector.param !== 'string' || !selector.param ||
        typeof selector.value !== 'string' || !selector.value) return false;
    const input = schema as { properties?: Record<string, { type?: string }>; required?: readonly string[] };
    return !!input?.properties && Object.hasOwn(input.properties, selector.param) &&
        input.properties[selector.param]?.type === 'string' && !Object.hasOwn(input.properties[selector.param]!, 'x-aotui-ref') &&
        Array.isArray(input.required) && input.required.includes(selector.param);
}
