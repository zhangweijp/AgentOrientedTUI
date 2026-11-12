import { ORDINARY_INVOCATION_MODE } from '@aotui/runtime/core';
import { VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/runtime/spi';
import Type from 'typebox';
import { compileOrdinarySchema } from '@aotui/runtime/core';
import type { JsonValue } from '@aotui/runtime/core';
import type { AppFrameTool, IAppTypeToolPort, ToolResult } from '@aotui/runtime/spi';
import { invokeOrdinaryParameterTool } from '../utils/ordinary-parameter-tool.js';
import { exportTypeBoxSchema, TypeBoxSchemaExportError } from './typebox-schema.js';

/** JSON values captured from TypeBox and normalized by Runtime. */
export type JsonSchemaValue = JsonValue;

export type JsonSchemaObject = Readonly<Record<string, JsonSchemaValue>>;

type TypeBoxObjectSchema = Type.TSchema & {
    readonly type: 'object';
    readonly properties: Type.TProperties;
};

export interface ViewTypeToolDeclaration<Schema extends TypeBoxObjectSchema> {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Schema;
    /** Retired from static declarations; handlers belong to App bindings. */
    readonly execute?: never;
}

declare const toolSchemaType: unique symbol;
declare const toolSetType: unique symbol;

/** Immutable static Tool metadata. The Schema witness exists only in its type. */
export interface DefinedViewTypeTool<Schema extends TypeBoxObjectSchema> {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
    readonly [toolSchemaType]: Schema;
}

export type ToolMap = Readonly<Record<string, DefinedViewTypeTool<TypeBoxObjectSchema>>>;

/** Immutable, type-preserving collection of static Tool definitions. */
export type ToolSet<Map extends ToolMap> = Readonly<Map> & {
    readonly [toolSetType]: Map;
};

export type SchemaOf<Definition> = Definition extends DefinedViewTypeTool<infer Schema> ? Schema : never;

export type DeepReadonly<Value> = Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> } : Value;

export type ArgsOf<Definition> = Definition extends DefinedViewTypeTool<infer Schema>
    ? DeepReadonly<Type.Static<Schema>>
    : never;

export type ToolSetMap<Definition> = Definition extends ToolSet<infer Map> ? Map : never;

export interface ToolCatalogEntry {
    readonly viewType: string;
    readonly name: string;
    readonly description: string;
    readonly inputSchema: JsonSchemaObject;
}

export type ToolCatalog = readonly ToolCatalogEntry[];

interface CapturedDefinition extends ToolCatalogEntry {
    readonly tupleKey: string;
}

const definitions = new WeakMap<object, CapturedDefinition>();
const toolSets = new WeakMap<object, readonly (readonly [string, CapturedDefinition])[]>();

const staticWitness = Symbol.for('@aotui/sdk/static-declaration');
const definitionVersion = '0.8.0-srt.1/p2a-tool';
const toolSetVersion = '0.8.0-srt.1/p2a-tool-set';

const definitionFields = new Set(['viewType', 'name', 'description', 'inputSchema']);

function codedError(code: string, reason: string, path?: string): TypeError & { readonly code: string } {
    const error = new TypeError(`${code}: ${reason}`) as TypeError & { readonly code: string };
    return Object.defineProperties(error, {
        code: { value: code, enumerable: true },
        reason: { value: reason },
        ...(path === undefined ? {} : { path: { value: path, enumerable: true } }),
    });
}

function fail(code: string, message: string, path?: string): never {
    throw codedError(code, message, path);
}

