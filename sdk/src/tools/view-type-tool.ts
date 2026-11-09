import { ORDINARY_INVOCATION_MODE } from '@aotui/runtime/core';
import { VIEW_TYPE_TOOL_PROTOCOL } from '@aotui/runtime/spi';
import Type from 'typebox';
import { compileOrdinarySchema } from '@aotui/runtime/core';
import type { ViewToolInvocationTerminal } from '@aotui/runtime/core';
import type { AppTypeToolDefinition, IAppTypeToolPort, ToolResult } from '@aotui/runtime/spi';
import { invokeOrdinaryParameterTool } from '../utils/ordinary-parameter-tool.js';
import { exportTypeBoxSchema, TypeBoxSchemaExportError } from './typebox-schema.js';

/** JSON values captured from TypeBox and normalized by Runtime. */
export type JsonSchemaValue = string | number | boolean | null
    | readonly JsonSchemaValue[]
    | { readonly [key: string]: JsonSchemaValue };

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
declare const toolBindingSchemaType: unique symbol;

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

const definitionFields = new Set(['viewType', 'name', 'description', 'inputSchema']);

function codedError(code: string, message: string): TypeError & { readonly code: string } {
    const error = new TypeError(`${code}: ${message}`) as TypeError & { readonly code: string };
    Object.defineProperty(error, 'code', { value: code, enumerable: true });
    return error;
}

function fail(code: string, message: string): never {
    throw codedError(code, message);
}

function plainDataProperties(
    value: unknown,
    label: string,
    allowed?: ReadonlySet<string>,
    code = 'TOOL_DEFINITION_INVALID',
): Map<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(code, `${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        fail(code, `${label} must not have a custom prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
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

function freezeJson(value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) freezeJson(child);
        Object.freeze(value);
    }
    return value;
}

function captureOrdinarySchema(typeBoxSchema: unknown): JsonSchemaObject {
    const exported = exportTypeBoxSchema(typeBoxSchema);
    const compiled = compileOrdinarySchema(exported, 'ref-value-specimen');
    if (!compiled.ok) {
        const code = compiled.issue.code === 'PARAMETER_DECLARATION_UNSUPPORTED'
            ? 'TOOL_SCHEMA_UNSUPPORTED'
            : 'TOOL_SCHEMA_INVALID';
        throw new TypeBoxSchemaExportError(code, compiled.issue.path, compiled.issue.message);
    }
    return freezeJson(compiled.contract.schema) as JsonSchemaObject;
}

/**
 * Declares a Ref parameter whose handler receives the business value Schema.
 * Top-level fields may be required, optional, or arrays of Ref names.
 * Each selected Ref resolves to the declared object or object-list value.
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

/** Capture one static Tool declaration; it does not register or own an App. */
export function defineViewTypeTool<const Schema extends TypeBoxObjectSchema>(
    declaration: ViewTypeToolDeclaration<Schema>,
): DefinedViewTypeTool<Schema> {
    const properties = plainDataProperties(declaration, 'definition', definitionFields);
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

    const capturedSchema = captureOrdinarySchema(inputSchema);
    const captured: CapturedDefinition = Object.freeze({
        viewType,
        name,
        description,
        inputSchema: capturedSchema,
        tupleKey: JSON.stringify([viewType, name]),
    });
    const definition = Object.freeze({
        viewType: captured.viewType,
        name: captured.name,
        description: captured.description,
        inputSchema: captured.inputSchema,
    }) as DefinedViewTypeTool<Schema>;
    definitions.set(definition, captured);
    return definition;
}

/** Capture and freeze a named mapping of definitions without registering them. */
export function defineToolSet<const Map extends ToolMap>(tools: Map): ToolSet<Map> {
    const properties = plainDataProperties(tools, 'ToolSet', undefined, 'TOOL_SET_INVALID');
    const capturedTools: Record<string, DefinedViewTypeTool<TypeBoxObjectSchema>> = Object.create(null);
    const entries: Array<readonly [string, CapturedDefinition]> = [];
    const tuples = new Set<string>();
    for (const [key, value] of properties) {
        if (key.length === 0) fail('TOOL_SET_INVALID', 'ToolSet keys must not be empty');
        if (value === null || typeof value !== 'object') {
            fail('TOOL_SET_INVALID', `ToolSet.${key} must be created with defineViewTypeTool`);
        }
        const captured = definitions.get(value);
        if (!captured) fail('TOOL_SET_INVALID', `ToolSet.${key} must be created with defineViewTypeTool`);
        if (tuples.has(captured.tupleKey)) {
            fail('TOOL_SET_DUPLICATE', `Duplicate ViewType Tool tuple (${captured.viewType}, ${captured.name})`);
        }
        tuples.add(captured.tupleKey);
        capturedTools[key] = value as DefinedViewTypeTool<TypeBoxObjectSchema>;
        entries.push(Object.freeze([key, captured] as const));
    }
    const toolSet = Object.freeze(capturedTools) as ToolSet<Map>;
    toolSets.set(toolSet, Object.freeze(entries));
    return toolSet;
}

