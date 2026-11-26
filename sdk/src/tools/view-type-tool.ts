import { compileToolParameters, isInstanceName, isViewTypeName, type ViewMultiplicity, type ViewRegion } from '@aotui/core';
import { VIEW_TYPE_TOOL_PROTOCOL, type AppFrameBinding, type AppFrameView, type JsonValue, type ToolResult } from '@aotui/core';
import { exportToolSchema, schemaDeclarationError } from './schema-export.js';
import type { AuthorSchema, JsonSchemaObject, SchemaInput, StandardJSONSchemaV1 } from './schema-types.js';

export type { JsonSchemaObject } from './schema-types.js';
const emptyInputSchema = { type: 'object', properties: {}, additionalProperties: false } as const;
type ToolSchema = StandardJSONSchemaV1 | {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, unknown>> & { readonly view_id?: never };
};
type InputSchema<Schema> = [Extract<Schema, ToolSchema>] extends [never]
    ? typeof emptyInputSchema : Extract<Schema, ToolSchema>;
type ToolDeclaration = {
    readonly description: string;
    readonly inputSchema?: ToolSchema;
};
type ToolDeclarations = Readonly<Record<string, ToolDeclaration>>;
// An omitted schema leaves an unknown entry during inference without widening the other tools.
export type ToolSchemas = Readonly<Record<string, unknown>>;
type ContextInvocation<Input, Context> = { readonly input: Input; readonly context: Context };
export type ContextToolDeclarations<Context, Schemas extends ToolSchemas> = {
    readonly [Key in keyof Schemas]: {
        readonly description: string;
        readonly inputSchema?: Schemas[Key] & ToolSchema;
        readonly execute: (call: ContextInvocation<DeepReadonly<SchemaInput<InputSchema<NoInfer<Schemas[Key]>>>>, Context>) => ToolResult | Promise<ToolResult>;
        readonly enabled?: (context: Context) => boolean;
    };
};
export type ContextToolMetadata<Schemas extends ToolSchemas> = {
    readonly [Key in keyof Schemas]: { readonly description: string; readonly inputSchema: InputSchema<Schemas[Key]> };
};
declare const schemaType: unique symbol;
declare const contextType: unique symbol;
type ToolDefinition<Schema extends ToolSchema> = {
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
    readonly [schemaType]: Schema;
};

/** Shared immutable metadata. The schema witness is used only for author types. */
export interface ViewType<Tools extends ToolDeclarations = ToolDeclarations, Multiplicity extends ViewMultiplicity = ViewMultiplicity,
    Region extends ViewRegion | undefined = ViewRegion | undefined> {
    readonly name: string;
    readonly multiplicity: Multiplicity;
    readonly region: Region;
    readonly tools: { readonly [Key in keyof Tools]: ToolDefinition<InputSchema<Tools[Key]['inputSchema']>> };
}

/** A ViewType whose instances supply their own context for the declared tools. */
export interface ContextualViewType<Tools extends ToolDeclarations, Context extends object, Multiplicity extends ViewMultiplicity = ViewMultiplicity,
    Region extends ViewRegion | undefined = ViewRegion | undefined> extends ViewType<Tools, Multiplicity, Region> {
    readonly [contextType]: Context;
}

export type DeepReadonly<Value> = [JsonValue] extends [Value] ? Value : Value extends readonly unknown[]
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> } : Value;

export type ArgsOf<Definition> = Definition extends ToolDefinition<infer Schema>
    ? DeepReadonly<SchemaInput<Schema>> : never;

export type ViewContextProps<Definition extends ViewType> = Definition extends { readonly [contextType]: infer Context }
    ? { readonly context: Context }
    : { readonly context?: never };

const viewTypeWitness = Symbol.for('@aotui/sdk/view-type');
const contextToolsWitness = Symbol.for('@aotui/sdk/view-type/context-tools');
const descriptorSymbols = [viewTypeWitness, contextToolsWitness];
const definedTypes = new WeakMap<object, ViewType>();
const typeFields = new Set(['name', 'multiplicity', 'region', 'tools']);
const toolFields = new Set(['description', 'inputSchema']);
const bindingFields = new Set(['execute', 'enabled']);
const contextToolFields = new Set([...toolFields, ...bindingFields]);

type ContextTool = Readonly<{
    execute: (args: Parameters<AppFrameBinding['execute']>[0], context: object) => ReturnType<AppFrameBinding['execute']>;
    enabled?: (context: object) => boolean;
}>;

function fail(code: string, reason: string, path?: string): never {
    throw Object.assign(new TypeError(code + ': ' + reason), { code, reason, path });
}

function dataProperties(value: unknown, label: string, code: string, allowed?: ReadonlySet<string>, ignoredSymbols?: readonly symbol[]) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code, label + ' must be a plain object');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key === 'symbol' && ignoredSymbols?.includes(key)) continue;
        if (typeof key !== 'string' || (allowed && !allowed.has(key))) fail(code, label + ' has an unsupported field');
        const field = descriptors[key]!;
        if (!field.enumerable || !('value' in field)) fail(code, label + '.' + key + ' must be an enumerable data property');
        result.set(key, field.value);
    }
    return result;
}

