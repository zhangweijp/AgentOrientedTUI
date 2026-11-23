import type { DesktopCloseReport, IDesktop } from '@aotui/runtime';

export class DesktopCloseError extends Error {
    constructor(readonly code: 'DESKTOP_CLOSE_FAILED' | 'CLOSE_DEADLINE_EXCEEDED', readonly report: DesktopCloseReport) {
        super(code);
    }
}

export function checkDesktopClose(report: DesktopCloseReport): void {
    if (!report.ok) throw new DesktopCloseError('DESKTOP_CLOSE_FAILED', report);
}

function closeFailures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
    return results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
}

export function checkCloseTasks(results: readonly PromiseSettledResult<unknown>[], message: string): void {
    const errors = closeFailures(results);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
}

export async function rethrowAfterCleanup(error: unknown, ...tasks: (() => void | Promise<void>)[]): Promise<never> {
    const failures = closeFailures(await Promise.allSettled(tasks.map(task => Promise.resolve().then(task))));
    if (failures.length) {
        throw new AggregateError([error, ...failures], error instanceof Error ? error.message : String(error), { cause: error });
    }
    throw error;
}

export function rethrowAfterDesktopClose(desktop: IDesktop, error: unknown, dispose?: () => Promise<void>): Promise<never> {
    const close = async () => checkDesktopClose(await desktop.beginClose().completion);
    return dispose ? rethrowAfterCleanup(error, dispose, close) : rethrowAfterCleanup(error, close);
}
