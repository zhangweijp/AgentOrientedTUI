import type { AppInteractionPolicy, ExecutionBinding, InstanceInteraction, InvocationSource, ProjectionLimits } from '@aotui/core';
import { forwardRequestSource, type Issue } from '@aotui/core/host';
import type { SemanticSnapshotReceiver } from '../../adapters/snapshot/receiver.js';
import { appInteractionUnavailable, type AppInteractionResult, type WorkerInteraction } from '../../spi/runtime/app-interaction.interface.js';

/** Only a validated snapshot rejection can expose details through an observation. */
export class ProjectionRefreshFailure extends Error {
    readonly issue: Issue;

    constructor({ code, message, path }: Issue) {
        super(message);
        this.issue = Object.freeze({ code, message, ...(path === undefined ? {} : { path }) });
    }
}

export function createWorkerInteraction({ receiver, available, refresh, refreshAuthority, canExecuteTools, resolve, policy, limits, timeoutMs }: {
    receiver: SemanticSnapshotReceiver;
    available(): boolean;
    refresh(): Promise<void>;
    refreshAuthority(): Promise<void>;
    canExecuteTools(): boolean;
    resolve(source: InvocationSource): ExecutionBinding | null;
    policy: AppInteractionPolicy;
    limits: ProjectionLimits;
    timeoutMs: number;
}): WorkerInteraction {
    let instance: InstanceInteraction | undefined;
    let observing = false;
    const interaction: WorkerInteraction = Object.freeze({
        async observe() {
            if (!available()) return appInteractionUnavailable();
            if (observing) return { status: 'rejected' as const, issue: { code: 'OBSERVATION_BUSY', message: 'An observation is already being prepared.' } };
            observing = true;
            try {
                await refresh();
                if (!available()) return appInteractionUnavailable();
                if (!instance) {
                    instance = receiver.interaction(policy, { resolve }, {
                        observationLimits: limits, refreshProjection: refreshAuthority, canExposeTools: canExecuteTools,
                    });
                    forwardRequestSource(interaction, instance);
                }
                return await instance.observe();
            } catch (error) { return projectionRejection(error); }
            finally { observing = false; }
        },
        async preview() {
            if (!available()) return appInteractionUnavailable();
            try {
                await refresh();
                return available() ? receiver.preview() : appInteractionUnavailable();
            } catch (error) { return projectionRejection(error); }
        },
        invoke: (request, timeout, turn, signal) => {
            if (!available() || !instance) return Promise.resolve({ kind: 'refused' as const, ...appInteractionUnavailable().issue });
            if (!turn) return Promise.resolve({ kind: 'refused' as const, code: 'TURN_NOT_ACTIVE', message: 'Use the current adopted Desktop turn.' });
            return instance.invoke(request, timeout ?? timeoutMs, turn, signal);
        },
        readReceipt: (query, timeout) => available() && instance
            ? instance.readReceipt(query, timeout ?? timeoutMs)
            : Promise.resolve({ kind: 'unavailable' as const, ...appInteractionUnavailable().issue }),
    });
    return interaction;
}

function projectionRejection(error: unknown): Extract<AppInteractionResult, { status: 'rejected' }> {
    if (error instanceof ProjectionRefreshFailure) return Object.freeze({ status: 'rejected', issue: error.issue });
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'OBSERVATION_REFRESH_FAILED';
    return Object.freeze({ status: 'rejected', issue: Object.freeze({ code, message: 'Committed projection could not be observed' }) });
}