/** Return the immutable, sorted four-field static descriptor list for a ToolSet. */
export function getToolCatalog<const Map extends ToolMap>(definition: ToolSet<Map>): ToolCatalog {
    const entries = toolSets.get(definition as object);
    if (!entries) fail('TOOL_SET_INVALID', 'ToolSet must be created with defineToolSet');
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

export interface ToolBindingController<Map extends ToolMap> {
    /** Type-only invariant witness: a controller keeps its original declaration map. */
    readonly [toolBindingSchemaType]: (map: Map) => Map;
    commit<const Candidate extends ToolBindings<Map>>(bindings: Candidate & ExactBindings<Candidate, Map>): void;
    dispose(): void;
}

export const TOOL_BINDING_DIAGNOSTIC_LIMITS = Object.freeze({
    cleanupErrors: 8,
    labelCodeUnits: 64,
    messageCodeUnits: 256,
});

export interface ToolBindingErrorSummary {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly truncated: boolean;
}

export interface ToolBindingCleanupDiagnostic {
    readonly toolKey: string;
    readonly toolKeyTruncated: boolean;
    readonly error: ToolBindingErrorSummary;
}

export interface ToolBindingDiagnostics {
    readonly original?: ToolBindingErrorSummary;
    readonly cleanupErrors: readonly ToolBindingCleanupDiagnostic[];
    readonly cleanupFailureCount: number;
    readonly omittedCleanupFailures: number;
}

export type ToolBindingErrorCode = 'TOOL_BINDING_INVALID' | 'TOOL_BINDING_PORT_INVALID'
    | 'TOOL_BINDING_OWNER_CONFLICT' | 'TOOL_BINDING_UNAVAILABLE' | 'TOOL_BINDING_CLOSED'
    | 'TOOL_BINDING_COMMIT_FAILED' | 'TOOL_BINDING_CLEANUP_FAILED';

type ControllerState = 'created' | 'active' | 'committing' | 'closing' | 'failed' | 'disposed';
const controllerStates = new WeakMap<object, () => ControllerState>();

/** Internal adapter check: a reentrant void dispose can still be closing. */
export function isToolBindingDisposed(controller: object): boolean {
    return controllerStates.get(controller)?.() === 'disposed';
}
interface CapturedBinding {
    readonly execute: (args: Readonly<Record<string, unknown>>) => ToolResult | Promise<ToolResult>;
    readonly enabled: boolean;
}
interface OwnedBinding { readonly release: () => void; readonly token: object }
interface CleanupReport { count: number; errors: ToolBindingCleanupDiagnostic[] }
const portOwners = new WeakMap<IAppTypeToolPort, object>();
const bindingFields = new Set(['execute', 'enabled']);
const controllerFields = new Set(['definition', 'appTypeTools']);

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
        fail('TOOL_BINDING_INVALID', 'bindings must contain exactly one entry for every ToolSet key');
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

/** Internal Preact preparation: the same descriptor capture used by commit. */
export function captureToolBindingsForRender<Candidate>(definition: unknown, input: Candidate) {
    const entries = definition !== null && typeof definition === 'object' ? toolSets.get(definition) : undefined;
    if (!entries) fail('TOOL_SET_INVALID', 'definition must be created with defineToolSet');
    const frame = captureBindings(input, entries);
    return Object.freeze({
        bindings: Object.freeze(Object.fromEntries(frame)) as Candidate,
        enabled: new Map([...frame].map(([key, value]) => [key, value.enabled])),
    });
}

/** Internal presentation lookup; a copied definition is not a member. */
export function toolSetKey(definition: unknown, tool: unknown): string | undefined {
    if (definition === null || typeof definition !== 'object' || !toolSets.has(definition)) return undefined;
    const set = definition as Readonly<Record<string, unknown>>;
    return Object.keys(set).find(key => set[key] === tool);
}

/** Bind one static ToolSet to one App port; construction has no registry effects. */
export function createToolBindings<const Map extends ToolMap>(options: {
    readonly definition: ToolSet<Map>;
    readonly appTypeTools: IAppTypeToolPort;
}): ToolBindingController<Map> {
    const properties = plainDataProperties(options, 'createToolBindings', controllerFields, 'TOOL_BINDING_INVALID');
    const definition = properties.get('definition');
    const port = properties.get('appTypeTools');
    const entries = definition !== null && typeof definition === 'object' ? toolSets.get(definition) : undefined;
    if (!entries) fail('TOOL_SET_INVALID', 'definition must be created with defineToolSet');
    if (port === null || typeof port !== 'object' || Array.isArray(port) ||
        diagnosticData(port, 'protocol') !== VIEW_TYPE_TOOL_PROTOCOL) throw bindingFailure('TOOL_BINDING_PORT_INVALID');
    const register = diagnosticData(port, 'registerTypeTool');
    if (typeof register !== 'function') throw bindingFailure('TOOL_BINDING_PORT_INVALID');
    const appPort = port as IAppTypeToolPort;
    const registerTypeTool = register as IAppTypeToolPort['registerTypeTool'];
    const owner = Object.freeze({});
    const handles = new Map<string, OwnedBinding>();
    let ownerHeld = false;
    let state: ControllerState = 'created';
    let operation: object | undefined;
    let committed: ReadonlyMap<string, CapturedBinding> | undefined;
    let failedOriginal: ToolBindingErrorSummary | undefined;

    const releaseOwner = () => {
        if (ownerHeld && portOwners.get(appPort) === owner) portOwners.delete(appPort);
        ownerHeld = false;
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
    const unavailable = (): ViewToolInvocationTerminal => ({
        phase: 'not-entered', result: { success: false, error: { code: 'TOOL_UNAVAILABLE', message: 'Tool binding is not currently available' } },
    });

    const commit = (candidate: unknown): void => {
        if (operation !== undefined || (state !== 'created' && state !== 'active')) {
            throw bindingFailure('TOOL_BINDING_UNAVAILABLE', summarizeError(codedError('TOOL_BINDING_UNAVAILABLE',
                operation ? 'A synchronous binding operation is in progress' : 'Cannot commit while controller is ' + state)));
        }
        const token = Object.freeze({});
        operation = token;
        let next: ReadonlyMap<string, CapturedBinding> | undefined;
        let registryEntered = false;
        try {
            next = captureBindings(candidate, entries);
            if (state !== 'created' && state !== 'active') throw codedError('TOOL_BINDING_CLOSED', 'Controller closed during prepare');
            const currentOwner = portOwners.get(appPort);
            if (currentOwner !== undefined && currentOwner !== owner) throw bindingFailure('TOOL_BINDING_OWNER_CONFLICT');
            portOwners.set(appPort, owner);
            ownerHeld = true;
            state = 'committing';
            registryEntered = true;
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
                const runtimeDefinition: AppTypeToolDefinition = {
                    viewType: item.viewType, name: item.name, description: item.description,
                    inputSchema: item.inputSchema, 
                };
                const release = registerTypeTool.call(appPort, runtimeDefinition, {
                    safeOrdinaryParametersInvocationMode: ORDINARY_INVOCATION_MODE,
                    createSafeOrdinaryParametersInvoker: contract => async args => {
                        if (!available(key, registration)) return unavailable();
                        let execute: CapturedBinding['execute'] | undefined;
                        return invokeOrdinaryParameterTool(contract, args, value => execute!(value), () => {
                            execute = available(key, registration);
                            return execute !== undefined;
                        });
                    },
                });
                if (typeof release !== 'function') throw bindingFailure('TOOL_BINDING_PORT_INVALID');
                handles.set(key, { release, token: registration });
                assertCommitting(token, 'register');
            }
            assertCommitting(token, 'commit');
            committed = next;
            state = 'active';
        } catch (error) {
            const original = summarizeError(error);
            if (registryEntered || (state as ControllerState) === 'closing') {
                const closing = (state as ControllerState) === 'closing';
                committed = undefined;
                next = undefined;
                state = closing ? 'closing' : 'failed';
                failedOriginal = original;
                const cleanup = cleanupHandles();
                finishCleanup(closing);
                const code = cleanup.count > 0 ? 'TOOL_BINDING_CLEANUP_FAILED'
                    : closing || original.code === 'TOOL_BINDING_CLOSED' ? 'TOOL_BINDING_CLOSED' : 'TOOL_BINDING_COMMIT_FAILED';
                throw bindingFailure(code, original, cleanup);
            }
            const code = original.code === 'TOOL_BINDING_OWNER_CONFLICT' ? 'TOOL_BINDING_OWNER_CONFLICT' : 'TOOL_BINDING_INVALID';
            throw bindingFailure(code, original);
        } finally {
            next = undefined;
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
    const controller = Object.freeze({ commit, dispose }) as ToolBindingController<Map>;
    controllerStates.set(controller, () => state);
    return controller;
}
