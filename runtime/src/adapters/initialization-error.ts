import type { InteractionIssue } from '@aotui/core';
import { copyWireJson } from '@aotui/core';
import { exact, invocationObject } from './worker-message-capture.js';
import type { WorkerError, WorkerInitializationDiagnostic } from '../spi/worker-protocol/messages.js';

// Only Runtime validation branches can establish this provenance. App issues
// with an identical code are ordinary startup failures.
const protocolIssues = new WeakMap<object, InteractionIssue>();
export function runtimeProtocolError(issue: InteractionIssue): Error & InteractionIssue {
    const value = Object.freeze({ code: issue.code, message: issue.message,
        ...(issue.path === undefined ? {} : { path: issue.path }) });
    const error = Object.assign(new Error(value.message), value);
    protocolIssues.set(error, value);
    return error;
}

export function readRuntimeProtocolIssue(error: unknown): InteractionIssue | undefined {
    try { for (let depth = 0; depth < 8 && error !== null && typeof error === 'object'; depth++) {
        const issue = protocolIssues.get(error);
        if (issue) return issue;
        // Only the Runtime-owned INSTALL_FAILED wrapper is traversed. In
        // particular, never elevate an arbitrary diagnostic cause.code.
        const code = Object.getOwnPropertyDescriptor(error, 'code');
        if (!code || !('value' in code) || code.value !== 'INSTALL_FAILED') return;
        const cause = Object.getOwnPropertyDescriptor(error, 'cause');
        if (!cause || !('value' in cause)) return;
        error = cause.value;
    } } catch { /* Untrusted properties do not establish provenance. */ }
}

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
                if (value.length <= limits[key]) return value;
                truncated = true;
                // A partial path or code is not the original identifier.
                if (key === 'path' || key === 'code') return undefined;
                const end = limits[key];
                const last = value.charCodeAt(end - 1);
                return value.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
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
        const value = copyWireJson(input, { maxDepth: 2, maxNodes: 16,
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
        if (typeof diagnostic.path === 'string')
            Object.defineProperty(error, 'path', { value: diagnostic.path, enumerable: true });
    }
    return error as Error & { readonly code: string };
}

/** Bound each neutral startup field independently; the original request fixes phase. */
export function executionStartupError(issue: unknown, appId: string, phase: Phase): Error & { readonly code: string } {
    const trusted = readRuntimeProtocolIssue(issue);
    const captured = initializationFailure(phase, issue);
    const diagnostic = captured.diagnostic!;
    const error = initializationError({ code: diagnostic.code ?? captured.code,
        message: diagnostic.message, diagnostic }, appId, phase);
    if (trusted) protocolIssues.set(error, trusted);
    return error;
}
