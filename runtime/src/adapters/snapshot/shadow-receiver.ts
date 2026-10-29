/**
 * Snapshot sink and trusted internal interaction assembly for one App instance.
 *
 * AppWorkerHost owns this adapter and authenticates its physical Worker channel.
 * Legacy shadow diagnostics remain isolated; opt-in Scope semantics use the same Core.
 */
import { createSnapshotCore } from '../../core/snapshot/index.js';
import { createScopedInteraction } from '../../core/invocation/scoped-interaction.js';
import type { ExecutionResolver, InteractionAuthority, ScopePolicy } from '../../core/invocation/scoped-interaction.js';
import { acquireToolSource, acquireVersionedEntitySource } from '../../core/tool/source-binding.js';
import { prepareSnapshotValueArguments } from '../../core/tool/snapshot-value-arguments.js';
import type { ToolSourceRequest } from '../../core/tool/source-binding.js';
import type { PreparedSnapshotFailure, SnapshotHealth, SnapshotIssueCode } from '../../core/snapshot/index.js';
import type { SnapshotFragmentPush } from '../../spi/worker-protocol/messages.js';

export interface SnapshotShadowReport {
    /** A valid Core Draft does NOT prove SDK commit-phase atomicity. */
    readonly mode: 'shadow';
    readonly producerConsistency: 'unverified';
    readonly strictEligible: false;
    readonly appId: string;
    readonly instanceId: string;
    readonly health: SnapshotHealth;
    readonly revision?: number;
    readonly snapshotId?: string;
    readonly prepared: number;
    readonly published: number;
    readonly unchanged: number;
    readonly rejected: number;
    readonly wrongSource: number;
    readonly prepareFailed: number;
    readonly legacy: number;
    readonly lastIssueCode?: SnapshotIssueCode;
    readonly lastIssuePath?: string;
    readonly lastViewCount?: number;
    readonly lastRefCount?: number;
    readonly lastToolCount?: number;
    readonly legacyViewCount?: number;
    readonly legacyRefCount?: number;
    readonly legacyToolCount?: number;
    /** Paired by capture sequence; only a coarse count diff, not semantic parity. */
    readonly pairedLegacyFrames: number;
    readonly unpairedPreparedFrames: number;
    readonly lastViewCountDelta?: number;
    readonly lastRefCountDelta?: number;
    readonly lastToolCountDelta?: number;
}

/** This receiver is explicitly bound to an instance, not to the worker's payload alone. */
export class SnapshotShadowReceiver {
    private readonly core: ReturnType<typeof createSnapshotCore>;
    private interactions?: InteractionAuthority;
    private interactionsClosed = false;
    private prepared = 0;
    private published = 0;
    private unchanged = 0;
    private rejected = 0;
    private wrongSource = 0;
    private prepareFailed = 0;
    private legacy = 0;
    private lastIssueCode?: SnapshotIssueCode;
    private lastIssuePath?: string;
    private lastViewCount?: number;
    private lastRefCount?: number;
    private lastToolCount?: number;
    private legacyViewCount?: number;
    private legacyRefCount?: number;
    private legacyToolCount?: number;
    private readonly legacyCaptures = new Map<number, { views: number; refs: number; tools: number }>();
    private pairedLegacyFrames = 0;
    private unpairedPreparedFrames = 0;
    private lastViewCountDelta?: number;
    private lastRefCountDelta?: number;
    private lastToolCountDelta?: number;
    private stopped = false;

    constructor(readonly appId: string, readonly instanceId: string, private readonly now: () => number = Date.now) {
        this.core = createSnapshotCore({ now });
        this.core.lifecycle.startApp(appId, instanceId);
    }

    createInteractionScope(policy: ScopePolicy, execution: ExecutionResolver): ReturnType<InteractionAuthority['createScope']> {
        if (this.interactionsClosed || this.stopped) return Object.freeze({ status: 'rejected', issue: Object.freeze({
            code: 'REF_EXECUTION_UNAVAILABLE', message: 'Scoped Ref interaction is unavailable' }) });
        this.interactions ??= createScopedInteraction(this.core.store, { namespace: `host:${this.instanceId}`, now: this.now });
        return this.interactions.createScope({ appId: this.appId, instanceId: this.instanceId, policy, execution });
    }

    getInteractionStats() { return this.interactions?.inspect() ?? null; }

    closeInteractions(): Promise<void> {
        this.interactionsClosed = true;
        this.interactions?.close();
        return this.interactions?.whenClosed() ?? Promise.resolve();
    }

    /** Observe legacy output only for counts. No mutation or execution on the primary path. */
    observeLegacy(fragment: SnapshotFragmentPush): void {
        if (this.stopped || fragment.appId !== this.appId) return;
        this.legacy++;
        const keys = Object.keys(fragment.indexMap ?? {});
        this.legacyViewCount = fragment.views?.length ?? 0;
        this.legacyRefCount = keys.filter(key => !key.startsWith('tool:')).length;
        this.legacyToolCount = keys.filter(key => key.startsWith('tool:')).length;
        if (fragment.shadowInstanceId === this.instanceId &&
            Number.isSafeInteger(fragment.shadowCaptureSeq) && fragment.shadowCaptureSeq! > 0) {
            this.legacyCaptures.set(fragment.shadowCaptureSeq!, {
                views: this.legacyViewCount,
                refs: this.legacyRefCount,
                tools: this.legacyToolCount,
            });
            // Diagnostic cache is bounded; mismatch counts are not a retention store.
            while (this.legacyCaptures.size > 16) {
                this.legacyCaptures.delete(this.legacyCaptures.keys().next().value!);
            }
        }
    }

