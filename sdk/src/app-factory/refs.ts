import { compileValueSchema, SnapshotDataError, type JsonValue } from '@aotui/runtime/core';
import type { createRefCapture, RefCapture, RefValueCheck } from '@aotui/runtime/spi';
import type Type from 'typebox';
import { exportTypeBoxValueSchema, schemaDeclarationError } from '../tools/typebox-schema.js';
import type { DeepReadonly } from '../tools/view-type-tool.js';

export interface RefOptions<Schema extends Type.TSchema = Type.TSchema> {
    readonly refType?: string | undefined;
    readonly schema?: Schema | undefined;
}

export interface ArrayRefOptions<Schema extends Type.TSchema = Type.TSchema> {
    readonly itemType?: string;
    /** Schema for the whole array. */
    readonly schema?: Schema | undefined;
}

export type RefSourceValue<Schema extends Type.TSchema> = NoInfer<DeepReadonly<Type.Static<Schema>>>;

export interface PublishedRef extends RefOptions {
    readonly id: string;
    readonly value: unknown;
    readonly array?: true;
}

type PublishedArrayRef = PublishedRef & { readonly array: true; readonly value: readonly unknown[] };

export function ref<Schema extends Type.TSchema>(
    id: string, value: RefSourceValue<Schema>, options?: RefOptions<Schema>,
): PublishedRef {
    return { id, value, refType: options?.refType, schema: options?.schema };
}

export function arrayRef<Schema extends Type.TSchema>(
    id: string, values: readonly unknown[] & RefSourceValue<Schema>, options?: ArrayRefOptions<Schema>,
): PublishedArrayRef {
    return { id, value: values, refType: options?.itemType, schema: options?.schema, array: true };
}

const reservedMarkerSyntax = /[\s\p{Cc}():\\<>]|&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/u;

function validateRefMarker(id: string, refType: string | undefined): void {
    const path = typeof id === 'string' ? ('Ref ' + id).slice(0, 512) : '$.refs.id';
    if (typeof id !== 'string' || !id || id.includes('.') || reservedMarkerSyntax.test(id)) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', path,
            'Ref ID must be non-empty and contain no dot, whitespace, control character or reserved Markdown marker syntax.');
    }
    if (refType !== undefined && (typeof refType !== 'string' || !refType || reservedMarkerSyntax.test(refType))) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', path,
            'Ref type must be non-empty and contain no whitespace, control character or reserved Markdown marker syntax.');
    }
}

/** Format a published Ref, or an element from a published ArrayRef. */
export function formatRef(label: string, descriptor: PublishedRef): string;
export function formatRef(label: string, descriptor: PublishedArrayRef, index: number): string;
export function formatRef(label: string, { id, value, refType, array }: PublishedRef, index?: number): string {
    validateRefMarker(id, refType);
    if (index !== undefined && (!array || !Array.isArray(value) || !Number.isSafeInteger(index) || index < 0 || index >= value.length)) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', 'Ref ' + id, 'Ref item index must select an element of the array.');
    }
    const localName = index === undefined ? id : id + '[' + index + ']';
    const type = array && index === undefined && refType !== undefined ? refType + '[]' : refType;
    const text = label.replace(/[\\[\]\\*_<>~`&!]/g, '\\$&').replace(/\r\n?|\n/g, '&#10;');
    return `[${text}](${type === undefined ? localName : type + ':' + localName})`;
}

const schemas = new WeakMap<Type.TSchema, RefValueCheck>();

export function capturedRefValue(viewId: string, id: string, capture: RefCapture): JsonValue {
    if ('issue' in capture) {
        const { code, path, message } = capture.issue;
        throw new SnapshotDataError(code, 'Ref ' + viewId + '.' + id + (path ? ' ' + path : ''), message);
    }
    return capture.value;
}

function validator(schema: Type.TSchema): RefValueCheck {
    const existing = schemas.get(schema);
    if (existing) return existing;
    const compiled = compileValueSchema(exportTypeBoxValueSchema(schema));
    if (!compiled.ok) throw schemaDeclarationError(compiled.issue);
    schemas.set(schema, compiled.validate);
    return compiled.validate;
}

export function captureRefEntries(
    capture: ReturnType<typeof createRefCapture>, { id, value, refType, schema, array }: PublishedRef,
): ReadonlyMap<string, RefCapture> {
    validateRefMarker(id, refType);
    const check = schema === undefined ? undefined : validator(schema);
    const entries = new Map<string, RefCapture>();
    entries.set(id, capture(value, array ? captured => {
        if (!Array.isArray(captured)) return { path: '$', message: 'ArrayRef requires an array' };
        const failure = check?.(captured);
        if (failure) return failure;
        for (const [index, item] of captured.entries()) entries.set(`${id}[${index}]`, capture(item));
    } : check));
    return entries;
}