function plainDataProperties(
    value: unknown,
    label: string,
    allowed?: ReadonlySet<string>,
    code = 'TOOL_DEFINITION_INVALID',
    version?: string,
): Map<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(code, `${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(code, `${label} must not have a custom prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const witness = Object.getOwnPropertyDescriptor(value, staticWitness);
    if (version !== undefined && (!witness || !('value' in witness) ||
        witness.value !== version || witness.enumerable || !Object.isFrozen(value))) {
        fail(code, `${label} must be a supported SDK static declaration`);
    }
    const result = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
        if (key === staticWitness && version !== undefined) continue;
        if (typeof key !== 'string') fail(code, `${label} has a symbol property`);
        if (allowed && !allowed.has(key)) fail(code, `${label}.${key} is not supported`);
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !('value' in descriptor)) {
            fail(code, `${label}.${key} must be an enumerable data property`);
        }
        result.set(key, descriptor.value);
    }
    return result;
}

function nonEmptyString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail('TOOL_DEFINITION_INVALID', `${field} must be a non-empty string`);
    }
}

function captureOrdinarySchema(schema: unknown): JsonSchemaObject {
    const compiled = compileOrdinarySchema(schema, 'ref-value-specimen');
    if (!compiled.ok) {
        const code = compiled.issue.code === 'PARAMETER_DECLARATION_UNSUPPORTED'
            ? 'TOOL_SCHEMA_UNSUPPORTED'
            : 'TOOL_SCHEMA_INVALID';
        throw new TypeBoxSchemaExportError(code, compiled.issue.path, compiled.issue.message);
    }
    return compiled.contract.schema;
}

/**
 * Declares a Ref parameter whose handler receives the business value Schema.
 * Top-level fields may be required, optional, or arrays of Ref names.
 * Each selected Ref resolves to the declared JSON value.
 * Existing declaration capture and Runtime profiles validate this annotation.
 */
export function refParam<Schema extends Type.TSchema>(
    refType: string,
    valueSchema: Schema,
): Type.TUnsafe<Type.Static<Schema>> {
    return Type.Unsafe<Type.Static<Schema>>(Type.String({
        minLength: 1,
        'x-aotui-ref-kind': refType,
        'x-aotui-ref-value': valueSchema,
    }));
}

function captureDefinition(properties: Map<string, unknown>, fromTypeBox: boolean): CapturedDefinition {
    if (properties.size !== 4) {
        fail('TOOL_DEFINITION_INVALID', 'definition must contain viewType, name, description, inputSchema');
    }
    const viewType = properties.get('viewType');
    const name = properties.get('name');
    const description = properties.get('description');
    const inputSchema = properties.get('inputSchema');
    nonEmptyString(viewType, 'viewType');
    nonEmptyString(name, 'name');
    nonEmptyString(description, 'description');
    if (inputSchema === undefined) fail('TOOL_DEFINITION_INVALID', 'inputSchema is required');
    return Object.freeze({
        viewType, name, description,
        inputSchema: captureOrdinarySchema(fromTypeBox ? exportTypeBoxSchema(inputSchema) : inputSchema),
        tupleKey: JSON.stringify([viewType, name]),
    });
}

/** Capture one static Tool declaration; it does not register or own an App. */
export function defineViewTypeTool<const Schema extends TypeBoxObjectSchema>(
    declaration: ViewTypeToolDeclaration<Schema>,
): DefinedViewTypeTool<Schema> {
    const captured = captureDefinition(plainDataProperties(declaration, 'definition', definitionFields), true);
    const definition = {
        viewType: captured.viewType, name: captured.name,
        description: captured.description, inputSchema: captured.inputSchema,
    };
    Object.defineProperty(definition, staticWitness, { value: definitionVersion });
    definitions.set(definition, captured);
    return Object.freeze(definition) as DefinedViewTypeTool<Schema>;
}

