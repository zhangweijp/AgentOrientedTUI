import { APP_LIFECYCLE_PROTOCOL } from '../spi/index.js';
import type { AppCleanupReport, AppLifecycleCallbacks, AppLifecyclePort } from '../spi/runtime/app-lifecycle.interface.js';

export function createAppLifecycle(instanceId: string) {
    let owner: AppLifecycleCallbacks | undefined, stopped = false;
    let state: AppCleanupReport['state'] = 'active', pendingStop: Promise<unknown> | undefined, completion: Promise<void> | undefined;
    const issues = new Set<AppCleanupReport['issues'][number]>();
    function stopOwner(): void {
        if (!owner) return;
        try {
            const result: unknown = owner.stop?.();
            if (result !== undefined) {
                issues.add('APP_STOP_ASYNC');
                pendingStop = Promise.resolve(result).catch(() => { issues.add('APP_STOP_FAILED'); });
            }
        } catch { issues.add('APP_STOP_FAILED'); }
    }
    function stop(): void {
        if (stopped) return;
        stopped = true; state = 'stopped';
        stopOwner();
    }
    function close(): Promise<void> {
        if (completion) return completion;
        stop(); state = 'pending';
        completion = Promise.resolve().then(async () => {
            await pendingStop;
            try { await owner?.close?.(); }
            catch { issues.add('APP_CLEANUP_FAILED'); }
            state = issues.size ? 'failed' : 'completed';
            if (issues.size) throw Object.assign(new Error('APP_CLEANUP_FAILED'), { code: 'APP_CLEANUP_FAILED' });
        });
        void completion.catch(() => {});
        return completion;
    }
    const port: AppLifecyclePort = Object.freeze({ protocol: APP_LIFECYCLE_PROTOCOL, register(callbacks: AppLifecycleCallbacks) {
        // APP_STOP may arrive while the App initializer is awaiting. Retain a
        // late committed owner and stop it synchronously; close runs only after
        // AppKernel has joined initialization. Never admit owners after close.
        if (completion || owner) throw new Error('APP_LIFECYCLE_REGISTRATION_CLOSED');
        if (!callbacks || typeof callbacks !== 'object') throw new Error('APP_LIFECYCLE_INVALID');
        const fields = Object.getOwnPropertyDescriptors(callbacks);
        if (Reflect.ownKeys(fields).some(key => key !== 'stop' && key !== 'close' || !fields[key]!.enumerable ||
            !('value' in fields[key]!) || fields[key]!.value !== undefined && typeof fields[key]!.value !== 'function'))
            throw new Error('APP_LIFECYCLE_INVALID');
        owner = Object.freeze({ stop: fields.stop?.value as AppLifecycleCallbacks['stop'], close: fields.close?.value as AppLifecycleCallbacks['close'] });
        if (stopped) stopOwner();
        return () => { stop(); void close().catch(() => {}); };
    } });
    return Object.freeze({ port, stop, close, getReport: (): AppCleanupReport => Object.freeze({
        protocol: APP_LIFECYCLE_PROTOCOL, instanceId, state,
        issues: Object.freeze([...issues]),
    }) });
}
