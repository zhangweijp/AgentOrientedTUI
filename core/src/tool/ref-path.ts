import type { AppSnapshot, JsonValue, RefScope, ViewToolReceiver } from '../snapshot/types.js';
import { REF_VALUE_LIMITS, refKey } from '../snapshot/snapshot-support.js';
import type { RefConsumer } from '../invocation/observation-types.js';

export const REF_ADDRESS_PREFIX = '$ref.';
const refLiteralPrefix = /^\$+ref\./;

export function encodeRefLiteral(value: string): string {
    return refLiteralPrefix.test(value) ? '$' + value : value;
}

export function decodeRefLiteral(value: string): string {
    return value.startsWith('$$') && refLiteralPrefix.test(value) ? value.slice(1) : value;
}

export const MAX_REF_ADDRESS_BYTES = 4096;
export const MAX_REF_PATH_SEGMENTS = REF_VALUE_LIMITS.maxDepth;
type JsonObject = Readonly<Record<string, JsonValue>>;
export type RefPath = readonly (string | number)[];

export interface RefAddress {
    readonly appId: string;
    readonly viewId: string;
    readonly refId: string;
    readonly path: RefPath;
}
export interface LocalRefUse {
    readonly param: string;
    readonly index?: number;
    readonly viewId: string;
    readonly viewInstanceId: string;
    readonly refId: string;
}

export function formatRefPath(path: RefPath): string {
    return path.map(segment => typeof segment === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
        ? '.' + segment : '[' + JSON.stringify(segment) + ']').join('');
}

export function pathStartsWith(path: RefPath, prefix: RefPath): boolean {
    return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

/** The caller owns a captured snapshot value. Only its own JSON keys and indices are traversed. */
export function readRefPath(root: JsonValue, path: RefPath):
    { readonly found: true; readonly value: JsonValue } | { readonly found: false; readonly segment: number; readonly reason: string } {
    let value = root;
    for (const [index, segment] of path.entries()) {
        if (typeof segment === 'number') {
            if (!Array.isArray(value)) return { found: false, segment: index, reason: 'requires an array' };
            if (!Object.hasOwn(value, segment)) return { found: false, segment: index, reason: 'is outside the observed array' };
            value = (value as readonly JsonValue[])[segment]!;
        } else {
            if (value === null || typeof value !== 'object' || Array.isArray(value))
                return { found: false, segment: index, reason: 'requires a JSON object' };
            if (!Object.hasOwn(value, segment)) return { found: false, segment: index, reason: 'is absent in the observed object' };
            value = (value as JsonObject)[segment]!;
        }
    }
    return { found: true, value };
}

export function isArrayElementPath(path: RefPath): boolean {
    return path.length === 1 && typeof path[0] === 'number';
}

export function refPath(param: string, index?: number): string {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(param) ? '.' + param : '[' + JSON.stringify(param) + ']';
    return ('$' + key + (index === undefined ? '' : '[' + index + ']')).slice(0, 512);
}

export function scopeAllows(scope: RefScope, publisher: string, receiver: string, sameApp = true): boolean {
    return scope === 'public' || (sameApp && (scope === 'protected' || (scope === 'private' && publisher === receiver)));
}

export function refConsumerAllowed(consumers: readonly RefConsumer[] | undefined, target: RefConsumer): boolean {
    return consumers === undefined || consumers.some(entry => entry.appId === target.appId &&
        entry.instanceId === target.instanceId && entry.viewId === target.viewId && entry.viewInstanceId === target.viewInstanceId);
}

export function checkRefViews(sources: readonly LocalRefUse[],
    isLive: (viewId: string, viewInstanceId: string) => boolean) {
    for (const { param, index, viewId, viewInstanceId } of sources) {
        if (!isLive(viewId, viewInstanceId)) return { code: 'REF_VIEW_UNAVAILABLE',
            message: 'The original View is closed or was reopened. Choose a Ref from a current observation.', path: refPath(param, index) };
    }
}

export function checkCurrentRefScopes(sources: readonly LocalRefUse[], receiver: ViewToolReceiver,
    current: Readonly<Pick<AppSnapshot, 'refs'>>, sameApp = true) {
    for (const { param, index, viewId, viewInstanceId, refId } of sources) {
        const ref = current.refs[refKey(viewId, viewInstanceId, refId)];
        if (!ref || !scopeAllows(ref.scope, viewInstanceId, receiver.viewInstanceId, sameApp)) return {
            code: 'REF_NOT_VISIBLE', message: 'The publishing View no longer grants access to this Ref.', path: refPath(param, index),
        };
    }
}