export interface RefParameter<Schema extends AuthorSchema> {
    readonly 'x-aotui-ref-kind': string;
    readonly 'x-aotui-ref-value': Schema;
    readonly '~unsafe': SchemaInput<Schema>;
}

/** Declare an explicit Ref parameter. The handler receives its resolved read-only business value. */
export function refParam<const Schema extends AuthorSchema>(refType: string, valueSchema: Schema): RefParameter<Schema> {
    const declaration = {
        'x-aotui-ref-kind': refType,
        'x-aotui-ref-value': valueSchema,
    };
    // Retain the structural type witness when composing with TypeBox 1.4.
    return Object.defineProperty(declaration, '~unsafe', { value: null, configurable: true, writable: true }) as RefParameter<Schema>;
}

export type ViewTypeDeclaration<M extends ViewMultiplicity, R extends ViewRegion | undefined> = {
    readonly name: string;
    readonly multiplicity: M;
    readonly region?: R;
};

export type ViewNamingProps<Definition extends ViewType> = Definition['multiplicity'] extends 'single'
    ? { readonly id?: string; readonly idPrefix?: never }
    : Definition['multiplicity'] extends 'multiple'
        ? { readonly idPrefix?: string; readonly id?: never }
        : { readonly id?: string; readonly idPrefix?: string };
export type ViewRegionProps<Definition extends ViewType> = Definition['region'] extends ViewRegion
    ? { readonly region?: ViewRegion }
    : { readonly region: ViewRegion };

/** Declare tools that receive the context of the View that committed their binding. */
export function defineViewType<Context extends object>(): <const M extends ViewMultiplicity,
    const Schemas extends ToolSchemas, const R extends ViewRegion | undefined = undefined>(
    declaration: ViewTypeDeclaration<M, R> & { readonly tools?: ContextToolDeclarations<Context, Schemas> },
) => ContextualViewType<ContextToolMetadata<Schemas>, Context, M, R>;
/** Declare a ViewType without tools. */
export function defineViewType<const M extends ViewMultiplicity, const R extends ViewRegion | undefined = undefined>(
    declaration: ViewTypeDeclaration<M, R> & { readonly tools?: never },
): ViewType<{}, M, R>;
export function defineViewType(declaration?: unknown): unknown {
    return arguments.length === 0 ? (input: unknown) => captureType(input, 'context') : captureType(declaration, 'empty');
}

function captureType(declaration: unknown, source: 'empty' | 'context' | 'descriptor'): ViewType {
    const code = 'TOOL_DEFINITION_INVALID';
    const authored = source !== 'descriptor';
    const fields = dataProperties(declaration, 'ViewType', code, typeFields, authored ? undefined : descriptorSymbols);
    const name = fields.get('name');
    const multiplicity = fields.get('multiplicity'), region = fields.get('region');
    if (!isViewTypeName(name)) fail(code, 'ViewType.name must use ASCII letters, digits or underscores and contain an ASCII letter', 'ViewType.name');
    if (multiplicity !== 'single' && multiplicity !== 'multiple') fail(code, 'ViewType.multiplicity must be single or multiple', name + '.multiplicity');
    if (region !== undefined && region !== 'static' && region !== 'dynamic') fail(code, 'ViewType.region must be static or dynamic', name + '.region');
    const contextStamp = authored ? undefined : Object.getOwnPropertyDescriptor(declaration, contextToolsWitness);
    if (contextStamp && (contextStamp.enumerable || !('value' in contextStamp)))
        fail(code, name + ' has invalid context tools');
    const imported = contextStamp && dataProperties(contextStamp.value, name + ' context tools', code);
    const contextTools: Record<string, ContextTool> | undefined = source === 'context' || imported ? Object.create(null) : undefined;
    const tools = Object.create(null);
    if (source === 'empty' && fields.has('tools')) fail(code, 'Use defineViewType<Context>() to declare tools', name + '.tools');
    const declared = fields.has('tools') ? dataProperties(fields.get('tools'), 'ViewType.tools', code) : new Map<string, unknown>();
    if (source === 'descriptor' && (imported?.size ?? 0) !== declared.size)
        fail(code, name + ' has mismatched context tools');
    for (const [key, input] of declared) {
        const label = name + '.' + key;
        const tool = dataProperties(input, label, code, source === 'context' ? contextToolFields : toolFields);
        const description = tool.get('description');
        if (!key.trim() || typeof description !== 'string' || !description.trim()) fail(code, 'Tool name and description are required');
        if (contextTools) {
            const callbacks = imported ? dataProperties(imported.get(key), label, code, bindingFields) : tool;
            const execute = callbacks.get('execute');
            const enabled = callbacks.get('enabled');
            if (typeof execute !== 'function' || (callbacks.has('enabled') && typeof enabled !== 'function'))
                fail(code, label + ' requires execute and optional enabled functions', label);
            const authorExecute = execute as (call: ContextInvocation<Parameters<AppFrameBinding['execute']>[0], object>) => ReturnType<AppFrameBinding['execute']>;
            const run: ContextTool['execute'] = imported
                ? execute as ContextTool['execute']
                : (input, context) => authorExecute({ input, context });
            contextTools[key] = Object.freeze({
                execute: run,
                ...(enabled === undefined ? {} : { enabled: enabled as NonNullable<ContextTool['enabled']> }),
            });
        }
        const schema = authored && !tool.has('inputSchema') ? emptyInputSchema : tool.get('inputSchema');
        const compiled = compileToolParameters(authored ? exportToolSchema(schema) : schema);
        if (!compiled.ok) throw schemaDeclarationError(compiled.issue);
        tools[key] = Object.freeze({ description, inputSchema: compiled.contract.schema });
    }
    const result: ViewType = { name, region, multiplicity, tools: Object.freeze(tools) };
    Object.defineProperty(result, viewTypeWitness, { value: VIEW_TYPE_TOOL_PROTOCOL });
    // Same-version SDK copies can re-capture this local behavior alongside the static metadata.
    if (contextTools) Object.defineProperty(result, contextToolsWitness, { value: Object.freeze(contextTools) });
    const type = Object.freeze(result);
    definedTypes.set(type, type);
    return type;
}

