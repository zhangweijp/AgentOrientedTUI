import { compileValueSchema, SnapshotDataError } from '@aotui/runtime/core';
import type { IRefRegistry, RefValueCheck } from '@aotui/runtime/spi';
import type Type from 'typebox';
import { exportTypeBoxValueSchema, TypeBoxSchemaExportError } from '../tools/typebox-schema.js';

export interface RefOptions {
    readonly refType?: string | undefined;
    readonly schema?: Type.TSchema | undefined;
}

export interface ArrayRefOptions {
    readonly itemType?: string;
    /** Schema for the whole array. */
    readonly schema?: Type.TSchema | undefined;
}

export interface PublishedRef extends RefOptions {
    readonly id: string;
    readonly value: unknown;
    readonly array?: true;
}

export function ref(id: string, value: unknown, options?: RefOptions): PublishedRef {
    return { id, value, ...options };
}

export function arrayRef(id: string, values: readonly unknown[], options?: ArrayRefOptions): PublishedRef {
    return { id, value: values, refType: options?.itemType, schema: options?.schema, array: true };
}

export function formatRef(label: string, id: string, refType?: string): string {
    const text = label.replace(/[\\[\]\\*_<>~`&!]/g, '\\$&').replace(/\r\n?|\n/g, '&#10;');
    return `[${text}](${refType === undefined ? id : `${refType}:${id}`})`;
}

const schemas = new WeakMap<Type.TSchema, RefValueCheck>();

function validator(schema: Type.TSchema): RefValueCheck {
    const existing = schemas.get(schema);
    if (existing) return existing;
    const compiled = compileValueSchema(exportTypeBoxValueSchema(schema));
    if (!compiled.ok) {
        const { code, path, message } = compiled.issue;
        throw new TypeBoxSchemaExportError(
            code === 'PARAMETER_DECLARATION_UNSUPPORTED' ? 'TOOL_SCHEMA_UNSUPPORTED' : 'TOOL_SCHEMA_INVALID', path, message,
        );
    }
    schemas.set(schema, compiled.validate);
    return compiled.validate;
}

export function captureRefEntries(
    capture: IRefRegistry['captureRef'], { id, value, refType, schema, array }: PublishedRef,
): ReadonlyMap<string, object> {
    if (refType !== undefined && (typeof refType !== 'string' || !refType.trim())) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', `Ref ${id}`, 'refType must be a non-empty string');
    }
    const check = schema === undefined ? undefined : validator(schema);
    const entries = new Map<string, object>();
    entries.set(id, capture(value, array ? captured => {
        if (!Array.isArray(captured)) return { path: '$', message: 'ArrayRef requires an array' };
        const failure = check?.(captured);
        if (failure) return failure;
        for (const [index, item] of captured.entries()) entries.set(`${id}[${index}]`, capture(item));
    } : check));
    return entries;
}
