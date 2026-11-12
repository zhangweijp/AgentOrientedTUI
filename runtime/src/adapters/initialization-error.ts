import { captureInvocationJson, exact, invocationObject } from './worker-message-capture.js';
import type { WorkerError, WorkerInitializationDiagnostic } from '../spi/worker-protocol/messages.js';

type Phase = WorkerInitializationDiagnostic['phase'];
const limits = { name: 128, message: 2048, code: 128, path: 512, stack: 8192 } as const;

/** Capture the thrown value before cleanup; only this flat, bounded record crosses IPC. */
export function initializationFailure(phase: Phase, thrown: unknown): WorkerError {
    let truncated = false;
    const read = (key: keyof typeof limits, fallback?: string): string | undefined => {
        try {
            // Native Error.stack is a lazy accessor on current Node versions.
            const value = key === 'message' && typeof thrown === 'string' ? thrown
                : thrown !== null && typeof thrown === 'object' ? (thrown as Record<string, unknown>)[key] : undefined;
            if (typeof value === 'string') {
                truncated ||= value.length > limits[key];
                return value.slice(0, limits[key]);
            }
        } catch { /* A diagnostic getter must not replace the installation failure. */ }
        return fallback;
    };
    const name = read('name', 'Error')!;
    const message = read('message', 'Non-Error value thrown')!;
    const stack = read('stack');
    const code = read('code');
    const path = read('path');
    return Object.freeze({
        code: phase === 'INIT' ? 'E_INIT_FAILED' : 'E_OPEN_FAILED',
        message: phase === 'INIT' ? 'App initialization failed' : 'App initial commit failed',
        diagnostic: Object.freeze({ phase, name, message,
            ...(code === undefined ? {} : { code }), ...(path === undefined ? {} : { path }),
            ...(stack === undefined ? {} : { stack }), ...(truncated ? { truncated: true as const } : {}) }),
    });
}

/** The request determines App and phase. Diagnostic details only become a local, non-enumerable cause. */
export function initializationError(input: unknown, appId: string, phase: Phase): Error & { readonly code: string } {
    let failure: WorkerError | undefined;
    try {
        const value = captureInvocationJson(input, { maxDepth: 2, maxNodes: 16,
            maxApproxBytes: 64 * 1024, maxCanonicalBytes: 64 * 1024 });
        if (invocationObject(value) && exact(value, ['code', 'message', ...(Object.hasOwn(value, 'diagnostic') ? ['diagnostic'] : [])]) &&
            typeof value.code === 'string' && value.code.length > 0 && value.code.length <= 128 &&
            typeof value.message === 'string' && value.message.length <= limits.message) failure = value as unknown as WorkerError;
    } catch { /* Invalid diagnostic transport still represents a failed installation. */ }
    const code = failure?.code ?? (phase === 'INIT' ? 'E_INIT_FAILED' : 'E_OPEN_FAILED');
    const error = new Error(code + ': ' + (failure?.message ?? (phase === 'INIT' ? 'App initialization failed' : 'App initial commit failed')));
    Object.defineProperties(error, {
        code: { value: code, enumerable: true },
        appId: { value: appId, enumerable: true }, phase: { value: phase, enumerable: true },
    });
    const diagnostic = failure?.diagnostic;
    if (invocationObject(diagnostic) && exact(diagnostic, ['phase', 'name', 'message',
        ...(Object.hasOwn(diagnostic, 'stack') ? ['stack'] : []),
        ...(Object.hasOwn(diagnostic, 'code') ? ['code'] : []), ...(Object.hasOwn(diagnostic, 'path') ? ['path'] : []), ...(Object.hasOwn(diagnostic, 'truncated') ? ['truncated'] : [])]) &&
        diagnostic.phase === phase && typeof diagnostic.name === 'string' && diagnostic.name.length <= limits.name &&
        typeof diagnostic.message === 'string' && diagnostic.message.length <= limits.message &&
        (!Object.hasOwn(diagnostic, 'code') || typeof diagnostic.code === 'string' && diagnostic.code.length <= limits.code) &&
        (!Object.hasOwn(diagnostic, 'path') || typeof diagnostic.path === 'string' && diagnostic.path.length <= limits.path) &&
        (!Object.hasOwn(diagnostic, 'stack') || typeof diagnostic.stack === 'string' && diagnostic.stack.length <= limits.stack) &&
        (!Object.hasOwn(diagnostic, 'truncated') || diagnostic.truncated === true)) {
        Object.defineProperty(error, 'cause', { value: diagnostic });
    }
    return error as Error & { readonly code: string };
}
