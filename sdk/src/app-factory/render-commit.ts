import { options } from 'preact';

let scheduled: Promise<void> | undefined;
const trackedSchedules = new WeakSet<NonNullable<typeof options.debounceRendering>>();

/** Observe Preact's existing queue; do not replace it with a second scheduler. */
export function trackRenderCommits(): void {
    if (options.debounceRendering && trackedSchedules.has(options.debounceRendering)) return;
    // Preact's default defer is a resolved Promise; preserve its error semantics too.
    const schedule = options.debounceRendering ?? ((callback: () => void) => { void Promise.resolve().then(callback); });
    const trackedSchedule: NonNullable<typeof options.debounceRendering> = callback => {
        let complete!: () => void;
        const pending = new Promise<void>(resolve => { complete = resolve; });
        scheduled = pending;
        const settle = () => {
            complete();
            if (scheduled === pending) scheduled = undefined;
        };
        try {
            schedule(() => { try { callback(); } finally { settle(); } });
        } catch (error) { settle(); throw error; }
    };
    trackedSchedules.add(trackedSchedule);
    options.debounceRendering = trackedSchedule;
}

export async function whenRenderCommitted(signal: AbortSignal): Promise<void> {
    const closed = () => Object.assign(new Error('Projection owner closed'), { code: 'PROJECTION_CLOSED' });
    while (scheduled) {
        if (signal.aborted) throw closed();
        const pending = scheduled;
        await new Promise<void>((resolve, reject) => {
            const abort = () => { signal.removeEventListener('abort', abort); reject(closed()); };
            signal.addEventListener('abort', abort, { once: true });
            void pending.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        });
    }
    if (signal.aborted) throw closed();
}
