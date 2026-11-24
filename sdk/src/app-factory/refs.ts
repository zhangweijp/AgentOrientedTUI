import { compileValueSchema, SnapshotDataError, type JsonValue, type RefScope } from '@aotui/core';
import type { AppFrameRef, createRefCapture, RefCapture, RefValueCheck } from '@aotui/core';
import type Type from 'typebox';
import { exportTypeBoxValueSchema, schemaDeclarationError, TypeBoxSchemaExportError } from '../tools/typebox-schema.js';
import type { DeepReadonly } from '../tools/view-type-tool.js';

export interface RefOptions<Schema extends Type.TSchema = Type.TSchema> {
    readonly scope: RefScope;
    readonly refType?: string | undefined;
    readonly schema: Schema;
}

export interface ArrayRefOptions<Schema extends Type.TSchema = Type.TSchema> {
    readonly scope: RefScope;
    readonly itemType?: string;
    /** Schema for the whole array. */
    readonly schema: Schema;
}

export type RefSourceValue<Schema extends Type.TSchema> = NoInfer<DeepReadonly<Type.Static<Schema>>>;

export interface PublishedRef extends RefOptions {
    readonly id: string;
    readonly value: unknown;
    readonly array?: true;
}

type PublishedArrayRef = PublishedRef & { readonly array: true; readonly value: readonly unknown[] };

export function ref<Schema extends Type.TSchema>(
    id: string, value: RefSourceValue<Schema>, options: RefOptions<Schema>,
): PublishedRef {
    const refType = options?.refType === undefined ? schemaType(options?.schema) : options.refType;
    return { id, value, scope: options?.scope, refType, schema: options?.schema };
}

export function arrayRef<Schema extends Type.TSchema>(
    id: string, values: readonly unknown[] & RefSourceValue<Schema>, options: ArrayRefOptions<Schema>,
): PublishedArrayRef {
    const refType = options?.itemType === undefined
        ? schemaType(options?.schema && Object.getOwnPropertyDescriptor(options.schema, 'items')?.value)
        : options.itemType;
    return { id, value: values, scope: options?.scope, refType, schema: options?.schema, array: true };
}

function schemaType(schema: Type.TSchema | undefined): string | undefined {
    const type = schema && Object.getOwnPropertyDescriptor(schema, 'type')?.value;
    return typeof type === 'string' ? type : undefined;
}
const reservedMarkerSyntax = /[\s\p{Cc}():\\<>]|&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/u;

function validateRefMarker(id: string, refType: string | undefined, scope: RefScope): void {
    const path = typeof id === 'string' ? ('Ref ' + id).slice(0, 512) : '$.refs.id';
    if (typeof id !== 'string' || !id || reservedMarkerSyntax.test(id)) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', path,
            'Ref ID must be non-empty and contain no whitespace, control character or reserved Markdown marker syntax.');
    }
    if (refType !== undefined && (typeof refType !== 'string' || !refType || reservedMarkerSyntax.test(refType))) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', path,
            'Ref type must be non-empty and contain no whitespace, control character or reserved Markdown marker syntax.');
    }
    if (scope !== 'private' && scope !== 'protected' && scope !== 'public')
        throw new SnapshotDataError('SNAPSHOT_INVALID', path + '.scope', 'Declare Ref scope as private, protected or public.');
}

/** Format a published Ref, or an element from a published ArrayRef. */
export function formatRef(label: string, descriptor: PublishedRef): string;
export function formatRef(label: string, descriptor: PublishedArrayRef, index: number): string;
export function formatRef(label: string, { id, value, refType, scope, array }: PublishedRef, index?: number): string {
    validateRefMarker(id, refType, scope);
    if (index !== undefined && (!array || !Array.isArray(value) || !Number.isSafeInteger(index) || index < 0 || index >= value.length)) {
        throw new SnapshotDataError('SNAPSHOT_INVALID', 'Ref ' + id, 'Ref item index must select an element of the array.');
    }
    const localName = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id) ? id : '[' + JSON.stringify(id) + ']';
    const type = (refType ?? 'unknown') + (array ? '[]' : '');
    const text = label.replace(/[\\[\]\\*_<>~`&!]/g, '\\$&').replace(/\r\n?|\n/g, '&#10;');
    return index === undefined ? `[${text}](${scope} ${localName}: ${type})` : `[${text}](${localName}[${index}])`;
}

const schemas = new WeakMap<Type.TSchema, { valueSchema: JsonValue; validate: RefValueCheck }>();

function capturedRefValue(viewId: string, id: string, capture: RefCapture): JsonValue {
    if ('issue' in capture) {
        const { code, path, message } = capture.issue;
        throw new SnapshotDataError(code, 'Ref ' + viewId + '.' + id + (path ? ' ' + path : ''), message);
    }
    return capture.value;
}

function validator(schema: Type.TSchema) {
    const existing = schemas.get(schema);
    if (existing) return existing;
    const valueSchema = exportTypeBoxValueSchema(schema);
    const compiled = compileValueSchema(valueSchema);
    if (!compiled.ok) throw schemaDeclarationError(compiled.issue);
    const result = { valueSchema, validate: compiled.validate };
    schemas.set(schema, result);
    return result;
}

export type CapturedPublication = Omit<AppFrameRef, 'value'> & { readonly capture: RefCapture };

export function capturePublication(
    capture: ReturnType<typeof createRefCapture>, { id, value, refType, scope, schema, array }: PublishedRef,
): CapturedPublication {
    validateRefMarker(id, refType, scope);
    if (schema === undefined) throw new SnapshotDataError('SNAPSHOT_INVALID', 'Ref ' + id + '.schema', 'Declare a schema for every published Ref.');
    let contract: ReturnType<typeof validator>;
    try { contract = validator(schema); }
    catch (error) {
        if (error instanceof TypeBoxSchemaExportError)
            throw new SnapshotDataError(error.code, 'Ref ' + id + '.schema' + error.path.slice(1), error.reason);
        if (!(error instanceof SnapshotDataError)) throw error;
        throw new SnapshotDataError(error.code, 'Ref ' + id + '.schema' + error.path.slice(1), error.message);
    }
    return {
        id, scope, ...(refType === undefined ? {} : { refType }),
        ...(array ? { array } : {}), valueSchema: contract.valueSchema,
        capture: capture(value, array ? captured => !Array.isArray(captured)
            ? { path: '$', message: 'ArrayRef requires an array' } : contract.validate(captured) : contract.validate),
    };
}

export function publishedValue(view: string, { capture, ...metadata }: CapturedPublication): AppFrameRef {
    return { ...metadata, value: capturedRefValue(view, metadata.id, capture) };
}