function captureToolSet(properties: Map<string, unknown>) {
    const entries: Array<readonly [string, CapturedDefinition]> = [];
    const tuples = new Set<string>();
    for (const [key, value] of properties) {
        if (!key) fail('TOOL_SET_INVALID', 'ToolSet keys must not be empty');
        if (value === null || typeof value !== 'object') {
            fail('TOOL_SET_INVALID', `ToolSet.${key} must be created with defineViewTypeTool`);
        }
        let captured = definitions.get(value);
        if (!captured) {
            const fields = plainDataProperties(value, `ToolSet.${key}`, definitionFields, 'TOOL_SET_INVALID', definitionVersion);
            captured = captureDefinition(fields, false);
            definitions.set(value, captured);
        }
        if (tuples.has(captured.tupleKey)) {
            fail('TOOL_SET_DUPLICATE', `Duplicate ViewType Tool tuple (${captured.viewType}, ${captured.name})`);
        }
        tuples.add(captured.tupleKey);
        entries.push(Object.freeze([key, captured] as const));
    }
    return Object.freeze(entries);
}

function readToolSet(definition: unknown) {
    if (definition === null || typeof definition !== 'object') fail('TOOL_SET_INVALID', 'Expected a ToolSet');
    let entries = toolSets.get(definition);
    if (!entries) {
        entries = captureToolSet(plainDataProperties(definition, 'ToolSet', undefined, 'TOOL_SET_INVALID', toolSetVersion));
        toolSets.set(definition, entries);
    }
    return entries;
}

/** Capture and freeze a named mapping of definitions without registering them. */
export function defineToolSet<const Map extends ToolMap>(tools: Map): ToolSet<Map> {
    const properties = plainDataProperties(tools, 'ToolSet', undefined, 'TOOL_SET_INVALID');
    const entries = captureToolSet(properties);
    const toolSet = Object.assign(Object.create(null), Object.fromEntries(properties)) as ToolSet<Map>;
    Object.defineProperty(toolSet, staticWitness, { value: toolSetVersion });
    toolSets.set(toolSet, entries);
    return Object.freeze(toolSet);
}

/** Return the immutable, sorted four-field static descriptor list for a ToolSet. */
export function getToolCatalog<const Map extends ToolMap>(definition: ToolSet<Map>): ToolCatalog {
    const entries = readToolSet(definition);
    const sorted = [...entries].sort((left, right) => {
        const leftViewType = left[1].viewType;
        const rightViewType = right[1].viewType;
        if (leftViewType !== rightViewType) return leftViewType < rightViewType ? -1 : 1;
        const leftName = left[1].name;
        const rightName = right[1].name;
        return leftName === rightName ? 0 : leftName < rightName ? -1 : 1;
    });
    return Object.freeze(sorted.map(([, item]) => Object.freeze({
        viewType: item.viewType,
        name: item.name,
        description: item.description,
        inputSchema: item.inputSchema,
    })));
}


export interface ToolBinding<Definition> {
    readonly execute: (args: ArgsOf<Definition>) => ToolResult | Promise<ToolResult>;
    readonly enabled?: boolean;
}

export type ToolBindings<Map extends ToolMap> = {
    readonly [Key in keyof Map]: ToolBinding<Map[Key]>;
};

export type ExactBindings<Candidate, Map extends ToolMap> = Candidate extends ToolBindings<Map>
    ? Exclude<keyof Candidate, keyof Map> extends never
        ? { readonly [Key in keyof Map]: Key extends keyof Candidate
            ? Exclude<keyof Candidate[Key], keyof ToolBinding<Map[Key]>> extends never ? Candidate[Key] : never
            : never }
        : never
    : never;

const TOOL_BINDING_DIAGNOSTIC_LIMITS = Object.freeze({
    cleanupErrors: 8,
    labelCodeUnits: 64,
    messageCodeUnits: 256,
});

interface ToolBindingErrorSummary {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly truncated: boolean;
}

interface ToolBindingCleanupDiagnostic {
    readonly toolKey: string;
    readonly toolKeyTruncated: boolean;
    readonly error: ToolBindingErrorSummary;
}

interface ToolBindingDiagnostics {
    readonly original?: ToolBindingErrorSummary;
    readonly cleanupErrors: readonly ToolBindingCleanupDiagnostic[];
    readonly cleanupFailureCount: number;
    readonly omittedCleanupFailures: number;
}

