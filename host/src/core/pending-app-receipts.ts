import type { PendingAppReceipt } from '@aotui/agent-driver-adapter';
import type { ToolResult } from '@aotui/agent-driver-v2';
import type { IDesktop, ReceiptAccess } from '@aotui/runtime';

export interface AppReceiptMessageQuery {
    readonly messageId: string;
    readonly toolCallId: string;
    readonly subcallId?: string;
}

interface ReceiptSession {
    desktop: IDesktop;
    isCurrent(): boolean;
    isAppEnabled(installationId: string): boolean;
}

const receiptKey = (messageId: string, toolCallId: string, subcallId?: string) => JSON.stringify([messageId, toolCallId, subcallId]);
const unavailable = (code: string, message: string): ReceiptAccess => ({ kind: 'unavailable', code, message });

/** Holds only locators for calls whose outcome the owning session still needs to verify. */
export class PendingAppReceipts {
    private readonly locators = new Map<string | symbol, PendingAppReceipt>();
    private readonly awaiting = new WeakMap<Readonly<ToolResult>, Map<string | undefined, symbol>>();

    remember(locator: PendingAppReceipt, result: Readonly<ToolResult>, subcallId?: string): void {
        const slots = this.awaiting.get(result) ?? new Map();
        const token = slots.get(subcallId) ?? Symbol();
        slots.set(subcallId, token);
        this.awaiting.set(result, slots);
        if (!this.locators.has(token) && this.locators.size >= 128) {
            const oldest = this.locators.keys().next();
            if (!oldest.done) this.locators.delete(oldest.value);
        }
        this.locators.set(token, locator);
    }

    associate(messageId: string | undefined, results: readonly ToolResult[]): void {
        const occurrences = new Map<string, number>();
        for (const { toolCallId } of results) occurrences.set(toolCallId, (occurrences.get(toolCallId) ?? 0) + 1);
        for (const result of results) {
            const slots = this.awaiting.get(result);
            this.awaiting.delete(result);
            for (const [subcallId, token] of slots ?? []) {
                const locator = this.locators.get(token);
                this.locators.delete(token);
                if (locator && messageId && occurrences.get(result.toolCallId) === 1)
                    this.locators.set(receiptKey(messageId, result.toolCallId, subcallId), locator);
            }
        }
    }

    clear(): void { this.locators.clear(); }

    async read(query: AppReceiptMessageQuery, session: ReceiptSession, timeoutMs?: number): Promise<ReceiptAccess> {
        const key = receiptKey(query.messageId, query.toolCallId, query.subcallId);
        const locator = this.locators.get(key);
        if (!locator || locator.desktopId !== session.desktop.id || !session.isCurrent())
            return unavailable('RECEIPT_LOCATOR_UNAVAILABLE', 'No pending receipt belongs to this session and call.');
        const readAccess = () => {
            if (!session.isCurrent())
                return { status: 'rejected' as const, issue: { code: 'RECEIPT_SESSION_CHANGED', message: 'The owning session is no longer current.' } };
            const access = session.desktop.getRunningApp(locator.appId, locator.appInstanceId);
            if (access.status === 'rejected') return access;
            const app = session.desktop.listApps().find(app => app.appId === locator.appId && app.appInstanceId === locator.appInstanceId);
            if (!app || !session.isAppEnabled(app.installationId))
                return { status: 'rejected' as const, issue: { code: 'APP_DISABLED', message: 'This application is disabled in the current session.' } };
            return access;
        };
        const rejected = (issue: { code: string; message: string }) => {
            if (issue.code === 'APP_INSTANCE_MISMATCH' || issue.code === 'APP_INTERACTION_UNAVAILABLE')
                this.locators.delete(key);
            return unavailable(issue.code, issue.message);
        };
        const access = readAccess();
        if (access.status === 'rejected') return rejected(access.issue);
        let result: ReceiptAccess;
        try { result = await session.desktop.readReceipt({ desktopId: locator.desktopId, appId: locator.appId,
            instanceId: locator.appInstanceId, observationId: locator.observationId, invocationId: locator.invocationId }, timeoutMs); }
        catch { result = unavailable('RECEIPT_READ_FAILED', 'The original App receipt could not be read.'); }
        const current = readAccess();
        if (current.status === 'rejected') return rejected(current.issue);
        if (current.app !== access.app)
            return rejected({ code: 'APP_INSTANCE_MISMATCH', message: 'The original application instance is no longer current.' });
        if (result.kind === 'receipt' || result.code === 'RESULT_UNAVAILABLE' || result.code === 'RESULT_EXPIRED') this.locators.delete(key);
        return result;
    }
}