    acceptPrepared(input: unknown): void {
        if (this.stopped) return;
        this.prepared++;
        if (!this.hasOwnSource(input)) {
            this.recordWrongSource();
            return;
        }
        const result = this.core.committer.accept(input);
        if (result.status === 'rejected') {
            this.rejected++;
            this.lastIssueCode = result.issue.code;
            this.lastIssuePath = result.issue.path;
            return;
        }
        if (result.status === 'published') this.published++;
        else this.unchanged++;
        this.lastIssueCode = undefined;
        this.lastIssuePath = undefined;
        const snap = result.snapshot;
        this.lastViewCount = snap.views.length;
        this.lastRefCount = Object.keys(snap.refs).length;
        this.lastToolCount = Object.keys(snap.tools).length;
        const seq = Object.getOwnPropertyDescriptor(input!, 'producerSeq')?.value as number | undefined;
        const legacy = typeof seq === 'number' ? this.legacyCaptures.get(seq) : undefined;
        if (legacy) {
            this.pairedLegacyFrames++;
            this.lastViewCountDelta = this.lastViewCount - legacy.views;
            this.lastRefCountDelta = this.lastRefCount - legacy.refs;
            this.lastToolCountDelta = this.lastToolCount - legacy.tools;
            this.legacyCaptures.delete(seq!);
        } else {
            this.unpairedPreparedFrames++;
        }
    }

    /** Called only after the bound Worker channel has been identified by AppWorkerHost. */
    acceptPrepareFailure(failure: PreparedSnapshotFailure): void {
        if (this.stopped) return;
        if (failure.appId !== this.appId || failure.instanceId !== this.instanceId) {
            this.recordWrongSource();
            return;
        }
        this.prepareFailed++;
        const result = this.core.committer.reportPrepareFailure(failure);
        if (result.status === 'rejected') {
            this.rejected++;
            this.lastIssueCode = result.issue.code;
            this.lastIssuePath = result.issue.path;
        }
    }

    /** Stage 3: only trusted Host sees this read-only pinned source selection. */
    selectToolSource(request: ToolSourceRequest) {
        return acquireToolSource(this.core.store, request);
    }

    prepareSnapshotValueArguments(request: unknown) {
        return prepareSnapshotValueArguments(this.core.store,
            { appId: this.appId, instanceId: this.instanceId }, request);
    }

    selectVersionedEntitySource(request: ToolSourceRequest & { readonly refId: string }) {
        return acquireVersionedEntitySource(this.core.store, request);
    }

    close(): void {
        this.closeInteractions();
        if (this.stopped) return;
        this.stopped = true;
        this.core.lifecycle.dispose();
        this.legacyCaptures.clear();
    }

    report(): SnapshotShadowReport {
        const current = this.core.store.readLatest(this.appId);
        return Object.freeze({
            mode: 'shadow' as const,
            producerConsistency: 'unverified' as const,
            strictEligible: false as const,
            appId: this.appId,
            instanceId: this.instanceId,
            health: current.status,
            ...(current.status === 'ready' ? {
                revision: current.snapshot.revision,
                snapshotId: current.snapshot.id,
            } : {}),
            prepared: this.prepared,
            published: this.published,
            unchanged: this.unchanged,
            rejected: this.rejected,
            wrongSource: this.wrongSource,
            prepareFailed: this.prepareFailed,
            legacy: this.legacy,
            pairedLegacyFrames: this.pairedLegacyFrames,
            unpairedPreparedFrames: this.unpairedPreparedFrames,
            ...(this.lastViewCountDelta !== undefined ? { lastViewCountDelta: this.lastViewCountDelta } : {}),
            ...(this.lastRefCountDelta !== undefined ? { lastRefCountDelta: this.lastRefCountDelta } : {}),
            ...(this.lastToolCountDelta !== undefined ? { lastToolCountDelta: this.lastToolCountDelta } : {}),
            ...(this.lastIssueCode ? { lastIssueCode: this.lastIssueCode } : {}),
            ...(this.lastIssuePath ? { lastIssuePath: this.lastIssuePath } : {}),
            ...(this.lastViewCount !== undefined ? { lastViewCount: this.lastViewCount } : {}),
            ...(this.lastRefCount !== undefined ? { lastRefCount: this.lastRefCount } : {}),
            ...(this.lastToolCount !== undefined ? { lastToolCount: this.lastToolCount } : {}),
            ...(this.legacyViewCount !== undefined ? { legacyViewCount: this.legacyViewCount } : {}),
            ...(this.legacyRefCount !== undefined ? { legacyRefCount: this.legacyRefCount } : {}),
            ...(this.legacyToolCount !== undefined ? { legacyToolCount: this.legacyToolCount } : {}),
        });
    }

    private recordWrongSource(): void {
        this.rejected++;
        this.wrongSource++;
        this.lastIssueCode = 'APP_INSTANCE_MISMATCH';
        this.lastIssuePath = undefined;
    }

    private hasOwnSource(input: unknown): boolean {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
        // No accessor evaluation in receiver identity checking.
        try {
            const fields = Object.getOwnPropertyDescriptors(input);
            const app = fields.appId;
            const instance = fields.instanceId;
            return !!app && 'value' in app && app.value === this.appId &&
                !!instance && 'value' in instance && instance.value === this.instanceId;
        } catch {
            return false;
        }
    }
}
