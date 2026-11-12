import type { JsonValue } from '../../core/snapshot/types.js';

/** Optional validation/derivation over the detached JSON value in the current commit. */
export type RefValueCheck = (value: JsonValue) => Readonly<{ path: string; message: string }> | void;

export interface IRefExporter {
    /** Capture the render's value for this batch before layout installs the binding. */
    captureRef(data: unknown, check?: RefValueCheck): object;
    /** Register a JSON value or a capture token from this commit. */
    registerRef(viewId: string, refId: string, data: unknown, refType?: string): IRefBinding;
}

/** A Ref registration handle; only its owner can update or release it. */
export interface IRefBinding {
    update(data: unknown): void;
    release(): void;
}

/** View-local Ref capture and registration used by SDK hooks. */
export interface IRefRegistry {
    captureRef(data: unknown, check?: RefValueCheck): object;
    registerRef(refId: string, data: unknown, refType?: string): IRefBinding;
}
