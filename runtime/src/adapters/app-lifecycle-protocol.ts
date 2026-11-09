import { APP_LIFECYCLE_PROTOCOL, APP_LIFECYCLE_VERSION } from '../spi/runtime/app-lifecycle.interface.js';
import { captureInvocationJson, exact, invocationObject } from './worker-message-capture.js';
import type { AppCleanupReport } from '../spi/runtime/app-lifecycle.interface.js';
export interface AppLifecycleAck { readonly protocol: typeof APP_LIFECYCLE_PROTOCOL; readonly version: typeof APP_LIFECYCLE_VERSION; readonly instanceId: string }
export function captureAppLifecycleAck(input: unknown, instanceId: string): AppLifecycleAck | null {
    try {
        const value = captureInvocationJson(input, { maxDepth: 1, maxNodes: 4, maxApproxBytes: 1024, maxCanonicalBytes: 1024 });
        return invocationObject(value) && exact(value, ['protocol', 'version', 'instanceId']) &&
            value.protocol === APP_LIFECYCLE_PROTOCOL && value.version === APP_LIFECYCLE_VERSION && value.instanceId === instanceId
            ? value as unknown as AppLifecycleAck : null;
    } catch { return null; }
}
export function captureAppCleanupReport(input: unknown, instanceId: string): AppCleanupReport | null {
    try {
        const v = captureInvocationJson(input, { maxDepth: 2, maxNodes: 16, maxApproxBytes: 2048, maxCanonicalBytes: 2048 });
        if (!invocationObject(v) || !exact(v, ['protocol', 'instanceId', 'state', 'issues']) ||
            v.protocol !== APP_LIFECYCLE_PROTOCOL || v.instanceId !== instanceId ||
            !['active', 'stopped', 'pending', 'completed', 'failed'].includes(v.state as string) ||
            !Array.isArray(v.issues) || v.issues.length > 3 || new Set(v.issues).size !== v.issues.length ||
            v.issues.some(i => !['APP_STOP_FAILED', 'APP_STOP_ASYNC', 'APP_CLEANUP_FAILED'].includes(i as string)) ||
            v.state === 'completed' && v.issues.length !== 0 || v.state === 'failed' && !v.issues.length) return null;
        return v as unknown as AppCleanupReport;
    } catch { return null; }
}
