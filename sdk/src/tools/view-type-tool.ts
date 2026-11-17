import Type from 'typebox';
import { compileToolParameters, modelToolSchema, SnapshotDataError } from '@aotui/runtime/core';
import type { JsonValue } from '@aotui/runtime/core';
import { VIEW_TYPE_TOOL_PROTOCOL, type AppFrameBinding, type ToolResult } from '@aotui/runtime/spi';
import { exportTypeBoxSchema, schemaDeclarationError, TypeBoxSchemaExportError } from './typebox-schema.js';

export type JsonSchemaObject = Readonly<Record<string, JsonValue>>;
const emptyInputSchema = Type.Object({}, { additionalProperties: false });
type ObjectSchema = Type.TSchema & {
    readonly type: 'object';
    readonly properties: Type.TProperties & { readonly view_id?: never };
};
type InputSchema<Schema> = [Extract<Schema, ObjectSchema>] extends [never]
    ? typeof emptyInputSchema : Extract<Schema, ObjectSchema>;
type ToolDeclaration = {
    readonly description: string;
    readonly inputSchema?: ObjectSchema;
};
type ToolDeclarations = Readonly<Record<string, ToolDeclaration>>;
// An omitted schema leaves an unknown entry during inference without widening the other tools.
type ToolSchemas = Readonly<Record<string, unknown>>;
type ContextInvocation<Input, Context> = { readonly input: Input; readonly context: Context };
type ContextToolDeclarations<Context, Schemas extends ToolSchemas> = {
    readonly [Key in keyof Schemas]: {
        readonly description: string;
        readonly inputSchema?: Schemas[Key] & ObjectSchema;
        readonly execute: (call: ContextInvocation<DeepReadonly<Type.Static<InputSchema<NoInfer<Schemas[Key]>>>>, Context>) => ToolResult | Promise<ToolResult>;
        readonly enabled?: (context: Context) => boolean;
    };
};
type ContextToolMetadata<Schemas extends ToolSchemas> = {
    readonly [Key in keyof Schemas]: { readonly description: string; readonly inputSchema: InputSchema<Schemas[Key]> };
};
declare const schemaType: unique symbol;
declare const contextType: unique symbol;
type ToolDefinition<Schema extends ObjectSchema> = {
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
    readonly [schemaType]: Schema;
};

/** Shared immutable metadata. The schema witness is used only for author types. */
export interface ViewType<Tools extends ToolDeclarations = ToolDeclarations> {
    readonly name: string;
    readonly tools: { readonly [Key in keyof Tools]: ToolDefinition<InputSchema<Tools[Key]['inputSchema']>> };
}

/** A ViewType whose instances supply their own context for the declared tools. */
export interface ContextualViewType<Tools extends ToolDeclarations, Context extends object> extends ViewType<Tools> {
    readonly [contextType]: Context;
}

export type DeepReadonly<Value> = Value extends readonly unknown[]
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> } : Value;

export type ArgsOf<Definition> = Definition extends ToolDefinition<infer Schema>
    ? DeepReadonly<Type.Static<Schema>> : never;

export type ViewContextProps<Definition extends ViewType> = Definition extends { readonly [contextType]: infer Context }
    ? { readonly context: Context }
    : { readonly context?: never };

export interface ToolCatalogEntry {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
}

const viewTypeWitness = Symbol.for('@aotui/sdk/view-type');
const contextToolsWitness = Symbol.for('@aotui/sdk/view-type/context-tools');
const descriptorSymbols = [viewTypeWitness, contextToolsWitness];
const definedTypes = new WeakMap<object, ViewType>();
const emptyTypeFields = new Set(['name']);
const typeFields = new Set(['name', 'tools']);
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

/** Declare an explicit Ref parameter. The handler receives its resolved read-only business value. */
export function refParam<Schema extends Type.TSchema>(refType: string, valueSchema: Schema): Type.TUnsafe<Type.Static<Schema>> {
    return Type.Unsafe<Type.Static<Schema>>(Type.String({
        minLength: 1,
        'x-aotui-ref-kind': refType,
        'x-aotui-ref-value': valueSchema,
    }));
}