type ToolBindingErrorCode = 'TOOL_BINDING_PORT_INVALID'
    | 'TOOL_BINDING_OWNER_CONFLICT' | 'TOOL_BINDING_UNAVAILABLE' | 'TOOL_BINDING_CLOSED'
    | 'TOOL_BINDING_COMMIT_FAILED' | 'TOOL_BINDING_CLEANUP_FAILED';

type ControllerState = 'created' | 'active' | 'committing' | 'closing' | 'failed' | 'disposed';
interface CapturedBinding {
    readonly execute: (args: Readonly<Record<string, unknown>>) => ToolResult | Promise<ToolResult>;
    readonly enabled: boolean;
}
interface OwnedBinding { readonly release: () => void; readonly token: object }
interface CleanupReport { count: number; errors: ToolBindingCleanupDiagnostic[] }
const portOwners = new WeakMap<IAppTypeToolPort, object>();
const bindingFields = new Set(['execute', 'enabled']);

// Read data descriptors only. The finite walk also handles a broken Proxy
// prototype chain without invoking an Error's message/name/code getters.
function diagnosticData(value: object, key: string): unknown {
    try {
        let current: object | null = value;
        for (let depth = 0; current !== null && depth < 8; depth++) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
            current = Object.getPrototypeOf(current);
        }
    } catch { /* An exception must not stop cleanup or diagnostic capture. */ }
    return undefined;
}

function summarizeError(value: unknown): ToolBindingErrorSummary {
    const limits = TOOL_BINDING_DIAGNOSTIC_LIMITS;
    const object = value !== null && (typeof value === 'object' || typeof value === 'function') ? value : undefined;
    const rawName = object ? diagnosticData(object, 'name') : typeof value;
    const rawMessage = object ? diagnosticData(object, 'message') : value;
    const rawCode = object ? diagnosticData(object, 'code') : undefined;
    const name = typeof rawName === 'string' ? rawName : 'Error';
    const message = typeof rawMessage === 'string' ? rawMessage : 'Exception details unavailable';
    const code = typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' ? String(rawCode) : undefined;
    return Object.freeze({
        name: name.slice(0, limits.labelCodeUnits),
        message: message.slice(0, limits.messageCodeUnits),
        ...(code === undefined ? {} : { code: code.slice(0, limits.labelCodeUnits) }),
        truncated: name.length > limits.labelCodeUnits || message.length > limits.messageCodeUnits ||
            (code !== undefined && code.length > limits.labelCodeUnits),
    });
}

function bindingFailure(code: ToolBindingErrorCode, original?: ToolBindingErrorSummary, cleanup?: CleanupReport) {
    const cleanupErrors = Object.freeze(cleanup?.errors ?? []);
    const diagnostics: ToolBindingDiagnostics = Object.freeze({
        ...(original === undefined ? {} : { original }),
        cleanupErrors,
        cleanupFailureCount: cleanup?.count ?? 0,
        omittedCleanupFailures: (cleanup?.count ?? 0) - cleanupErrors.length,
    });
    const error = codedError(code, 'Binding controller operation rejected; inspect diagnostics');
    return Object.defineProperty(error, 'diagnostics', { value: diagnostics, enumerable: true }) as
        TypeError & { readonly code: ToolBindingErrorCode; readonly diagnostics: ToolBindingDiagnostics };
}

