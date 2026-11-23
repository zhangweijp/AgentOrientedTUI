import type { LLMConfig } from './interfaces.js';
import { createLanguageModelWithChatFetch, isOpenAIResponsesEndpoint, resolveProviderEndpoint } from './provider-factory.js';

export interface ToolSchemaIssue {
    readonly path: string;
    readonly reason: string;
}

export interface ProviderToolSchemaPolicy {
    readonly label: string;
    readonly strict?: boolean;
    /** Present when the selected adapter or strict mode limits the supported vocabulary. */
    readonly check?: (schema: unknown) => ToolSchemaIssue | undefined;
}

export class ProviderToolSchemaError extends Error {
    readonly code = 'MODEL_TOOL_SCHEMA_UNSUPPORTED';
    readonly details: Readonly<ToolSchemaIssue & { provider: string; tool: string }>;
    constructor(readonly provider: string, readonly tool: string, readonly path: string, readonly reason: string) {
        super(`${provider} cannot encode ${tool} at ${path}: ${reason}`);
        this.name = 'ProviderToolSchemaError';
        this.details = Object.freeze({ provider, tool, path, reason });
    }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const child = (path: string, key: string) => /^[A-Za-z_$][\w$]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']';
const annotations = new Set(['description', 'title', '$schema']);
const types = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const common = new Set(['type', 'enum', 'anyOf', 'properties', 'required', 'additionalProperties', 'items']);
const numeric = new Set(['minimum', 'maximum', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum']);
const googleOpenApiKeywords = new Set(['type', 'enum', 'const', 'anyOf', 'allOf', 'oneOf', 'properties', 'required', 'items', 'format', 'minLength']);
type SchemaMode = 'openai' | 'deepseek' | 'google-openapi';
type EnumCount = { values: number; overflowPath?: string };

function checkSchema(schema: unknown, mode: SchemaMode, fineTuned = false): ToolSchemaIssue | undefined {
    const enums: EnumCount | undefined = mode === 'openai' ? { values: 0 } : undefined;
    const issue = walkSchema(schema, mode, fineTuned, '$', 0, enums);
    return issue ?? (enums?.overflowPath ? { path: enums.overflowPath,
        reason: `This tool schema uses ${enums.values} enum values. OpenAI strict allows 1000 per tool schema.` } : undefined);
}

function walkSchema(schema: unknown, mode: SchemaMode, fineTuned: boolean, path: string, nesting: number,
    enums: EnumCount | undefined): ToolSchemaIssue | undefined {
    const fail = (key: string, reason: string): ToolSchemaIssue => ({ path: key ? child(path, key) : path, reason });
    if (!record(schema)) return fail('', 'Expected a Schema object.');
    const google = mode === 'google-openapi';
    const type = schema.type;
    if (!google && path === '$' && (type !== 'object' || Object.hasOwn(schema, 'anyOf')))
        return fail(type === 'object' ? 'anyOf' : 'type', 'Strict mode requires an object at the root without anyOf.');
    if (type !== undefined && (typeof type !== 'string' || !types.has(type) || type === 'null' && mode === 'deepseek'))
        return fail('type', 'This type is outside the supported vocabulary for this mode.');
    if (Object.hasOwn(schema, 'prefixItems') || schema.items === false)
        return fail(Object.hasOwn(schema, 'prefixItems') ? 'prefixItems' : 'items', 'Fixed positions and a closed tuple cannot be encoded in this mode.');
    const childrenNesting = nesting + Number(type === 'object' || type === 'array');
    if (enums && childrenNesting > 10)
        return fail('', `This tool schema uses ${childrenNesting} levels of nesting. OpenAI strict allows 10.`);
    if (type === 'object' && !google) {
        if (schema.additionalProperties !== false) return fail('additionalProperties', 'Strict mode requires a closed object.');
        const required = new Set(Array.isArray(schema.required) ? schema.required : []);
        const absent = Object.keys(record(schema.properties) ? schema.properties : {}).find(key => !required.has(key));
        if (absent !== undefined) return { path: child(child(path, 'properties'), absent),
            reason: 'Strict mode requires this key. An absent key and a null value have different meanings.' };
    }
    if (google && schema.additionalProperties !== undefined && schema.additionalProperties !== true)
        return fail('additionalProperties', 'The installed Google encoder drops this object rule.');
    if (Array.isArray(schema.enum)) {
        if (schema.enum.some(value => value !== null && typeof value === 'object' || value === null && mode === 'deepseek'))
            return fail('enum', 'This mode has no documented encoding for these enum values.');
        if (enums) {
            enums.values += schema.enum.length;
            if (enums.values > 1000) enums.overflowPath ??= child(path, 'enum');
            if (schema.enum.length > 250) {
                const characters = schema.enum.reduce((total, value) => total + (typeof value === 'string' ? [...value].length : 0), 0);
                if (characters > 15_000)
                    return fail('enum', `This string enum uses ${characters} characters. OpenAI strict allows 15000 for an enum with more than 250 entries.`);
            }
        }
    }
    for (const key of Object.keys(schema)) {
        if (annotations.has(key)) continue;
        if (google) {
            if (key === 'additionalProperties' || googleOpenApiKeywords.has(key)) continue;
            return fail(key, 'The installed Google encoder does not preserve this rule.');
        }
        if (common.has(key)) continue;
        if (type === 'integer' || type === 'number') {
            if (mode === 'deepseek' && (key === 'const' || key === 'default') || !fineTuned && numeric.has(key)) continue;
        }
        if (type === 'string' && !fineTuned && (key === 'pattern' || key === 'format')) continue;
        if (type === 'array' && (key === 'minItems' || key === 'maxItems')) {
            if (mode === 'deepseek') return fail(key, `DeepSeek strict Beta does not support the array constraint ${key}.`);
            if (!fineTuned) continue;
        }
        return fail(key, 'This rule is outside the documented vocabulary for the selected mode.');
    }
    if (record(schema.properties)) for (const [key, property] of Object.entries(schema.properties)) {
        if (google && key === '__proto__') return { path: child(path + '.properties', key), reason: 'The installed encoder drops this property.' };
        const issue = walkSchema(property, mode, fineTuned, child(path + '.properties', key), childrenNesting, enums);
        if (issue) return issue;
    }
    if (schema.items !== undefined) {
        const issue = walkSchema(schema.items, mode, fineTuned, path + '.items', childrenNesting, enums);
        if (issue) return issue;
    }
    for (const keyword of google ? ['anyOf', 'allOf', 'oneOf'] : ['anyOf']) {
        const alternatives = schema[keyword];
        if (!Array.isArray(alternatives)) continue;
        for (const [index, alternative] of alternatives.entries()) {
            const issue = walkSchema(alternative, mode, fineTuned, path + '.' + keyword + '[' + index + ']', nesting, enums);
            if (issue) return issue;
        }
    }
}

async function googleEncodesJsonSchema(config: LLMConfig): Promise<boolean> {
    // The locked and npm-installed adapter versions can encode the same tool differently.
    // Observe this encoder locally, once per Driver, without contacting the endpoint.
    const probe = 'aotui_schema_probe';
    let encoded: boolean | undefined;
    const capture: typeof fetch = async (_url, request) => {
        const body = JSON.parse(String(request?.body));
        const declaration = body.tools?.flatMap((entry: { functionDeclarations?: unknown[] }) => entry.functionDeclarations ?? [])
            .find((entry: { name?: string }) => entry.name === probe);
        if (declaration) encoded = declaration.parametersJsonSchema !== undefined;
        throw new Error('Local tool schema probe completed');
    };
    const model = createLanguageModelWithChatFetch(config, capture, capture);
    try {
        await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Local tool schema probe' }] }],
            tools: [{ type: 'function', name: probe, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false } }] });
    } catch (error) { if (encoded === undefined) throw error; }
    if (encoded === undefined) throw new Error('The installed Google adapter did not encode a function schema.');
    return encoded;
}