/** Declare tools that receive the context of the View that committed their binding. */
export function defineViewType<Context extends object>(): <const Schemas extends ToolSchemas>(
    declaration: { readonly name: string; readonly tools: ContextToolDeclarations<Context, Schemas> },
) => ContextualViewType<ContextToolMetadata<Schemas>, Context>;
/** Declare a ViewType without tools. */
export function defineViewType(declaration: { readonly name: string; readonly tools?: never }): ViewType<{}>;
export function defineViewType(declaration?: unknown): unknown {
    return arguments.length === 0 ? (input: unknown) => captureType(input, 'context') : captureType(declaration, 'empty');
}

function captureType(declaration: unknown, source: 'empty' | 'context' | 'descriptor'): ViewType {
    const code = 'TOOL_DEFINITION_INVALID';
    const fromTypeBox = source !== 'descriptor';
    const fields = dataProperties(declaration, 'ViewType', code,
        source === 'empty' ? emptyTypeFields : typeFields, fromTypeBox ? undefined : descriptorSymbols);
    const name = fields.get('name');
    if (typeof name !== 'string' || !name.trim()) fail(code, 'ViewType.name must be a non-empty string');
    const contextStamp = fromTypeBox ? undefined : Object.getOwnPropertyDescriptor(declaration, contextToolsWitness);
    if (contextStamp && (contextStamp.enumerable || !('value' in contextStamp)))
        fail(code, name + ' has invalid context tools');
    const imported = contextStamp && dataProperties(contextStamp.value, name + ' context tools', code);
    const contextTools: Record<string, ContextTool> | undefined = source === 'context' || imported ? Object.create(null) : undefined;
    const tools = Object.create(null);
    const declared = source === 'empty' ? undefined : dataProperties(fields.get('tools'), 'ViewType.tools', code);
    if (source === 'descriptor' && (imported?.size ?? 0) !== declared!.size)
        fail(code, name + ' has mismatched context tools');
    for (const [key, input] of declared ?? []) {
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
        const schema = fromTypeBox && !tool.has('inputSchema') ? emptyInputSchema : tool.get('inputSchema');
        const compiled = compileToolParameters(fromTypeBox ? exportTypeBoxSchema(schema) : schema);
        if (!compiled.ok) throw schemaDeclarationError(compiled.issue);
        try {
            modelToolSchema(compiled.contract.schema, name);
        } catch (error) {
            if (error instanceof SnapshotDataError && error.code === 'TOOL_SCHEMA_CAPACITY')
                throw new TypeBoxSchemaExportError(error.code, error.path, error.message);
            throw error;
        }
        tools[key] = Object.freeze({ description, inputSchema: compiled.contract.schema });
    }
    const result = { name, tools: Object.freeze(tools) };
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

export function toolDefinitions(types: ReadonlyMap<string, ViewType>) {
    return [...types.values()].flatMap(({ name: viewType, tools }) =>
        Object.entries(tools).map(([name, { description, inputSchema }]) => ({ viewType, name, description, inputSchema })));
}

/** Static catalog. Dynamic receiver choices are added only to tools in a model request. */
export function getToolCatalog(viewTypes: readonly ViewType[]): readonly ToolCatalogEntry[] {
    return Object.freeze(toolDefinitions(captureViewTypes(viewTypes))
        .sort((a, b) => a.viewType === b.viewType ? compare(a.name, b.name) : compare(a.viewType, b.viewType))
        .map(tool => Object.freeze({ ...tool, inputSchema: modelToolSchema(tool.inputSchema, tool.viewType) })));
}

function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

export function captureViewBindings(type: ViewType, id: string, context?: unknown): readonly AppFrameBinding[] {
    const code = 'TOOL_BINDING_INVALID';
    const contextTools: Record<string, ContextTool> | undefined = Object.getOwnPropertyDescriptor(type, contextToolsWitness)?.value;
    if (!contextTools) return [];
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