function readViewType(type: ViewType): ViewType {
    const own = type && definedTypes.get(type);
    if (own) return own;
    // An App can import a descriptor produced by another copy of this SDK.
    const stamp = type && Object.getOwnPropertyDescriptor(type, viewTypeWitness);
    if (!stamp || !('value' in stamp) || stamp.value !== VIEW_TYPE_TOOL_PROTOCOL)
        fail('VIEW_TYPE_INVALID', 'Use defineViewType to declare each ViewType');
    const captured = captureType(type, 'descriptor');
    definedTypes.set(type, captured);
    return captured;
}

export function captureViewTypes(viewTypes: readonly ViewType[]): ReadonlyMap<string, ViewType> {
    if (!Array.isArray(viewTypes)) fail('VIEW_TYPE_INVALID', 'App requires a viewTypes array');
    const types = new Map<string, ViewType>();
    for (const input of viewTypes) {
        const type = readViewType(input);
        if (types.has(type.name)) fail('VIEW_TYPE_DUPLICATE', 'Duplicate ViewType ' + type.name);
        types.set(type.name, type);
    }
    return types;
}

export function requireViewType(types: ReadonlyMap<string, ViewType>, input: ViewType): ViewType {
    const type = readViewType(input);
    if (types.get(type.name) !== type) fail('VIEW_TYPE_INVALID', 'View type must use the App\'s declared descriptor');
    return type;
}

export function viewTypeDefinitions(types: ReadonlyMap<string, ViewType>) {
    return [...types.values()].map(({ name, multiplicity, tools }) => ({
        name, multiplicity, tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })),
    }));
}

export function captureViewPlacement(type: ViewType, options: {
    id?: string | undefined; idPrefix?: string | undefined; region?: ViewRegion | undefined; name?: string | undefined;
}): Pick<AppFrameView, 'id' | 'idPrefix' | 'region' | 'name'> {
    const { id, idPrefix, name } = options;
    const region = options.region === undefined ? type.region : options.region;
    const path = 'ViewType ' + type.name;
    if (region !== 'static' && region !== 'dynamic') fail('SNAPSHOT_INVALID', 'Set View region to static or dynamic', path + '.region');
    if (id !== undefined && (type.multiplicity !== 'single' || !isInstanceName(id)))
        fail('SNAPSHOT_INVALID', 'Only a single ViewType accepts an explicit valid id', path + '.id');
    if (idPrefix !== undefined && (type.multiplicity !== 'multiple' || !isInstanceName(idPrefix)))
        fail('SNAPSHOT_INVALID', 'Only a multiple ViewType accepts a valid idPrefix', path + '.idPrefix');
    return { region, ...(id === undefined ? {} : { id }), ...(idPrefix === undefined ? {} : { idPrefix }),
        ...(name === undefined ? {} : { name }) };
}

export function captureViewBindings(type: ViewType, id: string, context?: unknown): readonly AppFrameBinding[] {
    const code = 'TOOL_BINDING_INVALID';
    const contextTools: Record<string, ContextTool> | undefined = Object.getOwnPropertyDescriptor(type, contextToolsWitness)?.value;
    if (!contextTools || Object.keys(contextTools).length === 0) return [];
    if ((typeof context !== 'object' || context === null) && typeof context !== 'function')
        fail(code, 'Supply the instance context object for this ViewType', 'View ' + id + '.context');
    return Object.entries(contextTools).map(([name, { execute, enabled }]) => {
        const available = enabled === undefined ? true : enabled(context);
        if (typeof available !== 'boolean') {
            const path = 'View ' + id + '.' + name + '.enabled';
            fail(code, path + ' must return a boolean', path);
        }
        return Object.freeze({ name, enabled: available, execute: (args: Parameters<AppFrameBinding['execute']>[0]) => execute(args, context) });
    });
}
