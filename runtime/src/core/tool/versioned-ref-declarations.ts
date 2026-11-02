import { SnapshotDataError } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { ORDINARY_PARAMETER_MARKER } from './ordinary-parameter-profile.js';
import { validateToolRefDeclarations } from './ref-declarations.js';
import { compileSnapshotValueProfile } from './snapshot-value-parameter-contract.js';

/** Same copied-Schema precondition as C1. Admission never grants private execution eligibility. */
export function validateVersionedToolRefDeclarations(
    schema: JsonValue, isMutating: boolean, viewOwned = true, path = '$.inputSchema',
): boolean {
    if (schema && typeof schema === 'object' && !Array.isArray(schema) &&
        Object.hasOwn(schema, ORDINARY_PARAMETER_MARKER) && (schema as Readonly<Record<string, JsonValue>>)[ORDINARY_PARAMETER_MARKER] === 'snapshot-value-params-v1') {
        const compiled = compileSnapshotValueProfile(schema);
        if (!compiled.ok) throw new SnapshotDataError(compiled.issue.code === 'PARAMETER_DECLARATION_UNSUPPORTED'
            ? 'REF_CONTRACT_UNSUPPORTED' : 'REF_DECLARATION_INVALID', path, 'Invalid or unsupported snapshot-value parameter profile');
        if (!viewOwned) throw new SnapshotDataError('REF_CONTRACT_UNSUPPORTED', path, 'Ref profile requires a View-owned Tool');
        if (isMutating !== false) throw new SnapshotDataError('REF_DECLARATION_INVALID', path, 'Ref profile requires an explicitly read-only Tool');
        return true;
    }
    return validateToolRefDeclarations(schema, isMutating, viewOwned, path);
}
