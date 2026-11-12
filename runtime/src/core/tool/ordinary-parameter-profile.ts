import { canonicalJson, copyJson } from '../snapshot/json.js';
import type { JsonValue } from '../snapshot/types.js';
import { compileOrdinarySchema, VIEW_TYPE_PARAMETERS_MODE, ORDINARY_PARAMETER_REVISION, type OrdinaryParameterContract } from './ordinary-parameter-contract.js';

export const ORDINARY_PARAMETER_MARKER = 'x-aotui-parameter-contract';
const compiledProfiles = new WeakMap<object, { canonical: string; contract: OrdinaryParameterContract }>();

export function ordinaryParameterProfile(contract: OrdinaryParameterContract): JsonValue {
  return copyJson({ ...contract.schema, [ORDINARY_PARAMETER_MARKER]: contract.revision },
    { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 });
}
/** A declaration only. A live, negotiated binding and its private callable remain mandatory. */
export function compileOrdinaryProfile(input: unknown): OrdinaryParameterContract | null {
  try {
    const key = input !== null && typeof input === 'object' ? input : undefined;
    const cached = key && compiledProfiles.get(key);
    if (cached) return cached.contract;
    const captured = copyJson(input, { maxDepth: 48, maxNodes: 10_000, maxApproxBytes: 128 * 1024 });
    if (!captured || typeof captured !== 'object' || Array.isArray(captured) ||
        !Object.hasOwn(captured, ORDINARY_PARAMETER_MARKER)) return null;
    const marker = (captured as Record<string, JsonValue>)[ORDINARY_PARAMETER_MARKER];
    if (marker !== ORDINARY_PARAMETER_REVISION && marker !== VIEW_TYPE_PARAMETERS_MODE) return null;
    const schema = { ...captured } as Record<string, JsonValue>;
    const qualified = marker === VIEW_TYPE_PARAMETERS_MODE;
    delete schema[ORDINARY_PARAMETER_MARKER];
    const compiled = compileOrdinarySchema(schema, qualified ? VIEW_TYPE_PARAMETERS_MODE : undefined);
    if (!compiled.ok || canonicalJson(schema) !== canonicalJson(compiled.contract.schema)) return null;
    return compiled.contract;
  } catch { return null; }
}

/** Only for a schema in the immutable candidate produced by strict snapshot capture. */
export function compileCapturedOrdinaryProfile(
  schema: Readonly<Record<string, JsonValue>>, canonical: string, previous?: JsonValue,
): OrdinaryParameterContract | null {
  const prior = previous !== null && typeof previous === 'object' ? compiledProfiles.get(previous) : undefined;
  if (prior?.canonical === canonical) {
    compiledProfiles.set(schema, prior);
    return prior.contract;
  }
  const contract = compileOrdinaryProfile(schema);
  if (contract) compiledProfiles.set(schema, { canonical, contract });
  return contract;
}
