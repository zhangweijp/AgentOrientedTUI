import type { JsonValue } from '@aotui/core';

export type JsonSchemaObject = Readonly<Record<string, JsonValue>>;

/** The Standard JSON Schema v1 contract for exporting an input in AOTUI's dialect. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: { readonly input: Input; readonly output: Output } | undefined;
        readonly jsonSchema: {
            readonly input: (options: { readonly target: 'draft-2020-12' }) => Record<string, unknown>;
            readonly output: (options: { readonly target: 'draft-2020-12' }) => Record<string, unknown>;
        };
    };
}

// TypeBox 1.4 exposes these structural markers in its declarations.
export type AuthorSchema = JsonSchemaObject | StandardJSONSchemaV1 |
    { readonly '~kind': string } | { readonly '~unsafe': unknown };

type TypeBoxRequired<Properties> = {
    [Key in keyof Properties]-?: Properties[Key] extends { readonly '~optional': true } ? never : Key;
}[keyof Properties];

type RequiredKeys<Schema, Properties> = Schema extends { readonly '~kind': 'Object' } ? TypeBoxRequired<Properties>
    : Schema extends { readonly required: readonly (infer Name)[] } ? Extract<Name, keyof Properties> : never;

type ObjectInput<Properties, Required extends keyof Properties> = {
    readonly [Key in Required]: SchemaInput<Properties[Key]>;
} & {
    readonly [Key in Exclude<keyof Properties, Required>]?: SchemaInput<Properties[Key]>;
};

type TupleInput<Items extends readonly unknown[]> = { readonly [Index in keyof Items]: SchemaInput<Items[Index]> };

type JsonInput<Schema, Fallback = JsonValue> =
    Schema extends { readonly const: infer Value } ? Value :
    Schema extends { readonly enum: readonly (infer Value)[] } ? Value :
    Schema extends { readonly type: 'object'; readonly properties: infer Properties }
        ? ObjectInput<Properties, RequiredKeys<Schema, Properties>>
            & (Schema extends { readonly additionalProperties: true } ? JsonSchemaObject : unknown) :
    Schema extends { readonly type: 'object' }
        ? Schema extends { readonly additionalProperties: false } ? Readonly<Record<never, never>> : JsonSchemaObject :
    Schema extends { readonly type: 'array'; readonly prefixItems: infer Items extends readonly unknown[] } ? TupleInput<Items> :
    Schema extends { readonly type: 'array'; readonly items: false } ? readonly [] :
    Schema extends { readonly type: 'array'; readonly items: infer Items } ?
        Schema extends { readonly '~kind': 'Tuple' } ?
            Items extends readonly unknown[] ? TupleInput<Items> : never
            : ReadonlyArray<SchemaInput<Items>> :
    Schema extends { readonly type: 'string' } ? string :
    Schema extends { readonly type: 'number' | 'integer' } ? number :
    Schema extends { readonly type: 'boolean' } ? boolean :
    Schema extends { readonly type: 'null' } ? null : Fallback;

export type SchemaInput<Schema> =
    Schema extends StandardJSONSchemaV1 ? NonNullable<Schema['~standard']['types']>['input'] :
    Schema extends { readonly '~unsafe': infer Value } ? Value :
    Schema extends { readonly anyOf: readonly (infer Branch)[] } ? JsonInput<Schema, unknown> & SchemaInput<Branch> : JsonInput<Schema>;
