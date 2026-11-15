import Type from 'typebox';
import { compileOrdinarySchema, modelToolSchema, ordinaryParameterProfile, SnapshotDataError } from '@aotui/runtime/core';
import type { JsonValue } from '@aotui/runtime/core';
import type { AppFrameBinding, ToolResult, TUIAppFactory } from '@aotui/runtime/spi';
import { exportTypeBoxSchema, schemaDeclarationError, TypeBoxSchemaExportError } from './typebox-schema.js';

export type JsonSchemaObject = Readonly<Record<string, JsonValue>>;
export const SDK_VIEW_TYPE_PROTOCOL = 'view-type-tools-v5' satisfies TUIAppFactory['toolAuthoringProtocol'];
type ObjectSchema = Type.TSchema & { readonly type: 'object'; readonly properties: Type.TProperties };
type ToolDeclaration = {
    readonly description: string;
    readonly inputSchema: ObjectSchema;
    readonly execute?: never;
};
type ToolDeclarations = Readonly<Record<string, ToolDeclaration>>;
declare const schemaType: unique symbol;
type ToolDefinition<Schema extends ObjectSchema> = {
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
    readonly [schemaType]: Schema;
};

/** Shared immutable metadata. The schema witness is used only for author types. */
export interface ViewType<Tools extends ToolDeclarations = ToolDeclarations> {
    readonly name: string;
    readonly tools: { readonly [Key in keyof Tools]: ToolDefinition<Tools[Key]['inputSchema']> };
}

export type DeepReadonly<Value> = Value extends readonly unknown[]
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> } : Value;

export type ArgsOf<Definition> = Definition extends ToolDefinition<infer Schema>
    ? DeepReadonly<Type.Static<Schema>> : never;

export interface ToolBinding<Definition> {
    readonly execute: (args: ArgsOf<Definition>) => ToolResult | Promise<ToolResult>;
    readonly enabled?: boolean;
}

export type ViewBindings<Definition extends ViewType> = {
    readonly [Key in keyof Definition['tools']]: ToolBinding<Definition['tools'][Key]>;
};
export type ViewBindingProps<Definition extends ViewType> = keyof Definition['tools'] extends never
    ? { readonly bindings?: Readonly<Record<string, never>> }
    : { readonly bindings: ViewBindings<Definition> };

export interface ToolCatalogEntry {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
}

const viewTypeWitness = Symbol.for('@aotui/sdk/view-type');
const definedTypes = new WeakMap<object, ViewType>();
const typeFields = new Set(['name', 'tools']);
const toolFields = new Set(['description', 'inputSchema']);
const bindingFields = new Set(['execute', 'enabled']);

function fail(code: string, reason: string, path?: string): never {
    throw Object.assign(new TypeError(code + ': ' + reason), { code, reason, path });
}

function dataProperties(value: unknown, label: string, code: string, allowed?: ReadonlySet<string>, trustedWitness?: symbol) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code, label + ' must be a plain object');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
        if (key === trustedWitness) continue;
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

export function defineViewType<const Tools extends ToolDeclarations>(
    declaration: { readonly name: string; readonly tools: Tools },
): ViewType<Tools> {
    return captureType(declaration, true) as ViewType<Tools>;
}

function captureType(declaration: object, fromTypeBox: boolean): ViewType {
    const code = 'TOOL_DEFINITION_INVALID';
    const fields = dataProperties(declaration, 'ViewType', code, typeFields, fromTypeBox ? undefined : viewTypeWitness);
    const name = fields.get('name');
    if (typeof name !== 'string' || !name.trim()) fail(code, 'ViewType.name must be a non-empty string');
    const tools = Object.create(null);
    for (const [key, input] of dataProperties(fields.get('tools'), 'ViewType.tools', code)) {
        const tool = dataProperties(input, name + '.' + key, code, toolFields);
        const description = tool.get('description');
        if (!key.trim() || typeof description !== 'string' || !description.trim()) fail(code, 'Tool name and description are required');
        const schema = tool.get('inputSchema');
        const compiled = compileOrdinarySchema(fromTypeBox ? exportTypeBoxSchema(schema) : schema);
        if (!compiled.ok) throw schemaDeclarationError(compiled.issue);
        try {
            ordinaryParameterProfile(compiled.contract);
            modelToolSchema(compiled.contract.schema, name);
        } catch (error) {
            if (error instanceof SnapshotDataError && error.code === 'TOOL_SCHEMA_CAPACITY')
                throw new TypeBoxSchemaExportError(error.code, error.path, error.message);
            throw error;
        }
        tools[key] = Object.freeze({ description, inputSchema: compiled.contract.schema });
    }
    const result = { name, tools: Object.freeze(tools) };
    Object.defineProperty(result, viewTypeWitness, { value: SDK_VIEW_TYPE_PROTOCOL });
    const type = Object.freeze(result);
    definedTypes.set(type, type);
    return type;
}

function readViewType(type: ViewType): ViewType {
    const own = type && definedTypes.get(type);
    if (own) return own;
    // An App can import a descriptor produced by another copy of this SDK.
    const stamp = type && Object.getOwnPropertyDescriptor(type, viewTypeWitness);
    if (!stamp || !('value' in stamp) || stamp.value !== SDK_VIEW_TYPE_PROTOCOL)
        fail('VIEW_TYPE_INVALID', 'Use defineViewType to declare each ViewType');
    const captured = captureType(type, false);
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
        Object.entries(tools).map(([name, tool]) => ({ viewType, name, ...tool })));
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

export function captureViewBindings(type: ViewType, input: unknown, id: string): readonly AppFrameBinding[] {
    const code = 'TOOL_BINDING_INVALID';
    const label = 'View ' + id + '.bindings';
    const names = Object.keys(type.tools);
    const fields = dataProperties(input === undefined && names.length === 0 ? {} : input, label, code);
    if (fields.size !== names.length || names.some(name => !fields.has(name)))
        fail(code, label + ' must bind exactly ' + (names.join(', ') || 'no operations'), label);
    return names.map(name => {
        const definition = dataProperties(fields.get(name), label + '.' + name, code, bindingFields);
        const execute = definition.get('execute');
        const enabled = definition.has('enabled') ? definition.get('enabled') : true;
        if (typeof execute !== 'function' || typeof enabled !== 'boolean')
            fail(code, label + '.' + name + ' requires execute and optional boolean enabled', label);
        return Object.freeze({ name, execute: execute as AppFrameBinding['execute'], enabled });
    });
}
