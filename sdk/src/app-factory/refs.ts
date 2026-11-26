import { compileValueSchema, isRefId, SnapshotDataError, type JsonValue, type RefScope } from '@aotui/core';
import type { AppFrameRef, createRefCapture, RefCapture, RefValueCheck } from '@aotui/core';
import { exportValueSchema, schemaDeclarationError, SchemaExportError } from '../tools/schema-export.js';
import type { AuthorSchema, JsonSchemaObject, SchemaInput } from '../tools/schema-types.js';
import type { DeepReadonly } from '../tools/view-type-tool.js';

export interface RefOptions<Schema extends AuthorSchema = AuthorSchema> {
    readonly scope: RefScope;
    readonly refType?: string | undefined;
    readonly schema: Schema;
}

export interface ArrayRefOptions<Schema extends AuthorSchema = AuthorSchema> {
    readonly scope: RefScope;
    readonly itemType?: string;
    /** Schema for the whole array. */
    readonly schema: Schema;
}

export type RefSourceValue<Schema extends AuthorSchema> = NoInfer<DeepReadonly<SchemaInput<Schema>>>;

export interface PublishedRef extends RefOptions {
    readonly id: string;
    readonly value: unknown;
    readonly array?: true;
}

type PublishedArrayRef = PublishedRef & { readonly array: true; readonly value: readonly unknown[] };

export function ref<const Schema extends AuthorSchema>(
    id: string, value: RefSourceValue<Schema>, options: RefOptions<Schema>,
): PublishedRef {
    const { schema, scope, refType } = options ?? {};
    validateRefMarker(id, refType, scope);
    const { valueSchema } = publicationSchema(id, schema);
    return { id, value, scope, refType: refType ?? schemaType(valueSchema), schema };
}

export function arrayRef<const Schema extends AuthorSchema>(
    id: string, values: readonly unknown[] & RefSourceValue<Schema>, options: ArrayRefOptions<Schema>,
): PublishedArrayRef {
    const { schema, scope, itemType } = options ?? {};
    validateRefMarker(id, itemType, scope);
    const { valueSchema } = publicationSchema(id, schema);
    return { id, value: values, scope, refType: itemType ?? schemaType(valueSchema.items), schema, array: true };
}

function schemaType(schema: JsonValue | undefined): string | undefined {
    const type = schema && typeof schema === 'object' && !Array.isArray(schema) && (schema as JsonSchemaObject).type;
    return typeof type === 'string' ? type : undefined;
}
const reservedMarkerSyntax = /[\s\p{Cc}():\\<>]|&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/u;

function validateRefMarker(id: string, refType: string | undefined, scope: RefScope): void {
    const path = typeof id === 'string' ? ('Ref ' + id).slice(0, 512) : '$.refs.id';
    if (!isRefId(id))
        throw new SnapshotDataError('SNAPSHOT_INVALID', path, 'Ref ID must match [A-Za-z_][A-Za-z0-9_]*.');
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
    const type = (refType ?? 'unknown') + (array ? '[]' : '');
    const text = label.replace(/[\\[\]\\*_<>~`&!]/g, '\\$&').replace(/\r\n?|\n/g, '&#10;');
    return index === undefined ? `[${text}](${scope} ${id}: ${type})` : `[${text}](${id}[${index}])`;
}

const schemas = new WeakMap<AuthorSchema, { valueSchema: JsonSchemaObject; validate: RefValueCheck }>();

function capturedRefValue(viewId: string, id: string, capture: RefCapture): JsonValue {
    if ('issue' in capture) {
        const { code, path, message } = capture.issue;
        throw new SnapshotDataError(code, 'Ref ' + viewId + '.' + id + (path ? ' ' + path : ''), message);
    }
    return capture.value;
}

function validator(schema: AuthorSchema) {
    const existing = schemas.get(schema);
    if (existing) return existing;
    const valueSchema = exportValueSchema(schema);
    const compiled = compileValueSchema(valueSchema);
    if (!compiled.ok) throw schemaDeclarationError(compiled.issue);
    const result = { valueSchema, validate: compiled.validate };
    schemas.set(schema, result);
    return result;
}

function publicationSchema(id: string, schema: AuthorSchema) {
    if (schema === undefined) throw new SnapshotDataError('SNAPSHOT_INVALID', 'Ref ' + id + '.schema', 'Declare a schema for every published Ref.');
    try { return validator(schema); }
    catch (error) {
        if (error instanceof SchemaExportError)
            throw new SnapshotDataError(error.code, 'Ref ' + id + '.schema' + error.path.slice(1), error.reason);
        throw error;
    }
}

export type CapturedPublication = Omit<AppFrameRef, 'value'> & { readonly capture: RefCapture };

export function capturePublication(
    capture: ReturnType<typeof createRefCapture>, { id, value, refType, scope, schema, array }: PublishedRef,
): CapturedPublication {
    validateRefMarker(id, refType, scope);
    const contract = publicationSchema(id, schema);
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
