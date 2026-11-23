import { expect, it, vi } from 'vitest';
import type { ToolResult } from '@aotui/agent-driver-v2';
import type { PendingAppReceipt } from '@aotui/agent-driver-adapter';
import type { AppInteraction, IDesktop, IKernel, ReceiptAccess } from '@aotui/runtime';
import { PendingAppReceipts } from '../src/core/pending-app-receipts.js';

function fixture() {
    const desktopId = 'topic' as IDesktop['id'];
    const timeout: ReceiptAccess = { kind: 'unavailable', code: 'INVOCATION_WAIT_TIMEOUT', message: 'still running' };
    const readReceipt = vi.fn(async () => timeout);
    const interaction = { readReceipt } as unknown as AppInteraction;
    const access = vi.fn(() => ({ status: 'ready', interaction }));
    const session = {
        desktop: { id: desktopId, getInstalledApps: () => [{ appId: 'mail', appInstanceId: 'instance', installationId: 'mail_install' }] } as IDesktop,
        kernel: { getAppInteraction: access } as unknown as IKernel,
        isCurrent: () => true,
        isAppEnabled: () => true,
    };
    const pending = new PendingAppReceipts();
    const remember = (toolCallId: string, observationId: string): ToolResult => {
        const result: ToolResult = { toolName: 'mail-set_recipients', toolCallId, outcomeStatus: 'unknown' };
        const locator = { desktopId, appId: 'mail', appInstanceId: 'instance', invocationId: toolCallId, observationId } as PendingAppReceipt;
        pending.remember(locator, result);
        return result;
    };
    return { pending, remember, readReceipt, access, read: (messageId: string, toolCallId: string) =>
        pending.read({ messageId, toolCallId }, session, 50) };
}

it('associates multiple results independently and distinguishes two saved messages reusing a call ID', async () => {
    const f = fixture();
    const original = f.remember('reused', 'contacts-1');
    const sibling = f.remember('sibling', 'contacts-2');
    f.pending.associate('first-message', [original, sibling]);
    const later = f.remember('reused', 'contacts-3');
    expect(await f.read('later-message', 'reused')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
    f.pending.associate('later-message', [later]);
    expect(await f.read('later-message', 'sibling')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
    await f.read('later-message', 'reused');
    await f.read('first-message', 'sibling');
    await f.read('first-message', 'reused');
    expect(f.readReceipt.mock.calls).toEqual([
        [{ observationId: 'contacts-3', invocationId: 'reused' }, 50],
        [{ observationId: 'contacts-2', invocationId: 'sibling' }, 50],
        [{ observationId: 'contacts-1', invocationId: 'reused' }, 50],
    ]);
});

it('discards unsaved results and refuses an ambiguous call ID within one saved message', async () => {
    const f = fixture();
    const unsaved = f.remember('reused', 'discarded');
    f.pending.associate('different-result', [{ ...unsaved }]);
    expect(await f.read('different-result', 'reused')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
    f.pending.associate(undefined, [unsaved]);
    f.pending.associate('next-message', [unsaved]);
    expect(await f.read('next-message', 'reused')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });

    const first = f.remember('same-in-message', 'first');
    const second = f.remember('same-in-message', 'second');
    f.pending.associate('ambiguous', [first, second]);
    expect(await f.read('ambiguous', 'same-in-message')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
    expect(f.access).not.toHaveBeenCalled();
});

it('keeps one capacity across results awaiting save and associated message locators', async () => {
    const f = fixture();
    const result = f.remember('first', 'first-run');
    f.pending.associate('old-message', [result]);
    const outstanding = Array.from({ length: 128 }, (_, index) => f.remember('pending-' + index, 'run'));
    expect(await f.read('old-message', 'first')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
    f.pending.associate('latest-message', outstanding);
    expect(await f.read('latest-message', 'pending-0')).toMatchObject({ code: 'INVOCATION_WAIT_TIMEOUT' });
    f.pending.clear();
    expect(await f.read('latest-message', 'pending-127')).toMatchObject({ code: 'RECEIPT_LOCATOR_UNAVAILABLE' });
});
