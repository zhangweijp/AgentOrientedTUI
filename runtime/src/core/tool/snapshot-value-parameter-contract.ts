import { canonicalJson, copyJson, SnapshotDataError, utf8Size } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { compileOrdinaryParams, compileOrdinarySchema, type CompileResult,
    type OrdinaryValidation } from './ordinary-parameter-contract.js';
import { ORDINARY_PARAMETER_MARKER } from './ordinary-parameter-profile.js';
import { refParamDeclaration, validateToolRefDeclarations } from './ref-declarations.js';

type JsonObject = Readonly<Record<string, JsonValue>>;
type DeclarationCode = 'PARAMETER_DECLARATION_INVALID' | 'PARAMETER_DECLARATION_UNSUPPORTED';
export interface SnapshotValueParameterContract {
    readonly revision: 'snapshot-value-params-v1';
    readonly schema: JsonObject;
    readonly fingerprint: string;
    readonly ref: Readonly<{ param: string; refType?: string }>;
    validateRaw(input: unknown): OrdinaryValidation;
    validateEffective(input: unknown): OrdinaryValidation;
}
export type SnapshotValueCompileResult =
    | Readonly<{ ok: true; contract: SnapshotValueParameterContract }>
    | Readonly<{ ok: false; issue: Readonly<{ code: DeclarationCode; message: string }> }>;

const REVISION = 'snapshot-value-params-v1';
const DECLARATION = { maxDepth: 24, maxNodes: 5_000, maxApproxBytes: 64 * 1024 };
const object = (value: JsonValue | undefined): value is JsonObject =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
function bounded(input: unknown): JsonValue {
    const value = copyJson(input, DECLARATION);
    if (utf8Size(canonicalJson(value)) > DECLARATION.maxApproxBytes) throw new RangeError();
    return value;
}
function failed(code: DeclarationCode): SnapshotValueCompileResult {
    return Object.freeze({ ok: false, issue: Object.freeze({ code,
        message: code === 'PARAMETER_DECLARATION_INVALID'
            ? 'Expected a valid bounded snapshot-value parameter declaration.'
            : 'Declaration uses unsupported snapshot-value parameter vocabulary.' }) });
}
function compile(work: () => SnapshotValueCompileResult): SnapshotValueCompileResult {
    try { return work(); }
    catch (error) {
        return failed(error instanceof SnapshotDataError && error.code === 'REF_CONTRACT_UNSUPPORTED'
            ? 'PARAMETER_DECLARATION_UNSUPPORTED' : 'PARAMETER_DECLARATION_INVALID');
    }
}
function finish(raw: CompileResult, effective: CompileResult, param: string, field: JsonObject): SnapshotValueCompileResult {
    if (!raw.ok) return raw;
    if (!effective.ok) return effective;
    const properties = { ...(raw.contract.schema.properties as JsonObject), [param]: field };
    const schema = bounded({ ...raw.contract.schema, properties, [ORDINARY_PARAMETER_MARKER]: REVISION }) as JsonObject;
    const metadata = field['x-aotui-ref'] as JsonObject;
    return Object.freeze({ ok: true, contract: Object.freeze({
        revision: REVISION, schema, fingerprint: canonicalJson({ revision: REVISION, schema }),
        ref: Object.freeze({ param, ...(Object.hasOwn(metadata, 'refType') ? { refType: metadata.refType as string } : {}) }),
        validateRaw: raw.contract.validate, validateEffective: effective.contract.validate,
    }) });
}

/** Internal declaration only: neither stage resolves, authorizes or grants execution eligibility. */
export function compileSnapshotValueParams(params: unknown, options?: { additionalProperties?: boolean }): SnapshotValueCompileResult {
    return compile(() => {
        const captured = bounded(params);
        const settings = bounded(options === undefined ? {} : options);
        if (!object(captured) || !object(settings)) return failed('PARAMETER_DECLARATION_INVALID');
        const raw: Record<string, JsonValue> = Object.create(null);
        const effective: Record<string, JsonValue> = Object.create(null);
        const refs: { param: string; field: JsonObject }[] = [];
        for (const [param, value] of Object.entries(captured)) {
            if (!object(value)) return failed('PARAMETER_DECLARATION_INVALID');
            const metadata = refParamDeclaration(value, '$');
            if (metadata) {
                if (value.required !== true) return failed('PARAMETER_DECLARATION_UNSUPPORTED');
                const description: JsonObject = Object.hasOwn(value, 'desc') ? { description: value.desc! } : {};
                refs.push({ param, field: { type: 'string', ...description, 'x-aotui-ref': metadata } });
                raw[param] = { type: 'string', required: true, constraints: { minLength: 1 },
                    ...(Object.hasOwn(value, 'desc') ? { desc: value.desc! } : {}) };
                effective[param] = { type: 'object', required: true,
                    ...(Object.hasOwn(value, 'desc') ? { desc: value.desc! } : {}) };
            } else raw[param] = effective[param] = value;
        }
        if (refs.length !== 1) return failed('PARAMETER_DECLARATION_UNSUPPORTED');
        // B1 receives complete parameter declarations and validates complete inputs, including the Ref value.
        return finish(compileOrdinaryParams(raw, settings), compileOrdinaryParams(effective, settings), refs[0]!.param, refs[0]!.field);
    });
}

export function compileSnapshotValueProfile(input: unknown): SnapshotValueCompileResult {
    return compile(() => {
        const captured = bounded(input);
        if (!object(captured)) return failed('PARAMETER_DECLARATION_INVALID');
        if (!Object.hasOwn(captured, ORDINARY_PARAMETER_MARKER) || captured[ORDINARY_PARAMETER_MARKER] !== REVISION)
            return failed('PARAMETER_DECLARATION_UNSUPPORTED');
        if (Object.keys(captured).some(key => !['type', 'properties', 'required', 'description',
            'additionalProperties', ORDINARY_PARAMETER_MARKER].includes(key))) return failed('PARAMETER_DECLARATION_UNSUPPORTED');
        const schema = { ...captured };
        delete schema[ORDINARY_PARAMETER_MARKER];
        if (!validateToolRefDeclarations(schema, false) || !object(schema.properties))
            return failed('PARAMETER_DECLARATION_UNSUPPORTED');
        const refs = Object.entries(schema.properties).filter(([, field]) => object(field) && Object.hasOwn(field, 'x-aotui-ref'));
        if (refs.length !== 1 || !Array.isArray(schema.required) || !schema.required.includes(refs[0]![0]))
            return failed('PARAMETER_DECLARATION_UNSUPPORTED');
        const [param, value] = refs[0]!;
        const field = value as JsonObject;
        const description: JsonObject = Object.hasOwn(field, 'description') ? { description: field.description! } : {};
        const raw = { ...schema, properties: { ...schema.properties, [param]: { type: 'string', minLength: 1, ...description } } };
        const effective = { ...schema, properties: { ...schema.properties, [param]: { type: 'object', ...description } } };
        const result = finish(compileOrdinarySchema(raw), compileOrdinarySchema(effective), param, field);
        return result.ok && canonicalJson(result.contract.schema) !== canonicalJson(captured)
            ? failed('PARAMETER_DECLARATION_INVALID') : result;
    });
}
