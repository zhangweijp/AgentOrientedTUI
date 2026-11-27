/* Adapted from DeepSeek Harness ts-types.ts at 2e39e70496aa02986ca6a820c5d497e816b69d7e.
 * Copyright (c) 2026 DeepSeek. See LICENSE.deepseek-harness. */
import type { JsonValue } from '@aotui/core';
import { NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA, type PresentedRef } from '@aotui/runtime/adapters';

type JsonObject = Readonly<Record<string, JsonValue>>;
export interface ProgramToolInput {
    readonly schema: JsonObject;
    readonly refOnly: readonly { parameter: string; refType: string; arrayElement: boolean }[];
}
export function programToolInput(schema: JsonObject, business: JsonObject): ProgramToolInput {
    const properties = business.properties as JsonObject;
    const refOnly = Object.entries(properties).flatMap(([parameter, field]) => {
        if (!object(field)) return [];
        const direct = field['x-aotui-ref-kind'];
        if (typeof direct === 'string') return [{ parameter, refType: direct, arrayElement: false }];
        const element = object(field.items) ? field.items['x-aotui-ref-kind'] : undefined;
        return typeof element === 'string' ? [{ parameter, refType: element, arrayElement: true }] : [];
    });
    return { schema, refOnly };
}

export interface ConsoleToolDeclaration {
    readonly name: string;
    readonly input: ProgramToolInput;
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string): string => identifier.test(name) ? name : JSON.stringify(name);
const field = (path: string, name: string) => identifier.test(name) ? path + '.' + name : path + '[' + JSON.stringify(name) + ']';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const schemaKeys = new Set(['type', 'description', 'default', 'enum', 'const', 'anyOf', 'properties', 'required',
    'additionalProperties', 'items', 'prefixItems', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']);

class UnsupportedSchema extends Error {
    constructor(readonly path: string) { super('Cannot represent this schema in the program.'); }
}

function scalar(value: unknown, path: string): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return 'readonly [' + value.map((item, index) => scalar(item, path + '[' + index + ']')).join(', ') + ']';
    throw new UnsupportedSchema(path);
}

function schemaType(schema: unknown, path: string, untyped: string): string {
    if (schema === undefined) return untyped;
    if (!object(schema)) throw new UnsupportedSchema(path);
    if (schema.type === 'string' && schema.pattern === NATIVE_RESTRICTED_REF_ADDRESS_SCHEMA.pattern &&
        Object.keys(schema).every(name => ['type', 'pattern', 'description'].includes(name)) &&
        (schema.description === undefined || typeof schema.description === 'string')) return 'AppRefAddress';
    for (const name of Object.keys(schema)) if (!schemaKeys.has(name)) throw new UnsupportedSchema(field(path, name));
    const constraints: string[] = [];
    if (Object.hasOwn(schema, 'const')) constraints.push(scalar(schema.const, path + '.const'));
    if (Array.isArray(schema.enum)) constraints.push(schema.enum.map((value, index) => scalar(value, path + '.enum[' + index + ']')).join(' | '));
    if (Array.isArray(schema.anyOf)) {
        constraints.push(schema.anyOf.map((branch, index) => schemaType(branch, path + '.anyOf[' + index + ']', untyped)).join(' | '));
    }
    let base: string | undefined;
    switch (schema.type) {
        case undefined: break;
        case 'string': case 'boolean': case 'null': base = schema.type; break;
        case 'integer': case 'number': base = 'number'; break;
        case 'array': {
            if (schema.items === false) {
                const prefix = schema.prefixItems ?? [];
                if (!Array.isArray(prefix) || prefix.length !== schema.minItems) throw new UnsupportedSchema(path + '.prefixItems');
                base = 'readonly [' + prefix.map((item, index) => schemaType(item, path + '.prefixItems[' + index + ']', untyped)).join(', ') + ']';
            } else {
                if (Object.hasOwn(schema, 'prefixItems')) throw new UnsupportedSchema(path + '.prefixItems');
                base = 'ReadonlyArray<' + schemaType(schema.items, path + '.items', untyped) + '>';
            }
            break;
        }
        case 'object': {
            if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
                throw new UnsupportedSchema(path + '.additionalProperties');
            const required = new Set(Array.isArray(schema.required) ? schema.required : []);
            const entries = Object.entries(object(schema.properties) ? schema.properties : {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
            const fields = entries.map(([name, prop]) =>
                'readonly ' + key(name) + (required.has(name) ? ': ' : '?: ') + schemaType(prop, field(path + '.properties', name), untyped));
            const extra = 'Readonly<Record<string, ' + (schema.additionalProperties === false ? 'never' : untyped) + '>>';
            base = fields.length ? '{ ' + fields.join('; ') + ' }' : extra;
            if (fields.length && schema.additionalProperties !== false) base += ' & ' + extra;
            break;
        }
        default: throw new UnsupportedSchema(path + '.type');
    }
    const types = [...(base === undefined ? [] : [base]), ...constraints];
    return types.length > 1 ? types.map(type => '(' + type + ')').join(' & ') : types[0] ?? untyped;
}

function inputType(input: ProgramToolInput): string {
    return schemaType(input.schema, '$', 'JsonValue');
}

type Branch = { children: Map<string, Branch>; schema?: unknown; leaf?: true };
function refsType(refs: readonly PresentedRef[]): string {
    const root: Branch = { children: new Map() };
    for (const { source: { appId }, ref: { viewId, refId, valueSchema, scope } } of refs) {
        if (scope !== 'public') continue;
        let branch = root;
        for (const segment of [appId, viewId, refId]) {
            const child: Branch = branch.children.get(segment) ?? { children: new Map() };
            branch.children.set(segment, child);
            branch = child;
        }
        branch.leaf = true;
        branch.schema = valueSchema;
    }
    const draw = (branch: Branch): string => {
        if (branch.leaf) {
            try { return schemaType(branch.schema, '$', 'unknown'); }
            catch (error) { if (error instanceof UnsupportedSchema) return 'unknown'; throw error; }
        }
        if (!branch.children.size) return 'Readonly<Record<never, never>>';
        return '{ ' + [...branch.children.keys()].sort().map(name => 'readonly ' + key(name) + ': ' + draw(branch.children.get(name)!)).join('; ') + ' }';
    };
    return draw(root);
}

export const RUN_CODE = 'run_code';
const types = [
    'type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };',
    'type AppRefAddress = `$ref.${string}`;',
    'declare function inspect(...values: unknown[]): void;',
    'declare class ToolCallError extends Error {',
    '  private constructor();',
    '  readonly name: "ToolCallError";',
    '  readonly toolName: keyof typeof tools;',
    '  readonly code: string;',
    '}',
];

export function consoleDeclarations(tools: readonly ConsoleToolDeclaration[], refs: readonly PresentedRef[]) {
    const names: string[] = [];
    const signatures: string[] = [];
    const issues: { tool: string; path: string }[] = [];
    for (const { name, input } of [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (name === RUN_CODE) continue;
        try {
            const args = inputType(input);
            const labels = input.refOnly.map(({ parameter, arrayElement, refType }) =>
                JSON.stringify(parameter) + (arrayElement ? ' elements' : '') + ' require a published ' + JSON.stringify(refType) + ' address.');
            if (labels.length) signatures.push('  /** ' + labels.join(' ').replaceAll('*/', '* /') + ' */');
            signatures.push('  ' + key(name) + '(args: ' + args + '): Promise<unknown>;');
            names.push(name);
        } catch (error) {
            if (!(error instanceof UnsupportedSchema)) throw error;
            issues.push({ tool: name, path: error.path });
        }
    }
    return { names, issues, declaration: [...types, 'declare const refs: ' + refsType(refs) + ';',
        'declare const tools: {', ...signatures, '};'].join('\n') };
}