function captureBindings(input: unknown, entries: readonly (readonly [string, CapturedDefinition])[]): ReadonlyMap<string, CapturedBinding> {
    const properties = plainDataProperties(input, 'bindings', undefined, 'TOOL_BINDING_INVALID');
    if (properties.size !== entries.length || entries.some(([key]) => !properties.has(key))) {
        fail('TOOL_BINDING_INVALID', 'bindings must contain exactly one entry for every ToolSet key', '$.bindings');
    }
    const result = new Map<string, CapturedBinding>();
    for (const [key] of entries) {
        const fields = plainDataProperties(properties.get(key), 'bindings.' + key, bindingFields, 'TOOL_BINDING_INVALID');
        const execute = fields.get('execute');
        if (typeof execute !== 'function' || (fields.has('enabled') && typeof fields.get('enabled') !== 'boolean')) {
            fail('TOOL_BINDING_INVALID', 'Each binding requires execute and optional boolean enabled');
        }
        result.set(key, Object.freeze({ execute: execute as CapturedBinding['execute'], enabled: fields.has('enabled') ? fields.get('enabled') as boolean : true }));
    }
    return result;
}

function toolRegistration(item: CapturedDefinition, current: () => CapturedBinding['execute'] | undefined): AppFrameTool {
    return {
        definition: { viewType: item.viewType, name: item.name, description: item.description, inputSchema: item.inputSchema },
        options: {
            safeOrdinaryParametersInvocationMode: ORDINARY_INVOCATION_MODE,
            createSafeOrdinaryParametersInvoker: contract => async args => {
                if (!current()) return {
                    phase: 'not-entered', result: { success: false,
                        error: { code: 'TOOL_UNAVAILABLE', message: 'Tool binding is not currently available' } },
                };
                let execute: CapturedBinding['execute'] | undefined;
                return invokeOrdinaryParameterTool(contract, args, value => execute!(value), () => {
                    execute = current();
                    return execute !== undefined;
                });
            },
        },
    };
}

/** A complete frame selects registrations and handlers before accepting either. */
export function createAppFrameTools(definition: unknown) {
    const entries = readToolSet(definition);
    let active: ReadonlyMap<string, CapturedBinding> | undefined;
    const registrations = entries.map(([key, item]) => [key, toolRegistration(item, () => {
        const binding = active?.get(key);
        return binding?.enabled ? binding.execute : undefined;
    })] as const);
    return {
        prepare(input: unknown) {
            const next = captureBindings(input === undefined && entries.length === 0 ? {} : input, entries);
            const tools = registrations.filter(([key]) => next.get(key)!.enabled).map(([, registration]) => registration);
            return { tools, accept() { active = next; } };
        },
        close() { active = undefined; },
    };
}