/** Use the same policy to select candidates and to encode the final request. */
export async function createProviderToolSchemaPolicy(config: LLMConfig): Promise<ProviderToolSchemaPolicy> {
    const { id, toolSchemaMode } = config.provider;
    if (toolSchemaMode !== undefined && toolSchemaMode !== 'strict' && toolSchemaMode !== 'non-strict')
        throw new ProviderToolSchemaError(id, 'function tools', '$', 'Select strict or non-strict toolSchemaMode.');
    const strict = toolSchemaMode === 'strict';
    const { baseURL } = resolveProviderEndpoint(id, config.provider.baseURL);
    if (id === 'deepseek' && strict) {
        if (!baseURL?.replace(/\/$/, '').endsWith('/beta'))
            throw new ProviderToolSchemaError('DeepSeek strict Beta', 'function tools', '$', 'Use a base URL ending in /beta.');
    }
    if (id === 'openai' || id === 'deepseek') {
        const api = id === 'openai' ? (baseURL && !isOpenAIResponsesEndpoint(baseURL) ? 'OpenAI-compatible Chat' : 'OpenAI Responses') : 'DeepSeek Chat';
        const label = api + (strict ? id === 'deepseek' ? ' strict Beta' : ' strict' : ' non-strict');
        return Object.freeze({ label, strict, ...(strict ? { check: (schema: unknown) => checkSchema(schema, id, id === 'openai' && config.model.startsWith('ft:')) } : {}) });
    }
    if (strict) throw new ProviderToolSchemaError(id, 'function tools', '$', 'This Host has no verified strict tool encoding for this Provider.');
    if (id === 'google' && !await googleEncodesJsonSchema(config))
        return Object.freeze({ label: 'Google OpenAPI tool encoder', check: (schema: unknown) => checkSchema(schema, 'google-openapi') });
    return Object.freeze({ label: id });
}