/** Preact captures bindings during render and adopts them only during commit. */
export function createToolBindings(definition: unknown, appPort: IAppTypeToolPort | undefined) {
    const entries = readToolSet(definition);
    if (!appPort || typeof appPort !== 'object' || Array.isArray(appPort) ||
        diagnosticData(appPort, 'protocol') !== VIEW_TYPE_TOOL_PROTOCOL) throw bindingFailure('TOOL_BINDING_PORT_INVALID');
    const register = diagnosticData(appPort, 'registerTypeTool');
    if (typeof register !== 'function') throw bindingFailure('TOOL_BINDING_PORT_INVALID');
    const registerTypeTool = register as IAppTypeToolPort['registerTypeTool'];
    const owner = Object.freeze({});
    const handles = new Map<string, OwnedBinding>();
    let state: ControllerState = 'created';
    let operation: object | undefined;
    let committed: ReadonlyMap<string, CapturedBinding> | undefined;
    let failedOriginal: ToolBindingErrorSummary | undefined;

    const releaseOwner = () => {
        if (portOwners.get(appPort) === owner) portOwners.delete(appPort);
    };
    const cleanupHandles = (): CleanupReport => {
        const report: CleanupReport = { count: 0, errors: [] };
        for (const [key, handle] of [...handles]) {
            try {
                handle.release();
                handles.delete(key);
            } catch (error) {
                report.count++;
                if (report.errors.length < TOOL_BINDING_DIAGNOSTIC_LIMITS.cleanupErrors) {
                    report.errors.push(Object.freeze({ toolKey: key.slice(0, TOOL_BINDING_DIAGNOSTIC_LIMITS.labelCodeUnits),
                        toolKeyTruncated: key.length > TOOL_BINDING_DIAGNOSTIC_LIMITS.labelCodeUnits, error: summarizeError(error) }));
                }
            }
        }
        return report;
    };
    const finishCleanup = (closing: boolean) => {
        if (handles.size === 0) {
            releaseOwner();
            failedOriginal = undefined;
            state = closing || state === 'closing' ? 'disposed' : 'failed';
        } else state = 'failed';
    };
    const assertCommitting = (token: object, phase: string) => {
        if (operation !== token || state !== 'committing') throw codedError('TOOL_BINDING_CLOSED', 'Controller closed during ' + phase);
    };
    const available = (key: string, token: object) => {
        if (state !== 'active' || operation !== undefined || handles.get(key)?.token !== token) return undefined;
        const binding = committed?.get(key);
        return binding?.enabled ? binding.execute : undefined;
    };

    const commit = (next: ReadonlyMap<string, CapturedBinding>): void => {
        if (operation !== undefined || (state !== 'created' && state !== 'active')) {
            throw bindingFailure('TOOL_BINDING_UNAVAILABLE', summarizeError(codedError('TOOL_BINDING_UNAVAILABLE',
                operation ? 'A synchronous binding operation is in progress' : 'Cannot commit while controller is ' + state)));
        }
        const currentOwner = portOwners.get(appPort);
        if (currentOwner !== undefined && currentOwner !== owner) throw bindingFailure('TOOL_BINDING_OWNER_CONFLICT');
        const token = Object.freeze({});
        operation = token;
        portOwners.set(appPort, owner);
        state = 'committing';
        try {
            for (const [key] of entries) {
                const handle = handles.get(key);
                if (!next.get(key)!.enabled && handle) {
                    handle.release();
                    handles.delete(key);
                    assertCommitting(token, 'release');
                }
            }
            for (const [key, item] of entries) {
                if (!next.get(key)!.enabled || handles.has(key)) continue;
                const registration = Object.freeze({});
                const tool = toolRegistration(item, () => available(key, registration));
                const release = registerTypeTool.call(appPort, tool.definition, tool.options);
                if (typeof release !== 'function') throw bindingFailure('TOOL_BINDING_PORT_INVALID');
                handles.set(key, { release, token: registration });
                assertCommitting(token, 'register');
            }
            assertCommitting(token, 'commit');
            committed = next;
            state = 'active';
        } catch (error) {
            const closing = (state as ControllerState) === 'closing';
            committed = undefined;
            state = closing ? 'closing' : 'failed';
            failedOriginal = summarizeError(error);
            const original = failedOriginal;
            const cleanup = cleanupHandles();
            finishCleanup(closing);
            const code = cleanup.count > 0 ? 'TOOL_BINDING_CLEANUP_FAILED'
                : closing || original.code === 'TOOL_BINDING_CLOSED' ? 'TOOL_BINDING_CLOSED' : 'TOOL_BINDING_COMMIT_FAILED';
            throw bindingFailure(code, original, cleanup);
        } finally {
            if (operation === token) operation = undefined;
        }
    };

    const dispose = (): void => {
        if (state === 'disposed') return;
        committed = undefined;
        state = 'closing';
        if (operation !== undefined) return;
        const token = Object.freeze({});
        operation = token;
        try {
            const original = failedOriginal;
            const cleanup = cleanupHandles();
            finishCleanup(true);
            if (cleanup.count > 0) throw bindingFailure('TOOL_BINDING_CLEANUP_FAILED', original, cleanup);
        } finally {
            if (operation === token) operation = undefined;
        }
    };
    return {
        prepare(input: unknown) {
            const next = captureBindings(input, entries);
            return () => commit(next);
        },
        dispose,
        get disposed() { return state === 'disposed'; },
    };
}
